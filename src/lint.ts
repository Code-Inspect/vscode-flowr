import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import type { LintingRuleConfig, LintingRuleMetadata, LintingRuleNames, LintingRuleResult } from '@eagleoutice/flowr/linter/linter-rules';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { getConfig, isVerbose, LinterRefresherConfigKeys, Settings } from './settings';
import type { ConfiguredLintingRule, LintingResult, LintQuickFix } from '@eagleoutice/flowr/linter/linter-format';
import { ConfigurableRefresher } from './configurable-refresher';
import type { LinterQueryResult } from '@eagleoutice/flowr/queries/catalog/linter-query/linter-query-format';
import { rangeToVscodeRange } from './flowr/utils';
import { flowrScheme } from './doc-provider';
import { SourceLocation } from '@eagleoutice/flowr/util/range';

/**
 *
 */
export function registerLintCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const linter = new LinterService(context, output);
	registerCommand(context, 'vscode-flowr.lint.run', async() => {
		await linter.updateDiagnostics();
	});
}

/** rules that only make sense for a whole R package; dropped for standalone scripts (see {@link isInRPackage}) */
const packageOnlyRules = new Set<LintingRuleNames>(['software-has-license', 'software-has-tests']);

/** whether a file exists at the given URI (never throws) */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch{
		return false;
	}
}

/** whether a document lives in an R package: walks up (bounded by the workspace) for a `DESCRIPTION` file */
export async function isInRPackage(document: Pick<vscode.TextDocument, 'uri'>): Promise<boolean> {
	if(document.uri.scheme !== 'file') {
		return false;
	}
	const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
	let dir = vscode.Uri.joinPath(document.uri, '..');
	for(let i = 0; i < 20; i++) {
		if(await fileExists(vscode.Uri.joinPath(dir, 'DESCRIPTION'))) {
			return true;
		}
		const parent = vscode.Uri.joinPath(dir, '..');
		if(dir.fsPath === root || parent.fsPath === dir.fsPath) {
			break; // reached the workspace or filesystem root
		}
		dir = parent;
	}
	return false;
}

/**
 * flowR reports a {@link SourceLocation} for every finding, and that location carries an optional file name.
 * For code that `source()`s other scripts, flowR (correctly) analyzes those scripts too and reports findings
 * located in them. We must not surface those in the sourcing document's editor, so we keep only findings that
 * belong to the given document (or that have no file attribution, which means the primary in-buffer document).
 */
export function isLocInDocument(loc: SourceLocation, document: Pick<vscode.TextDocument, 'fileName' | 'uri'>): boolean {
	const file = SourceLocation.getFile(loc);
	if(file === undefined || file === '@inline') {
		// no file attribution (or the inline-buffer marker) => the primary document being analyzed
		return true;
	}
	const normalize = (p: string) => p.replace(/^file:\/\//, '').replace(/\\/g, '/');
	const target = normalize(file);
	return target === normalize(document.fileName) || target === normalize(document.uri.fsPath);
}

/** drops the finding's absolute file path from its message: {@link SourceLocation.format} prefixes the location with it, but the diagnostic already points at the file in the editor and Problems panel */
export function stripFilePath(message: string, loc: SourceLocation): string {
	const file = SourceLocation.getFile(loc);
	return file ? message.split(`${file}:`).join('') : message;
}

class CodeAction extends vscode.CodeAction {

	public readonly document:   vscode.TextDocument;
	public readonly quickFixes: LintQuickFix[];

	constructor(document: vscode.TextDocument, quickFixes: LintQuickFix[]) {
		super([...new Set<string>(quickFixes.map(q => q.description))].join(', '), vscode.CodeActionKind.QuickFix);
		this.document = document;
		this.quickFixes = quickFixes;
	}
}

class LinterService implements vscode.CodeActionProvider<CodeAction> {
	private readonly output: vscode.OutputChannel;
	private readonly diagnosticCollection = vscode.languages.createDiagnosticCollection('flowr-lint');
	private readonly codeActions = vscode.languages.registerCodeActionsProvider({ language: 'r' }, this, {
		providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
	});
	private readonly refresher:      ConfigurableRefresher;
	/** cached lint results keyed by `uri@version` so an edit invalidates the entry (avoids stale quick-fixes) */
	private readonly resultsPerFile: Map<string, LinterQueryResult> = new Map<string, LinterQueryResult>();
	private static readonly maxResultCacheEntries = 32;

	constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		this.output = output;
		this.refresher = new ConfigurableRefresher({
			name:            'Lint',
			keys:            LinterRefresherConfigKeys,
			refreshCallback: async() => {
				await this.updateDiagnostics();
			},
			output: output
		});
		context.subscriptions.push(this.diagnosticCollection, this.codeActions, this.refresher);
	}

	async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, _context: vscode.CodeActionContext, _token: vscode.CancellationToken): Promise<(CodeAction | vscode.Command)[]> {
		const ret: CodeAction[] = [];
		const results = await this.lintFile(document);
		for(const findings of Object.values(results?.results ?? {})) {
			if('error' in findings) {
				continue;
			}
			for(const finding of findings.results) {
				if(!('loc' in finding)) {
					continue;
				}
				// do not offer quick fixes for findings that belong to sourced/other files
				if(!isLocInDocument(finding.loc, document)) {
					continue;
				}
				const quickFixes = (finding as LintingResult).quickFix;
				if(!quickFixes?.length){
					continue;
				}
				// only add quick fixes if we overlap the relevant range or selection
				if([...quickFixes.map(q => q.loc), finding.loc].some(l => rangeToVscodeRange(SourceLocation.getRange(l)).intersection(range))) {
					ret.push(new CodeAction(document, quickFixes));
				}
			}
		}
		return ret;
	}

	resolveCodeAction(codeAction: CodeAction, _token: vscode.CancellationToken): vscode.ProviderResult<CodeAction> {
		codeAction.edit = new vscode.WorkspaceEdit();
		for(const fix of codeAction.quickFixes.sort((f1, f2) => SourceLocation.compare(f2.loc, f1.loc))) {
			const range = rangeToVscodeRange(SourceLocation.getRange(fix.loc));
			switch(fix.type) {
				case 'replace':
					codeAction.edit.replace(codeAction.document.uri, range, fix.replacement);
					break;
				case 'remove':
					codeAction.edit.delete(codeAction.document.uri, range);
					break;
				default:
					vscode.window.showWarningMessage(`The quick fix type ${(fix as LintQuickFix).type} is not yet supported by this extension`);
			}
		}
		return codeAction;
	}

	async lintFile(document: vscode.TextDocument, forceRefresh: boolean = false): Promise<LinterQueryResult | undefined> {
		// skip documents generated by flowR for linting (like the slice reconstruction)
		if(document.uri.scheme === flowrScheme) {
			this.output.appendLine(`[Lint] Not analyzing flowR-generated document ${document.fileName}`);
			return;
		}

		const cacheKey = `${document.uri.toString()}@${document.version}`;
		if(!forceRefresh) {
			const results = this.resultsPerFile.get(cacheKey);
			if(results !== undefined) {
				if(isVerbose()) {
					this.output.appendLine(`[Lint] Using cached results for document ${document.fileName}`);
				}
				return results;
			}
		}

		const session = await getFlowrSession();

		// rules are only enabled if they're contained in the enabledRules config
		let rules: (LintingRuleNames | ConfiguredLintingRule)[] = getConfig().get<LintingRuleNames[]>(Settings.LinterEnabledRules, []);
		// empty array means all rules should be enabled (we do it like this so we can apply configs)
		if(rules.length <= 0) {
			rules = Object.keys(LintingRules) as LintingRuleNames[];
		}
		// drop rule names that flowR doesn't know about (e.g. stale/renamed rules like the old `problematic-eval`),
		// so a single outdated entry doesn't break the whole linter query
		const unknownRules = rules.filter(r => !(((typeof r === 'string' ? r : r.name)) in LintingRules));
		if(unknownRules.length > 0) {
			this.output.appendLine(`[Lint] Ignoring unknown linting rule(s): ${unknownRules.map(r => typeof r === 'string' ? r : r.name).join(', ')}`);
			rules = rules.filter(r => ((typeof r === 'string' ? r : r.name)) in LintingRules);
		}
		// license/tests rules only make sense inside an R package
		if(!(await isInRPackage(document))) {
			rules = rules.filter(r => !packageOnlyRules.has(typeof r === 'string' ? r : r.name));
		}
		// now we apply the ruleConfigs to all enabled rules
		for(const [ruleName, config] of Object.entries(getConfig().get<{ [N in LintingRuleNames]?: LintingRuleConfig<N> }>(Settings.LinterRuleConfigs, {}))) {
			const index = rules.indexOf(ruleName as LintingRuleNames);
			if(index >= 0) {
				rules[index] = {
					name:   ruleName as LintingRuleNames,
					config: config as LintingRuleConfig<LintingRuleNames>
				};
			}
		}
		if(isVerbose()) {
			this.output.appendLine(`[Lint] Analyzing ${document.fileName} with rules: ${rules.map(r => typeof r === 'string' ? r : r.name).join(', ')}`);
		}

		let lint;
		try {
			lint = await session.retrieveQuery(document, [{
				type:  'linter',
				rules: rules
			}]);
		} catch(e) {
			this.output.appendLine(`[Lint] Error while analyzing ${document.fileName}: ${(e as Error).message}`);
			this.output.appendLine((e as Error).stack ?? '');
			return undefined;
		}
		// bound the cache (one entry per file+version otherwise grows without limit)
		if(this.resultsPerFile.size >= LinterService.maxResultCacheEntries) {
			const oldest = this.resultsPerFile.keys().next().value;
			if(oldest !== undefined) {
				this.resultsPerFile.delete(oldest);
			}
		}
		this.resultsPerFile.set(cacheKey, lint.result.linter);

		return lint.result.linter;
	}

	async updateDiagnostics(): Promise<void> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return;
		}

		const results = await this.lintFile(activeEditor.document, true);
		const diagnostics: vscode.Diagnostic[] = [];
		const perRuleCounts: string[] = [];
		for(const [ruleName, findings] of Object.entries(results?.results ?? {})) {
			if('error' in findings) {
				continue;
			}
			const rule = LintingRules[ruleName as LintingRuleNames];

			if(findings.results.length > 0) {
				perRuleCounts.push(`${ruleName}: ${findings.results.length}`);
			}
			if(isVerbose()) {
				this.output.appendLine(`[Lint] ${ruleName} findings: ${JSON.stringify(findings)}`);
			}

			for(const finding of findings.results) {
				if(!('loc' in finding)) {
					continue;
				}
				// do not show findings that belong to sourced/other files in this document
				if(!isLocInDocument(finding.loc, activeEditor.document)) {
					continue;
				}
				const range = rangeToVscodeRange(SourceLocation.getRange(finding.loc));
				const pageName = ruleName.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
				const pageUrl = `https://github.com/flowr-analysis/flowr/wiki/[Linting Rule] ${pageName}`;
				const message = (rule.prettyPrint['full'] as (result: LintingRuleResult<LintingRuleNames>, metadata: LintingRuleMetadata<LintingRuleNames>) => string)(
					finding as LintingRuleResult<LintingRuleNames>,
					finding as LintingRuleMetadata<LintingRuleNames>
				);
				const diag = new vscode.Diagnostic(
					range,
					`${ruleName}: ${stripFilePath(message, finding.loc)}`,
					vscode.DiagnosticSeverity.Warning
				);
				diag.source = this.diagnosticCollection.name;
				diag.code = {
					value:  ruleName,
					target: vscode.Uri.parse(encodeURI(pageUrl))
				};
				diagnostics.push(diag);
			}
		}
		this.diagnosticCollection.set(activeEditor.document.uri, diagnostics);
		// one compact line per run instead of a JSON dump per rule
		this.output.appendLine(`[Lint] ${diagnostics.length} finding${diagnostics.length === 1 ? '' : 's'} in ${activeEditor.document.fileName}${perRuleCounts.length > 0 ? ` (${perRuleCounts.join(', ')})` : ''}`);
	}
}
