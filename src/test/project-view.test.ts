import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	classifyLibrary, dedupeLibraries, readDescription, parseRenvLock, parseRenvLockMeta, parseRvLock,
	readRProject, readUvrManifest, satisfiesDeclaredVersion, lockfileSyncReport, pickDeclaredRVersion
} from '../flowr/views/project-view';
import { downloadSigDbScope, readSigDbRemotePointer } from '../package-db';

suite('project view library matching', () => {
	test('reports base packages as base', async() => {
		assert.equal((await classifyLibrary('stats')).status, 'base');
		assert.equal((await classifyLibrary('methods')).status, 'base');
		assert.equal((await classifyLibrary('base')).status, 'base');
	});

	test('reports an unknown package as unmatched when nothing is downloaded', async() => {
		assert.equal((await classifyLibrary('notARealPackage')).status, 'unmatched');
	});

	// regression test: classifyLibrary() once never consulted the sigdb at all, always returning 'unmatched'; this exercises the real on-disk lookup end to end
	suite('against a real downloaded scope', () => {
		let previousCacheDir: string | undefined;
		let tempDir: string;

		setup(() => {
			previousCacheDir = process.env.FLOWR_SIGDB_CACHE;
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-project-view-test-'));
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

		test('reports a real, downloaded CRAN package as matched, with a real version', async function() {
			this.timeout(60000);
			if(!readSigDbRemotePointer()) {
				this.skip();
				return;
			}
			await downloadSigDbScope('current', undefined, undefined, ['base-current', 'current-top']);

			// "digest" is a near-universal CRAN dependency, virtually guaranteed to be in the "top" shard
			const match = await classifyLibrary('digest');
			assert.equal(match.status, 'matched', `expected "digest" to be matched against the real downloaded database, got: ${JSON.stringify(match)}`);
			assert.ok(match.dbVersion, 'expected a real database version to be reported');

			const satisfied = await classifyLibrary('digest', '>= 0.1');
			assert.equal(satisfied.dbSatisfies, true, `expected the database's version to cover ">= 0.1", got: ${JSON.stringify(satisfied)}`);

			const unsatisfiable = await classifyLibrary('digest', '>= 999.0');
			assert.equal(unsatisfiable.dbSatisfies, false, `expected no database version to cover ">= 999.0", got: ${JSON.stringify(unsatisfiable)}`);
			assert.equal(unsatisfiable.status, 'matched', 'an uncovered declared version still reports the package itself as matched');
		});
	});
});

suite('project view manifest parsing', () => {
	test('dedupeLibraries drops R, removes duplicates, and sorts', () => {
		const result = dedupeLibraries([
			{ name: 'purrr', declaredVersion: '1.0' },
			{ name: 'R', declaredVersion: '4.3' },
			{ name: 'dplyr' },
			{ name: 'purrr', declaredVersion: '9.9' },
			{ name: '' }
		]);
		assert.deepEqual(result.map(l => l.name), ['dplyr', 'purrr']);
		// the first occurrence's version wins
		assert.equal(result.find(l => l.name === 'purrr')?.declaredVersion, '1.0');
	});

	test('parses DESCRIPTION dependency fields', () => {
		const desc = [
			'Package: mypkg',
			'Version: 1.0',
			'Depends: R (>= 4.0.0), methods',
			'Imports:',
			'    dplyr (>= 1.0.0),',
			'    purrr,',
			'    rlang',
			'Suggests: testthat (>= 3.0.0)',
			'License: MIT'
		].join('\n');
		const libs = readDescription(desc).libraries;
		const names = libs.map(l => l.name);
		assert.ok(names.includes('dplyr'), `expected dplyr, got ${names.join(', ')}`);
		assert.ok(names.includes('purrr'));
		assert.ok(names.includes('rlang'));
		assert.ok(names.includes('methods'));
		assert.ok(names.includes('testthat'));
		// dplyr's version constraint should be captured (normalized by flowR); R is dropped by dedupeLibraries
		const dplyr = libs.find(l => l.name === 'dplyr');
		assert.equal(dplyr?.declaredVersion, '>=1.0.0');
	});

	test('reads the package name and version a DESCRIPTION describes itself', () => {
		const desc = 'Package: ggplot2\nType: Package\nVersion: 3.5.1\nImports: rlang\n';
		const meta = readDescription(desc);
		assert.equal(meta.packageName, 'ggplot2');
		assert.equal(meta.packageVersion, '3.5.1');
	});

	test('reads the minimum R version a DESCRIPTION declares', () => {
		assert.equal(readDescription('Package: x\nDepends: R (>= 4.1.0), methods\n').declaredRVersion, '4.1.0');
		assert.equal(readDescription('Package: x\nDepends:\n    methods,\n    R (>= 3.6)\n').declaredRVersion, '3.6.0');
		assert.equal(readDescription('Package: x\nImports: rlang\n').declaredRVersion, undefined);
		assert.equal(readDescription('Package: x\nDepends: R\n').declaredRVersion, undefined);
	});

	test('a malformed DESCRIPTION yields nothing instead of throwing', () => {
		const meta = readDescription('not a dcf at all');
		assert.equal(meta.packageName, undefined);
		assert.deepEqual(meta.libraries, []);
	});

	test('reads the R version an renv.lock pins', () => {
		assert.equal(parseRenvLockMeta(JSON.stringify({ R: { Version: '4.3.1' }, Packages: {} })).declaredRVersion, '4.3.1');
		assert.equal(parseRenvLockMeta(JSON.stringify({ Packages: {} })).declaredRVersion, undefined);
		assert.deepEqual(parseRenvLockMeta('not json'), {});
	});

	test('reads the project name and R version an rproject.toml declares', () => {
		const toml = '[project]\nname = "myproject"\nr_version = "4.4"\ndependencies = ["dplyr"]\n\n[other]\nname = "decoy"\n';
		const meta = readRProject(toml);
		assert.equal(meta.packageName, 'myproject');
		assert.equal(meta.declaredRVersion, '4.4');
	});

	test('pickDeclaredRVersion prefers an exact lockfile/rv pin over a DESCRIPTION minimum', () => {
		assert.equal(pickDeclaredRVersion([
			{ kind: 'DESCRIPTION', declaredRVersion: '4.0' },
			{ kind: 'renv', declaredRVersion: '4.3.1' }
		]), '4.3.1');
		assert.equal(pickDeclaredRVersion([{ kind: 'DESCRIPTION', declaredRVersion: '4.0' }]), '4.0');
		assert.equal(pickDeclaredRVersion([{ kind: 'renv' }]), undefined);
	});

	test('satisfiesDeclaredVersion handles exact pins, constraints, and R-style versions', () => {
		assert.ok(satisfiesDeclaredVersion('1.1.4', '1.1.4'));
		assert.ok(!satisfiesDeclaredVersion('1.1.4', '1.1.5'));
		assert.ok(satisfiesDeclaredVersion('1.1.4', '>= 1.0.0'));
		assert.ok(!satisfiesDeclaredVersion('0.9.0', '>= 1.0.0'));
		assert.ok(satisfiesDeclaredVersion('1.7-24', '>= 1.7-20'));
		assert.ok(satisfiesDeclaredVersion('2.0.0', '> 1.9'));
		assert.ok(!satisfiesDeclaredVersion('2.0.0', '< 2.0.0'));
		// unparseable declarations never flag a mismatch
		assert.ok(satisfiesDeclaredVersion('1.0.0', 'whatever'));
	});

	test('lockfileSyncReport finds missing and version-conflicting packages', () => {
		const report = lockfileSyncReport('DESCRIPTION',
			[{ name: 'dplyr', declaredVersion: '>= 1.1.0' }, { name: 'rlang' }, { name: 'missingpkg' }],
			[{ name: 'dplyr', declaredVersion: '1.0.0' }, { name: 'rlang', declaredVersion: '1.1.3' }]);
		assert.deepEqual(report.missing, ['missingpkg']);
		assert.deepEqual(report.unsatisfied, [{ name: 'dplyr', constraint: '>= 1.1.0', locked: '1.0.0' }]);

		const clean = lockfileSyncReport('DESCRIPTION',
			[{ name: 'rlang' }],
			[{ name: 'rlang', declaredVersion: '1.1.3' }, { name: 'extra', declaredVersion: '1.0' }]);
		assert.deepEqual(clean.missing, []);
		assert.deepEqual(clean.unsatisfied, []);
	});

	test('parses renv.lock packages', () => {
		const lock = JSON.stringify({
			R:        { Version: '4.3.0' },
			Packages: {
				dplyr: { Package: 'dplyr', Version: '1.1.4', Source: 'Repository' },
				purrr: { Package: 'purrr', Version: '1.0.2', Source: 'Repository' }
			}
		});
		const libs = parseRenvLock(lock);
		assert.equal(libs.length, 2);
		const dplyr = libs.find(l => l.name === 'dplyr');
		assert.equal(dplyr?.declaredVersion, '1.1.4');
	});

	test('parses rv.lock package tables', () => {
		const lock = [
			'[[packages]]',
			'name = "dplyr"',
			'version = "1.1.4"',
			'',
			'[[packages]]',
			'name = "purrr"',
			'version = "1.0.2"'
		].join('\n');
		const libs = parseRvLock(lock);
		assert.deepEqual(libs.map(l => l.name).sort(), ['dplyr', 'purrr']);
	});

	test('parses rproject.toml dependency array', () => {
		const toml = [
			'[project]',
			'name = "myproject"',
			'dependencies = [',
			'    "dplyr",',
			'    { name = "purrr", repository = "CRAN" },',
			']'
		].join('\n');
		const libs = readRProject(toml).libraries;
		assert.deepEqual(libs.map(l => l.name).sort(), ['dplyr', 'purrr']);
	});

	test('a malformed rproject.toml yields nothing instead of throwing', () => {
		const meta = readRProject('[project\nname = ');
		assert.equal(meta.packageName, undefined);
		assert.deepEqual(meta.libraries, []);
	});

	test('parses a uvr.toml manifest, keeping its dev-dependencies apart from its dependencies', () => {
		const toml = [
			'[project]',
			'name = "uvrproject"',
			'r_version = "4.4.1"',
			'',
			'[dependencies]',
			'ggplot2 = ">=3.0.0"',
			'dplyr = "*"',
			'',
			'[dev-dependencies]',
			'testthat = "*"'
		].join('\n');
		const meta = readUvrManifest(toml);
		assert.equal(meta.packageName, 'uvrproject');
		assert.equal(meta.declaredRVersion, '4.4.1');
		assert.deepEqual(meta.libraries.map(l => l.name).sort(), ['dplyr', 'ggplot2', 'testthat']);
		assert.equal(meta.libraries.find(l => l.name === 'ggplot2')?.declaredVersion, '>=3.0.0');
	});

	test('a uvr.toml that only states an R requirement pins no R version', () => {
		assert.equal(readUvrManifest('[project]\nname = "p"\nr_version = ">=4.0.0"\n').declaredRVersion, undefined);
	});
});
