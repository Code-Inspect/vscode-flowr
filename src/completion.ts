import * as vscode from 'vscode';
import { allKnownPackageNames, defaultLoadedPackages, findSigDbPackageSource, resolveSigDbPackageVersion, safeFunctionsOf, safeLatestVersionStr, safeSigDbCall } from './package-db';
import { getInstalledPackageVersions, getInstalledVersion } from './installed-packages';
import { getConfig, Settings } from './settings';
import type { PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';
import type { DecodedFunction } from '@eagleoutice/flowr/project/sigdb/decode';
import { LibraryFunctions } from '@eagleoutice/flowr/queries/catalog/dependencies-query/function-info/library-functions';
import type { FunctionInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/function-info/function-info';
import { findByPrefixIfUnique } from '@eagleoutice/flowr/util/prefix';

function completionEnabled(): boolean {
	return getConfig().get<boolean>(Settings.CompletionEnabled, true);
}

/** matches `library(pkg)` / `require(pkg)`, quoted or bare */
const LibraryCallPattern = /\b(?:library|require)\s*\(\s*['"]?([A-Za-z][A-Za-z0-9._]*)/g;

/** every package named in a `library(pkg)`/`require(pkg)` call (quoted or bare) found in `text` */
export function loadedPackagesIn(text: string): Set<string> {
	const packages = new Set<string>();
	for(const match of text.matchAll(LibraryCallPattern)) {
		packages.add(match[1]);
	}
	return packages;
}

/** the document's text up to (not including) `position` - so completion only ever sees `library()` calls the cursor has actually reached, not ones later in the file */
function textBeforePosition(document: vscode.TextDocument, position: vscode.Position): string {
	return document.getText(new vscode.Range(new vscode.Position(0, 0), position));
}

const RawStringPrefix = /^[rR]['"](-*)([([{])/;
const CloseBracketFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * If an R raw string opens at position `i` (e.g. r"( ... )", R'--[ ... ]--'), the index just past its close, or
 * `-1` if it never closes (runs to the end of `text`); `undefined` if no raw string opens there. Raw strings
 * take no backslash escapes; the delimiter is a quote, then dashes, then a bracket, closed by that run mirrored.
 */
function rawStringEnd(text: string, i: number): number | undefined {
	const m = RawStringPrefix.exec(text.slice(i));
	if(!m) {
		return undefined;
	}
	const quote = text[i + 1];
	const [, dashes, open] = m;
	const closer = `${CloseBracketFor[open]}${dashes}${quote}`;
	const at = text.indexOf(closer, i + m[0].length);
	return at === -1 ? -1 : at + closer.length;
}

/** the index just past the close of the plain `"`/`'` string opening at `text[i]`, or `-1` if it never closes */
function quotedStringEnd(text: string, i: number): number {
	const quote = text[i];
	for(let j = i + 1; j < text.length; j++) {
		if(text[j] === '\\') {
			j++; // raw content of an escape - skip the escaped char
		} else if(text[j] === quote) {
			return j + 1;
		}
	}
	return -1;
}

/** whether `text[i-1]` is part of an R name, so an `r`/`R` at `i` belongs to that name rather than opening a raw string */
function precededByNameChar(text: string, i: number): boolean {
	return i > 0 && /[A-Za-z0-9._]/.test(text[i - 1]);
}

/**
 * Whether `text` ends inside an unterminated string literal. Handles `"`/`'` strings (with `\` escapes), R raw
 * strings (`r"(...)"`, which take no escapes), and `#` line comments (a quote in a comment opens nothing). R
 * strings may span lines, so the whole text-before-cursor is scanned, not just the current line.
 */
export function endsInsideString(text: string): boolean {
	let i = 0;
	while(i < text.length) {
		const c = text[i];
		if(c === '#') {
			const nl = text.indexOf('\n', i);
			if(nl === -1) {
				return false; // a line comment runs to the cursor - not a string
			}
			i = nl + 1;
		} else if((c === 'r' || c === 'R') && !precededByNameChar(text, i)) {
			const end = rawStringEnd(text, i);
			if(end === undefined) {
				i++; // a plain `r`/`R` name, not a raw-string prefix
			} else if(end === -1) {
				return true; // unterminated raw string runs to the cursor
			} else {
				i = end;
			}
		} else if(c === '"' || c === '\'') {
			const end = quotedStringEnd(text, i);
			if(end === -1) {
				return true;
			}
			i = end;
		} else {
			i++;
		}
	}
	return false;
}

/**
 * The range of the identifier (an R name, which may contain `.`) ending at `position`. VS Code has no built-in
 * notion of R's word boundaries - its default word pattern doesn't include `.` - so without an explicit range,
 * it tracks "what's been typed so far" itself and resets to empty right after a `.`, showing every completion
 * unfiltered instead of narrowing to what was actually typed (e.g. `print.` would suggest `abbreviate`,
 * `abline`, ... alongside `print.data.frame`). Passing this range on every item makes VS Code filter/replace
 * against the real typed text instead.
 */
function identifierRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
	const match = /[A-Za-z0-9._]*$/.exec(textBeforePosition(document, position));
	return new vscode.Range(position.translate(0, -(match?.[0].length ?? 0)), position);
}

/** sort rank: plain names first, S3-method-shaped names next, operator/subscript names last */
function completionRank(name: string): '0' | '1' | '2' {
	if(!/^[A-Za-z.]/.test(name)) {
		return '2';
	}
	if(name.includes('.')) {
		return '1';
	}
	return '0';
}

/** finds a function within any of the given (already `library()`-loaded) packages */
async function findFunctionInLoadedPackages(fnName: string, packages: Iterable<string>): Promise<{ pkg: string, source: PackageSignatureSource, version?: string } | undefined> {
	for(const pkg of packages) {
		const found = await findSigDbPackageSource(pkg);
		if(!found) {
			continue;
		}
		const version = safeLatestVersionStr(found.source, pkg);
		if(safeSigDbCall(() => found.source.functionByName(pkg, fnName, version))) {
			return { pkg, source: found.source, version };
		}
	}
	return undefined;
}

/** packages whose functions are completable without any `library()`/`require()`, user-configurable via {@link Settings.CompletionAlwaysAvailablePackages} */
function alwaysAvailablePackages(): string[] {
	return getConfig().get<string[]>(Settings.CompletionAlwaysAvailablePackages, ['base', ...defaultLoadedPackages]);
}

/** whether dotted names (e.g. `print.data.frame`) should be offered before the user has typed the dot themselves - off by default, since most dotted names are S3 methods better reached by typing their generic (`print`) first */
function showS3Methods(): boolean {
	return getConfig().get<boolean>(Settings.CompletionShowS3Methods, false);
}

/**
 * Whether `fn` should be excluded from function-name completion because it's a dotted name (`print.data.frame`,
 * `print.acf`, ...) the user hasn't asked for yet. Not every such name is a registered S3 method in the
 * signature database - flowR's `s3-method` prop is populated inconsistently across packages (e.g. base's
 * `print.data.frame` carries it, stats' `print.acf` doesn't) - so name shape plus what the user actually typed
 * is the only reliable signal: once they've typed the dot themselves (`typedHasDot`), or {@link showS3Methods}
 * is on, a dotted name is exactly as intentional as any other completion.
 */
function isHiddenDottedName(fn: DecodedFunction, typedHasDot: boolean): boolean {
	return fn.name.includes('.') && !typedHasDot && !showS3Methods();
}

/** matches a `pkg::partial` / `pkg:::partial` at the very end of the text before the cursor (`partial` may be empty) */
const NamespacedCallPattern = /\b([A-Za-z][A-Za-z0-9.]*):(:{1,2})([A-Za-z0-9._]*)$/;

/** a function-name completion item, shared by loaded/always-available and `pkg::`-namespaced completions */
function functionCompletionItem(fn: DecodedFunction, pkg: string, version: string | undefined, range: vscode.Range): vscode.CompletionItem {
	const params = fn.signature.map(p => p.name).join(', ');
	const item = new vscode.CompletionItem(
		{ label: fn.name, detail: `(${params})`, description: pkg },
		vscode.CompletionItemKind.Function
	);
	item.documentation = new vscode.MarkdownString(`\`\`\`r\n${fn.name}(${params})\n\`\`\`\n\nfrom \`${pkg}\`${version ? ` v${version}` : ''}\n\n*via flowR's signature database*`);
	item.insertText = new vscode.SnippetString(`${fn.name}($0)`);
	item.sortText = `${completionRank(fn.name)}${fn.name}`;
	item.range = range;
	// snippet-inserting the `(` doesn't fire its trigger character, so reopen suggestions for the argument names
	item.command = { title: 'Suggest arguments', command: 'editor.action.triggerSuggest' };
	return item;
}

/** the R extension, whose language server (the R `languageserver` package) also completes R code */
const RExtensionId = 'reditorsupport.r';

function rExtensionInstalled(): boolean {
	return vscode.extensions.getExtension(RExtensionId) !== undefined;
}

/**
 * Whether the R extension's language server is serving this session. Deliberately *not* based on the extension's
 * `isActive`: both extensions activate on the same R document, in an order VS Code does not guarantee, so an
 * activation-time `isActive` check answers differently from run to run. What does hold for the whole session is
 * that the extension is installed, its `r.lsp.enabled` is on, and its server - the R `languageserver` package -
 * is actually installed (without it vscode-R only offers to install it and completes nothing).
 */
async function rLanguageServerLive(): Promise<boolean> {
	if(!rExtensionInstalled() || vscode.workspace.getConfiguration('r.lsp').get<boolean>('enabled', true) === false) {
		return false;
	}
	const installed = await getInstalledPackageVersions();
	return installed === undefined || installed.has('languageserver');
}

/** how flowR's suggestions are narrowed to coexist with the R language server, see {@link Settings.CompletionWithRlanguageServer} */
export interface Coexistence {
	/** whether flowR contributes nothing at all, leaving completion entirely to the R language server */
	silent:           boolean;
	/** packages the R language server already suggests from (the locally installed ones), so flowR does not repeat them */
	coveredPackages?: ReadonlySet<string>;
}

/** flowR alone: everything the signature database knows is offered */
const Alone: Coexistence = { silent: false };

/**
 * How flowR narrows its suggestions while the R language server is live, for the configured `mode` and the
 * `installedPackages` that server can see. Not knowing what is installed (no R around) falls back to suggesting
 * everything: a duplicate suggestion is a much smaller problem than silently having none.
 */
export function coexistenceWith(mode: string, installedPackages: ReadonlySet<string> | undefined): Coexistence {
	switch(mode) {
		case 'off':
			return { silent: true };
		case 'full':
			return Alone;
		default:
			// the language server evaluates the real R session, so it covers installed packages far better than we can;
			// what it cannot see is everything *not* installed, which is most of what the signature database holds
			return installedPackages ? { silent: false, coveredPackages: installedPackages } : Alone;
	}
}

/**
 * Recomputed per request rather than latched at registration - the R extension may be installed, enabled, or
 * disabled at any point in a session, and its `r.lsp.enabled` toggled, all without a window reload.
 */
async function rLanguageServerCoexistence(): Promise<Coexistence> {
	if(!await rLanguageServerLive()) {
		return Alone;
	}
	const installed = await getInstalledPackageVersions();
	return coexistenceWith(getConfig().get<string>(Settings.CompletionWithRlanguageServer, 'complement'), installed && new Set(installed.keys()));
}

/** the packages of `packages` the R language server does not already cover */
export function notCoveredBy(packages: Iterable<string>, coexist: Coexistence | undefined): string[] {
	return [...packages].filter(pkg => !coexist?.coveredPackages?.has(pkg));
}

class FlowrSigDbCompletionProvider implements vscode.CompletionItemProvider {
	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
		if(!completionEnabled()) {
			return [];
		}
		const coexist = await rLanguageServerCoexistence();
		if(coexist.silent || token.isCancellationRequested) {
			return [];
		}
		const textBefore = textBeforePosition(document, position);

		const range = identifierRange(document, position);

		const namespaced = await this.namespacedFunctionCompletions(textBefore, range, coexist);
		if(namespaced) {
			return token.isCancellationRequested ? [] : namespaced;
		}

		const packageArgItems = await packageArgumentCompletions(textBefore, range, coexist);
		if(packageArgItems) {
			return token.isCancellationRequested ? [] : packageArgItems;
		}

		// past the package-argument path (which is meant to fire inside `library("...")`), an unterminated string
		// is plain string content - offering function/argument names there is noise
		if(endsInsideString(textBefore)) {
			return [];
		}

		const packages = new Set(notCoveredBy([...loadedPackagesIn(textBefore), ...alwaysAvailablePackages()], coexist));
		const typedHasDot = (/[A-Za-z][A-Za-z0-9._]*$/.exec(textBefore)?.[0] ?? '').includes('.');
		const [functionItems, argumentItems] = await Promise.all([
			this.functionNameCompletions(packages, typedHasDot, range),
			this.argumentNameCompletions(document, position, packages, range)
		]);
		return token.isCancellationRequested ? [] : [...argumentItems, ...functionItems];
	}

	/** completions for a `pkg::partial`/`pkg:::partial` call, from that specific package regardless of whether it is loaded, or `undefined` if the cursor isn't in one */
	private async namespacedFunctionCompletions(textBefore: string, range: vscode.Range, coexist?: Coexistence): Promise<vscode.CompletionItem[] | undefined> {
		const match = NamespacedCallPattern.exec(textBefore);
		if(!match) {
			return undefined;
		}
		const [, pkg, colons, partial] = match;
		if(coexist?.coveredPackages?.has(pkg)) {
			return [];
		}
		const found = await findSigDbPackageSource(pkg);
		if(!found) {
			return [];
		}
		const version = safeLatestVersionStr(found.source, pkg);
		const includeInternal = colons === ':::';
		const typedHasDot = partial.includes('.');
		return safeFunctionsOf(found.source, pkg, version)
			.filter(fn => (includeInternal || fn.exported) && fn.name.startsWith(partial) && !isHiddenDottedName(fn, typedHasDot))
			.map(fn => functionCompletionItem(fn, pkg, version, range));
	}

	private async functionNameCompletions(packages: Set<string>, typedHasDot: boolean, range: vscode.Range): Promise<vscode.CompletionItem[]> {
		const perPackage = await Promise.all([...packages].map(async pkg => {
			const found = await findSigDbPackageSource(pkg);
			if(!found) {
				return [];
			}
			const version = safeLatestVersionStr(found.source, pkg);
			const functions = safeFunctionsOf(found.source, pkg, version);
			return functions.filter(fn => fn.exported && !isHiddenDottedName(fn, typedHasDot)).map(fn => functionCompletionItem(fn, pkg, version, range));
		}));
		return perPackage.flat();
	}

	/** right after ( or , (not after name =), suggest the function's own remaining parameter names first */
	private async argumentNameCompletions(document: vscode.TextDocument, position: vscode.Position, packages: Set<string>, range: vscode.Range): Promise<vscode.CompletionItem[]> {
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call || call.inValuePosition) {
			return [];
		}
		const found = await findFunctionInLoadedPackages(call.fnName, packages);
		if(!found) {
			return [];
		}
		const fn = safeSigDbCall(() => found.source.functionByName(found.pkg, call.fnName, found.version));
		if(!fn) {
			return [];
		}
		// resolved against the real parameter list so a partially-typed name (`dat = ` for `data`) still excludes it
		const { filled } = resolveCallArgs(call.rawSegments, fn.signature.map(p => p.name));
		return fn.signature.filter(p => p.name !== '...' && !filled.has(p.name)).map(p => {
			const item = new vscode.CompletionItem(
				{ label: p.name, detail: p.default !== undefined ? ` = ${p.default}` : '', description: `${call.fnName} argument` },
				vscode.CompletionItemKind.Variable
			);
			item.insertText = new vscode.SnippetString(`${p.name} = $0`);
			item.documentation = new vscode.MarkdownString(`parameter of \`${call.fnName}\` from \`${found.pkg}\`\n\n*via flowR's signature database*`);
			item.sortText = `00${p.name}`; // ahead of function-name completions
			item.range = range;
			return item;
		});
	}

	/** fills in a package's version lazily, since resolving all of CRAN's versions per keystroke would be far too slow */
	async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
		if(item.kind !== vscode.CompletionItemKind.Module || typeof item.label === 'string') {
			return item;
		}
		const pkg = item.label.label.startsWith('package:') ? item.label.label.slice('package:'.length) : item.label.label;
		const [dbVersion, installed] = await Promise.all([resolveSigDbPackageVersion(pkg), getInstalledVersion(pkg)]);
		if(token.isCancellationRequested) {
			return item;
		}
		const parts = [dbVersion && `v${dbVersion}`, installed && installed !== dbVersion ? `installed v${installed}` : undefined].filter((s): s is string => !!s);
		if(parts.length > 0) {
			item.label = { ...item.label, detail: ` — ${parts.join(', ')}` };
		}
		return item;
	}
}

const NamedArgPattern = /^\s*([A-Za-z.][A-Za-z0-9._]*)\s*=(?!=)/;

/** parses argsText (between a call's `(` and the cursor) into its argument index, raw segments, and value-position state */
function parseCallArgs(argsText: string): { argIndex: number, rawSegments: string[], inValuePosition: boolean } {
	const segments: string[] = [];
	let depth = 0;
	let segStart = 0;
	for(let i = 0; i < argsText.length; i++) {
		const c = argsText[i];
		if(c === '(' || c === '[' || c === '{') {
			depth++;
		} else if(c === ')' || c === ']' || c === '}') {
			depth--;
		} else if(c === ',' && depth === 0) {
			segments.push(argsText.slice(segStart, i));
			segStart = i + 1;
		}
	}
	segments.push(argsText.slice(segStart));

	const inValuePosition = NamedArgPattern.test(segments[segments.length - 1]);
	return { argIndex: segments.length - 1, rawSegments: segments, inValuePosition };
}

/** matches the innermost open call `fnName(args, so, far` immediately before the cursor, to drive signature help */
export function callBeforeCursor(text: string): { fnName: string, argIndex: number, rawSegments: string[], inValuePosition: boolean } | undefined {
	let depth = 0;
	for(let i = text.length - 1; i >= 0; i--) {
		const c = text[i];
		if(c === ')' || c === ']' || c === '}') {
			depth++;
		} else if(c === '(') {
			if(depth === 0) {
				const before = text.slice(0, i);
				const m = /([A-Za-z.][A-Za-z0-9._]*)\s*$/.exec(before);
				return m ? { fnName: m[1], ...parseCallArgs(text.slice(i + 1)) } : undefined;
			}
			depth--;
		} else if(c === '[' || c === '{') {
			depth--;
		}
	}
	return undefined;
}

/** resolves a typed name against real parameter names via R's own pmatch rule: exact match wins, else an unambiguous prefix before `...`; undefined if unknown or ambiguous */
export function resolveArgNameAgainst(typed: string, paramNames: readonly string[]): string | undefined {
	return findByPrefixIfUnique(typed, paramNames);
}

/** resolves every argument of a call via R's three-pass matching: named args claim their formal first, then unnamed args fill remaining formals in order, stopping at `...` */
export function resolveCallArgs(rawSegments: readonly string[], paramNames: readonly string[]): { filled: Set<string>, current?: string } {
	const namedAt = rawSegments.map(seg => NamedArgPattern.exec(seg)?.[1]);
	const resolvedNamedAt = namedAt.map(name => name !== undefined ? resolveArgNameAgainst(name, paramNames) : undefined);
	const filled = new Set(resolvedNamedAt.filter((name): name is string => name !== undefined));

	let positionalIdx = 0;
	// the next formal reachable positionally; `...` is returned and never advanced past once reached
	const nextPositionalFormal = (): string | undefined => {
		while(positionalIdx < paramNames.length) {
			const name = paramNames[positionalIdx];
			if(name === '...') {
				return '...';
			}
			positionalIdx++;
			if(!filled.has(name)) {
				return name;
			}
		}
		return undefined;
	};

	let current: string | undefined;
	for(let i = 0; i < rawSegments.length; i++) {
		const isLast = i === rawSegments.length - 1;
		if(namedAt[i] !== undefined) {
			if(isLast) {
				current = resolvedNamedAt[i];
			}
			continue;
		}
		const formal = nextPositionalFormal();
		if(isLast) {
			current = formal;
		} else if(formal !== undefined && formal !== '...') {
			filled.add(formal);
		}
	}
	return { filled, current };
}

/** `detach` mirrors `attach`'s "package:<pkg>" argument but loads nothing, so flowR's {@link LibraryFunctions} omits it */
const ExtraPackageArgFunctions: FunctionInfo[] = [
	{ package: 'base', name: 'detach', argIdx: 0, argName: 'name', resolveValue: true }
];

/** every call flowR (plus {@link ExtraPackageArgFunctions}) recognizes as taking a package name argument, by function name */
const PackageArgFunctions: Map<string, FunctionInfo> = new Map(
	[...LibraryFunctions, ...ExtraPackageArgFunctions].map(info => [info.name, info])
);

/** functions whose package argument is also commonly given in `package:<pkg>` form - the name R itself puts on the search path */
const PackageColonForms = new Set(['attach', 'detach']);

/** a function's real, ordered parameter names from flowR's signature database, or `undefined` if unresolvable (package not synced/found, or the function isn't in it) */
async function sigDbParamNames(pkg: string, fnName: string): Promise<string[] | undefined> {
	const found = await findSigDbPackageSource(pkg);
	if(!found) {
		return undefined;
	}
	const fn = safeSigDbCall(() => found.source.functionByName(pkg, fnName));
	return fn?.signature.map(p => p.name);
}

/** whether the cursor sits at `info`'s package-name argument; prefers the real sigdb signature, falls back to `info.argName` alone */
async function isAtPackageArgPosition(call: { rawSegments: string[], inValuePosition: boolean }, info: FunctionInfo): Promise<boolean> {
	if(info.argIdx === 'unnamed') {
		return !call.inValuePosition;
	}
	if(info.argName === undefined) {
		return false;
	}
	const paramNames = (info.package && await sigDbParamNames(info.package, info.name)) || [info.argName];
	return resolveCallArgs(call.rawSegments, paramNames).current === info.argName;
}

function packageNameCompletionItem(label: string, insertText: string, range: vscode.Range | undefined): vscode.CompletionItem {
	const item = new vscode.CompletionItem({ label, description: 'package' }, vscode.CompletionItemKind.Module);
	item.insertText = insertText;
	item.sortText = label;
	// some real CRAN package names contain a dot (e.g. R.utils) - without an explicit range, VS Code's default
	// (dot-excluding) word pattern would reset its filter right after the dot, same as function-name completion
	if(range) {
		item.range = range;
	}
	return item;
}

/** completions for a `library(...)`/`attach(...)`/... package-name argument, or `undefined` if the cursor isn't in one */
export async function packageArgumentCompletions(textBeforeCursor: string, range?: vscode.Range, coexist?: Coexistence): Promise<vscode.CompletionItem[] | undefined> {
	const call = callBeforeCursor(textBeforeCursor);
	const info = call && PackageArgFunctions.get(call.fnName);
	if(!call || !info || !await isAtPackageArgPosition(call, info)) {
		return undefined;
	}
	const names = notCoveredBy(await allKnownPackageNames(), coexist).sort((a, b) => a.localeCompare(b));
	const items = names.map(pkg => packageNameCompletionItem(pkg, pkg, range));
	if(PackageColonForms.has(call.fnName)) {
		items.push(...names.map(pkg => packageNameCompletionItem(`package:${pkg}`, `package:${pkg}`, range)));
	}
	return items;
}

class FlowrSigDbSignatureHelpProvider implements vscode.SignatureHelpProvider {
	async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
		if(!completionEnabled()) {
			return undefined;
		}
		const coexist = await rLanguageServerCoexistence();
		if(coexist.silent) {
			return undefined;
		}
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call) {
			return undefined;
		}
		// returning `undefined` for a package the R language server covers lets its own signature help win, rather than ours shadowing it
		const found = await findFunctionInLoadedPackages(call.fnName, notCoveredBy(loadedPackagesIn(textBeforePosition(document, position)), coexist));
		if(!found || token.isCancellationRequested) {
			return undefined;
		}
		const fn = safeSigDbCall(() => found.source.functionByName(found.pkg, call.fnName, found.version));
		if(!fn) {
			return undefined;
		}

		const paramLabels = fn.signature.map(p => p.default !== undefined ? `${p.name} = ${p.default}` : p.name);
		const info = new vscode.SignatureInformation(`${fn.name}(${paramLabels.join(', ')})`);
		info.parameters = paramLabels.map(label => new vscode.ParameterInformation(label));
		info.documentation = new vscode.MarkdownString(`from \`${found.pkg}\`${found.version ? ` v${found.version}` : ''}\n\n*via flowR's signature database*`);

		// resolved against the real parameter list so a named or out-of-order argument highlights its actual target
		const paramNames = fn.signature.map(p => p.name);
		const resolved = resolveCallArgs(call.rawSegments, paramNames).current;
		const resolvedIdx = resolved !== undefined ? paramNames.indexOf(resolved) : -1;

		const help = new vscode.SignatureHelp();
		help.signatures = [info];
		help.activeSignature = 0;
		help.activeParameter = resolvedIdx >= 0 ? resolvedIdx : Math.min(call.argIndex, Math.max(paramLabels.length - 1, 0));
		return help;
	}
}

/** registers R/Rmd completion + signature help for `library()`d packages, backed by whichever sigdb scopes are downloaded */
export function registerCompletion(): vscode.Disposable {
	// warms the installed-package list (one Rscript call) so the first keystroke doesn't wait on it to decide how to
	// coexist with the R language server; only worth it if that extension is around at all
	if(rExtensionInstalled()) {
		void getInstalledPackageVersions();
	}
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	return vscode.Disposable.from(
		...selectors.map(selector => vscode.languages.registerCompletionItemProvider(selector, new FlowrSigDbCompletionProvider(), '(', ',', ' ', '"', '\'', ':')),
		...selectors.map(selector => vscode.languages.registerSignatureHelpProvider(selector, new FlowrSigDbSignatureHelpProvider(), '(', ','))
	);
}
