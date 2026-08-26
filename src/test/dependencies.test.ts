import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension, ensureSigDbCurrentDownloaded, openTestFile } from './test-util';
import type { Dependency } from '../flowr/views/dependency-view';
import { unknownGuardedName } from '../flowr/views/dependency-view';
import { downloadSigDbScope } from '../package-db';
import { refreshSigDbConfig } from '../extension';

type DependencyDisplay = { label: string, description: string, children?: DependencyDisplay[] };

function simplifyDependencies(dependencies: Dependency[] | undefined): DependencyDisplay[] {
	return dependencies?.map(d => ({
		label:       typeof d.label === 'string' ? d.label : d.label?.label as string,
		// strip the version/installed badge: it depends on the machine's local R library, which assertions must stay independent of
		description: (d.description as string)?.replace(/ — .*$/, ''),
		children:    simplifyDependencies(d.children)
	})) ?? [];
}

function populateExpectedDependencies(expected: DependencyDisplay[]) {
	const expectedSorted = [];

	// set default values for any that we didn't specify (undeclared/unused are not shown in the overview)
	for(const def of ['Libraries', 'Imported Data', 'Sourced Scripts', 'Outputs', 'Visualizations', 'Tests', 'Statistical Tests', 'Remote Installs']) {
		const idx = expected.findIndex(e => e.label === def);

		if(idx < 0) {
			expectedSorted.push({ label: def, description: '0 items', children: [] });
		} else {
			expectedSorted.push(expected[idx]);
		}
	}

	return expectedSorted;
}

async function verifyDependencies(expected: DependencyDisplay[]) {
	const result: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
	assert.ok(result);
	assert.deepEqual(simplifyDependencies(result), populateExpectedDependencies(expected));
}

suite('dependencies', () => {
	// regression: a namespaced call keeps its Identifier (['map','purrr',false]); it must render as valid R, not a stringified array
	suite('unknownGuardedName', () => {
		type Info = Parameters<typeof unknownGuardedName>[0];
		test('renders a namespaced Identifier value as pkg::fn', () => {
			assert.strictEqual(unknownGuardedName({ nodeId: 0, functionName: 'x', value: ['map', 'purrr', false] } as unknown as Info), 'purrr::map');
		});
		test('passes a plain string value through unchanged', () => {
			assert.strictEqual(unknownGuardedName({ nodeId: 0, functionName: 'x', value: 'dplyr' } as unknown as Info), 'dplyr');
		});
	});

	suiteSetup(async function() {
		this.timeout(60000);
		await activateExtension();
		await vscode.commands.executeCommand('flowr-dependencies.focus');
		// several guess-dep-versions tests below need real signature-database data (ggplot2, dplyr, ...) -
		// a fresh checkout/CI runner has none of this synced yet
		await ensureSigDbCurrentDownloaded();
	});

	test('vapply', async() => {
		await openTestFile('vapply-example.R');
		await verifyDependencies([
			{ label:       'Libraries', description: '6 items', children:    [
				{ label: 'a', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'b', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'c', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'd', description: 'by "library" in (L. 5)', children: [] },
				{ label: 'e', description: 'by "library" in (L. 5)', children: [] },
				{ label: 'f', description: 'by "library" in (L. 5)', children: [] },
			] },
			{
				label:       'Outputs', description: '2 items', children:    [
					{ label: 'stdout', description: 'by "lapply" in (L. 2)', children: [] },
					{ label: 'stdout', description: 'by "vapply" in (L. 5)', children: [] },
				]
			}
		]);
	});

	// typing a new library() line must be reflected in the view - the analyzer is keyed by document version, not served stale
	test('reflects edits: a newly typed library() appears', async() => {
		const editor = await openTestFile('dep-edit-example.R');
		const libraryLabels = (deps: Dependency[] | undefined) =>
			simplifyDependencies(deps).find(d => d.label === 'Libraries')?.children?.map(c => c.label) ?? [];

		const before: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		assert.deepEqual(libraryLabels(before), ['alpha'], 'the fixture starts with a single library');

		// simulate the user typing a second library() call
		await editor.edit(eb => eb.insert(new vscode.Position(1, 0), 'library(beta)\n'));

		const after: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		assert.deepEqual(libraryLabels(after).sort(), ['alpha', 'beta'], 'the typed library must appear alongside the original');
	});

	// regression test: "Go to Dependency" used to only scroll into view without moving the cursor there, unlike a direct click
	test('"Go to Dependency" (context menu) moves the cursor to the entry\'s location', async() => {
		const editor = await openTestFile('vapply-example.R');
		editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		const result: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		const entry = result?.find(d => d.label === 'Libraries')?.children?.[0];
		assert.ok(entry, 'expected a library dependency entry');
		const loc = entry.getLocation();
		assert.ok(loc, 'expected the entry to know its source location');

		await vscode.commands.executeCommand('vscode-flowr.internal.goto.dependency', entry);
		// the command itself defers the actual move via setTimeout(…, 50)
		await new Promise(resolve => setTimeout(resolve, 200));

		assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, loc[0] - 1, 'expected the cursor to have moved to the dependency\'s line');
	});

	// regression test: a cached refresh must still carry location and ast/dfi - these were silently dropped on a cache hit before
	test('"go to dependency" and slicing still work on a cached (unchanged) refresh', async() => {
		await openTestFile('vapply-example.R');
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');

		const cached: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		const entry = cached?.find(d => d.label === 'Libraries')?.children?.[0];
		assert.ok(entry, 'expected a library dependency entry on the cached refresh');
		assert.ok(entry.getLocation(), 'expected the cached entry to know its source location (used by "go to dependency")');
		assert.ok(entry.command, 'expected the cached entry to have a "go to location" command');
		assert.ok(entry.getAnalysisInfo(), 'expected the cached entry to still carry ast/dfi (used when slicing from a dependency entry)');
	});

	test('"Guess Dependency Versions" opens a Markdown report', async() => {
		await openTestFile('definition-self-example.R'); // `library(ggplot2)`
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');

		// .findLast(), not .find(): an earlier test in this file may have left its own such report open
		const report = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
		assert.ok(report, 'expected a Markdown report document to have been opened');
		// without a synced signature database (as in this sandbox) the query reports that explicitly instead of guessing
		const text = report.getText();
		assert.ok(text.includes('ggplot2') || text.includes('signature database'), `expected the report to mention ggplot2 or explain why it could not, got: ${text}`);
	});

	// regression test: the command must always guess for whichever document is the *active* editor, using its
	// current (possibly unsaved) content - not a stale target left over from an earlier invocation
	// uses fresh untitled documents (not a shared test-workspace fixture) so this test can freely edit its own
	// content without leaking state into other tests - editing a shared .R fixture would persist unsaved for
	// the rest of the suite run, since re-opening the same file reuses the already-open, already-edited document
	test('"Guess Dependency Versions" targets the active editor\'s current content, not a stale one', async() => {
		const doc1 = await vscode.workspace.openTextDocument({ language: 'r', content: 'library(ggplot2)\n' });
		await vscode.window.showTextDocument(doc1, { preview: false });
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');
		const firstReport = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
		assert.ok(firstReport, 'expected a report for the first active editor');
		assert.ok(firstReport.getText().includes('## ggplot2'), `expected the first report to mention package "ggplot2", got: ${firstReport.getText()}`);

		const doc2 = await vscode.workspace.openTextDocument({ language: 'r', content: 'library(dplyr)\n' });
		await vscode.window.showTextDocument(doc2, { preview: false });
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');
		const secondReport = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
		assert.ok(secondReport, 'expected a report for the second active editor');
		assert.ok(secondReport.getText().includes('## dplyr'), `expected the second report to mention package "dplyr" (the new active editor), got: ${secondReport.getText()}`);
		assert.ok(!secondReport.getText().includes('## ggplot2'), 'must not still show the first document\'s package once the active editor switched');

		// now edit the *currently* active editor (still `doc2`) and re-run - must reflect the live, unsaved edit
		// re-fetch a fresh editor reference: showing the markdown report above may have replaced doc2's own tab,
		// invalidating an earlier-captured TextEditor object ("TextEditor#edit not possible on closed editors")
		const editor2 = await vscode.window.showTextDocument(doc2, { preview: false });
		await editor2.edit(eb => eb.insert(new vscode.Position(0, 0), 'library(tidyr)\n'));
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');
		const thirdReport = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
		assert.ok(thirdReport, 'expected a report after the live edit');
		assert.ok(thirdReport.getText().includes('## tidyr'), `expected the report to reflect the just-typed, unsaved library(tidyr), got: ${thirdReport.getText()}`);
	});

	// regression test: a real function/parameter usage must actually narrow the guessed range (not just report
	// "N/A no constraining evidence" - that path is covered separately by the history-scope warning test below,
	// which deliberately has no real evidence to work with)
	test('"Guess Dependency Versions" narrows the range using real function/parameter usage evidence', async function() {
		this.timeout(120000);
		// `legend.key.spacing` was added to ggplot2::theme() in 0.9.2 - calling it with that named argument
		// must raise ggplot2's guessed lower bound accordingly, with a concrete evidence line saying so
		const doc = await vscode.workspace.openTextDocument({
			language: 'r',
			content:  'library(ggplot2)\ntheme(legend.key.spacing = 1)\n'
		});
		await vscode.window.showTextDocument(doc, { preview: false });
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');

		const report = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
		assert.ok(report, 'expected a Markdown report document to have been opened');
		const text = report.getText();

		assert.ok(/legend\.key\.spacing.*only from/.test(text), `expected an evidence line about the "legend.key.spacing" parameter, got: ${text}`);
		assert.ok(!text.includes('Runnable combinations:** N/A'), 'expected a real runnable-combinations percentage, not the no-evidence "N/A" case');
		assert.ok(/Runnable combinations:\*\* \d+ \/ \d+ \(\d+%\)/.test(text), `expected a "N / M (P%)" runnable-combinations line, got: ${text}`);
	});

	// regression test: without the full CRAN history scope, a guess can only be checked against currently-available
	// versions, so an older release that would actually satisfy a constraint may look unsatisfiable or go missing -
	// the report and a toast must both say so, rather than presenting an incomplete guess as if it were complete
	test('"Guess Dependency Versions" warns when the CRAN history scope is not downloaded', async function() {
		this.timeout(120000);
		const previousCacheDir = process.env.FLOWR_SIGDB_CACHE;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-guess-versions-test-'));
		process.env.FLOWR_SIGDB_CACHE = tempDir;
		const originalShowWarning = vscode.window.showWarningMessage;
		let warned = false;
		try {
			await downloadSigDbScope('base');
			await downloadSigDbScope('current');
			// intentionally no downloadSigDbScope('history')
			// the flowR session may already be alive from an earlier test, built against the real (non-temp)
			// cache dir - force it to rebuild now so the query below actually sees the temp dir's mount paths
			refreshSigDbConfig();
			(vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = (msg: string) => {
				if(msg.includes('CRAN history')) {
					warned = true;
				}
				return Promise.resolve(undefined);
			};

			await openTestFile('definition-self-example.R'); // `library(ggplot2)`
			await vscode.commands.executeCommand('vscode-flowr.dependencyView.guessVersions');

			// .findLast(), not .find(): an earlier test in this file may have left its own such report open
			const report = vscode.workspace.textDocuments.findLast(d => d.languageId === 'markdown' && d.getText().includes('Guessed Dependency Versions'));
			assert.ok(report, 'expected a Markdown report document to have been opened');
			assert.ok(report.getText().includes('CRAN history'), `expected the report to warn about the missing CRAN history scope, got: ${report.getText()}`);
			assert.ok(warned, 'expected a warning toast about the missing CRAN history scope');
		} finally {
			(vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = originalShowWarning;
			if(previousCacheDir === undefined) {
				delete process.env.FLOWR_SIGDB_CACHE;
			} else {
				process.env.FLOWR_SIGDB_CACHE = previousCacheDir;
			}
			// the guess-versions query above ran against the shared flowR session while FLOWR_SIGDB_CACHE pointed
			// at the temp dir - rebuild it now that the env var is restored, so later tests see the real cache again
			refreshSigDbConfig();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
