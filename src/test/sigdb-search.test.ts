import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSigDbSearchQuery, matchesPattern, matchesVersion, findSigDbMatches } from '../flowr/views/sigdb-view';
import { downloadSigDbScope, readSigDbRemotePointer, getScopeSource, getSigDbScopeState, getSigDbBundleDir, invalidateSigDbPackageNamesCache } from '../package-db';

suite('SigDB search', () => {
	suite('parseSigDbSearchQuery', () => {
		// every case includes `parameters`/`requiredParameters` explicitly (as `undefined` when unused), since
		// `deepStrictEqual` treats a present-but-undefined key differently from an absent one
		const noParamFilter = { parameters: undefined, requiredParameters: undefined };

		test('parses a plain package', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2'), { pkg: 'ggplot2', version: undefined, fnName: undefined, ...noParamFilter });
		});

		test('parses pkg::fn', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2::ggplot'), { pkg: 'ggplot2', version: undefined, fnName: 'ggplot', ...noParamFilter });
		});

		test('parses pkg@version', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.5.0'), { pkg: 'ggplot2', version: '3.5.0', fnName: undefined, ...noParamFilter });
		});

		test('parses pkg@version::fn', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.5.0::ggplot'), { pkg: 'ggplot2', version: '3.5.0', fnName: 'ggplot', ...noParamFilter });
		});

		test('parses glob patterns in every part', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.*::ggp*'), { pkg: 'ggplot2', version: '3.*', fnName: 'ggp*', ...noParamFilter });
		});

		// mirrors flowR's own `:signature query` REPL syntax exactly (signatureQueryLineParser in
		// signature-query-format.js): a second whitespace-separated token is the function name, whether or
		// not the first token also carries a version
		test('a space works as the pkg/fn separator too, like "::"', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2 ggplot'), { pkg: 'ggplot2', version: undefined, fnName: 'ggplot', ...noParamFilter });
		});

		test('a space after "pkg@version" still separates the function name', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.5.0 ggplot'), { pkg: 'ggplot2', version: '3.5.0', fnName: 'ggplot', ...noParamFilter });
		});

		test('extra whitespace between tokens is ignored', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('  ggplot2   ggplot  '), { pkg: 'ggplot2', version: undefined, fnName: 'ggplot', ...noParamFilter });
		});

		// `pkg@version` must be one contiguous token, exactly like flowR's own parser - spaces around "@" are
		// not a supported alternative spelling, so this is expected to misparse rather than to be handled leniently
		test('"@" only works as part of a single pkg@version token, not with spaces around it', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('dplyr @ 1.1.0'), { pkg: 'dplyr', version: undefined, fnName: '@', ...noParamFilter });
		});

		test('parses --param (repeatable, comma-separable)', () => {
			assert.deepStrictEqual(
				parseSigDbSearchQuery('ggplot2::ggplot --param x,y* --param z'),
				{ pkg: 'ggplot2', version: undefined, fnName: 'ggplot', parameters: ['x', 'y*', 'z'], requiredParameters: undefined }
			);
		});

		test('parses --required', () => {
			assert.deepStrictEqual(
				parseSigDbSearchQuery('mutate --required 2'),
				{ pkg: 'mutate', version: undefined, fnName: undefined, parameters: undefined, requiredParameters: 2 }
			);
		});

		test('-p and --req are accepted as short forms', () => {
			assert.deepStrictEqual(
				parseSigDbSearchQuery('ggplot2::ggplot -p x --req 2'),
				{ pkg: 'ggplot2', version: undefined, fnName: 'ggplot', parameters: ['x'], requiredParameters: 2 }
			);
		});

		test('a bare --param with no package searches every package', () => {
			assert.deepStrictEqual(
				parseSigDbSearchQuery('--param mapping'),
				{ pkg: '*', version: undefined, fnName: undefined, parameters: ['mapping'], requiredParameters: undefined }
			);
		});

		test('rejects an empty query, or one that is only flags with no filter value', () => {
			assert.strictEqual(parseSigDbSearchQuery(''), undefined);
			assert.strictEqual(parseSigDbSearchQuery('::mutate'), undefined);
		});
	});

	suite('matchesPattern', () => {
		test('exact (non-glob) pattern requires an exact match', () => {
			assert.strictEqual(matchesPattern('ggplot2', 'ggplot2'), true);
			assert.strictEqual(matchesPattern('ggplot2', 'ggplot2x'), false);
		});

		test('"*" matches any run of characters', () => {
			assert.strictEqual(matchesPattern('ggp*', 'ggplot'), true);
			assert.strictEqual(matchesPattern('ggp*', 'gg'), false);
			assert.strictEqual(matchesPattern('*plot', 'ggplot'), true);
		});

		test('"?" matches exactly one character', () => {
			assert.strictEqual(matchesPattern('a?c', 'abc'), true);
			assert.strictEqual(matchesPattern('a?c', 'ac'), false);
			assert.strictEqual(matchesPattern('a?c', 'abbc'), false);
		});

		test('glob special characters in the pattern are escaped, not treated as regex', () => {
			assert.strictEqual(matchesPattern('a.b', 'aXb'), false);
			assert.strictEqual(matchesPattern('a.b', 'a.b'), true);
		});
	});

	suite('matchesVersion', () => {
		test('exact version string matches itself', () => {
			assert.strictEqual(matchesVersion('3.5.0', '3.5.0'), true);
			assert.strictEqual(matchesVersion('3.5.0', '3.5.1'), false);
		});

		test('glob version pattern', () => {
			assert.strictEqual(matchesVersion('3.*', '3.5.0'), true);
			assert.strictEqual(matchesVersion('3.*', '4.0.0'), false);
		});

		test('semver-range version pattern via flowR\'s real RRange', () => {
			assert.strictEqual(matchesVersion('>=3.0.0', '3.5.0'), true);
			assert.strictEqual(matchesVersion('>=3.0.0', '2.9.9'), false);
		});

		test('unparseable pattern matches nothing', () => {
			assert.strictEqual(matchesVersion('not a version', '3.5.0'), false);
		});
	});

	// exercises the real, on-disk search against a real (downloaded) base-R scope - not just the pure
	// pattern-matching helpers above - so a regression in the scope-scanning/glob-expansion logic itself
	// (not just the parsing/matching primitives) would actually be caught
	suite('findSigDbMatches (real base scope)', () => {
		let previousCacheDir: string | undefined;
		let tempDir: string;
		const output = vscode.window.createOutputChannel('vscode-flowr-test-sigdb-search');

		setup(() => {
			previousCacheDir = process.env.FLOWR_SIGDB_CACHE;
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-sigdb-search-test-'));
			process.env.FLOWR_SIGDB_CACHE = tempDir;
		});

		teardown(() => {
			if(previousCacheDir === undefined) {
				delete process.env.FLOWR_SIGDB_CACHE;
			} else {
				process.env.FLOWR_SIGDB_CACHE = previousCacheDir;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('finds an exact package, a glob package match, and an exact function within a real base scope', async function() {
			this.timeout(30000);
			if(!readSigDbRemotePointer()) {
				this.skip(); // no bundled release pointer in this build -- nothing to download
				return;
			}
			await downloadSigDbScope('base');

			const exact = await findSigDbMatches({ pkg: 'base' }, output, 'base');
			assert.strictEqual(exact.length, 1, 'expected exactly one match for the exact package name "base"');
			assert.strictEqual(exact[0].pkg, 'base');
			assert.strictEqual(exact[0].scope, 'base');

			// "stat*" matches both "stats" and "stats4" among the real base-R packages
			const glob = await findSigDbMatches({ pkg: 'stat*' }, output, 'base');
			assert.deepStrictEqual(glob.map(m => m.pkg).sort(), ['stats', 'stats4']);

			const fn = await findSigDbMatches({ pkg: 'base', fnName: 'print' }, output, 'base');
			assert.ok(fn.length > 0, 'expected "print" to be found in the real base package');
			assert.ok(fn.every(m => m.fnName === 'print' && m.pkg === 'base'));

			const noMatch = await findSigDbMatches({ pkg: 'this-package-does-not-exist' }, output, 'base');
			assert.deepStrictEqual(noMatch, []);
		});

		// a partially-downloaded scope leaves the manifest advertising shards whose files were never fetched; reading
		// one as-is throws ENOENT. getScopeSource must mount only the present shards (flowR's excludeShards).
		test('mounts only the shards present on disk after a partial download', async function() {
			this.timeout(30000);
			if(!readSigDbRemotePointer()) {
				this.skip();
				return;
			}
			await downloadSigDbScope('base');

			const raw = getSigDbScopeState('base');
			assert.ok(raw.manifestPath && raw.manifest, 'expected a downloaded base manifest');
			if(raw.manifest.shards.length < 2) {
				this.skip(); // need at least two shards to simulate a partial download
				return;
			}

			// simulate "only some shards downloaded": delete every shard file except the first
			const bundleDir = getSigDbBundleDir();
			assert.ok(bundleDir, 'expected a bundle dir');
			for(const shard of raw.manifest.shards.slice(1)) {
				for(const ext of ['', '.br', '.zst']) {
					fs.rmSync(path.join(bundleDir, shard.path + ext), { force: true });
				}
			}
			invalidateSigDbPackageNamesCache();

			// opening must not throw, and must still resolve packages served by the present shard
			const source = await getScopeSource('base');
			assert.ok(source, 'expected a usable source restricted to the present shard');
			assert.ok(source.packageNames().length > 0, 'expected the present shard\'s packages to still be listed');
			assert.ok(source.has('base'), 'expected base to still resolve from the present shard');

			const matches = await findSigDbMatches({ pkg: '*' }, output, 'base');
			assert.ok(matches.length > 0, 'expected the present shard\'s packages to still be searchable');
		});

		test('filters by --param (glob, position-independent) and --required, against a real function', async function() {
			this.timeout(30000);
			if(!readSigDbRemotePointer()) {
				this.skip();
				return;
			}
			await downloadSigDbScope('base');

			// base::grepl(pattern, x, ignore.case, perl, fixed, useBytes) has a stable `ignore.case` parameter,
			// taken directly (not deferred to an S3 default method, unlike e.g. mean/mean.default)
			const byParam = await findSigDbMatches({ pkg: 'base', fnName: 'grepl', parameters: ['ignore.*'] }, output, 'base');
			assert.ok(byParam.some(m => m.fnName === 'grepl'), 'expected base::grepl to match an "ignore.*" parameter glob');

			const byMissingParam = await findSigDbMatches({ pkg: 'base', fnName: 'grepl', parameters: ['this-param-does-not-exist'] }, output, 'base');
			assert.deepStrictEqual(byMissingParam, []);

			// a bare --param search (no package/function given) must still search every package, like flowR's own `pkg: '*'`
			const bareParam = await findSigDbMatches({ pkg: '*', parameters: ['ignore.case'] }, output, 'base');
			assert.ok(bareParam.some(m => m.fnName === 'grepl' && m.pkg === 'base'), 'expected a bare --param search to still find base::grepl');
		});
	});
});
