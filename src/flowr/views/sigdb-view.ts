import * as vscode from 'vscode';
import {
	isSigDbEnabled, getSigDbAdditionalPath, getSigDbCacheDir, getSigDbBundleDir,
	readSigDbRemotePointer, getSigDbScopeState, getScopeSource,
	downloadSigDbScope, removeSigDbScope, cranMirrorSourceUrl, cranPageUrl, rMajorVersionPageUrl, rdrrDocUrl, isSigDbFunctionS3Generic,
	SigDbShardGroups, getDownloadedShardGroups, getDownloadedShardIds, safeSigDbCall, safeLatestVersionStr, safeFunctionsOf
} from '../../package-db';
import { Settings, getConfig } from '../../settings';
import { registerCommand, refreshSigDbConfig } from '../../extension';
import { getInstalledVersion, getHelpDoc } from '../../installed-packages';
import type { PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';
import type { DecodedFunction, SigParameter } from '@eagleoutice/flowr/project/sigdb/decode';
import { RRange, RVersion } from '@eagleoutice/flowr/util/r-version';
import { ArgProp } from '@eagleoutice/flowr/dataflow/environments/built-in-props';

const GlobChars = /[*?]/;

/** `*`/`?` glob to an anchored, case-sensitive RegExp (same semantics as flowR's own `signature` query) */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`);
}

/** matches a package/function name against an exact string or a `*`/`?` glob pattern */
export function matchesPattern(pattern: string, value: string): boolean {
	return GlobChars.test(pattern) ? globToRegExp(pattern).test(value) : pattern === value;
}

/** a version pattern: exact string, a glob (`3.*`), or a semver-ish range (`>=3.0.0`) - via flowR's real `RVersion`/`RRange` */
export function matchesVersion(pattern: string, version: string): boolean {
	if(pattern === version) {
		return true;
	}
	if(GlobChars.test(pattern)) {
		return matchesPattern(pattern, version);
	}
	const range = RRange.parse(pattern);
	return range ? RRange.satisfies(version, range) : false;
}

function formatSignature(params: readonly SigParameter[]): string {
	return params.map(p => p.default !== undefined ? `${p.name} = ${p.default}` : p.name).join(', ');
}

export const FlowrSigDbViewId = 'flowr-sigdb';

const Scopes = ['base', 'current', 'history'] as const;
type Scope = typeof Scopes[number];

const ScopeLabel: Record<Scope, string> = {
	base:    'Base R',
	current: 'Current CRAN',
	history: 'Full CRAN History'
};

const ScopeDescription: Record<Scope, string> = {
	base:    'R-core packages (downloaded on sync, not bundled with the extension)',
	current: 'Latest version of every current CRAN package (downloading fetches all of its shards together)',
	history: 'Full CRAN archive, including every historical version of every package'
};

/** how many children to materialize on the first page (packages under a scope, functions under a version) before capping */
const MaxListedChildren = 200;
/** how many more to reveal each time "… N more" is expanded again, after the first page - a much gentler increment than dumping another full page */
const MoreListedChildren = 20;

export type SigDbNode =
	| { kind: 'scope', scope: Scope }
	| { kind: 'sync', scope: Scope }
	| { kind: 'package', scope: Scope, pkg: string }
	| { kind: 'version', scope: Scope, pkg: string, version: string }
	| { kind: 'function', scope: Scope, pkg: string, version: string, name: string }
	/** the next page of a scope's package list or a version's function list, itself lazily expandable */
	| { kind: 'more', scope: Scope, pkg?: string, version?: string, offset: number, remaining: number }
	| { kind: 'custom', path: string }
	| { kind: 'info', text: string };

function nodeId(node: SigDbNode): string {
	switch(node.kind) {
		case 'scope': return `scope:${node.scope}`;
		case 'sync': return `sync:${node.scope}`;
		case 'package': return `pkg:${node.scope}:${node.pkg}`;
		case 'version': return `ver:${node.scope}:${node.pkg}:${node.version}`;
		case 'function': return `fn:${node.scope}:${node.pkg}:${node.version}:${node.name}`;
		case 'more': return node.pkg !== undefined
			? `more:fn:${node.scope}:${node.pkg}:${node.version}:${node.offset}`
			: `more:pkg:${node.scope}:${node.offset}`;
		case 'custom': return `custom:${node.path}`;
		case 'info': return `info:${node.text}`;
	}
}

/** Tree view over the real, on-disk signature-database state, built lazily (nothing is enumerated until expanded) */
/** exported for testing - see sigdb-search.test.ts's partial-download tree resilience test */
export class SigDbTreeDataProvider implements vscode.TreeDataProvider<SigDbNode> {
	private changeEvent = new vscode.EventEmitter<SigDbNode | undefined>();
	public readonly onDidChangeTreeData = this.changeEvent.event;
	/** ids that must stay reachable via getChildren() even past the listing cap -- see {@link pin} */
	private readonly pinned = new Set<string>();

	constructor(private output: vscode.OutputChannel) {}

	/** guarantees `id` survives {@link capped} truncation, so `TreeView.reveal()` can find it even deep in an alphabetical listing */
	pin(id: string): void {
		this.pinned.add(id);
	}

	dispose(): void {
		this.changeEvent.dispose();
	}

	refresh(): void {
		this.changeEvent.fire(undefined);
	}

	getParent(node: SigDbNode): SigDbNode | undefined {
		switch(node.kind) {
			case 'sync': return { kind: 'scope', scope: node.scope };
			case 'package': return { kind: 'scope', scope: node.scope };
			case 'version': return { kind: 'package', scope: node.scope, pkg: node.pkg };
			case 'function': return { kind: 'version', scope: node.scope, pkg: node.pkg, version: node.version };
			case 'more': return node.pkg !== undefined
				? { kind: 'version', scope: node.scope, pkg: node.pkg, version: node.version ?? '' }
				: { kind: 'scope', scope: node.scope };
			default: return undefined;
		}
	}

	async getChildren(element?: SigDbNode): Promise<SigDbNode[]> {
		if(!element) {
			return this.getRootChildren();
		}
		switch(element.kind) {
			case 'scope': return this.getScopeChildren(element.scope);
			case 'package': return this.getPackageChildren(element.scope, element.pkg);
			case 'version': return this.getVersionChildren(element.scope, element.pkg, element.version);
			case 'more': return element.pkg !== undefined
				? this.getVersionChildren(element.scope, element.pkg, element.version, element.offset)
				: this.getScopeChildren(element.scope, element.offset);
			default: return [];
		}
	}

	private getRootChildren(): SigDbNode[] {
		if(!isSigDbEnabled()) {
			return [{ kind: 'info', text: 'Signature database is disabled (vscode-flowr.config.solver.sigdb.enabled).' }];
		}

		const children: SigDbNode[] = Scopes.map(scope => ({ kind: 'scope', scope }));
		const custom = getSigDbAdditionalPath().trim();
		// a customPath equal to the auto-managed synced-bundle dir is stale state from an earlier bug; self-heal it away
		if(custom && custom === getSigDbBundleDir()) {
			void getConfig().update(Settings.SigDbCustomPath, '', vscode.ConfigurationTarget.Global);
		} else if(custom) {
			children.push({ kind: 'custom', path: custom });
		}
		return children;
	}

	private async openScopeSource(scope: Scope): Promise<PackageSignatureSource | undefined> {
		// mount only the shards actually on disk: a partially-downloaded scope must not list packages whose shard was
		// never fetched, or reading each would throw ENOENT and flood the output
		return await getScopeSource(scope, msg => this.output.appendLine(`[SigDB] ${msg}`));
	}

	private async getScopeChildren(scope: Scope, offset = 0): Promise<SigDbNode[]> {
		const state = getSigDbScopeState(scope);
		if(!state.manifest || !state.manifestPath) {
			return [{ kind: 'sync', scope }];
		}
		const source = await this.openScopeSource(scope);
		if(!source) {
			return [{ kind: 'info', text: 'Could not open this database (see the flowR output channel).' }];
		}
		// current/history manifests embed their own base-R shard copy; hide that overlap here since "Base R" already lists them
		let names = [...source.packageNames()];
		if(scope !== 'base') {
			names = names.filter(pkg => !source.isBaseR(pkg));
		}
		names.sort((a, b) => a.localeCompare(b));
		const packages = this.capped(
			names.map(pkg => ({ kind: 'package', scope, pkg } as SigDbNode)),
			offset,
			nextOffset => ({ kind: 'more', scope, offset: nextOffset, remaining: names.length - nextOffset })
		);
		// the manifest lists every package regardless of which shard groups are on disk, so keep "fetch the rest" visible even after the first download
		const mostComplete = SigDbShardGroups[scope].at(-1);
		if(offset === 0 && mostComplete && !getDownloadedShardGroups(scope).has(mostComplete.id)) {
			return [{ kind: 'sync', scope }, ...packages];
		}
		return packages;
	}

	/** an explanatory leaf shown instead of a package's versions/functions when its shard isn't actually on disk yet */
	private notYetDownloadedNode(scope: Scope, e: unknown): SigDbNode {
		this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		return {
			kind: 'info',
			text: `Not downloaded yet - this package's data lives in a shard of ${ScopeLabel[scope]} you haven't synced. Use the download icon on ${ScopeLabel[scope]} to fetch the rest.`
		};
	}

	private async getPackageChildren(scope: Scope, pkg: string): Promise<SigDbNode[]> {
		const source = await this.openScopeSource(scope);
		if(!source) {
			return [];
		}
		try {
			const releases = source.releaseDates(pkg);
			if(releases.length > 0) {
				return releases.slice().reverse().map(r => ({ kind: 'version', scope, pkg, version: r.version.str } as SigDbNode));
			}
			// base R packages carry no release dates; their per-R-release version history lives in coreVersions instead
			if(source.isBaseR(pkg)) {
				const core = source.coreVersions(pkg) ?? [];
				if(core.length > 0) {
					return core.slice().reverse().map(v => ({ kind: 'version', scope, pkg, version: v.str } as SigDbNode));
				}
			}
			const latest = source.latestVersion(pkg);
			if(latest) {
				return [{ kind: 'version', scope, pkg, version: latest.str }];
			}
			// no version metadata at all -- fall back to functions directly under the package, unversioned
			return await this.getVersionChildren(scope, pkg, undefined);
		} catch(e) {
			return [this.notYetDownloadedNode(scope, e)];
		}
	}

	private async getVersionChildren(scope: Scope, pkg: string, version: string | undefined, offset = 0): Promise<SigDbNode[]> {
		const source = await this.openScopeSource(scope);
		try {
			const functions = source?.functions(pkg, version) ?? [];
			const names = functions.map(f => f.name).sort((a, b) => a.localeCompare(b));
			return this.capped(
				names.map(name => ({ kind: 'function', scope, pkg, version: version ?? '', name } as SigDbNode)),
				offset,
				nextOffset => ({ kind: 'more', scope, pkg, version, offset: nextOffset, remaining: names.length - nextOffset })
			);
		} catch(e) {
			return [this.notYetDownloadedNode(scope, e)];
		}
	}

	/** slices `nodes` at `offset`, appending a lazily-expandable "more" node (via `buildMore`) when there's more beyond the cap */
	private capped(nodes: SigDbNode[], offset: number, buildMore: (nextOffset: number) => SigDbNode): SigDbNode[] {
		const pageSize = offset === 0 ? MaxListedChildren : MoreListedChildren;
		const remainingNodes = nodes.slice(offset);
		if(remainingNodes.length <= pageSize) {
			return remainingNodes;
		}
		const visible = remainingNodes.slice(0, pageSize);
		const overflow = remainingNodes.slice(pageSize);
		// anything pinned (e.g. a search result being revealed) stays reachable on this page too
		const pinnedOverflow = overflow.filter(n => this.pinned.has(nodeId(n)));
		const nextOffset = offset + pageSize;
		return [...visible, ...pinnedOverflow, buildMore(nextOffset)];
	}

	/** for Base R, the version range a package was bundled for when it doesn't span the whole known history */
	private baseRCoreRangeLabel(source: PackageSignatureSource, pkg: string): string | undefined {
		const core = source.coreVersions(pkg);
		const allCore = source.coreVersions('base');
		const firstCore = core?.[0];
		const lastCore = core?.at(-1);
		const earliestR = allCore?.[0];
		const latestR = allCore?.at(-1);
		if(!firstCore || !lastCore || !earliestR || !latestR) {
			return undefined;
		}
		const addedLater = RVersion.compare(firstCore.str, earliestR.str) > 0;
		const removedSince = RVersion.compare(lastCore.str, latestR.str) < 0;
		if(addedLater && removedSince) {
			return `R v${firstCore.str}–v${lastCore.str}`;
		} else if(addedLater) {
			return `from R v${firstCore.str}`;
		} else if(removedSince) {
			return `until R v${lastCore.str}`;
		}
		return undefined;
	}

	/** rich tooltip for a package node; degrades to the bare item rather than throw when a shard isn't downloaded yet */
	private async packageTreeItem(scope: Scope, pkg: string): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(pkg, vscode.TreeItemCollapsibleState.Collapsed);
		const source = await this.openScopeSource(scope);
		if(!source) {
			return item;
		}
		try {
			const version = source.latestVersion(pkg)?.str;
			const exportsInfo = source.lookup(pkg, version);
			const base = source.isBaseR(pkg);
			// base R packages have no CRAN package= page; link to the R version series they shipped with instead
			const cranPage = !base && exportsInfo?.cran ? cranPageUrl(pkg) : undefined;
			const rVersionPage = base && version ? rMajorVersionPageUrl(version) : undefined;
			const link = cranPage ?? rVersionPage;
			const coreRange = base ? this.baseRCoreRangeLabel(source, pkg) : undefined;
			const versionCount = base ? undefined : source.releaseDates(pkg).length;
			const installed = base ? undefined : await getInstalledVersion(pkg);
			item.description = [
				coreRange ?? (versionCount && versionCount > 1 ? `${versionCount} versions` : undefined),
				installed && `installed ${installed}`
			].filter(Boolean).join(' · ') || undefined;

			const md = new vscode.MarkdownString();
			md.appendMarkdown(link ? `**[\`${pkg}\`](${link})**` : `**\`${pkg}\`**`);
			if(version) {
				md.appendMarkdown(` \`v${version}\``);
			}
			md.appendMarkdown('\n\n');
			md.appendMarkdown(base ? 'Part of base R.' : (exportsInfo?.cran ? 'A CRAN package.' : 'Not a CRAN package.'));
			if(coreRange) {
				md.appendMarkdown(` ${coreRange}.`);
			} else if(versionCount && versionCount > 1) {
				md.appendMarkdown(` ${versionCount} versions known.`);
			}
			if(exportsInfo) {
				md.appendMarkdown(`\n\n${exportsInfo.exported.length} exported identifiers`);
				if(exportsInfo.deprecated.length > 0) {
					md.appendMarkdown(`, ${exportsInfo.deprecated.length} deprecated`);
				}
			}
			if(installed) {
				md.appendMarkdown(`\n\nInstalled locally as \`v${installed}\`${version && installed !== version ? ` (database describes \`v${version}\`)` : ''}.`);
			}
			if(exportsInfo?.s3Classes.length) {
				md.appendMarkdown(`\n\n**S3 classes:** ${exportsInfo.s3Classes.map(c => `\`${c}\``).join(', ')}`);
			}
			if(exportsInfo?.s4Classes.length) {
				md.appendMarkdown(`\n\n**S4 classes:** ${exportsInfo.s4Classes.map(c => `\`${c}\``).join(', ')}`);
			}
			if(cranPage) {
				md.appendMarkdown(`\n\n[CRAN](${cranPage})`);
			} else if(rVersionPage) {
				md.appendMarkdown(`\n\n[R v${version} source](${rVersionPage})`);
			}
			md.isTrusted = true;
			item.tooltip = md;
		} catch(e) {
			this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		}
		return item;
	}

	async getTreeItem(node: SigDbNode): Promise<vscode.TreeItem> {
		const item = await this.buildTreeItem(node);
		item.id = nodeId(node);
		return item;
	}

	private async buildTreeItem(node: SigDbNode): Promise<vscode.TreeItem> {
		switch(node.kind) {
			case 'scope': return this.scopeTreeItem(node.scope);
			case 'sync': return this.syncTreeItem(node.scope);
			case 'package': return this.packageTreeItem(node.scope, node.pkg);
			case 'version': return this.versionTreeItem(node.scope, node.pkg, node.version);
			case 'function': return this.functionTreeItem(node);
			case 'more': {
				const item = new vscode.TreeItem(`… ${node.remaining} more`, vscode.TreeItemCollapsibleState.Collapsed);
				item.iconPath = new vscode.ThemeIcon('ellipsis');
				item.tooltip = 'Expand for the next page, or use "Search Signatures" to jump straight to a specific one.';
				return item;
			}
			case 'custom': {
				const item = new vscode.TreeItem(`Custom: ${node.path}`, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('folder-library');
				item.tooltip = 'Configured via vscode-flowr.config.solver.sigdb.customPath';
				return item;
			}
			case 'info': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('info');
				return item;
			}
		}
	}

	private scopeTreeItem(scope: Scope): vscode.TreeItem {
		const state = getSigDbScopeState(scope);
		const item = new vscode.TreeItem(ScopeLabel[scope], vscode.TreeItemCollapsibleState.Collapsed);

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${ScopeLabel[scope]}**\n\n${ScopeDescription[scope]}\n\n`);
		if(state.manifest) {
			// the manifest's package count is independent of what's actually on disk; report both numbers separately
			const downloadedIds = getDownloadedShardIds(scope);
			const totalPackages = state.manifest.shards.reduce((sum, s) => sum + s.packages, 0);
			const downloadedPackages = state.manifest.shards.filter(s => downloadedIds.has(s.id)).reduce((sum, s) => sum + s.packages, 0);
			const complete = state.manifest.shards.every(s => downloadedIds.has(s.id));

			item.iconPath = new vscode.ThemeIcon(complete ? 'pass-filled' : 'circle-filled');
			item.description = complete
				? `${totalPackages} packages across ${state.manifest.shards.length} shard${state.manifest.shards.length === 1 ? '' : 's'}`
				: `${downloadedPackages} of ${totalPackages} packages downloaded`;

			md.appendMarkdown(`- **Manifest:** ${state.manifestPath}\n`);
			md.appendMarkdown(`- **Generated:** ${state.manifest.date}\n`);
			for(const shard of state.manifest.shards) {
				md.appendMarkdown(`- \`${shard.id}\`${downloadedIds.has(shard.id) ? '' : ' (not downloaded)'}: ${shard.packages} packages, ${shard.versions} versions\n`);
			}
			md.appendMarkdown('\nDecompressed shards are cached on disk and reused (see flowR\'s `sigDbCacheDir`) - opening the same package twice does not redecompress it.');
		} else {
			item.iconPath = new vscode.ThemeIcon('circle-outline');
			item.description = 'not downloaded';
			md.appendMarkdown('Not downloaded yet. Use the download icon on this row, or expand it, to sync.');
		}
		item.tooltip = md;
		item.contextValue = `sigdb-scope-${scope}-${state.manifest ? 'downloaded' : 'missing'}`;
		return item;
	}

	private syncTreeItem(scope: Scope): vscode.TreeItem {
		const item = new vscode.TreeItem(`↓ Download ${ScopeLabel[scope]}`, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('cloud-download');
		item.command = { title: 'Download', command: 'vscode-flowr.sigdb.downloadScope', arguments: [{ kind: 'scope', scope } satisfies SigDbNode] };

		const pointer = readSigDbRemotePointer();
		const md = new vscode.MarkdownString();
		if(pointer) {
			md.appendMarkdown(`**Download from:** https://github.com/${pointer.repo}/releases/tag/${pointer.tag}\n\n`);
			md.appendMarkdown(`**Destination:** ${getSigDbBundleDir() ?? getSigDbCacheDir()}\n\n`);
			md.appendMarkdown(SigDbShardGroups[scope].length > 1
				? 'Asks which shards to download; already-downloaded ones are skipped either way.'
				: 'Downloads every shard for this scope; already-downloaded shards are skipped.');
		} else {
			md.appendMarkdown('No release pointer bundled with this build of the extension.');
		}
		item.tooltip = md;
		return item;
	}

	private versionTreeItem(scope: Scope, pkg: string, version: string): vscode.TreeItem {
		const item = new vscode.TreeItem(version ? `v${version}` : '(unversioned)', vscode.TreeItemCollapsibleState.Collapsed);
		item.iconPath = new vscode.ThemeIcon('tag');
		return item;
	}

	private async functionTreeItem(node: { scope: Scope, pkg: string, version: string, name: string }): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('symbol-function');

		const source = await this.openScopeSource(node.scope);
		if(!source) {
			return item;
		}
		const version = node.version || undefined;
		try {
			const fn = source.functions(node.pkg, version)?.find(f => f.name === node.name);
			if(!fn) {
				return item;
			}

			const exportsInfo = source.lookup(node.pkg, version);
			const deprecated = fn.props.includes('deprecated') || (exportsInfo?.deprecated.includes(node.name) ?? false);
			const canThrow = fn.props.includes('can-throw');
			const nonDeterministic = fn.props.includes('non-deterministic');
			const s3generic = isSigDbFunctionS3Generic(source, node.pkg, node.name, version);
			const base = source.isBaseR(node.pkg);
			const cran = exportsInfo?.cran ?? false;
			const sourceUrl = cran && !base && fn.file ? cranMirrorSourceUrl(node.pkg, version, fn.file, fn.line) : undefined;
			// `no-doc` marks a function proven undocumented; `fn.topic` is its real Rd help topic if not its own name
			const docUrl = fn.exported && !fn.props.includes('no-doc') ? rdrrDocUrl(node.pkg, fn.topic ?? node.name, { base, cran }) : undefined;
			const helpDoc = docUrl ? await getHelpDoc(node.pkg, node.name) : undefined;

			item.description = `(${formatSignature(fn.signature)})${deprecated ? ' deprecated' : ''}${sourceUrl ? ' ↗' : ''}`;
			if(sourceUrl) {
				item.command = { title: 'Open Source', command: 'vscode.open', arguments: [vscode.Uri.parse(sourceUrl)] };
			}

			const md = new vscode.MarkdownString();
			md.appendMarkdown(`\`\`\`r\n${fn.name}(${formatSignature(fn.signature)})\n\`\`\`\n\n`);
			if(deprecated) {
				md.appendMarkdown('⚠️ **Deprecated**\n\n');
			}
			md.appendMarkdown(`${fn.exported ? 'Exported' : 'Internal'} function of \`${node.pkg}\`.\n`);
			if(helpDoc?.title) {
				md.appendMarkdown(`\n**${helpDoc.title}**\n`);
			}
			const flags = [
				s3generic ? '🔀 S3 generic' : undefined,
				canThrow ? '⚠ can throw' : undefined,
				nonDeterministic ? '🎲 non-deterministic' : undefined
			].filter((f): f is string => !!f);
			if(flags.length > 0) {
				md.appendMarkdown(`\n${flags.join(' &nbsp;•&nbsp; ')}\n`);
			}
			if(fn.callees.length > 0) {
				md.appendMarkdown(`\n**Calls:** ${fn.callees.slice(0, 20).map(c => `\`${c}\``).join(', ')}${fn.callees.length > 20 ? ', …' : ''}\n`);
			}
			const links = [sourceUrl ? `[View source](${sourceUrl})` : undefined, docUrl ? `[Documentation](${docUrl})` : undefined].filter(Boolean);
			if(links.length > 0) {
				md.appendMarkdown(`\n${links.join(' · ')}\n`);
			}
			if(version) {
				md.appendMarkdown(`\n*via \`${node.scope}\` signature database, v${version}*`);
			}
			md.isTrusted = true;
			item.tooltip = md;
		} catch(e) {
			this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		}
		return item;
	}
}

export interface SigDbSearchQuery {
	pkg:                 string;
	version?:            string;
	fnName?:             string;
	/** keep only functions with a parameter matching every one of these names (glob wildcards allowed, position-independent) - `--param`/`-p` */
	parameters?:         string[];
	/** keep only functions with exactly this many required (no-default) parameters, excluding `...` - `--required`/`--req` */
	requiredParameters?: number;
}

/**
 * Tokenizes on whitespace and parses exactly like flowR's own `:signature query` REPL command (see
 * signatureQueryLineParser in signature-query-format.js): `--param <name>` (repeatable, comma-separable) and
 * `--required <n>` are pulled out first, then the remaining positional tokens are `<pkg>[@<version>]` and,
 * optionally, a second `<pkg>::<fn>`/`<fn>` token - so `pkg fn` and `pkg@version fn` both work, matching flowR's own
 * syntax. `pkg@version` (and `pkg::fn`) must stay one contiguous token each - flowR's own parser has no notion of
 * spaces inside either.
 */
export function parseSigDbSearchQuery(query: string): SigDbSearchQuery | undefined {
	const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
	const parameters: string[] = [];
	let requiredParameters: number | undefined;
	const positional: string[] = [];
	for(let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if(tok === '--param' || tok === '-p') {
			parameters.push(...(tokens[++i] ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0));
		} else if(tok === '--required' || tok === '--req') {
			const n = Number(tokens[++i]);
			if(!Number.isNaN(n)) {
				requiredParameters = n;
			}
		} else if(!tok.startsWith('--')) {
			positional.push(tok);
		}
	}
	const paramFilters = { parameters: parameters.length > 0 ? parameters : undefined, requiredParameters };
	const [first, second] = positional;
	if(!first) {
		// a bare parameter filter (`--param fuzz`) searches every package; otherwise there is nothing to look up
		return (parameters.length > 0 || requiredParameters !== undefined) ? { pkg: '*', version: undefined, fnName: undefined, ...paramFilters } : undefined;
	}
	const dbl = first.indexOf('::');
	const left = dbl >= 0 ? first.slice(0, dbl) : first;
	const fnFromColon = dbl >= 0 ? first.slice(dbl + 2) : undefined;
	const at = left.indexOf('@');
	const pkg = at >= 0 ? left.slice(0, at) : left;
	const version = at >= 0 ? (left.slice(at + 1) || undefined) : undefined;
	const fnName = second ?? fnFromColon;
	return pkg ? { pkg, version, fnName, ...paramFilters } : undefined;
}

export interface SigDbSearchMatch {
	scope:    Scope;
	pkg:      string;
	version?: string;
	fnName?:  string;
}

/** mirrors flowR's own `parameterFilter` (signature-query-executor.ts) */
function matchesParameterFilter(fn: DecodedFunction, parameters: string[] | undefined, requiredParameters: number | undefined): boolean {
	if(parameters && !parameters.every(pat => fn.signature.some(p => matchesPattern(pat, p.name)))) {
		return false;
	}
	return requiredParameters === undefined || fn.signature.filter(p => p.name !== '...' && (p.props & ArgProp.NoDefault) !== 0).length === requiredParameters;
}

/** resolves a parsed query against every downloaded scope with flowR's own wildcard semantics; a plain exact name stays a cheap has() check */
export async function findSigDbMatches(
	query: SigDbSearchQuery, output: vscode.OutputChannel, restrictTo: Scope | undefined, progress?: vscode.Progress<{ message?: string }>
): Promise<SigDbSearchMatch[]> {
	const { pkg: pkgPattern, version: versionPattern, fnName: fnPattern, parameters, requiredParameters } = query;
	const pkgIsGlob = GlobChars.test(pkgPattern);
	const fnIsGlob = fnPattern !== undefined && GlobChars.test(fnPattern);
	const hasParamFilter = (parameters?.length ?? 0) > 0 || requiredParameters !== undefined;
	const matches: SigDbSearchMatch[] = [];

	for(const scope of restrictTo ? [restrictTo] : Scopes) {
		// search only the shards present on disk, so a partial download can't route lookups to a missing shard file
		const source = await getScopeSource(scope, msg => output.appendLine(`[SigDB] ${msg}`));
		if(!source) {
			continue;
		}
		progress?.report({ message: `Scanning ${ScopeLabel[scope]}…` });

		const candidatePkgs = pkgIsGlob ? source.packageNames().filter(p => matchesPattern(pkgPattern, p)) : (source.has(pkgPattern) ? [pkgPattern] : []);
		for(const pkg of candidatePkgs) {
			let versions: (string | undefined)[];
			if(versionPattern) {
				versions = (safeSigDbCall(() => source.releaseDates(pkg)) ?? []).map(r => r.version.str).filter(v => matchesVersion(versionPattern, v));
				const latest = safeLatestVersionStr(source, pkg);
				if(versions.length === 0 && latest && matchesVersion(versionPattern, latest)) {
					versions = [latest];
				}
			} else {
				versions = [safeLatestVersionStr(source, pkg)];
			}

			for(const version of versions) {
				if(fnPattern || hasParamFilter) {
					for(const fn of safeFunctionsOf(source, pkg, version)) {
						const nameMatches = fnPattern === undefined || (fnIsGlob ? matchesPattern(fnPattern, fn.name) : fn.name === fnPattern);
						if(nameMatches && matchesParameterFilter(fn, parameters, requiredParameters)) {
							matches.push({ scope, pkg, version, fnName: fn.name });
						}
					}
				} else {
					matches.push({ scope, pkg, version });
				}
			}
		}
	}
	return matches;
}

async function runSync(dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	const pointer = readSigDbRemotePointer();
	const choice = await vscode.window.showInformationMessage(
		pointer
			? `Sync signature databases from ${pointer.tag}? Already-downloaded shards are skipped.`
			: 'Sync signature databases from the latest flowR release?',
		'Sync',
		'Cancel'
	);
	if(choice !== 'Sync') {
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Syncing signature databases', cancellable: false },
		async progress => {
			// go through our own downloadSigDbScope() per scope, not flowR's downloadFullSigDb(): the latter
			// locates the committed pointer relative to its own source file (__dirname), which once webpacked
			// into a single bundle no longer resolves to anything real - it then silently falls back to guessing
			// a release tag from the *running flowR package's own version* (`sigdb-v<flowR version>`), which is
			// not the same release cadence as the sigdb data and 404s. downloadSigDbScope reads the bundled
			// dist/node/sigdb/sigdb.remote.json directly (see readSigDbRemotePointer's own doc comment), so it
			// isn't affected by this.
			// each scope downloads independently: a failure on one (e.g. a network blip on the large `history`
			// scope) must not throw away `base`/`current` succeeding, so every scope gets its own try/catch
			// rather than one that aborts the whole loop on the first error
			let totalFiles = 0;
			const failures: string[] = [];
			for(const scope of Scopes) {
				try {
					const result = await downloadSigDbScope(scope, msg => {
						output.appendLine(`[SigDB] [${scope}] ${msg}`);
						progress.report({ message: `${ScopeLabel[scope]}: ${msg}` });
					});
					totalFiles += result.files.length;
				} catch(e) {
					const message = e instanceof Error ? e.message : String(e);
					output.appendLine(`[SigDB] [${scope}] sync failed: ${message}`);
					failures.push(`${ScopeLabel[scope]} (${message})`);
				}
			}
			output.appendLine(`[SigDB] Sync ${failures.length > 0 ? 'partially ' : ''}complete: ${totalFiles} file(s)${failures.length > 0 ? `, failed: ${failures.join('; ')}` : ''}`);
			if(failures.length === 0) {
				vscode.window.showInformationMessage('Signature databases synced.');
			} else if(totalFiles > 0) {
				vscode.window.showWarningMessage(`Signature databases partially synced; failed: ${failures.join('; ')}`);
			} else {
				vscode.window.showErrorMessage(`Signature database sync failed: ${failures.join('; ')}`);
			}
			// an already-running flowR session bakes its sigdb paths in at construction; drop it so the next analysis sees what was just synced
			refreshSigDbConfig();
			dataProvider.refresh();
		}
	);
}

async function runDownloadScope(scope: Scope, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	const groups = SigDbShardGroups[scope];
	const downloaded = getDownloadedShardGroups(scope);
	let shardIds: string[] | undefined;
	let label = ScopeLabel[scope];

	if(groups.length > 1) {
		const picked = await vscode.window.showQuickPick(
			groups.map(g => ({ label: g.label, description: downloaded.has(g.id) ? 'already downloaded' : '', g })),
			{ placeHolder: `Which ${ScopeLabel[scope]} shards to download?` }
		);
		if(!picked) {
			return;
		}
		shardIds = picked.g.shardIds;
		label = `${ScopeLabel[scope]} (${picked.g.label})`;
	}

	const controller = new AbortController();
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Downloading ${label}`, cancellable: true },
		async(progress, cancelToken) => {
			cancelToken.onCancellationRequested(() => controller.abort());
			try {
				const result = await downloadSigDbScope(scope, msg => {
					output.appendLine(`[SigDB] ${msg}`);
					progress.report({ message: msg });
				}, controller.signal, shardIds);
				output.appendLine(`[SigDB] ${label} synced: ${result.files.length} file(s) in ${result.dir}`);
				vscode.window.showInformationMessage(`${label} downloaded.`);
			} catch(e) {
				if(!cancelToken.isCancellationRequested) {
					const message = e instanceof Error ? e.message : String(e);
					output.appendLine(`[SigDB] ${label} download failed: ${message}`);
					vscode.window.showErrorMessage(`Failed to download ${label}: ${message}`);
				}
			}
			refreshSigDbConfig();
			dataProvider.refresh();
		}
	);
}

async function runRemoveScope(scope: Scope, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	if(scope === 'base') {
		vscode.window.showWarningMessage('Base R signatures are required for basic symbol resolution and cannot be removed once downloaded.');
		return;
	}

	const groups = SigDbShardGroups[scope];
	const downloaded = getDownloadedShardGroups(scope);
	let shardIds: string[] | undefined;
	let label = ScopeLabel[scope];

	if(groups.length > 1) {
		const options = [
			...groups.filter(g => downloaded.has(g.id)).map(g => ({ label: g.label, g })),
			{ label: `Everything (all of ${ScopeLabel[scope]})`, g: undefined }
		];
		const picked = await vscode.window.showQuickPick(options, { placeHolder: `What to remove from ${ScopeLabel[scope]}?` });
		if(!picked) {
			return;
		}
		shardIds = picked.g?.shardIds;
		label = picked.g ? `${ScopeLabel[scope]} (${picked.g.label})` : ScopeLabel[scope];
	}

	const choice = await vscode.window.showWarningMessage(
		`Remove the downloaded "${label}" signature database from disk? It can be re-downloaded later.`,
		'Remove',
		'Cancel'
	);
	if(choice !== 'Remove') {
		return;
	}
	const { removed } = removeSigDbScope(scope, shardIds);
	output.appendLine(`[SigDB] Removed ${removed.length} file(s) for ${label}: ${removed.join(', ')}`);
	vscode.window.showInformationMessage(`${label} removed (${removed.length} file${removed.length === 1 ? '' : 's'}).`);
	refreshSigDbConfig();
	dataProvider.refresh();
}

/** the chain of ancestors from the root down to (and including) `node`, using getParent() */
function ancestorChain(dataProvider: SigDbTreeDataProvider, node: SigDbNode): SigDbNode[] {
	const chain: SigDbNode[] = [node];
	let current = node;
	for(;;) {
		const parent = dataProvider.getParent(current);
		if(!parent) {
			break;
		}
		chain.unshift(parent);
		current = parent;
	}
	return chain;
}

/** runs `command` only if the host actually registers it, so a fork/version that names things differently (e.g. Positron) or a not-yet-ready view degrades quietly instead of throwing "command not found"/"No view is registered" */
async function runCommandIfAvailable(command: string, output: vscode.OutputChannel): Promise<void> {
	if(!(await vscode.commands.getCommands(true)).includes(command)) {
		output.appendLine(`[SigDB] Command "${command}" is not available on this host; skipping.`);
		return;
	}
	try {
		await vscode.commands.executeCommand(command);
	} catch(e) {
		output.appendLine(`[SigDB] Command "${command}" failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** reveals `node`; VS Code's own `reveal()` won't force a lazy scope/package to load, so we walk the chain top-down first to materialize it */
async function revealSafely(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, node: SigDbNode, output: vscode.OutputChannel, label: string): Promise<void> {
	const chain = ancestorChain(dataProvider, node);
	for(const n of chain) {
		dataProvider.pin(nodeId(n));
	}
	await runCommandIfAvailable('workbench.view.extension.flowr', output);
	await runCommandIfAvailable(`${FlowrSigDbViewId}.focus`, output);
	try {
		// force every ancestor level to actually materialize before asking VS Code to find the leaf
		let parent: SigDbNode | undefined;
		for(const n of chain) {
			await dataProvider.getChildren(parent);
			parent = n;
		}
		await treeView.reveal(node, { select: true, focus: true, expand: true });
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		output.appendLine(`[SigDB] Could not reveal ${label} in the tree: ${message}`);
		vscode.window.showInformationMessage(`Found ${label}, but couldn't scroll to it in the tree (${message}) - open the Signature DB view and expand it manually.`);
	}
}

async function revealSearchMatch(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, m: SigDbSearchMatch, output: vscode.OutputChannel): Promise<void> {
	dataProvider.pin(nodeId({ kind: 'package', scope: m.scope, pkg: m.pkg }));
	if(m.fnName) {
		await revealSafely(treeView, dataProvider, { kind: 'function', scope: m.scope, pkg: m.pkg, version: m.version ?? '', name: m.fnName }, output, `"${m.pkg}::${m.fnName}"`);
	} else {
		await revealSafely(treeView, dataProvider, { kind: 'package', scope: m.scope, pkg: m.pkg }, output, `"${m.pkg}"`);
	}
}

let searchInFlight = false;

async function runSearch(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel, restrictTo?: Scope): Promise<void> {
	if(searchInFlight) {
		return;
	}
	searchInFlight = true;
	try {
		await runSearchImpl(treeView, dataProvider, output, restrictTo);
	} finally {
		searchInFlight = false;
	}
}

async function runSearchImpl(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel, restrictTo?: Scope): Promise<void> {
	const query = await vscode.window.showInputBox({
		prompt: restrictTo
			? `Package, pkg::fn/pkg fn, pkg@version, --param <name>, --required <n> - globs allowed - in ${ScopeLabel[restrictTo]}`
			: 'Package, pkg::fn/pkg fn, pkg@version, --param <name>, --required <n> - globs allowed',
		placeHolder: 'e.g. ggplot2, ggplot2 ggplot, dplyr::mutate, ggp*, ggplot2@3.*::ggp*, --param x,y*, mutate --required 2'
	});
	if(!query) {
		return;
	}
	const parsed = parseSigDbSearchQuery(query);
	if(!parsed) {
		return;
	}

	let matches = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}"`, cancellable: false },
		progress => findSigDbMatches(parsed, output, restrictTo, progress)
	);

	// a bare term is tried as a package name first, then as a function name across every package (mirrors flowR's own signature query)
	if(matches.length === 0 && !parsed.fnName && !parsed.version && !parsed.parameters && parsed.requiredParameters === undefined) {
		matches = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}" as a function name`, cancellable: false },
			progress => findSigDbMatches({ pkg: '*', fnName: parsed.pkg }, output, restrictTo, progress)
		);
	}

	if(matches.length === 0) {
		const where = restrictTo ? ScopeLabel[restrictTo] : 'any downloaded signature database';
		output.appendLine(`[SigDB] Search: "${query}" had no matches in ${where}`);
		vscode.window.showWarningMessage(`"${query}" had no matches in ${where}.`);
		return;
	}
	if(matches.length === 1) {
		await revealSearchMatch(treeView, dataProvider, matches[0], output);
		return;
	}

	const picked = await vscode.window.showQuickPick(
		matches.slice(0, 200).map(m => ({
			label:       m.fnName ? `${m.pkg}::${m.fnName}` : m.pkg,
			description: `${ScopeLabel[m.scope]}${m.version ? ` • v${m.version}` : ''}`,
			m
		})),
		{ placeHolder: `${matches.length} matches for "${query}"${matches.length > 200 ? ' (showing first 200)' : ''} - pick one` }
	);
	if(picked) {
		await revealSearchMatch(treeView, dataProvider, picked.m, output);
	}
}

/** registers the SigDB sidebar view; every value shown is read live from disk, nothing is estimated or hardcoded */
export function registerSigDbView(context: vscode.ExtensionContext, output: vscode.OutputChannel): { dispose: () => void } {
	const dataProvider = new SigDbTreeDataProvider(output);
	const disposables: vscode.Disposable[] = [];

	const treeView = vscode.window.createTreeView(FlowrSigDbViewId, {
		treeDataProvider: dataProvider,
		showCollapseAll:  true
	});
	disposables.push(treeView, dataProvider);

	registerCommand(context, 'vscode-flowr.sigdb.refresh', () => {
		output.appendLine('[SigDB] Refreshing...');
		dataProvider.refresh();
	});

	registerCommand(context, 'vscode-flowr.sigdb.download', async() => {
		await runSync(dataProvider, output);
	});

	registerCommand(context, 'vscode-flowr.sigdb.downloadScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runDownloadScope(node.scope, dataProvider, output);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.removeScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runRemoveScope(node.scope, dataProvider, output);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.search', async() => {
		await runSearch(treeView, dataProvider, output);
	});

	registerCommand(context, 'vscode-flowr.sigdb.searchScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runSearch(treeView, dataProvider, output, node.scope);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.settings.open', async() => {
		await vscode.commands.executeCommand('workbench.action.openSettings', `${Settings.Category}.config.solver.sigdb`);
	});

	disposables.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if(e.affectsConfiguration(Settings.Category)) {
				dataProvider.refresh();
			}
		})
	);

	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		dispose: (): void => disposables.forEach(d => d.dispose())
	};
}
