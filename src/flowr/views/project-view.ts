import * as vscode from 'vscode';
import { Settings } from '../../settings';
import { baseRPackages, isSigDbEnabled, findSigDbPackageSource, safeLatestVersionStr, safeSigDbCall } from '../../package-db';
import { getInstalledPackageVersions } from '../../installed-packages';
import { setProjectDeclaredRVersion } from '../../extension';
import { RRange } from '@eagleoutice/flowr/util/r-version';
import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import { FlowrDescriptionFile } from '@eagleoutice/flowr/project/plugins/file-plugins/files/flowr-description-file';
import { FlowrRProjectFile, FlowrUvrManifestFile } from '@eagleoutice/flowr/project/plugins/file-plugins/files/flowr-manifest-files';
import type { Package } from '@eagleoutice/flowr/project/plugins/package-version-plugins/package';
import { minVersion } from 'semver';

export const FlowrProjectViewId = 'flowr-project';

type MatchStatus = 'matched' | 'base' | 'unmatched' | 'db-unavailable';

interface LibraryMatch {
	status:       MatchStatus;
	dbVersion?:   string;
	/** with a declared version: whether any downloaded database version covers it (see {@link classifyLibrary}) */
	dbSatisfies?: boolean;
	exportCount?: number;
}

/** classifies a declared library against base R and the on-disk sigdb; with a declaredVersion, also resolves the latest covering db version */
export async function classifyLibrary(name: string, declaredVersion?: string): Promise<LibraryMatch> {
	if(baseRPackages.has(name)) {
		return { status: 'base' };
	}
	if(!isSigDbEnabled()) {
		return { status: 'db-unavailable' };
	}
	const found = await findSigDbPackageSource(name);
	if(!found) {
		return { status: 'unmatched' };
	}
	let dbVersion = safeLatestVersionStr(found.source, name);
	let dbSatisfies: boolean | undefined;
	if(declaredVersion) {
		if(dbVersion && satisfiesDeclaredVersion(dbVersion, declaredVersion)) {
			dbSatisfies = true;
		} else {
			const releases = safeSigDbCall(() => found.source.releaseDates(name)) ?? [];
			const newestSatisfying = [...releases].reverse().find(r => satisfiesDeclaredVersion(r.version.str, declaredVersion));
			if(newestSatisfying) {
				dbVersion = newestSatisfying.version.str;
				dbSatisfies = true;
			} else {
				dbSatisfies = false;
			}
		}
	}
	const exportCount = safeSigDbCall(() => found.source.lookup(name, dbVersion))?.exported.length;
	return { status: 'matched', dbVersion, dbSatisfies, exportCount };
}

export interface DeclaredLibrary {
	name:             string;
	/** version as declared in the manifest: an exact pin for lockfiles, a constraint like `>= 1.2` for a DESCRIPTION */
	declaredVersion?: string;
}

/** how a lockfile relates to its declaring manifest in the same folder (renv.lock ↔ DESCRIPTION, rv.lock ↔ rproject.toml) */
export interface LockfileSyncReport {
	/** the declaring manifest's file name */
	partner:     string;
	/** declared packages that are absent from the lockfile */
	missing:     string[];
	/** declared version constraints the locked version does not satisfy */
	unsatisfied: { name: string, constraint: string, locked: string }[];
}

interface ProjectManifest {
	/** absolute path of the manifest file */
	uri:               vscode.Uri;
	/** short, human-readable label (relative to the workspace folder) */
	label:             string;
	/** e.g. `renv`, `DESCRIPTION`, `rv` */
	kind:              string;
	/** whether this manifest pins resolved, exact versions (a `*.lock` file) rather than declaring constraints */
	lockfile:          boolean;
	/** the package/project this manifest itself describes, if any */
	packageName?:      string;
	/** the version this manifest declares for itself, if any */
	packageVersion?:   string;
	/** the R version the project declares (renv.lock's `R.Version`, rproject.toml's `r_version`, a DESCRIPTION's `Depends: R (>= …)` minimum) */
	declaredRVersion?: string;
	/** for lockfiles: how it compares against the declaring manifest in the same folder, if one exists */
	sync?:             LockfileSyncReport;
	libraries:         DeclaredLibrary[];
}

/** the tree is two levels deep: manifests at the top, their libraries below */
type ProjectNode =
	| { type: 'manifest', manifest: ProjectManifest }
	| ({ type: 'library', manifest: ProjectManifest, library: DeclaredLibrary, installedVersion?: string, rAvailable?: boolean } & LibraryMatch);

type LibraryNode = Extract<ProjectNode, { type: 'library' }>;

/** how a given match status is surfaced in the tree (icon, themable color, short badge and a tooltip) */
interface StatusPresentation {
	icon:    string;
	color?:  string;
	badge:   (node: LibraryNode) => string;
	tooltip: (node: LibraryNode) => string;
}

const statusPresentations: Record<MatchStatus, StatusPresentation> = {
	matched: {
		icon:  'pass',
		color: 'testing.iconPassed',
		badge: node => node.dbSatisfies === false
			? `in DB: v${node.dbVersion} (declared ${node.library.declaredVersion} not covered)`
			: `in DB: v${node.dbVersion}`,
		tooltip: node => node.dbSatisfies === false
			? `\`${node.library.name}\` is in the package database, but no downloaded version covers the declared \`${node.library.declaredVersion}\` (closest: v${node.dbVersion}). Signature lookups fall back to that version; downloading the full-history scope may add the declared one.`
			: `\`${node.library.name}\` is in the package database (v${node.dbVersion}, ${node.exportCount} exported identifiers${node.dbSatisfies && node.library.declaredVersion ? `, covering the declared \`${node.library.declaredVersion}\`` : ''}).`
	},
	base: {
		icon:    'library',
		badge:   () => 'bundled with R',
		tooltip: node => `\`${node.library.name}\` is a base package that is part of R itself.`
	},
	unmatched: {
		icon:    'circle-slash',
		color:   'testing.iconFailed',
		badge:   () => 'not in package DB',
		tooltip: node => `\`${node.library.name}\` was not found in the package database. flowR cannot resolve its exports or definitions.`
	},
	'db-unavailable': {
		icon:    'question',
		badge:   () => 'package DB unavailable',
		tooltip: node => `The package database is disabled or could not be loaded, so \`${node.library.name}\` could not be matched.`
	}
};

/** registers the "Project" sidebar view: detects R manifests in the workspace and shows whether flowR's sigdb knows each declared library */
export function registerProjectView(output: vscode.OutputChannel): { dispose: () => void } {
	const data = new FlowrProjectTreeView(output);
	const disposables: vscode.Disposable[] = [];
	let treeView: vscode.TreeView<ProjectNode> | undefined;

	// re-scan when project manifests appear/change/disappear or the workspace layout changes
	const watcher = vscode.workspace.createFileSystemWatcher('**/{renv.lock,DESCRIPTION,rv.lock,rproject.toml,uvr.toml}');
	const refresh = () => void data.refresh();
	watcher.onDidCreate(refresh);
	watcher.onDidChange(refresh);
	watcher.onDidDelete(refresh);
	disposables.push(
		watcher,
		vscode.workspace.onDidChangeWorkspaceFolders(refresh),
		vscode.workspace.onDidChangeConfiguration(e => {
			if(e.affectsConfiguration(Settings.Category)) {
				refresh();
			}
		})
	);

	void (async() => {
		try {
			treeView = vscode.window.createTreeView(FlowrProjectViewId, { treeDataProvider: data });
			data.setTreeView(treeView);
		} catch(e) {
			output.appendLine(`[Project View] Could not create the tree view: ${(e as Error).message}`);
		}
		await data.refresh();
	})();

	return {
		dispose: () => {
			treeView?.dispose();
			data.dispose();
			for(const d of disposables) {
				d.dispose();
			}
		}
	};
}

class FlowrProjectTreeView implements vscode.TreeDataProvider<ProjectNode> {
	private readonly output: vscode.OutputChannel;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | undefined>();
	readonly onDidChangeTreeData          = this._onDidChangeTreeData.event;
	private manifests:       ProjectManifest[] = [];
	private tv:              vscode.TreeView<ProjectNode> | undefined;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	setTreeView(tv: vscode.TreeView<ProjectNode>): void {
		this.tv = tv;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	async refresh(): Promise<void> {
		this.manifests = await detectManifests(this.output);
		setProjectDeclaredRVersion(pickDeclaredRVersion(this.manifests));
		if(this.tv) {
			const total = this.manifests.reduce((n, m) => n + m.libraries.length, 0);
			this.tv.message = this.manifests.length === 0
				? 'No project manifest (renv.lock, DESCRIPTION, rv.lock, rproject.toml) found in this workspace.'
				: `Found ${this.manifests.length} manifest${this.manifests.length === 1 ? '' : 's'} declaring ${total} librar${total === 1 ? 'y' : 'ies'}.`;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: ProjectNode): vscode.TreeItem {
		if(element.type === 'manifest') {
			return manifestTreeItem(element.manifest);
		}
		return libraryTreeItem(element);
	}

	async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
		if(!element) {
			return this.manifests.map(manifest => ({ type: 'manifest', manifest }));
		}
		if(element.type === 'manifest') {
			const installed = await getInstalledPackageVersions();
			return Promise.all(element.manifest.libraries.map(async library => ({
				type:             'library' as const,
				manifest:         element.manifest,
				library,
				installedVersion: installed?.get(library.name),
				rAvailable:       installed !== undefined,
				...await classifyLibrary(library.name, library.declaredVersion)
			})));
		}
		return [];
	}
}

/** a short badge + tooltip for a lockfile's sync state against its declaring manifest */
function syncPresentation(sync: LockfileSyncReport): { badge: string, tooltip: string } {
	if(sync.missing.length === 0 && sync.unsatisfied.length === 0) {
		return { badge: `in sync with ${sync.partner}`, tooltip: `Every package the \`${sync.partner}\` declares is pinned by this lockfile with a satisfying version.` };
	}
	const parts = [
		sync.missing.length > 0 ? `${sync.missing.length} missing` : undefined,
		sync.unsatisfied.length > 0 ? `${sync.unsatisfied.length} version conflict${sync.unsatisfied.length === 1 ? '' : 's'}` : undefined
	].filter(Boolean);
	const details = [
		sync.missing.length > 0 ? `Declared in \`${sync.partner}\` but missing from the lockfile: ${sync.missing.map(m => `\`${m}\``).join(', ')}.` : undefined,
		...sync.unsatisfied.map(u => `\`${u.name}\`: locked \`v${u.locked}\` does not satisfy the declared \`${u.constraint}\`.`)
	].filter(Boolean);
	return { badge: `out of sync with ${sync.partner} (${parts.join(', ')})`, tooltip: details.join('\n\n') };
}

function manifestTreeItem(manifest: ProjectManifest): vscode.TreeItem {
	// when the manifest describes a package/project itself, surface that name and version
	const libraryCount = `${manifest.libraries.length} librar${manifest.libraries.length === 1 ? 'y' : 'ies'}`;
	const item = new vscode.TreeItem(manifest.packageName ?? manifest.label, vscode.TreeItemCollapsibleState.Expanded);
	const sync = manifest.sync && syncPresentation(manifest.sync);
	const outOfSync = manifest.sync && (manifest.sync.missing.length > 0 || manifest.sync.unsatisfied.length > 0);
	item.description = [
		manifest.packageVersion && `v${manifest.packageVersion}`,
		manifest.kind,
		manifest.lockfile ? 'lockfile' : undefined,
		manifest.declaredRVersion && `R ${manifest.declaredRVersion}`,
		libraryCount,
		sync?.badge
	].filter(Boolean).join(' · ');
	item.iconPath = manifest.lockfile
		? new vscode.ThemeIcon(outOfSync ? 'unlock' : 'lock', outOfSync ? new vscode.ThemeColor('list.warningForeground') : undefined)
		: new vscode.ThemeIcon('package');
	if(sync?.tooltip || manifest.declaredRVersion) {
		item.tooltip = new vscode.MarkdownString([
			manifest.declaredRVersion && `Declares R \`${manifest.declaredRVersion}\`${manifest.lockfile ? '' : ' (minimum)'} - used as flowR's assumed R version instead of the default.`,
			sync?.tooltip
		].filter(Boolean).join('\n\n'));
	}
	item.resourceUri = manifest.uri;
	const title = manifest.packageName
		? `\`${manifest.packageName}\`${manifest.packageVersion ? ` v${manifest.packageVersion}` : ''} — ${manifest.kind}`
		: `Detected ${manifest.kind} manifest`;
	item.tooltip = new vscode.MarkdownString(`${title}\n\n\`${manifest.uri.fsPath}\``);
	item.command = { command: 'vscode.open', title: 'Open manifest', arguments: [manifest.uri] };
	return item;
}

/** the local-installation part of a library row (only meaningful when R itself was reachable) */
function installedPresentation(node: LibraryNode): { badge?: string, tooltip?: string } {
	if(!node.rAvailable || node.status === 'base') {
		return {};
	}
	if(node.installedVersion === undefined) {
		return { badge: 'not installed', tooltip: `\`${node.library.name}\` is not installed in the local R library.` };
	}
	const declared = node.library.declaredVersion;
	if(declared && !satisfiesDeclaredVersion(node.installedVersion, declared)) {
		return {
			badge:   `installed ${node.installedVersion} ≠ ${declared}`,
			tooltip: `Installed locally as v${node.installedVersion}, but the manifest declares \`${declared}\`.`
		};
	}
	return { badge: `installed ${node.installedVersion}`, tooltip: `Installed locally as v${node.installedVersion}.` };
}

function libraryTreeItem(node: LibraryNode): vscode.TreeItem {
	const present = statusPresentations[node.status];
	const installed = installedPresentation(node);
	const item = new vscode.TreeItem(node.library.name, vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon(present.icon, present.color ? new vscode.ThemeColor(present.color) : undefined);
	const declared = node.library.declaredVersion ? `declared ${node.library.declaredVersion}` : undefined;
	item.description = [declared, present.badge(node), installed.badge].filter(Boolean).join(' · ');
	item.tooltip = new vscode.MarkdownString([present.tooltip(node), installed.tooltip].filter(Boolean).join('\n\n'));
	return item;
}

/* ------------------------------------------------------------------ detection ------------------------------------------------------------------ */

/** binds a manifest file name to the project kind it represents and the reader that lifts it */
interface ManifestDetector {
	file:     string;
	kind:     string;
	lockfile: boolean;
	/** the declaring manifest in the same folder this lockfile resolves (checked for sync) */
	partner?: string;
	/** what the manifest declares, plus what it says about itself (name/version/declared R version) */
	read:     (content: string, path: string) => ManifestMeta & { libraries: DeclaredLibrary[] };
}

const manifestDetectors: readonly ManifestDetector[] = [
	{ file: 'renv.lock', kind: 'renv', lockfile: true, partner: 'DESCRIPTION', read: readRenvLock },
	{ file: 'DESCRIPTION', kind: 'DESCRIPTION', lockfile: false, read: readDescription },
	{ file: 'rv.lock', kind: 'rv', lockfile: true, partner: 'rproject.toml', read: readRvLock },
	{ file: 'rproject.toml', kind: 'rv', lockfile: false, read: readRProject },
	{ file: 'uvr.toml', kind: 'uvr', lockfile: false, read: readUvrManifest }
];

/** the R version the project declares: an exact lockfile pin wins over a DESCRIPTION's Depends minimum */
export function pickDeclaredRVersion(manifests: readonly { declaredRVersion?: string, kind: string }[]): string | undefined {
	const exact = manifests.find(m => m.declaredRVersion && m.kind !== 'DESCRIPTION');
	return (exact ?? manifests.find(m => m.declaredRVersion))?.declaredRVersion;
}

async function detectManifests(output: vscode.OutputChannel): Promise<ProjectManifest[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const manifests: ProjectManifest[] = [];
	for(const folder of folders) {
		const perFolder: ProjectManifest[] = [];
		for(const { file, kind, lockfile, read } of manifestDetectors) {
			const uri = vscode.Uri.joinPath(folder.uri, file);
			let content: string;
			try {
				content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			} catch{
				continue; // file does not exist
			}
			try {
				const { libraries, ...meta } = read(content, uri.fsPath);
				perFolder.push({ uri, label: file, kind, lockfile, ...meta, libraries: dedupeLibraries(libraries) });
			} catch(e) {
				output.appendLine(`[Project View] Failed to parse ${uri.fsPath}: ${(e as Error).message}`);
				perFolder.push({ uri, label: file, kind, lockfile, libraries: [] });
			}
		}
		for(const manifest of perFolder) {
			const partnerName = manifestDetectors.find(d => d.file === manifest.label)?.partner;
			const partner = partnerName && perFolder.find(m => m.label === partnerName);
			if(partner) {
				manifest.sync = lockfileSyncReport(partner.label, partner.libraries, manifest.libraries);
			}
		}
		manifests.push(...perFolder);
	}
	return manifests;
}

/** whether `version` satisfies a manifest's declared constraint via flowR's own RRange; an unparseable declaration is treated as satisfied (fail-open) */
export function satisfiesDeclaredVersion(version: string, declared: string): boolean {
	if(RRange.parse(declared) === undefined) {
		return true;
	}
	return RRange.satisfies(version, declared);
}

/** how a lockfile's pinned packages relate to the packages a declaring manifest asks for (see {@link LockfileSyncReport}) */
export function lockfileSyncReport(partner: string, declared: DeclaredLibrary[], locked: DeclaredLibrary[]): LockfileSyncReport {
	const pins = new Map(locked.map(l => [l.name, l.declaredVersion]));
	const missing: string[] = [];
	const unsatisfied: LockfileSyncReport['unsatisfied'] = [];
	for(const lib of declared) {
		if(!pins.has(lib.name)) {
			missing.push(lib.name);
		} else {
			const locked = pins.get(lib.name);
			if(lib.declaredVersion && locked && !satisfiesDeclaredVersion(locked, lib.declaredVersion)) {
				unsatisfied.push({ name: lib.name, constraint: lib.declaredVersion, locked });
			}
		}
	}
	return { partner, missing, unsatisfied };
}

/** Removes empty names and the `R` pseudo-package, collapses duplicates (keeping the first), and sorts by name. */
export function dedupeLibraries(libraries: DeclaredLibrary[]): DeclaredLibrary[] {
	const seen = new Map<string, DeclaredLibrary>();
	for(const lib of libraries) {
		if(!lib.name || lib.name === 'R') {
			continue;
		}
		if(!seen.has(lib.name)) {
			seen.set(lib.name, lib);
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** what a flowR {@link Package} declares, in the shape the tree renders */
function toDeclaredLibraries(packages: readonly Package[] | undefined): DeclaredLibrary[] {
	return (packages ?? []).map(p => ({ name: p.name, declaredVersion: p.versionConstraints[0]?.raw }));
}

/** the lowest concrete version a constraint admits, e.g. `4.1.0` for a `DESCRIPTION`'s `R (>= 4.1.0)` */
function declaredMinimum(pkg: Package | undefined): string | undefined {
	const range = pkg?.versionConstraints[0];
	return range ? minVersion(range)?.version : undefined;
}

/** Reads a `DESCRIPTION` through flowR's own {@link FlowrDescriptionFile}. */
export function readDescription(content: string, path = 'DESCRIPTION'): ManifestMeta & { libraries: DeclaredLibrary[] } {
	const description = FlowrDescriptionFile.from(new FlowrInlineTextFile(path, content));
	const declared = [
		...description.depends() ?? [], ...description.imports() ?? [],
		...description.linkingTo() ?? [], ...description.suggests() ?? []
	];
	return {
		packageName:      description.packageName(),
		packageVersion:   description.version()?.str,
		declaredRVersion: declaredMinimum(declared.find(p => p.name === 'R')),
		libraries:        toDeclaredLibraries(declared)
	};
}

/** Reads an rv `rproject.toml` through flowR's own {@link FlowrRProjectFile}. */
export function readRProject(content: string, path = 'rproject.toml'): ManifestMeta & { libraries: DeclaredLibrary[] } {
	const project = FlowrRProjectFile.from(new FlowrInlineTextFile(path, content));
	return {
		packageName:      project.projectName(),
		declaredRVersion: project.rVersion(),
		libraries:        toDeclaredLibraries(project.dependencies())
	};
}

/** Reads a uvr `uvr.toml` through flowR's own {@link FlowrUvrManifestFile}. */
export function readUvrManifest(content: string, path = 'uvr.toml'): ManifestMeta & { libraries: DeclaredLibrary[] } {
	const manifest = FlowrUvrManifestFile.from(new FlowrInlineTextFile(path, content));
	const declares = manifest.declares();
	return {
		packageName:      manifest.projectName(),
		declaredRVersion: manifest.rVersion(),
		libraries:        toDeclaredLibraries([...declares.imports ?? [], ...declares.suggests ?? []])
	};
}

/** Reads an `renv.lock`; flowR only parses these inside its analyzer plugins, so this stays extension-side for now. */
export function readRenvLock(content: string): ManifestMeta & { libraries: DeclaredLibrary[] } {
	return { ...parseRenvLockMeta(content), libraries: parseRenvLock(content) };
}

/** Reads an `rv.lock`; flowR only parses these inside its analyzer plugins, so this stays extension-side for now. */
export function readRvLock(content: string): { libraries: DeclaredLibrary[] } {
	return { libraries: parseRvLock(content) };
}

/** Extracts the declared packages (with versions) from a `renv.lock` file's `Packages` object. */
export function parseRenvLock(content: string): DeclaredLibrary[] {
	const lock = JSON.parse(content) as { Packages?: Record<string, { Package?: string, Version?: string }> };
	if(!lock.Packages) {
		return [];
	}
	return Object.entries(lock.Packages).map(([key, entry]) => ({
		name:            entry.Package ?? key,
		declaredVersion: entry.Version
	}));
}

/** what a manifest says about itself: the package/project it describes and the R version it declares */
export interface ManifestMeta {
	packageName?:      string;
	packageVersion?:   string;
	declaredRVersion?: string;
}

/** Extracts the R version an `renv.lock` pins (`{"R": {"Version": "4.3.1"}}`). */
export function parseRenvLockMeta(content: string): ManifestMeta {
	try {
		const lock = JSON.parse(content) as { R?: { Version?: string } };
		return { declaredRVersion: typeof lock.R?.Version === 'string' ? lock.R.Version : undefined };
	} catch{
		return {};
	}
}


/** Extracts the packages from an `rv.lock` TOML file's `[[packages]]` tables. */
export function parseRvLock(content: string): DeclaredLibrary[] {
	// rv.lock is TOML with [[packages]] tables carrying name = "..." / version = "..."
	const libraries: DeclaredLibrary[] = [];
	let name: string | undefined;
	let version: string | undefined;
	const flush = () => {
		if(name) {
			libraries.push({ name, declaredVersion: version });
		}
		name = undefined;
		version = undefined;
	};
	for(const raw of content.split('\n')) {
		const line = raw.trim();
		if(/^\[\[.*\]\]$/.test(line)) {
			flush();
			continue;
		}
		const n = /^name\s*=\s*"([^"]+)"/.exec(line);
		if(n) {
			name = n[1];
		}
		const v = /^version\s*=\s*"([^"]+)"/.exec(line);
		if(v) {
			version = v[1];
		}
	}
	flush();
	return libraries;
}
