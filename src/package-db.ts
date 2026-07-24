import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { getConfig, Settings } from './settings';
import { getBundledSigDbPath, isWeb } from './extension';
import { getInstalledPackageVersions } from './installed-packages';
import { readManifestFile, type SigDbManifest } from '@eagleoutice/flowr/project/sigdb/manifest';
import { sigDbCacheDir } from '@eagleoutice/flowr/project/sigdb/decompress';
import { selectDownloadVariants } from '@eagleoutice/flowr/project/sigdb/sigdb-download';
import { readableExtsPreferred } from '@eagleoutice/flowr/project/sigdb/codec';
import { getSharedSigSource, SigDatabaseSet, type PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';
import type { DecodedFunction } from '@eagleoutice/flowr/project/sigdb/decode';

export const baseRPackages = new Set([
	'base', 'compiler', 'datasets', 'grDevices', 'graphics', 'grid', 'methods', 'parallel',
	'splines', 'stats', 'stats4', 'tcltk', 'tools', 'translations', 'utils'
]);

/** R's actual default-loaded packages besides `base` (`getOption("defaultPackages")`); other ship-with-R packages (`tools`, `grid`, `parallel`, ...) still need an explicit library()/`::` */
export const defaultLoadedPackages = ['stats', 'utils', 'grDevices', 'graphics', 'datasets', 'methods'];

/** Whether the signature database is enabled via configuration */
export function isSigDbEnabled(): boolean {
	return getConfig().get<boolean>(Settings.SigDbEnabled, true);
}

/** Extra directory/bundle the user configured, searched in addition to the shipped default (maps to flowR's `solver.sigdb.additionalPaths`) */
export function getSigDbAdditionalPath(): string {
	return getConfig().get<string>(Settings.SigDbCustomPath, '');
}

/** Whether to automatically sync and download missing signature database shards */
export function shouldSigDbAutoSync(): boolean {
	return getConfig().get<boolean>(Settings.SigDbAutoSync, true);
}

/** Whether to load the signature database up front during startup */
export function shouldSigDbEagerlyLoad(): boolean {
	return getConfig().get<boolean>(Settings.SigDbEagerlyLoad, false);
}

/** the real, published-release "shard link" pointer: `{repo, tag, shards: {filename: {sha256, bytes}}}` */
export interface SigDbRemotePointer {
	format?: string;
	schema?: number;
	tag:     string;
	repo?:   string;
	shards:  Record<string, { sha256: string, bytes: number }>;
}

let cachedPointer: SigDbRemotePointer | undefined | null = null;

/** reads dist/node/sigdb/sigdb.remote.json directly; flowR's own sigDbRemoteRelease() resolves paths relative to its module file, which breaks once webpacked */
export function readSigDbRemotePointer(): SigDbRemotePointer | undefined {
	if(cachedPointer !== null) {
		return cachedPointer ?? undefined;
	}
	try {
		const bundled = getBundledSigDbPath();
		if(!bundled) {
			cachedPointer = undefined;
			return undefined;
		}
		const raw = fs.readFileSync(path.join(bundled, 'sigdb.remote.json'), 'utf8');
		cachedPointer = JSON.parse(raw) as SigDbRemotePointer;
	} catch{
		cachedPointer = undefined;
	}
	return cachedPointer ?? undefined;
}

/** the real cache directory flowR downloads/decompresses signature databases into (honors `$FLOWR_SIGDB_CACHE`/`$FLOWR_CACHE_DIR`/XDG) */
export function getSigDbCacheDir(): string {
	return sigDbCacheDir();
}

/** the directory a sync of the bundled pointer's release lands in / has already landed in -- no network access */
export function getSigDbBundleDir(): string | undefined {
	const pointer = readSigDbRemotePointer();
	if(!pointer) {
		return undefined;
	}
	return path.join(sigDbCacheDir(), 'bundles', pointer.tag);
}

/** locate a real, on-disk manifest file for a scope (`base` | `current` | `history`) inside a directory */
function findManifestFile(dir: string, scope: string): string | undefined {
	// a cache dir can genuinely hold both `.zst` and `.br` for the same shard (e.g. downloaded by different Node
	// versions over time) - always trying `.zst` first regardless of runtime support would pick a variant this
	// Node can't decompress and never fall back to the working `.br` right next to it, only to a different dir
	for(const ext of [...readableExtsPreferred(), '']) {
		const candidate = path.join(dir, `${scope}.manifest.json${ext}`);
		if(fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export interface SigDbScopeState {
	scope:         'base' | 'current' | 'history';
	manifestPath?: string;
	manifest?:     SigDbManifest;
}

/** parsed manifests keyed by path+mtime; a `current`/`history` manifest is many MB, and getSigDbScopeState() is called per completion/hover/tree item, so re-parsing it every time thrashes the CPU. Cleared by {@link invalidateSigDbPackageNamesCache}. */
const manifestParseCache = new Map<string, { mtimeMs: number, manifest: SigDbManifest }>();

/** {@link readManifestFile}, but reuses the parse while the file is unchanged (same mtime) */
function readManifestCached(manifestPath: string): SigDbManifest {
	const mtimeMs = fs.statSync(manifestPath).mtimeMs;
	const cached = manifestParseCache.get(manifestPath);
	if(cached && cached.mtimeMs === mtimeMs) {
		return cached.manifest;
	}
	const manifest = readManifestFile(manifestPath);
	manifestParseCache.set(manifestPath, { mtimeMs, manifest });
	return manifest;
}

/** searches bundled dir, then configured additional path, then downloaded-bundle dir, first match wins (mirrors flowR's own sigdb plugin) */
export function getSigDbScopeState(scope: 'base' | 'current' | 'history'): SigDbScopeState {
	const dirs = [getBundledSigDbPath(), getSigDbAdditionalPath().trim() || undefined, getSigDbBundleDir()]
		.filter((d): d is string => !!d);

	for(const dir of dirs) {
		const manifestPath = findManifestFile(dir, scope);
		if(!manifestPath) {
			continue;
		}
		try {
			return { scope, manifestPath, manifest: readManifestCached(manifestPath) };
		} catch{
			// fall through to the next search dir
		}
	}
	return { scope };
}

/** whether a manifest shard's data file (in any shipped codec variant) is actually on disk, so we never mount a manifest that routes reads to a not-downloaded shard */
function shardFilePresent(baseDir: string, shardPath: string): boolean {
	const full = path.join(baseDir, shardPath);
	return fs.existsSync(full) || fs.existsSync(`${full}.br`) || fs.existsSync(`${full}.zst`);
}

/** restricted sources (opened excluding the shards not on disk), keyed by manifest path + excluded ids; cleared by {@link invalidateSigDbPackageNamesCache} */
const restrictedSourceCache = new Map<string, Promise<PackageSignatureSource | undefined>>();

/**
 * A signature source for `scope` that mounts only the shards actually on disk. A partially-downloaded scope (e.g.
 * only "Top CRAN") lists every package in its manifest, but reading one whose shard was never fetched throws
 * ENOENT; excluding the missing shards up front (flowR's own `excludeShards`) makes those packages uniformly
 * "not available" instead of half-present. When every shard is present, the process-wide shared source is reused.
 *
 * Kept separate from {@link getSigDbScopeState}, whose FULL manifest still drives the tree's "X of Y downloaded"
 * display and its "download the rest" affordance.
 */
export async function getScopeSource(scope: 'base' | 'current' | 'history', onError?: (message: string) => void): Promise<PackageSignatureSource | undefined> {
	const state = getSigDbScopeState(scope);
	if(!state.manifestPath) {
		return undefined;
	}
	const baseDir = path.dirname(state.manifestPath);
	const missing = state.manifest?.shards.filter(s => !shardFilePresent(baseDir, s.path)).map(s => s.id) ?? [];
	if(missing.length === 0) {
		return safeGetSigSource(state.manifestPath, onError);
	}
	const key = `${state.manifestPath}|${missing.slice().sort().join(',')}`;
	let source = restrictedSourceCache.get(key);
	if(!source) {
		source = SigDatabaseSet.openManifest(state.manifestPath, { excludeShards: missing })
			.then((s): PackageSignatureSource => s)
			.catch((e: unknown): PackageSignatureSource | undefined => {
				onError?.(`could not open ${state.manifestPath} (excluding ${missing.join(', ')}): ${e instanceof Error ? e.message : String(e)}`);
				restrictedSourceCache.delete(key); // let a transient failure retry next time
				return undefined;
			});
		restrictedSourceCache.set(key, source);
	}
	return source;
}

/** tolerates a corrupt/partial shard instead of throwing; callers get undefined plus an onError explanation */
export async function safeGetSigSource(manifestPath: string, onError?: (message: string) => void): Promise<PackageSignatureSource | undefined> {
	try {
		return await getSharedSigSource(manifestPath);
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		onError?.(`could not open ${manifestPath}: ${message}`);
		return undefined;
	}
}

/** fs codes a signature-db read can legitimately hit when a shard isn't downloaded or isn't readable */
const SwallowableSigDbErrorCodes = new Set(['ENOENT', 'EACCES', 'EISDIR', 'EPERM']);

/** whether `e` is a "shard not available / not readable" error we treat as an absent lookup rather than a real fault - a missing shard file (ENOENT), or a corrupt/partial one that fails to decompress or parse */
function isSwallowableSigDbError(e: unknown): boolean {
	if(!e || typeof e !== 'object') {
		return false;
	}
	const code = (e as { code?: unknown }).code;
	if(typeof code === 'string' && SwallowableSigDbErrorCodes.has(code)) {
		return true;
	}
	const message = e instanceof Error ? e.message : '';
	return /\b(ENOENT|EACCES|decompress|decompression|brotli|zstd|inflate|corrupt|unexpected (?:end|token)|invalid (?:distance|literal|block|stored))\b/i.test(message);
}

/** a package can be listed in a manifest whose shard wasn't actually downloaded (or is corrupt); swallow the resulting fs/decompression error so best-effort lookups degrade to "not available" instead of throwing */
export function safeSigDbCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch(e) {
		if(isSwallowableSigDbError(e)) {
			return undefined;
		}
		throw e;
	}
}

/** sha256 hex digest of a file's contents (same algorithm flowR's own downloader hashes against) */
function sha256File(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** a sandbox that silently drops egress would otherwise hang the request forever */
const RequestTimeoutMs = 30_000;

/** follows redirects (GitHub release assets redirect to a signed storage host); VS Code's https patch already handles proxy settings */
function httpGet(url: string, opts: { redirects?: number, signal?: AbortSignal } = {}): Promise<import('http').IncomingMessage> {
	const { redirects = 5, signal } = opts;
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': 'vscode-flowr', Accept: 'application/octet-stream' },
			timeout: RequestTimeoutMs,
			signal
		}, res => {
			const status = res.statusCode ?? 0;
			if(status >= 300 && status < 400 && res.headers.location && redirects > 0) {
				res.resume();
				httpGet(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, signal }).then(resolve, reject);
			} else if(status >= 200 && status < 300) {
				resolve(res);
			} else {
				res.resume();
				reject(new Error(`GET ${url} -> HTTP ${status}`));
			}
		});
		req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${RequestTimeoutMs / 1000}s (network may be blocked by a sandbox)`)));
		req.on('error', reject);
	});
}

/** web target: no node:https in a webworker, so this uses fetch instead (which follows redirects itself, unlike httpGet) */
async function downloadToWeb(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason as Error | undefined);
	signal?.addEventListener('abort', onAbort);
	const timeout = setTimeout(() => controller.abort(new Error(`request to ${url} timed out after ${RequestTimeoutMs / 1000}s`)), RequestTimeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/octet-stream' } });
		if(!res.ok) {
			throw new Error(`GET ${url} -> HTTP ${res.status}`);
		}
		fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
	} catch(e) {
		if(e instanceof TypeError) {
			// GitHub's release-asset host sends no CORS headers, so a browser blocks the request outright
			throw new Error(`the browser blocked the download of ${url} (cross-origin requests to this host are not allowed); base-R signatures are bundled with the extension, but additional scopes cannot be synced from the web version`);
		}
		throw e;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', onAbort);
	}
}

async function downloadTo(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	if(isWeb()) {
		await downloadToWeb(url, dest, signal);
		return;
	}
	const res = await httpGet(url, { signal });
	await new Promise<void>((resolve, reject) => {
		const out = fs.createWriteStream(dest);
		res.on('error', reject);
		out.on('error', reject).on('finish', () => out.close(err => err ? reject(err) : resolve()));
		res.pipe(out);
	});
}

export interface SigDbScopeDownloadResult {
	dir:   string;
	files: string[];
}

let sigDbPackageNamesCache: Promise<Set<string>> | undefined;

/** drops the {@link allSigDbPackageNames} cache; call whenever a scope's shards or the custom sigdb path setting change */
export function invalidateSigDbPackageNamesCache(): void {
	sigDbPackageNamesCache = undefined;
	// a scope's present-shard set may have changed (a download/removal), so restricted sources must be reopened
	restrictedSourceCache.clear();
	manifestParseCache.clear();
}

/** a shard id (e.g. current-top) parsed from the release pointer's asset name <scope>.<shardId>.sigs.ndjson[.br|.zst] */
function shardIdOf(scope: string, assetName: string): string {
	const rest = assetName.slice(scope.length + 1);
	// "rest" is manifest.json[.br|.zst] itself here, unlike a shard's <id>.sigs.ndjson[.br|.zst] - needs its own check
	if(/^manifest\.json(\.br|\.zst)?$/.test(rest)) {
		return 'manifest';
	}
	return rest.replace(/\.sigs\.ndjson(\.br|\.zst)?$/, '');
}

/** named, incrementally-downloadable groups of shards per scope, real IDs matching the pointer's own asset names */
export const SigDbShardGroups: Record<'base' | 'current' | 'history', { id: string, label: string, shardIds: string[] }[]> = {
	base: [
		{ id: 'current', label: 'Base R (current version only)', shardIds: ['base-current'] },
		{ id: 'full', label: 'Base R (all historical versions)', shardIds: ['base-current', 'base-full'] }
	],
	current: [
		{ id: 'top', label: 'Top CRAN packages only (fast)', shardIds: ['base-current', 'current-top'] },
		{ id: 'full', label: 'All current CRAN packages', shardIds: ['base-current', 'base-full', 'current-top', 'current-rest'] }
	],
	history: [
		{ id: 'full', label: 'Full CRAN history', shardIds: ['history-rest'] }
	]
};

/** downloads a scope's shards, optionally filtered to shardIds (see {@link SigDbShardGroups}); manifest/dict are always included, already-verified shards are skipped */
export async function downloadSigDbScope(
	scope: 'base' | 'current' | 'history',
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
	shardIds?: readonly string[]
): Promise<SigDbScopeDownloadResult> {
	const pointer = readSigDbRemotePointer();
	if(!pointer) {
		throw new Error('no signature database release pointer is bundled with this build of the extension');
	}
	const dir = path.join(sigDbCacheDir(), 'bundles', pointer.tag);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`cannot create the signature database cache directory (${dir}): ${message}. If this environment is sandboxed, set vscode-flowr's FLOWR_SIGDB_CACHE/FLOWR_CACHE_DIR env var to a writable path.`);
	}

	const scopeShardNames = Object.keys(pointer.shards).filter(name => name.startsWith(`${scope}.`));
	const wantedNames = shardIds === undefined
		? scopeShardNames
		: scopeShardNames.filter(name => {
			const id = shardIdOf(scope, name);
			return id === 'manifest' || id === 'dict' || shardIds.includes(id);
		});
	const picked = selectDownloadVariants(wantedNames);
	onProgress?.(`syncing ${picked.length} shard${picked.length === 1 ? '' : 's'} for ${scope} (${pointer.tag}) from ${pointer.repo}`);

	const files: string[] = [];
	for(const name of picked) {
		if(signal?.aborted) {
			throw new Error('download cancelled');
		}
		const meta = pointer.shards[name];
		const dest = path.join(dir, name);
		if(fs.existsSync(dest) && sha256File(dest) === meta.sha256) {
			onProgress?.(`have ${name}`);
		} else {
			onProgress?.(`downloading ${name} (${(meta.bytes / 1e6).toFixed(1)} MB)`);

			await downloadTo(`https://github.com/${pointer.repo}/releases/download/${pointer.tag}/${encodeURIComponent(name)}`, dest, signal);
			if(sha256File(dest) !== meta.sha256) {
				throw new Error(`sha256 mismatch for ${name} (${pointer.tag}); the download is corrupt, retry`);
			}
		}
		files.push(dest);
	}
	invalidateSigDbPackageNamesCache();
	return { dir, files };
}

/** the real, individual shard ids (`current-top`, `base-full`, ...) actually present and hash-verified on disk for a scope */
export function getDownloadedShardIds(scope: 'base' | 'current' | 'history'): Set<string> {
	const pointer = readSigDbRemotePointer();
	const dir = getSigDbBundleDir();
	if(!pointer || !dir) {
		return new Set();
	}
	const scopeShardNames = Object.keys(pointer.shards).filter(name => name.startsWith(`${scope}.`));
	return new Set(
		selectDownloadVariants(scopeShardNames).filter(name => {
			const dest = path.join(dir, name);
			return fs.existsSync(dest) && sha256File(dest) === pointer.shards[name].sha256;
		}).map(name => shardIdOf(scope, name))
	);
}

/** which of a scope's shard groups are already fully downloaded (hash-verified) on disk */
export function getDownloadedShardGroups(scope: 'base' | 'current' | 'history'): Set<string> {
	const downloaded = getDownloadedShardIds(scope);
	const groups = new Set<string>();
	for(const group of SigDbShardGroups[scope]) {
		if(group.shardIds.every(id => downloaded.has(id))) {
			groups.add(group.id);
		}
	}
	return groups;
}

/** removes a scope's shard files; with shardIds only those data shards go, otherwise the whole scope (manifest, dict, cache included) */
export function removeSigDbScope(scope: 'base' | 'current' | 'history', shardIds?: readonly string[]): { removed: string[] } {
	const removed: string[] = [];
	const pointer = readSigDbRemotePointer();
	const dir = getSigDbBundleDir();
	const state = getSigDbScopeState(scope);

	// decompressed shard cache, keyed by content hash; only cleared on a full-scope removal
	if(shardIds === undefined && state.manifest) {
		for(const shard of state.manifest.shards) {
			const cached = path.join(sigDbCacheDir(), `sigdb-${shard.hash}.sigs.ndjson`);
			if(fs.existsSync(cached)) {
				fs.unlinkSync(cached);
				removed.push(cached);
			}
		}
	}

	if(pointer && dir) {
		for(const name of Object.keys(pointer.shards).filter(n => n.startsWith(`${scope}.`))) {
			if(shardIds !== undefined) {
				const id = shardIdOf(scope, name);
				if(id === 'manifest' || id === 'dict' || !shardIds.includes(id)) {
					continue;
				}
			}
			const file = path.join(dir, name);
			if(fs.existsSync(file)) {
				fs.unlinkSync(file);
				removed.push(file);
			}
		}
	}

	invalidateSigDbPackageNamesCache();
	return { removed };
}

export { cranPageUrl, cranMirrorSourceUrl } from '@eagleoutice/flowr/queries/catalog/signature-query/signature-query-executor';

const RdrrTopicName = /^[A-Za-z.][A-Za-z0-9._]*$/;

/** the CRAN listing page for an R major-version series (e.g. `R-4`) - what to link a base-R package's version to instead of a (non-existent) CRAN package page */
export function rMajorVersionPageUrl(version: string): string | undefined {
	const major = /^(\d+)\./.exec(version)?.[1];
	return major ? `https://cran.r-project.org/src/base/R-${major}/` : undefined;
}

/** best-effort rdrr.io documentation link: `/r/<pkg>/<fn>` for base R, `/cran/<pkg>/man/<fn>` for CRAN */
export function rdrrDocUrl(pkg: string, fn: string, opts: { base: boolean, cran: boolean }): string | undefined {
	if(!RdrrTopicName.test(fn)) {
		return undefined;
	}
	if(opts.base) {
		return `https://rdrr.io/r/${pkg}/${fn}.html`;
	}
	if(opts.cran) {
		return `https://rdrr.io/cran/${pkg}/man/${fn}.html`;
	}
	return undefined;
}

const SigDbScopeOrder = ['base', 'current', 'history'] as const;

/** the first downloaded scope (base, then current, then history) that knows `pkg`, and its opened source */
export async function findSigDbPackageSource(pkg: string): Promise<{ scope: 'base' | 'current' | 'history', source: PackageSignatureSource } | undefined> {
	for(const scope of SigDbScopeOrder) {
		const source = await getScopeSource(scope);
		if(source?.has(pkg)) {
			return { scope, source };
		}
	}
	return undefined;
}

/** every package name any synced signature-database scope can resolve, deduplicated across scopes; cached until a scope is downloaded/removed */
export function allSigDbPackageNames(): Promise<Set<string>> {
	sigDbPackageNamesCache ??= (async() => {
		const names = new Set<string>();
		for(const scope of SigDbScopeOrder) {
			const source = await getScopeSource(scope);
			for(const name of source?.packageNames() ?? []) {
				names.add(name);
			}
		}
		return names;
	})().catch((e: unknown) => {
		// don't let a failed attempt poison the cache forever - the next call should retry fresh
		sigDbPackageNamesCache = undefined;
		throw e;
	});
	return sigDbPackageNamesCache;
}

/** every package name known locally (installed) or via any synced signature-database scope, deduplicated */
export async function allKnownPackageNames(): Promise<Set<string>> {
	const [sigdb, installed] = await Promise.all([allSigDbPackageNames(), getInstalledPackageVersions()]);
	const names = new Set(sigdb);
	for(const pkg of installed?.keys() ?? []) {
		names.add(pkg);
	}
	return names;
}

/** edit distance between two strings (Wagner-Fischer DP, one-row) - used to guess a likely-intended package name for a typo */
function levenshtein(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for(let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for(let j = 1; j <= b.length; j++) {
			const above = prev[j];
			prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
			diag = above;
		}
	}
	return prev[b.length];
}

/** how far (relative to the typed name's own length) a known package name may be before it stops being a plausible "did you mean" for a typo */
const MaxSuggestionDistanceRatio = 0.4;

/** the closest known package name(s) to `typed` (a package that wasn't resolved), for a "did you mean" hint - empty when nothing is close enough to plausibly be a typo of `typed` */
export function closestPackageNames(typed: string, known: Iterable<string>, max = 3): string[] {
	const maxDistance = Math.max(1, Math.floor(typed.length * MaxSuggestionDistanceRatio));
	const scored: { name: string, distance: number }[] = [];
	for(const name of known) {
		if(name === typed) {
			continue;
		}
		const distance = levenshtein(typed.toLowerCase(), name.toLowerCase());
		if(distance <= maxDistance) {
			scored.push({ name, distance });
		}
	}
	return scored
		.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
		.slice(0, max)
		.map(s => s.name);
}

/** `source`'s recorded (latest) version string for `pkg`, or `undefined` if unavailable/errored */
export function safeLatestVersionStr(source: PackageSignatureSource, pkg: string): string | undefined {
	return safeSigDbCall(() => source.latestVersion(pkg))?.str;
}

/** `pkg`'s function signatures on `source` at `version` (or its latest), or `[]` if unavailable/errored */
export function safeFunctionsOf(source: PackageSignatureSource, pkg: string, version?: string): DecodedFunction[] {
	return safeSigDbCall(() => source.functions(pkg, version)) ?? [];
}

/** the signature database's recorded (latest) version for `pkg`, if any downloaded scope knows it */
export async function resolveSigDbPackageVersion(pkg: string): Promise<string | undefined> {
	const found = await findSigDbPackageSource(pkg);
	return found && safeLatestVersionStr(found.source, pkg);
}

/** whether `fnName` is an S3 generic: another function `<fnName>.<class>` is a registered `s3-method` */
export function isSigDbFunctionS3Generic(source: PackageSignatureSource, pkg: string, fnName: string, version: string | undefined): boolean {
	const prefix = `${fnName}.`;
	return safeFunctionsOf(source, pkg, version).some(f => f.name !== fnName && f.name.startsWith(prefix) && f.props.includes('s3-method'));
}

/** current's manifest already embeds base R, so mounting base too registers every package twice and crashes flowR's reconstructS3Generics; prefer current over base, always add history */
export function getSigDbMountPaths(): string[] {
	const current = getSigDbScopeState('current');
	const base = getSigDbScopeState('base');
	const history = getSigDbScopeState('history');
	const paths: string[] = [];
	if(current.manifestPath) {
		paths.push(current.manifestPath);
	} else if(base.manifestPath) {
		paths.push(base.manifestPath);
	}
	if(history.manifestPath) {
		paths.push(history.manifestPath);
	}
	return paths;
}

/** A short, human-readable summary of the active signature database, built from real on-disk manifest state */
export function sigDbSummary(): string {
	if(!isSigDbEnabled()) {
		return 'Signature DB: disabled';
	}
	const scopes: string[] = [];
	for(const scope of ['base', 'current', 'history'] as const) {
		if(getSigDbScopeState(scope).manifest) {
			scopes.push(scope);
		}
	}
	return scopes.length > 0 ? `Signature DB: ${scopes.join(', ')}` : 'Signature DB: not yet downloaded';
}
