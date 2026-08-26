import * as vscode from 'vscode';
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, VSCodeFlowrConfiguration, getWasmRootPath, isWeb, updateStatusBar } from '../extension';
import { Settings, getConfig, isVerbose } from '../settings';
import type { FlowrSession, SliceReturn } from './utils';
import { makeSliceElements, selectionsToNodeIds } from './utils';
import type { RShellOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { RShell, RShellReviveOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast';
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg';
import type { KnownParser, KnownParserName } from '@eagleoutice/flowr/r-bridge/parser';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { type Queries, type QueryResults, type SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { SemVer } from 'semver';
import { repl, type FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import { versionReplString } from '@eagleoutice/flowr/cli/repl/print-version';
import { LogLevel, log } from '@eagleoutice/flowr/util/log';
import { staticSlice } from '@eagleoutice/flowr/slicing/static/static-slicer';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import { reconstructToCode } from '@eagleoutice/flowr/reconstruct/reconstruct';
import { doNotAutoSelect } from '@eagleoutice/flowr/reconstruct/auto-select/auto-select-defaults';
import { makeMagicCommentHandler } from '@eagleoutice/flowr/reconstruct/auto-select/magic-comments';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { sigDbSummary } from '../package-db';
import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';
import type { CfgSimplificationPassName } from '@eagleoutice/flowr/control-flow/cfg-simplification';
import { MermaidDefaultMarkStyle } from '@eagleoutice/flowr/util/mermaid/info';
import type { DiagramSelectionMode } from './diagrams/diagram-definitions';
import { FlowrDiagramType, DiagramDefinitions } from './diagrams/diagram-definitions';
import { FlowrConfig } from '@eagleoutice/flowr/config';
import { DataflowMermaid } from '@eagleoutice/flowr/util/mermaid/dfg';
import type { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';

const logLevelToScore = {
	Silly: LogLevel.Silly,
	Trace: LogLevel.Trace,
	Debug: LogLevel.Debug,
	Info:  LogLevel.Info,
	Warn:  LogLevel.Warn,
	Error: LogLevel.Error,
	Fatal: LogLevel.Fatal
} as const;

function setFlowrLoggingSensitivity(output: vscode.OutputChannel) {
	const desired = getConfig().get<keyof typeof logLevelToScore>(Settings.DebugFlowrLoglevel, isVerbose() ? 'Info' : 'Fatal');
	const level = desired in logLevelToScore ? logLevelToScore[desired] : LogLevel.Info;

	output.appendLine('[flowR] Setting log level to ' + desired + ' (' + level + ')');

	log.updateSettings(l => {
		l.settings.minLevel = level;
		// disable all formatting highlights
		l.settings.type = 'json';
		if(isVerbose()) {
			// redirect console.log to output channel
			let lastMessage = '';
			l.attachTransport(l => {
				const level = l._meta?.logLevelName ?? 'LEVEL?';
				const date = l._meta?.date ? l._meta.date.toUTCString() : 'TIME?';
				let msg = l['0'] as unknown as string | (() => string);
				if(typeof msg === 'function') {
					msg = msg();
				}
				const message = '[flowR, ' + date + ', ' + level + '] ' + msg;
				if(lastMessage !== message) {
					output.appendLine(message);
					lastMessage = message;
				}
			});
		}
	});
}


let loggingListenerRegistered = false;

function configureFlowrLogging(output: vscode.OutputChannel) {
	// register the config listener only once (it is process-global logging state); creating a session per
	// reconnect must not keep stacking listeners
	if(!loggingListenerRegistered) {
		loggingListenerRegistered = true;
		vscode.workspace.onDidChangeConfiguration(e => {
			if(e.affectsConfiguration(Settings.Category)) {
				setFlowrLoggingSensitivity(output);
			}
		});
	}
	setFlowrLoggingSensitivity(output);
}

type WorkActions = 'slice' | FlowrDiagramType;

type ProgressReporter = vscode.Progress<{ message?: string }>;

/** runs the (memoized) pipeline step by step, reporting each stage to the progress bar */
async function dataflowWithProgress(analyzer: FlowrAnalyzer, progress: ProgressReporter): Promise<{ ast: NormalizedAst, dfi: DataflowInformation }> {
	progress.report({ message: 'Parsing…' });
	await analyzer.parse();
	progress.report({ message: 'Normalizing…' });
	const ast = await analyzer.normalize();
	progress.report({ message: 'Computing data flow…' });
	const dfi = await analyzer.dataflow();
	return { ast, dfi };
}

export class FlowrInternalSession implements FlowrSession {

	private static treeSitterInitialized: boolean = false;

	public state:    'inactive' | 'loading' | 'active' | 'failure';
	public rVersion: string | undefined;
	public working:  boolean = false;
	public parser:   KnownParser | undefined;

	private readonly outputChannel: vscode.OutputChannel;

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.state = 'inactive';
		configureFlowrLogging(this.outputChannel);
		updateStatusBar();
	}

	private async startWorkWithProgressBar<T = void>(document: vscode.TextDocument, actionFn: (analyzer: FlowrAnalyzer, progress: ProgressReporter) => Promise<T>, action: WorkActions, showErrorMessage: boolean, defaultOnErr = {} as T): Promise<T> {
		this.setWorking(true);

		// Wait for the flowr session
		if(!this.parser) {
			const times =  [3000, 2000, 1000];
			while(times.length !== 0) {
				const timeout = times.pop();
				this.outputChannel.appendLine(`FlowR Session not available - retrying in ${timeout}ms`);
				await new Promise(res => setTimeout(res, timeout));

				if(this.parser) {
					break;
				}
			}

			if(!this.parser) {
				this.setWorking(false);
				return defaultOnErr;
			}
		}


		const parser = this.parser;

		// status-bar progress, not a Notification: slicers re-run on every edit and stacked notifications spam
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title:    (() => {
				if(action === 'slice') {
					return 'flowR: slicing';
				} else if(action in DiagramDefinitions) {
					return DiagramDefinitions[action].verb;
				} else {
					return 'flowR: working';
				}
			})(),
			cancellable: false
		},
		async(progress) => {
			try {
				return await withAnalyzer(document, parser, analyzer => actionFn(analyzer, progress));
			} catch(e) {
				this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
				(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l));
				if(showErrorMessage) {
					void vscode.window.showErrorMessage(`There was an error: ${(e as Error)?.message}. See the flowR output for more information.`);
				}
				return defaultOnErr;
			} finally {
				this.setWorking(false);
			}
		});
	}

	setWorking(working: boolean): void {
		this.working = working;
		updateStatusBar();
	}

	async initialize() {
		this.state = 'loading';
		updateStatusBar();
		this.outputChannel.appendLine('Starting internal flowR engine');

		switch(FlowrInternalSession.getEngineToUse()) {
			case 'r-shell': {
				let options: Partial<RShellOptions> = {
					revive:      RShellReviveOptions.Always,
					sessionName: 'flowr - vscode'
				};
				const executable = getConfig().get<string>(Settings.Rexecutable)?.trim();
				if(executable !== undefined && executable.length > 0) {
					options = { ...options, pathToRExecutable: executable };
				}
				this.outputChannel.appendLine(`Using options ${JSON.stringify(options)}`);

				this.parser = new RShell(FlowrConfig.getForEngine(VSCodeFlowrConfiguration, 'r-shell'), options);
				this.parser.tryToInjectHomeLibPath();

				// wait at most 1 second for the version, since the R shell doesn't let us know if the path
				// we provided doesn't actually lead anywhere, or doesn't contain an R executable, etc.
				let handle: NodeJS.Timeout;
				const timeout = new Promise<null>(resolve => handle = setTimeout(() => resolve(null), 5000));
				await Promise.race([this.parser.usedRVersion(), timeout]).then((version: SemVer | null) => {
					clearTimeout(handle);
					if(!version){
						const seeDoc = 'See documentation';
						const sandboxHint = typeof process !== 'undefined' && process.env?.FLATPAK_ID
							? ` VS Code is running inside a Flatpak sandbox (${process.env.FLATPAK_ID}); R must either be installed inside the sandbox or the sandbox needs host filesystem access to it (e.g. "flatpak override --filesystem=host" or granting access to R's install location), and the resulting path set as vscode-flowr's "r.executable" setting.`
							: '';
						void vscode.window.showErrorMessage(`The R version could not be determined. R needs to be installed and part of your PATH environment variable.${sandboxHint}`, seeDoc)
							.then(s => {
								if(s === seeDoc){
									void vscode.env.openExternal(vscode.Uri.parse('https://github.com/flowr-analysis/vscode-flowr/blob/main/README.md#using'));
								}
							});

						this.state = 'failure';
						updateStatusBar();
					} else {
						this.outputChannel.appendLine(`Using R version ${version.toString()}`);
						if(version.major < MINIMUM_R_MAJOR) {
							void vscode.window.showErrorMessage(`You are using R version ${version.toString()}, but ${MINIMUM_R_MAJOR}.0.0 or higher is required.`);
						} else if(version.major < BEST_R_MAJOR) {
							void vscode.window.showWarningMessage(`You are using R version ${version.toString()}, which flowR has not been tested for. Version ${BEST_R_MAJOR}.0.0 or higher is recommended.`);
						}

						this.state = 'active';
						this.rVersion = version.toString();
						updateStatusBar();
					}
				});
				break;
			}
			case 'tree-sitter': {
				if(!FlowrInternalSession.treeSitterInitialized) {
					try {
						const timeout = getConfig().get<number>(Settings.TreeSitterTimeout, 60000);

						this.outputChannel.appendLine('Initializing tree-sitter... (wasm at: ' + getWasmRootPath() + ', timeout: ' + timeout + 'ms)');

						await Promise.race([TreeSitterExecutor.initTreeSitter(
							FlowrConfig.getForEngine(VSCodeFlowrConfiguration, 'tree-sitter'),
						), new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Timeout (${Settings.TreeSitterTimeout} = ${timeout}ms)`)), timeout))]);
						FlowrInternalSession.treeSitterInitialized = true;
					} catch(e) {
						this.outputChannel.appendLine('Error in init of tree sitter: ' + (e as Error)?.message);
						this.outputChannel.appendLine((e as Error)?.stack ?? '');
						vscode.window.showErrorMessage('Failed to initialize tree-sitter. See the flowR output for more information.');
					}
				}
				this.outputChannel.appendLine('Tree-sitter loaded!');

				this.parser = new TreeSitterExecutor();
				this.outputChannel.appendLine('Tree-sitter initialized!');

				this.state = 'active';
				this.rVersion = await this.parser.rVersion();
				updateStatusBar();
			}
		}
	}

	public destroy(): void {
		clearAnalyzerCache();
		this.parser?.close();
	}

	async retrieveSlice(criteria: SlicingCriteria, direction: SliceDirection, document: vscode.TextDocument, showErrorMessage: boolean = true, info?: { dfi: DataflowInformation, ast: NormalizedAst }): Promise<SliceReturn> {
		if(!this.parser) {
			return {
				code:          '',
				sliceElements: []
			};
		}
		return await this.startWorkWithProgressBar(document, (analyzer, progress) => this.extractSlice(analyzer, progress, criteria, direction, info), 'slice', showErrorMessage, { code: '', sliceElements: [] });
	}

	async retrieveDataflowMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified = false): Promise<string> {
		return await this.startWorkWithProgressBar(document, async(analyzer, progress) => {
			const { ast, dfi: df } = await dataflowWithProgress(analyzer, progress);
			const selectionNodes = selectionsToNodeIds(ast.ast.files.map(f => f.root), selections);

			progress.report({ message: 'Rendering diagram…' });
			return DataflowMermaid.convert({
				graph:               df.graph,
				simplified,
				includeEnvironments: false,
				includeOnlyIds:      selectionMode === 'hide' ? selectionNodes : undefined,
				mark:                selectionMode === 'highlight' ? new Set(selectionNodes?.values().map(v => String(v))) : undefined,
			}).string;
		}, FlowrDiagramType.Dataflow, true, '');
	}

	async retrieveCallgraphMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified?: boolean): Promise<string> {
		return await this.startWorkWithProgressBar(document, async(analyzer, progress) => {
			progress.report({ message: 'Computing call graph…' });
			const callGraph = await analyzer.callGraph();
			const ast = await analyzer.normalize();
			const selectionNodes = selectionsToNodeIds(ast.ast.files.map(f => f.root), selections);

			progress.report({ message: 'Rendering diagram…' });
			return DataflowMermaid.convert({
				graph:               callGraph,
				simplified,
				includeEnvironments: false,
				includeOnlyIds:      selectionMode === 'hide' ? selectionNodes : undefined,
				mark:                selectionMode === 'highlight' ? new Set(selectionNodes?.values().map(v => String(v))) : undefined,
			}).string;
		}, FlowrDiagramType.CallGraph, true, '');
	}


	async retrieveAstMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode): Promise<string> {
		return await this.startWorkWithProgressBar(document, async(analyzer, progress) => {
			progress.report({ message: 'Parsing…' });
			await analyzer.parse();
			progress.report({ message: 'Normalizing…' });
			const result = await analyzer.normalize();
			const selectionNodes = selectionsToNodeIds(result.ast.files.map(f => f.root), selections);

			progress.report({ message: 'Rendering diagram…' });
			return normalizedAstToMermaid(result.ast, {
				includeOnlyIds: selectionMode === 'hide' ? selectionNodes : undefined,
				mark:           selectionMode === 'highlight' ? selectionNodes : undefined,
			});
		}, FlowrDiagramType.Ast, true, '');
	}

	async retrieveCfgMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified: boolean, simplifications: CfgSimplificationPassName[]): Promise<string> {
		return await this.startWorkWithProgressBar(document, async(analyzer, progress) => {
			progress.report({ message: 'Normalizing…' });
			const ast = await analyzer.normalize();
			progress.report({ message: 'Computing control flow…' });
			const result = await analyzer.controlflow(simplifications);

			const selectionNodes = selectionsToNodeIds(ast.ast.files.map(f => f.root), selections);

			progress.report({ message: 'Rendering diagram…' });
			return cfgToMermaid(result, ast, {
				includeOnlyIds: selectionMode === 'hide' ? selectionNodes : undefined,
				mark:           selectionMode === 'highlight' ? selectionNodes : undefined,
				simplify:       simplified,
				markStyle:      MermaidDefaultMarkStyle
			});
		}, FlowrDiagramType.Controlflow, true, '');
	}

	// takes the analyzer from its caller's withAnalyzer scope (opening its own would deadlock the queue)
	private async extractSlice(analyzer: FlowrAnalyzer, progress: ProgressReporter, criteria: SlicingCriteria, direction: SliceDirection, info?: { dfi: DataflowInformation, ast: NormalizedAst }): Promise<SliceReturn> {
		const threshold = getConfig().get<number>(Settings.SliceRevisitThreshold, 12);
		const includeCallees = getConfig().get<boolean>(Settings.SliceIncludeCallees, false);
		const inlineSources = getConfig().get<boolean>(Settings.SliceInlineSources, false);
		if(!info) {
			info = await dataflowWithProgress(analyzer, progress);
		}
		progress.report({ message: 'Computing slice…' });
		const sliceStart = Date.now();
		const elements = staticSlice({
			ctx:  analyzer.inspectContext(),
			info: info.dfi,
			ast:  info.ast,
			ids:  SlicingCriteria.convertAll(criteria, info.ast.idMap),
			direction,
			threshold,
			includeCallees
		}).result;
		const sliceMs = Date.now() - sliceStart;

		progress.report({ message: 'Reconstructing…' });
		const reconstructStart = Date.now();
		const sliceElements = makeSliceElements(elements, id => info.ast.idMap.get(id)?.location);
		const sliceSelection: Parameters<typeof reconstructToCode>[1] = { nodes: new Set(elements) };
		if(inlineSources) {
			sliceSelection.inlineSources = true;
			sliceSelection.reconstructFiles = [0];
		}
		const result = reconstructToCode(info.ast, sliceSelection, makeMagicCommentHandler(doNotAutoSelect));
		const code = typeof result.code === 'string' ? result.code : result.code.join('\n');

		this.outputChannel.appendLine(`[Slice] ${elements.size} node${elements.size === 1 ? '' : 's'} (slice ${sliceMs}ms, reconstruct ${Date.now() - reconstructStart}ms)${isVerbose() ? ` ids=${JSON.stringify([...elements])}` : ''}`);

		return {
			code,
			sliceElements
		};
	}

	public async retrieveQuery<T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>): Promise<{ result: QueryResults<T>, hasError: boolean, dfi?: DataflowInformation, ast?: NormalizedAst }> {
		if(!this.parser) {
			throw new Error('No parser available');
		}

		return withAnalyzer(document, this.parser, async analyzer => {
			const dataflow = await analyzer.dataflow();
			const normalize = await analyzer.normalize();

			if(normalize.hasError && (normalize.ast.files as unknown[])?.length === 0) {
				return { result: {} as QueryResults<T>, hasError: true, dfi: dataflow, ast: normalize };
			}

			return {
				result:   await analyzer.query(query),
				hasError: normalize.hasError ?? false,
				dfi:      dataflow,
				ast:      normalize
			};
		});
	}

	/**
	 * Builds the analyzer the REPL runs on (validating the flowR configuration) and the banner shown on start,
	 * which includes the flowR/engine versions and the active package database. Split out from {@link runRepl}
	 * so it can be exercised in tests without entering the interactive read loop (which would end the process).
	 */
	public async replStartup(): Promise<{ analyzer: FlowrAnalyzer, banner: string } | undefined> {
		if(!this.parser) {
			return undefined;
		}
		const analyzer = await new FlowrAnalyzerBuilder()
			.setParser(this.parser)
			.setConfig(VSCodeFlowrConfiguration)
			.build();
		return { analyzer, banner: `${await versionReplString(this.parser)}\n${sigDbSummary()}` };
	}

	public async runRepl(config: Omit<Required<FlowrReplOptions>, 'parser'>) {
		const startup = await this.replStartup();
		if(!startup) {
			return;
		}
		(config.output as { stdout: (s: string) => void }).stdout(startup.banner);
		await repl({ analyzer: startup.analyzer, ...config });
	}

	public static getEngineToUse(): KnownParserName {
		return isWeb() ? 'tree-sitter' : getConfig().get<KnownParserName>(Settings.Rengine, 'tree-sitter');
	}
}

interface CachedAnalyzer {
	version:  number;
	parser:   KnownParser;
	config:   FlowrConfig;
	analyzer: Promise<FlowrAnalyzer>;
	/** serializes pipeline access: flowR's pipeline is not re-entrant, so concurrent callers must queue */
	queue:    Promise<unknown>;
}

/**
 * Caches one analyzer per document (keyed by version/parser/config) so the many analyses a single interaction
 * triggers reuse memoized dataflow/normalize/query results instead of recomputing them.
 */
const analyzerCache = new Map<string, CachedAnalyzer>();
const maxAnalyzerCache = 4;

/**
 *
 */
export function clearAnalyzerCache(): void {
	analyzerCache.clear();
}

function buildAnalyzerForDocument(document: vscode.TextDocument, parser: KnownParser, config: FlowrConfig): Promise<FlowrAnalyzer> {
	return new FlowrAnalyzerBuilder()
		.setParser(parser)
		.setConfig(config)
		.build()
		.then(analyzer => {
			if(document.uri.scheme === 'file') {
				const file = new FlowrInlineTextFile(document.fileName, document.getText());
				analyzer.reset();
				analyzer.addFile(file);
				analyzer.addRequest({
					request: 'file',
					content: document.fileName
				});
			} else {
				analyzer.reset();
				analyzer.addRequest({
					request: 'text',
					content: document.getText()
				});
			}
			return analyzer;
		});
}

function analyzerEntryForDocument(document: vscode.TextDocument, parser: KnownParser): CachedAnalyzer {
	const key = document.uri.toString();
	const config = VSCodeFlowrConfiguration;
	const cached = analyzerCache.get(key);
	if(cached && cached.version === document.version && cached.parser === parser && cached.config === config) {
		// mark as most-recently-used and reuse the analyzer (with its memoized results)
		analyzerCache.delete(key);
		analyzerCache.set(key, cached);
		return cached;
	}

	const analyzer = buildAnalyzerForDocument(document, parser, config);
	// don't let a failed build poison the cache
	analyzer.catch(() => {
		if(analyzerCache.get(key)?.analyzer === analyzer) {
			analyzerCache.delete(key);
		}
	});
	const entry: CachedAnalyzer = { version: document.version, parser, config, analyzer, queue: Promise.resolve() };
	analyzerCache.set(key, entry);

	// evict least-recently-used entries; we must NOT close evicted analyzers, as they share the session's parser
	while(analyzerCache.size > maxAnalyzerCache) {
		const oldest = analyzerCache.keys().next().value;
		if(oldest === undefined) {
			break;
		}
		analyzerCache.delete(oldest);
	}

	return entry;
}

/** runs `work` against the document's cached analyzer, serialized against other callers (see {@link CachedAnalyzer.queue}) */
export function withAnalyzer<T>(document: vscode.TextDocument, parser: KnownParser, work: (analyzer: FlowrAnalyzer) => Promise<T>): Promise<T> {
	const entry = analyzerEntryForDocument(document, parser);
	const run = entry.queue.then(async() => work(await entry.analyzer));
	// swallow rejections on the chain so one failure doesn't wedge the queue
	entry.queue = run.then(() => undefined, () => undefined);
	return run;
}
