import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { locationSearch, rangeToVscodeRange, toDataflowNode } from './flowr/utils';
import { getOriginInDfg, OriginType } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import type { Origin } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import { FunctionCallVertex, FunctionDefinitionVertex, VariableDefinitionVertex } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { DfEdge, EdgeType } from '@eagleoutice/flowr/dataflow/graph/edge';
import { RType } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/type';
import { baseRPackages, defaultLoadedPackages, getSigDbScopeState, findSigDbPackageSource, resolveSigDbPackageVersion, rMajorVersionPageUrl, allKnownPackageNames, closestPackageNames, cranPageUrl } from './package-db';
import { getHelpDoc, getInstalledVersion } from './installed-packages';
import type { SignatureFunctionView, SignaturePackageView, SignatureQueryResult, SignatureDependencyView, SignatureParameterView } from '@eagleoutice/flowr/queries/catalog/signature-query/signature-query-format';
import {
	DefaultBuiltinConfig, GgPlotCreate, TinyPlotCrate, GraphicsPlotCreate, PlotCreate,
	TinyPlotAddons, GraphicsPlotAddons, GgPlotAddons
} from '@eagleoutice/flowr/dataflow/environments/default-builtin-config';

const SigDbScopes = ['base', 'current', 'history'] as const;

/** only base/auto-loaded builtins are exposed here; non-base attributions need an explicit library() and go through dataflow origins instead */
let builtinBasePackages: Map<string, string> | undefined;
function builtinBasePackageOf(name: string): string | undefined {
	if(!builtinBasePackages) {
		builtinBasePackages = new Map();
		for(const entry of DefaultBuiltinConfig) {
			for(const declared of entry.names ?? []) {
				if(Array.isArray(declared) && baseRPackages.has(declared[1])) {
					builtinBasePackages.set(declared[0], declared[1]);
				}
			}
		}
	}
	return builtinBasePackages.get(name);
}

/** functions whose (first) argument names a package to load */
const libraryLoadFunctions = new Set(['library', 'require', 'loadNamespace', 'requireNamespace', 'attachNamespace']);

/** names flowR special-cases as "Built-In" despite belonging to a real package (e.g. ggplot); only these trigger the expensive cross-package sigdb scan */
const nonBaseBuiltinNames = new Set([
	...GgPlotCreate, ...TinyPlotCrate, ...GraphicsPlotCreate, ...PlotCreate,
	...TinyPlotAddons, ...GraphicsPlotAddons, ...GgPlotAddons
]);

/** whether any scope (base/current/history) has actually been synced to disk */
function anySigDbScopeDownloaded(): boolean {
	return SigDbScopes.some(scope => getSigDbScopeState(scope).manifest);
}

/** hover text for an unresolved `library(pkg)`, with a "did you mean" guess when a known package name is close */
async function sigDbMissingHint(pkg: string): Promise<string> {
	const base = anySigDbScopeDownloaded()
		? 'not in the downloaded signature database(s)'
		: 'no signature database downloaded yet — see the Signature DB view';
	const suggestions = closestPackageNames(pkg, await allKnownPackageNames());
	const didYouMean = suggestions.length > 0 ? ` — did you mean ${suggestions.map(s => `\`${s}\``).join(' or ')}?` : '';
	return `${base}${didYouMean}`;
}

/** runs flowR's real `signature` query against the active session - all URL/deprecated/S3-generic logic lives there, not reimplemented here */
async function runSignatureQuery(document: vscode.TextDocument, pkg: string | undefined, fnName: string | undefined, output: vscode.OutputChannel): Promise<SignatureQueryResult | undefined> {
	try {
		const session = await getFlowrSession();
		const { result, hasError } = await session.retrieveQuery(document, [{ type: 'signature', package: pkg, function: fnName }]);
		return hasError ? undefined : result.signature;
	} catch(e) {
		output.appendLine(`[Package Info] signature query failed: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

/** which scope's on-disk database knows pkg; flowR's signature query doesn't report this, so the scope is the finest attribution available */
async function resolveSigDbScopeLabel(pkg: string): Promise<string | undefined> {
	return (await findSigDbPackageSource(pkg))?.scope;
}

/** `name = default`, `name` (required), or `name?` (optional without a shown default) */
function formatParameter(p: SignatureParameterView): string {
	return p.default !== undefined ? `${p.name} = ${p.default}` : p.name;
}

async function formatFunctionView(fn: SignatureFunctionView, scope?: string): Promise<string> {
	const link = fn.sourceUrl ? `[\`${fn.package}::${fn.name}\`](${fn.sourceUrl})` : `\`${fn.package}::${fn.name}\``;
	const signature = `\`\`\`r\n${fn.name}(${fn.parameters.map(p => formatParameter(p)).join(', ')})\n\`\`\``;
	const parts = [fn.flowrOnly
		? `modeled by flowR itself as ${link} — the signature database has no entry for it`
		: `resolved via the${scope ? ` \`${scope}\`` : ''} signature database as ${link}`];
	if(fn.version) {
		parts.push(`\`v${fn.version}\``);
	}
	// gate on `exported` to avoid linking internal functions; fn.docUrl already resolves the real Rd topic
	const wantsHelpDoc = fn.docUrl && fn.exported;
	const [installed, helpDoc] = await Promise.all([getInstalledVersion(fn.package), wantsHelpDoc ? getHelpDoc(fn.package, fn.name) : undefined]);
	if(installed) {
		parts.push(`installed \`v${installed}\``);
	}
	const flags = [
		fn.properties.includes('deprecated') ? '⚠ deprecated' : undefined,
		fn.properties.includes('can-throw') ? '⚠ can throw' : undefined,
		fn.s3generic ? '🔀 S3 generic' : undefined,
		fn.s3method ? `🔀 S3 method for \`${fn.s3method.generic}\` (\`${fn.s3method.package}\`), class \`${fn.s3method.class}\`` : undefined,
		fn.flowr?.props.length ? `flowR: ${fn.flowr.props.map(p => `\`${p}\``).join(', ')}` : undefined,
		fn.flowr?.returns ? `returns \`${fn.flowr.returns}\`` : undefined
	].filter((f): f is string => !!f);
	// the documentation link leads, large (a heading), rather than being buried at the end of the inline summary
	const docLink = wantsHelpDoc ? `#### 📖 Documentation: [${helpDoc?.title ?? fn.name}](${fn.docUrl})\n\n` : '';
	const body = [signature, parts.join(' · '), flags.length > 0 ? flags.join(' • ') : undefined].filter(Boolean).join('\n\n');
	return `${docLink}${body}`;
}

function formatPackageView(pkg: SignaturePackageView, scope?: string): string {
	const link = pkg.repoUrl ?? pkg.cranPage;
	const label = link ? `[\`${pkg.name}\`](${link})` : `\`${pkg.name}\``;
	const parts = [`resolved via the${scope ? ` \`${scope}\`` : ''} signature database as ${label}`, `\`v${pkg.version}\``, `${pkg.functionCount} functions`];
	if(pkg.cranPage) {
		parts.push(`[CRAN](${pkg.cranPage})`);
	}
	let text = parts.join(' · ');
	if(pkg.dependencies.length > 0) {
		text += `\n\n${formatGroupedDependencies(pkg.dependencies)}`;
	}
	return text;
}

/** DESCRIPTION dependency field order (the ones users actually care about distinguishing first); anything else keeps its first-seen order after these */
const DependencyTypeOrder = ['Depends', 'Imports', 'LinkingTo', 'Suggests', 'Enhances'];

/** groups dependencies by their DESCRIPTION field (Imports, Suggests, ...), one comma-separated line per group */
function formatGroupedDependencies(dependencies: readonly SignatureDependencyView[]): string {
	const byType = new Map<string, string[]>();
	for(const d of dependencies) {
		const label = d.constraint ? `\`${d.name}\` \`${d.constraint}\`` : `\`${d.name}\``;
		const labels = byType.get(d.type) ?? [];
		labels.push(label);
		byType.set(d.type, labels);
	}
	const rank = (type: string) => {
		const i = DependencyTypeOrder.indexOf(type);
		return i === -1 ? DependencyTypeOrder.length : i;
	};
	return [...byType.entries()]
		.sort(([a], [b]) => rank(a) - rank(b))
		.map(([type, labels]) => `**${type}:** ${labels.join(', ')}`)
		.join('\n\n');
}

/** the name of the function called at (or named by) the node at `id`, if it is a named call */
function functionNameAt(ast: NormalizedAst, id: NodeId): string | undefined {
	const node = ast.idMap.get(toDataflowNode(ast, id));
	return node?.type === RType.FunctionCall && node.named ? node.functionName.lexeme ?? undefined : undefined;
}

/** the package + function of a `pkg::fn`/`pkg:::fn` call at `id`, from flowR's already-namespaced call identifier - the namespace is explicit in the source, so no `library()` is needed to attribute it */
function namespacedCallAt(graph: DataflowGraph, ast: NormalizedAst, id: NodeId): { package: string, name: string } | undefined {
	const vertex = graph.getVertex(toDataflowNode(ast, id));
	if(!FunctionCallVertex.is(vertex)) {
		return undefined;
	}
	const namespace = Identifier.getNamespace(vertex.name);
	return namespace ? { package: namespace, name: Identifier.getName(vertex.name) } : undefined;
}

function unquote(lexeme: string | undefined): string | undefined {
	return (lexeme ?? '').replace(/^["'`]|["'`]$/g, '') || undefined;
}

/** resolves the package for a library()/require() call, whether hovering the package name or the load function itself */
function loadedPackageAt(ast: NormalizedAst, id: NodeId): { package: string, viaFunctionName: boolean } | undefined {
	const node = ast.idMap.get(id);
	// (a) hovering the package name argument: value -> RArgument -> call
	if(node && (node.type === RType.Symbol || node.type === RType.String)) {
		const argId = node.info.parent;
		const call = argId !== undefined ? ast.idMap.get(ast.idMap.get(argId)?.info.parent ?? '') : undefined;
		if(call?.type === RType.FunctionCall && call.named && libraryLoadFunctions.has(call.functionName.lexeme ?? '')) {
			const pkg = unquote(node.lexeme);
			return pkg ? { package: pkg, viaFunctionName: false } : undefined;
		}
	}
	// (b) hovering the load function itself: take its first argument as the package
	const call = ast.idMap.get(toDataflowNode(ast, id));
	if(call?.type === RType.FunctionCall && call.named && libraryLoadFunctions.has(call.functionName.lexeme ?? '')) {
		const first = call.arguments[0];
		const pkg = first && typeof first === 'object' && first.type === RType.Argument ? unquote(first.value?.lexeme) : undefined;
		return pkg ? { package: pkg, viaFunctionName: true } : undefined;
	}
	return undefined;
}

/** an unused, zero-width target range - the redirect document itself has no real content to point at */
const ZeroRange = new vscode.Range(0, 0, 0, 0);

const RedirectScheme = 'vscode-flowr-open-external';

/** a virtual document whose entire purpose is carried in its query string (the external URL to open on a real click) */
function redirectUri(target: string): vscode.Uri {
	return vscode.Uri.from({ scheme: RedirectScheme, path: '/redirect', query: target });
}

// no side effect here on purpose: this also runs for a Ctrl+hover "peek" preview, not just a real navigation -
// the actual `openExternal` lives in the tab-open listener below instead, which real previews don't trigger
class RedirectContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(): string {
		return '';
	}
}

/**
 * Opens the external URL carried by a {@link redirectUri}, but only once it becomes a real, open editor tab.
 * Unlike `TextDocumentContentProvider.provideTextDocumentContent` (which VS Code also calls to render a Ctrl+hover
 * peek preview, not just a real navigation - the original bug this whole mechanism exists to avoid), a tab actually
 * opening only happens on a genuine "go to definition" navigation. This is what makes the link work exactly like a
 * normal go-to-definition target (no permanent underline, only while Ctrl is held) while still reliably opening an
 * external URL, unlike a plain Definition/LocationLink to an http(s) URI - which VS Code tries to open as a text
 * editor tab and fails ("the editor could not be opened due to an unexpected error"), verified against a real click.
 */
function registerExternalRedirect(): vscode.Disposable[] {
	return [
		vscode.workspace.registerTextDocumentContentProvider(RedirectScheme, new RedirectContentProvider()),
		vscode.window.tabGroups.onDidChangeTabs(e => {
			for(const tab of e.opened) {
				const input = tab.input;
				if(input instanceof vscode.TabInputText && input.uri.scheme === RedirectScheme) {
					void vscode.env.openExternal(vscode.Uri.parse(input.uri.query));
					void vscode.window.tabGroups.close(tab);
				}
			}
		})
	];
}

/** registers the hover/definition/reference providers plus the external-link redirect mechanism */
export function registerPackageInfo(output: vscode.OutputChannel): vscode.Disposable[] {
	const provider = new FlowrPackageInfoProvider(output);
	const referenceProvider = new FlowrReferenceProvider(output);
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	const disposables: vscode.Disposable[] = [...registerExternalRedirect()];
	for(const selector of selectors) {
		disposables.push(
			vscode.languages.registerHoverProvider(selector, provider),
			vscode.languages.registerDefinitionProvider(selector, provider),
			vscode.languages.registerReferenceProvider(selector, referenceProvider)
		);
	}
	return disposables;
}

/** the dataflow origins flowR knows for a node, together with the node they were ultimately resolved from */
interface ResolvedOrigins {
	origins: readonly Origin[];
	id:      NodeId;
}

/** the node the location search resolved to, with the AST and dataflow graph it came from */
interface ResolvedNode {
	id:    NodeId;
	ast:   NormalizedAst;
	graph: DataflowGraph;
}

/** an origin that carries a source-level definition (i.e. not a built-in function) */
function isLocalOrigin(origin: Origin): origin is Exclude<Origin, { readonly proc: string }> {
	return !('proc' in origin);
}

/** a location search resolves to the innermost symbol, but flowR attaches origins to the enclosing call - climb to the parent call if the symbol itself has none */
function originsForNode(graph: DataflowGraph, ast: NormalizedAst, id: NodeId): ResolvedOrigins | undefined {
	const direct = getOriginInDfg(graph, id);
	if(direct && direct.length > 0) {
		return { origins: direct, id };
	}
	// the location search resolves to the function-name symbol; the origins live on the enclosing call node
	const callId = toDataflowNode(ast, id);
	if(callId !== id) {
		const viaCall = getOriginInDfg(graph, callId);
		if(viaCall && viaCall.length > 0) {
			return { origins: viaCall, id: callId };
		}
	}
	return undefined;
}

/** resolves the AST/dataflow node the user pointed at, shared by the hover/definition and reference providers */
async function resolveNode(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken, output: vscode.OutputChannel): Promise<ResolvedNode | undefined> {
	const session = await getFlowrSession();
	if(!session || token.isCancellationRequested) {
		return undefined;
	}
	try {
		const res = await session.retrieveQuery(document, [{ type: 'search', search: locationSearch(pos, document) }]);
		if(token.isCancellationRequested || res.hasError || !res.dfi || !res.ast) {
			return undefined;
		}
		const id = res.result.search.results[0]?.ids[0];
		if(id === undefined) {
			return undefined;
		}
		return { id, ast: res.ast, graph: res.dfi.graph };
	} catch(e) {
		output.appendLine(`[Package Info] Error while resolving symbol: ${(e as Error).message}`);
		return undefined;
	}
}

/** the node at `id` itself if it is a variable/function definition vertex, otherwise the local definition its origin points to (if any) */
function definitionIdFor(resolved: ResolvedNode): NodeId | undefined {
	const vertex = resolved.graph.getVertex(resolved.id) ?? resolved.graph.getVertex(toDataflowNode(resolved.ast, resolved.id));
	if(VariableDefinitionVertex.is(vertex) || FunctionDefinitionVertex.is(vertex)) {
		return resolved.id;
	}
	const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
	return origins?.find(isLocalOrigin)?.id;
}

export class FlowrPackageInfoProvider implements vscode.HoverProvider, vscode.DefinitionProvider {
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	private async resolveNode(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<ResolvedNode | undefined> {
		return resolveNode(document, pos, token, this.output);
	}

	/** package/function attribution text: dataflow-origin call, library() load, base builtin, or a special-cased non-base builtin */
	private async resolveSigDbInfo(resolved: ResolvedNode, document: vscode.TextDocument): Promise<string | undefined> {
		// case 0: an explicit `pkg::fn` call - the namespace is in the source, so resolve it directly without needing a library() load
		const explicit = namespacedCallAt(resolved.graph, resolved.ast, resolved.id);
		if(explicit) {
			const [result, scope] = await Promise.all([runSignatureQuery(document, explicit.package, explicit.name, this.output), resolveSigDbScopeLabel(explicit.package)]);
			return `**\`${explicit.name}\`** is provided by the \`${explicit.package}\` package${result?.function ? `\n\n${await formatFunctionView(result.function, scope)}` : ''}`;
		}

		// case 1: a call attributed to a package (e.g. `ggplot` -> ggplot2); local variables/functions are left to other hover providers
		const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
		const qualified = origins && Identifier.toQualified(origins);
		const namespace = qualified && Identifier.getNamespace(qualified);
		if(qualified && namespace) {
			const fnName = Identifier.getName(qualified);
			const [result, scope] = await Promise.all([runSignatureQuery(document, namespace, fnName, this.output), resolveSigDbScopeLabel(namespace)]);
			return `**\`${fnName}\`** is provided by the \`${namespace}\` package${result?.function ? `\n\n${await formatFunctionView(result.function, scope)}` : ''}`;
		}

		// case 2: a `library(pkg)`/`require(pkg)` load — jumps to the package's CRAN page
		const loaded = loadedPackageAt(resolved.ast, resolved.id);
		if(loaded) {
			const subject = loaded.viaFunctionName ? `loads the \`${loaded.package}\` package` : `**\`${loaded.package}\`**`;
			const [result, scope] = await Promise.all([runSignatureQuery(document, loaded.package, undefined, this.output), resolveSigDbScopeLabel(loaded.package)]);
			return result?.package ? `${subject} — ${formatPackageView(result.package, scope)}` : `${subject}: ${await sigDbMissingHint(loaded.package)}`;
		}

		// case 3: a base/auto-loaded built-in (e.g. `print` -> base); base R has no GitHub mirror, so only a version, no source link
		const fnName = functionNameAt(resolved.ast, resolved.id);
		const basePackage = fnName && builtinBasePackageOf(fnName);
		if(fnName && basePackage) {
			const version = await resolveSigDbPackageVersion(basePackage);
			const rVersionPage = version && rMajorVersionPageUrl(version);
			const pkgLabel = rVersionPage ? `[\`${basePackage}\`](${rVersionPage})` : `\`${basePackage}\``;
			return `**\`${fnName}\`** is provided by the ${pkgLabel} package${version ? ` \`v${version}\`` : ''}`;
		}

		// case 3b: a bare call (no library()/`::`) to a function from one of R's *other* default-loaded packages
		// (e.g. `acf` -> stats) - flowR has no special dataflow handling for these (unlike case 3's builtins), so
		// only the signature database can attribute them
		if(fnName) {
			const defaultLoaded = await this.resolveDefaultLoadedFunction(document, fnName);
			if(defaultLoaded) {
				const scope = await resolveSigDbScopeLabel(defaultLoaded.pkg);
				return `**\`${fnName}\`** is provided by the \`${defaultLoaded.pkg}\` package (loaded by default)\n\n${await formatFunctionView(defaultLoaded.fn, scope)}`;
			}
		}

		// case 4: flowR pre-registers some non-base functions (e.g. `ggplot`) as built-ins; if the sigdb also knows a
		// real package for the name, surface it too - re-query the top wildcard hit by exact name for the full view
		if(fnName && nonBaseBuiltinNames.has(fnName) && anySigDbScopeDownloaded()) {
			const wildcard = await runSignatureQuery(document, undefined, fnName, this.output);
			const hit = wildcard?.matches?.[0];
			const [result, scope] = hit
				? await Promise.all([runSignatureQuery(document, hit.package, hit.name, this.output), resolveSigDbScopeLabel(hit.package)])
				: [undefined, undefined];
			if(result?.function) {
				return `**\`${fnName}\`** is treated as a built-in by flowR (for output/dependency tracking), but the signature database also knows it as ${await formatFunctionView(result.function, scope)}`;
			}
		}

		return undefined;
	}

	/** the sigdb function view a call is attributed to (mirrors {@link resolveSigDbInfo}'s cases 1/3b/4), for its `sourceUrl` */
	private async resolveAttributedFunction(resolved: ResolvedNode, document: vscode.TextDocument): Promise<SignatureFunctionView | undefined> {
		const explicit = namespacedCallAt(resolved.graph, resolved.ast, resolved.id);
		if(explicit) {
			return (await runSignatureQuery(document, explicit.package, explicit.name, this.output))?.function;
		}
		const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
		const qualified = origins && Identifier.toQualified(origins);
		const namespace = qualified && Identifier.getNamespace(qualified);
		if(qualified && namespace) {
			const result = await runSignatureQuery(document, namespace, Identifier.getName(qualified), this.output);
			return result?.function;
		}
		const fnName = functionNameAt(resolved.ast, resolved.id);
		if(fnName) {
			const defaultLoaded = await this.resolveDefaultLoadedFunction(document, fnName);
			if(defaultLoaded) {
				return defaultLoaded.fn;
			}
		}
		if(fnName && nonBaseBuiltinNames.has(fnName) && anySigDbScopeDownloaded()) {
			const wildcard = await runSignatureQuery(document, undefined, fnName, this.output);
			const hit = wildcard?.matches?.[0];
			const result = hit && await runSignatureQuery(document, hit.package, hit.name, this.output);
			return result?.function;
		}
		return undefined;
	}

	/** the {@link defaultLoadedPackages} package exporting `fnName` (a bare call, no library()/`::` needed), if exactly one does */
	private async resolveDefaultLoadedFunction(document: vscode.TextDocument, fnName: string): Promise<{ fn: SignatureFunctionView, pkg: string } | undefined> {
		if(!anySigDbScopeDownloaded()) {
			return undefined;
		}
		const results = await Promise.all(defaultLoadedPackages.map(pkg => runSignatureQuery(document, pkg, fnName, this.output)));
		const hitIdx = results.findIndex(r => r?.function);
		const fn = hitIdx >= 0 ? results[hitIdx]?.function : undefined;
		return fn ? { fn, pkg: defaultLoadedPackages[hitIdx] } : undefined;
	}

	async provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}
		const info = await this.resolveSigDbInfo(resolved, document);
		return info ? new vscode.Hover(new vscode.MarkdownString(info)) : undefined;
	}

	async provideDefinition(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}

		// a library(pkg) package name redirects to its CRAN page
		const loaded = loadedPackageAt(resolved.ast, resolved.id);
		if(loaded && !loaded.viaFunctionName && !baseRPackages.has(loaded.package)) {
			return new vscode.Location(redirectUri(cranPageUrl(loaded.package)), ZeroRange);
		}

		// a call attributed to a package function (see resolveSigDbInfo's cases 1/4) redirects to its source
		const attributedFn = await this.resolveAttributedFunction(resolved, document);
		if(attributedFn?.sourceUrl) {
			return new vscode.Location(redirectUri(attributedFn.sourceUrl), ZeroRange);
		}

		// skip the misleading local-origin lookup for builtins and library() package-name args
		const fnName = functionNameAt(resolved.ast, resolved.id);
		const isPackageNameArg = !!loaded;
		if(!(fnName && nonBaseBuiltinNames.has(fnName)) && !isPackageNameArg) {
			const localOrigins = (originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins ?? []).filter(isLocalOrigin);
			// prefer the FunctionCallOrigin over a plain variable-binding origin, so `f <- function(){}; f()` jumps to the body only
			const hasFunctionCallOrigin = localOrigins.some(o => o.type === OriginType.FunctionCallOrigin);
			const preferredOrigins = hasFunctionCallOrigin ? localOrigins.filter(o => o.type === OriginType.FunctionCallOrigin) : localOrigins;

			const locations = new Map<string, vscode.Location>();
			for(const origin of preferredOrigins) {
				const loc = resolved.ast.idMap.get(origin.id)?.location;
				if(loc) {
					const range = rangeToVscodeRange(loc);
					// collapse origins pointing at the same spot into one jump target
					locations.set(`${range.start.line}:${range.start.character}`, new vscode.Location(document.uri, range));
				}
			}
			if(locations.size > 0) {
				return [...locations.values()];
			}
		}

		// clicking a definition itself (not a use of it) has no origin to resolve; report it as its own location instead of nothing
		const vertex = resolved.graph.getVertex(resolved.id) ?? resolved.graph.getVertex(toDataflowNode(resolved.ast, resolved.id));
		if(VariableDefinitionVertex.is(vertex) || FunctionDefinitionVertex.is(vertex)) {
			const loc = resolved.ast.idMap.get(resolved.id)?.location;
			if(loc) {
				return new vscode.Location(document.uri, rangeToVscodeRange(loc));
			}
		}
		return undefined;
	}
}

/** "Find All References" via flowR's dataflow graph: every node with a Reads edge into the definition is a use of it */
export class FlowrReferenceProvider implements vscode.ReferenceProvider {
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	async provideReferences(document: vscode.TextDocument, pos: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const resolved = await resolveNode(document, pos, token, this.output);
		if(!resolved || token.isCancellationRequested) {
			return [];
		}
		const defId = definitionIdFor(resolved);
		if(defId === undefined) {
			return [];
		}

		const locations = new Map<string, vscode.Location>();
		const addLocation = (id: NodeId) => {
			const loc = resolved.ast.idMap.get(id)?.location;
			if(loc) {
				const range = rangeToVscodeRange(loc);
				locations.set(`${range.start.line}:${range.start.character}`, new vscode.Location(document.uri, range));
			}
		};

		if(context.includeDeclaration) {
			addLocation(defId);
		}
		for(const [sourceId, edge] of resolved.graph.ingoingEdges(defId) ?? []) {
			if(DfEdge.includesType(edge, EdgeType.Reads)) {
				addLocation(sourceId);
			}
		}
		return [...locations.values()];
	}
}
