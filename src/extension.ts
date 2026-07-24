import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FlowrInternalSession } from './flowr/internal-session';
import { FlowrServerSession } from './flowr/server-session';
import { getConfig, Settings } from './settings';
import { registerSliceCommands } from './slice';
import { registerDiagramCommands } from './flowr/diagrams/diagram';
import type { FlowrSession } from './flowr/utils';
import { selectionSlicer } from './selection-slicer';
import { positionSlicers } from './position-slicer';
import { version as flowrPackageVersion } from '@eagleoutice/flowr/package.json';
import { registerDependencyInternalCommands, registerDependencyView } from './flowr/views/dependency-view';
import { DropPathsOption, FlowrConfig, InferWorkingDirectory, VariableResolve  } from '@eagleoutice/flowr/config';
import type { BuiltInDefinitions } from '@eagleoutice/flowr/dataflow/environments/built-in-config';
import { deepMergeObject } from '@eagleoutice/flowr/util/objects';
import { registerLintCommands } from './lint';
import { NoTelemetry, RecordingTelemetry, registerTelemetry, telemetry, TelemetryEvent } from './telemetry';
import { registerHoverOverValues } from './hover-values';
import { registerPackageInfo } from './package-info';
import { registerCompletion } from './completion';
import { registerProjectView } from './flowr/views/project-view';
import { registerSigDbView } from './flowr/views/sigdb-view';
import { registerSigDbNotifications } from './sigdb-notifications';
import { sigDbSummary, getSigDbMountPaths, isSigDbEnabled, shouldSigDbAutoSync, getDownloadedShardGroups, getSigDbScopeState, downloadSigDbScope, invalidateSigDbPackageNamesCache } from './package-db';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { showRepl } from './flowr/terminals/flowr-repl';

/** public-facing API for the flowR extension; currently required and used for unit tests */
export interface FlowrExtensionApi {
	flowrConfig: () => FlowrConfig
}

export const MINIMUM_R_MAJOR = 3;
export const BEST_R_MAJOR = 4;

let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let flowrSession: FlowrSession | undefined;
/** coalesces concurrent lazy session inits so a burst of feature calls doesn't spawn (and tear down) duplicates */
let sessionInitPromise: Promise<FlowrSession> | undefined;

/**
 *
 */
export async function activate(context: vscode.ExtensionContext): Promise<FlowrExtensionApi> {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel('flowR');
	outputChannel.appendLine(`flowR extension activated (ships with flowR v${flowrPackageVersion}, web: ${isWeb()})`);

	registerDiagramCommands(context, outputChannel);
	registerSliceCommands(context, outputChannel);
	registerLintCommands(context, outputChannel);
	registerDependencyInternalCommands(context, outputChannel);
	registerTelemetry(context, outputChannel);

	// web only: readies the brotli WASM decompressor and the bundled sigdb's virtual-fs copy before any sigdb read
	await initSigDbForWeb();
	// make flowR's bundled signature database discoverable before the first analysis runs
	configureSigDb();
	updateFlowrConfig();
	// pre-download base R signatures on first activation for better UX
	void predownloadBaseRSignatures();
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			invalidateSigDbPackageNamesCache();
			configureSigDb();
			updateFlowrConfig();
		}
	});

	registerCommand(context, 'vscode-flowr.session.internal', async() => {
		await establishInternalSession();
		return flowrSession;
	});
	registerCommand(context, 'vscode-flowr.session.connect', async() => {
		await establishServerSession();
		return flowrSession;
	});
	registerCommand(context, 'vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession();
		}
	});
	registerCommand(context, 'vscode-flowr.repl', async() => {
		try {
			showRepl(context, await getFlowrSession());
		} catch(e){
			vscode.window.showErrorMessage('Failed to start flowR REPL');
			console.error(e);
		}
	});
	registerCommand(context, 'vscode-flowr.settings.open', async() => {
		await vscode.commands.executeCommand('workbench.action.openSettings', Settings.Category);
	});

	registerCommand(context, 'vscode-flowr.feedback', () => {
		void vscode.window.showQuickPick(['Report a Bug', 'Provide Feedback'], { placeHolder: 'Report a bug or provide Feedback' }).then((result: string | undefined) => {
			if(result === 'Report a Bug') {
				const body = encodeURIComponent(`
<!-- Please describe your issue, suggestion or feature request in more detail below! -->



<!-- Automatically generated issue metadata, please do not edit or delete content below this line -->
---
flowR version: ${flowrPackageVersion}  
Extension version: ${(extensionContext.extension.packageJSON as { version: string }).version} (${vscode.ExtensionMode[extensionContext.extensionMode]} mode)  
VS Code version: ${vscode.version} (web ${isWeb()})  
Session: ${flowrSession ? `${flowrSession instanceof FlowrServerSession ? 'server' : 'internal'} (${flowrSession instanceof FlowrServerSession ? flowrSession.state : (flowrSession as FlowrInternalSession)?.state})` : 'none'}  
OS: ${process.platform}  
Extension config:  
\`\`\`json
${JSON.stringify(getConfig(), null, 2)}
\`\`\`
				`.trim());
				const url = `https://github.com/flowr-analysis/vscode-flowr/issues/new?body=${body}`;
				void vscode.env.openExternal(vscode.Uri.parse(url));
			} else if(result === 'Provide Feedback') {
				const url = 'https://docs.google.com/forms/d/e/1FAIpQLScKFhgnh9LGVU7QzqLvFwZe1oiv_5jNhkIO-G-zND0ppqsMxQ/viewform?pli=1';
				vscode.env.openExternal(vscode.Uri.parse(url));
			}
		});
	});

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'workbench.view.extension.flowr';
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	context.subscriptions.push(new vscode.Disposable(() => destroySession()),
		...registerHoverOverValues(outputChannel),
		...registerPackageInfo(outputChannel),
		registerCompletion());

	// register the contributed tree views synchronously, not behind a timer: they are declared in package.json, so a
	// window restore focuses whichever was open before a deferred registration runs, and VS Code throws "No view is
	// registered". These calls are cheap; the heavy analysis stays lazy in each provider's getChildren()/update().
	const { dispose: disposeDep, update: updateDependencyView } = registerDependencyView(outputChannel);
	registerCommand(context, 'vscode-flowr.dependencyView.update', async() => {
		return await updateDependencyView();
	});
	context.subscriptions.push(new vscode.Disposable(() => disposeDep()));

	const { dispose: disposeProject } = registerProjectView(outputChannel);
	const { dispose: disposeSigDb } = registerSigDbView(context, outputChannel);
	const { dispose: disposeSigDbNotif } = registerSigDbNotifications(context, outputChannel);
	context.subscriptions.push(
		new vscode.Disposable(() => disposeProject()),
		new vscode.Disposable(() => disposeSigDb()),
		new vscode.Disposable(() => disposeSigDbNotif())
	);
	if(typeof process !== 'undefined' && typeof process.on === 'function') {
		process.on('SIGINT', () => destroySession());
	}

	if(getConfig().get<boolean>(Settings.ServerAutoConnect)) {
		await establishServerSession();
	}

	// initialize the api :)
	return {
		flowrConfig: () => VSCodeFlowrConfiguration
	};
}

/**
 *
 */
export async function establishInternalSession() {
	destroySession();
	flowrSession = new FlowrInternalSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}
/**
 *
 */
export async function getFlowrSession() {
	if(flowrSession) {
		return flowrSession;
	}
	// initialize a default session if none is active, coalescing concurrent callers onto a single init
	sessionInitPromise ??= establishInternalSession().finally(() => {
		sessionInitPromise = undefined;
	});
	return await sessionInitPromise;
}

/**
 *
 */
export async function establishServerSession() {
	destroySession();
	flowrSession = new FlowrServerSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}

/**
 *
 */
export function destroySession() {
	flowrSession?.destroy();
	flowrSession = undefined;
}

/**
 *
 */
export function updateStatusBar() {
	// telemetry/recording may sync from settings before the status bar exists; activate() refreshes it right after creation
	if(!statusBarItem) {
		return;
	}
	const text: string[] = [];
	const tooltip: string[] = [];

	if(flowrSession instanceof FlowrServerSession) {
		const connected = flowrSession.state === 'connected';
		text.push(`$(cloud) flowR ${flowrSession.state}${connected && flowrSession.rVersion ? ` (R ${flowrSession.rVersion})` : ''}`);
		if(connected) {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrSession.flowrVersion}`);
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing');
		}
	} else if(flowrSession instanceof FlowrInternalSession) {
		const active = flowrSession.state === 'active';
		text.push(`$(console) flowR ${flowrSession.state}${active && flowrSession.rVersion ? ` (R ${flowrSession.rVersion})` : ''}`);
		if(active) {
			let info = `R version ${flowrSession.rVersion}  \nflowR version ${flowrPackageVersion}  \nEngine ${flowrSession.parser?.name}`;
			if(flowrSession.parser instanceof TreeSitterExecutor) {
				info += ` version ${flowrSession.parser.treeSitterVersion()}`;
			}
			info += `  \n${sigDbSummary()}`;
			tooltip.push(info);
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing');
		}
	}

	const slicingTypes: string[] = [];
	const slicingFiles: string[] = [];
	if(selectionSlicer?.changeListeners.length) {
		slicingTypes.push('cursor');
	}
	if(positionSlicers.size) {
		const pos = [...positionSlicers].reduce((i, [,s]) => i + s.positions.length, 0);
		if(pos > 0) {
			slicingTypes.push(`${pos} position${pos === 1 ? '' : 's'}`);
			for(const [doc, slicer] of positionSlicers) {
				slicingFiles.push(`${vscode.workspace.asRelativePath(doc.fileName)} (${slicer.positions.length} position${slicer.positions.length === 1 ? '' : 's'})`);
			}
		}
	}

	if(slicingTypes.length) {
		text.push(`$(lightbulb) Slicing ${slicingTypes.join(', ')}`);
		if(slicingFiles.length) {
			tooltip.push(`Slicing in\n${slicingFiles.map(f => `- ${f}`).join('\n')}`);
		}
	}

	if(telemetry instanceof RecordingTelemetry){
		text.push('$(record) Recording');
		tooltip.push(`Recording this session to ${telemetry.filePath}`);
	} else if(!(telemetry instanceof NoTelemetry)){
		text.push('$(record) Telemetry active');
	}

	if(text.length) {
		statusBarItem.show();
		statusBarItem.text = text.join(' ');
		statusBarItem.tooltip = tooltip.length ? tooltip.reduce((m, s) => m.appendMarkdown('\n\n').appendMarkdown(s), new vscode.MarkdownString()) : undefined;
	} else {
		statusBarItem.hide();
	}
}

/** whether running in VS Code Web; uiKind alone still reports desktop inside Desktop's fake-browser mode, see https://code.visualstudio.com/updates/v1_101#_web-environment-detection */
export function isWeb() {
	return !(typeof process === 'object' && process.versions.node);
}

/**
 *
 */
export function getWasmRootPath(): string {
	if(!isWeb()) {
		return __dirname;
	} else {
		const uri = vscode.Uri.joinPath(extensionContext.extensionUri, '/dist/web');
		// in the fake browser version of vscode, it needs to be a special scheme, so we do this check
		return uri.scheme !== 'file' ? uri.toString() : `vscode-file://vscode-app/${uri.fsPath}`;
	}
}


/**
 *
 */
// we're just passing through vscode's command args syntax here :)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommand(context: vscode.ExtensionContext, command: string, callback: (...args: any[]) => any, thisArg?: any): void {
	context.subscriptions.push(vscode.commands.registerCommand(command, a => {
		telemetry.event(TelemetryEvent.UsedCommand, { command, args: a });
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return callback(a);
	}, thisArg));
}

/** virtual-fs path key for the bundled sigdb on web - not a real URL, so path.join stays safe */
const WebBundledSigDbVirtualPath = '/virtual/bundled-sigdb';

/** path to the bundled signature database (virtual fs path on web, real path on desktop) */
export function getBundledSigDbPath(): string | undefined {
	if(isWeb()) {
		// the virtual fs has no directory concept - existsSync only ever matches an exact file key
		return fs.existsSync(`${WebBundledSigDbVirtualPath}/sigdb.remote.json`) ? WebBundledSigDbVirtualPath : undefined;
	}
	return path.join(getWasmRootPath(), 'sigdb');
}

/** copies the bundled dist/web/sigdb/* files into the virtual fs so the sync sigdb reader can open them */
async function hydrateBundledSigDbForWeb(): Promise<void> {
	if(!isWeb()) {
		return;
	}
	try {
		const sourceDir = vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'web', 'sigdb');
		const entries = await vscode.workspace.fs.readDirectory(sourceDir);
		await Promise.all(entries.map(async([name, type]) => {
			if(type !== vscode.FileType.File) {
				return;
			}
			const virtualPath = `${WebBundledSigDbVirtualPath}/${name}`;
			if(fs.existsSync(virtualPath)) {
				return;
			}
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(sourceDir, name));
			fs.writeFileSync(virtualPath, Buffer.from(bytes));
		}));
	} catch(e) {
		outputChannel?.appendLine(`[flowR] could not load the bundled signature database in the web build: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** web-only: readies WASM brotli, restores the virtual fs from IndexedDB, hydrates the bundled sigdb */
async function initSigDbForWeb(): Promise<void> {
	if(!isWeb()) {
		return;
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const zlibShim = require('zlib') as { initBrotliSync: (bytes: Uint8Array) => void };
	const wasmUri = vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'web', 'wasm', 'brotli_dec_wasm_bg.wasm');
	zlibShim.initBrotliSync(await vscode.workspace.fs.readFile(wasmUri));
	const virtualFs = (fs as unknown as { __vscodeFlowrVirtualFs?: { restoreFromIndexedDb: () => Promise<void> } }).__vscodeFlowrVirtualFs;
	await virtualFs?.restoreFromIndexedDb();
	await hydrateBundledSigDbForWeb();
}

/** with auto-sync on, downloads the current-R-version Base R shard on first activation so base symbol resolution works out of the box */
export async function predownloadBaseRSignatures(): Promise<void> {
	if(typeof process === 'undefined' || !process.env) {
		return;
	}
	if(!isSigDbEnabled() || !shouldSigDbAutoSync() || getDownloadedShardGroups('base').has('current')) {
		return;
	}
	// base signatures may already ship inside the bundle (the web build always does; browsers can't download GitHub assets anyway)
	if(getSigDbScopeState('base').manifest) {
		return;
	}
	outputChannel?.appendLine('[flowR] SigDB auto-sync enabled - downloading Base R signatures in the background');
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Downloading Base R signatures' }, () =>
			downloadSigDbScope('base', msg => outputChannel?.appendLine(`[flowR] ${msg}`), undefined, ['base-current']));
		refreshSigDbConfig();
	} catch(e) {
		outputChannel?.appendLine(`[flowR] Base R signature pre-download failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** re-reads sigdb settings/on-disk state and destroys the active session, so the next feature call mounts what is now on disk */
export function refreshSigDbConfig() {
	configureSigDb();
	updateFlowrConfig();
	destroySession();
}

function configureSigDb() {
	if(typeof process === 'undefined' || !process.env) {
		return;
	}
	const config = getConfig();
	if(!config.get<boolean>(Settings.SigDbEnabled, true)) {
		process.env.FLOWR_DISABLE_DEFAULT_SIGDB = 'true';
		delete process.env.FLOWR_SIGDB;
		outputChannel?.appendLine('[flowR] Signature database disabled via configuration');
		return;
	}
	delete process.env.FLOWR_DISABLE_DEFAULT_SIGDB;
	const sources = sigDbAdditionalSources(config);
	if(sources.length > 0) {
		process.env.FLOWR_SIGDB = sources.join(path.delimiter);
		outputChannel?.appendLine(`[flowR] Using signature database source(s): ${sources.join(', ')}`);
	}
}

/** every sigdb source beyond the bundled default (see {@link getSigDbMountPaths}) plus the user's customPath, shared by both env-var and FlowrConfig wiring */
function sigDbAdditionalSources(config = getConfig()): string[] {
	const sources = getSigDbMountPaths();
	const custom = config.get<string>(Settings.SigDbCustomPath, '')?.trim();
	if(custom) {
		sources.push(custom);
	}
	return sources;
}

// undefined until extension initialization loads it, so we never access the default flowR config by accident
export let VSCodeFlowrConfiguration: FlowrConfig = undefined as unknown as FlowrConfig;

/** reads the sigdb settings into the shape flowR expects under `solver.sigdb`, so autoSync/eagerlyLoad actually reach the real FlowrConfig */
function sigDbConfigFromSettings(config = getConfig()): {
	sigdb?: { enabled: boolean, autoSync: boolean, eagerlyLoad: boolean, additionalPaths: string[], assumedRVersion?: string }
} {
	const solverDefaults = FlowrConfig.default().solver as object | undefined;
	if(!solverDefaults || !('sigdb' in solverDefaults)) {
		return {};
	}
	return {
		sigdb: {
			enabled:         config.get<boolean>(Settings.SigDbEnabled, true),
			autoSync:        config.get<boolean>(Settings.SigDbAutoSync, false),
			eagerlyLoad:     config.get<boolean>(Settings.SigDbEagerlyLoad, false),
			additionalPaths: sigDbAdditionalSources(config),
			...(projectDeclaredRVersion ? { assumedRVersion: projectDeclaredRVersion } : {})
		}
	};
}

let projectDeclaredRVersion: string | undefined;

/** pins flowR's assumed R version to what the project declares, instead of flowR's auto-detection/default; only an actual change rebuilds the session */
export function setProjectDeclaredRVersion(version: string | undefined): void {
	if(version === projectDeclaredRVersion) {
		return;
	}
	projectDeclaredRVersion = version;
	outputChannel?.appendLine(version
		? `[flowR] Using the project's declared R version ${version} as the assumed R version`
		: '[flowR] No project-declared R version - falling back to flowR\'s assumed R version detection');
	refreshSigDbConfig();
}

function updateFlowrConfig() {
	const config = getConfig();
	const wasmRoot = getWasmRootPath();
	// we don't want to *amend* here since updates to our extension config shouldn't add additional entries while keeping old ones (definitions etc.)
	VSCodeFlowrConfiguration = deepMergeObject<FlowrConfig>(FlowrConfig.default(), {
		ignoreSourceCalls: config.get<boolean>(Settings.IgnoreSourceCalls, false),
		solver:            {
			variables:     config.get<VariableResolve>(Settings.SolverVariableHandling, VariableResolve.Alias),
			resolveSource: {
				ignoreCapitalization:  config.get<boolean>(Settings.SolverSourceIgnoreCapitalization, true),
				inferWorkingDirectory: config.get<InferWorkingDirectory>(Settings.SolverSourceInferWorkingDirectory, InferWorkingDirectory.ActiveScript),
				searchPath:            config.get<string[]>(Settings.SolverSourceSearchPath, []),
				dropPaths:             config.get<DropPathsOption>(Settings.SolverSourceDropPaths, DropPathsOption.No)
			},
			...sigDbConfigFromSettings(config)
		},
		semantics: {
			environment: {
				overwriteBuiltIns: {
					loadDefaults: config.get<boolean>(Settings.BuiltInsLoadDefaults, true),
					definitions:  config.get<BuiltInDefinitions>(Settings.BuiltInsDefinitions, [])
				}
			}
		},
		defaultEngine: FlowrInternalSession.getEngineToUse(),
		engines:       [{
			type:               FlowrInternalSession.getEngineToUse(),
			wasmPath:           `${wasmRoot}/tree-sitter-r.wasm`,
			treeSitterWasmPath: `${wasmRoot}/tree-sitter.wasm`,
			lax:                config.get<boolean>(Settings.TreeSitterLax, true)
		}]
	} as Partial<FlowrConfig>);
}
