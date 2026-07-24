import * as vscode from 'vscode';
import { activateExtension, ensureSigDbCurrentDownloaded, openTestFile } from './test-util';
import assert from 'assert';

suite('package info', () => {
	suiteSetup(async function() {
		this.timeout(60000);
		await activateExtension();
		// the package-function source-link tests below need real signature-database data (ggplot2) - a fresh
		// checkout/CI runner has none of this synced yet
		await ensureSigDbCurrentDownloaded();
	});

	test('attributes a base built-in (print) to its base package', async() => {
		const editor = await openTestFile('hover-bottom-example.R');
		// `print` on the second line is a base built-in, available without library()
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(1, 0));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const baseHover = contents.find(v => /provided by/.test(v) && v.includes('base'));
		assert.ok(baseHover, `expected 'print is provided by the base package', got: ${JSON.stringify(contents)}`);
	});

	// regression test: `acf` (from `stats`) has no special dataflow handling in flowR (unlike `print`), so it
	// isn't in the small builtin-name set case 3 used to rely on exclusively - a bare call with no library()/`::`
	// must still be attributed via the signature database, checking R's other default-loaded packages directly
	test('attributes a bare call to a function from a default-loaded package (stats::acf) without library()', async() => {
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'acf(1:10)\n' });
		await vscode.window.showTextDocument(doc, { preview: false });
		const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 1));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const hover = contents.find(v => /provided by/.test(v) && v.includes('stats'));
		assert.ok(hover, `expected 'acf is provided by the stats package', got: ${JSON.stringify(contents)}`);
		assert.ok(hover.includes('📖'), `expected a prominent documentation link, got: ${hover}`);
	});

	// regression: a `pkg::fn` call carries its namespace in the source, so the hover must resolve it without a library() load
	test('attributes an explicit ggplot2::after_scale call without library()', async() => {
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'ggplot2::after_scale(1)\n' });
		await vscode.window.showTextDocument(doc, { preview: false });
		const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 12));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const hover = contents.find(v => /provided by/.test(v) && v.includes('ggplot2'));
		assert.ok(hover, `expected 'after_scale is provided by the ggplot2 package', got: ${JSON.stringify(contents)}`);
	});

	test('does not attribute a locally defined function to a package', async() => {
		const editor = await openTestFile('package-info-example.R');
		// `myFunction` is defined in this very file, so we must not claim it comes from a package
		const pos = new vscode.Position(5, 3);
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		assert.ok(!contents.some(v => /provided by/.test(v)), `did not expect a package hover for a local function, got: ${JSON.stringify(contents)}`);
	});

	// regression test: a call's origins include both the closure and its binding; VS Code can't label multiple results, so this must collapse to the function body alone
	test('jumps to the definition of a locally defined function (a single location, not also its own binding)', async() => {
		const editor = await openTestFile('package-info-example.R');
		// the call `myFunction(2)` on the last line should resolve to its definition on line 3 (index 2)
		const pos = new vscode.Position(5, 3);
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos);
		assert.strictEqual(result?.length, 1, `expected exactly one (unambiguous) definition location, got: ${JSON.stringify(result?.map(l => l.range))}`);
		assert.strictEqual(result[0].range.start.line, 2, `expected the definition on line 3 (index 2), got line ${result[0].range.start.line}`);
	});

	// regression test: clicking a definition itself has no dataflow origin to resolve, so it must not come up empty
	test('clicking a local function definition itself resolves to its own location, not nothing', async() => {
		const editor = await openTestFile('package-info-example.R');
		// `myFunction` on line 3 (index 2) is the definition itself, not a use of it
		const pos = new vscode.Position(2, 3);
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos);
		assert.ok(result && result.length > 0, 'expected the definition to resolve to itself rather than nothing');
		assert.ok(
			result.some(loc => loc.range.start.line === 2),
			`expected a location on line 3 (index 2), got lines: ${result.map(l => l.range.start.line).join(', ')}`
		);
	});

	test('clicking a local variable definition (not a function) itself resolves to its own location', async() => {
		const editor = await openTestFile('definition-self-example.R');
		// `df` on line 5 (index 4) is the definition itself: `df <- data.frame(x = 1:5)`
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, new vscode.Position(4, 0));
		assert.ok(result && result.length > 0, 'expected the definition to resolve to itself rather than nothing');
		assert.ok(
			result.some(loc => loc.range.start.line === 4),
			`expected a location on line 5 (index 4), got lines: ${result.map(l => l.range.start.line).join(', ')}`
		);
	});

	// regression test: "Find All References" used to always report nothing, since no ReferenceProvider was registered at all
	test('finds all references to a local variable, including its own definition', async() => {
		const editor = await openTestFile('definition-self-example.R');
		// `df` is defined on line 5 (index 4) and used on line 6 (index 5)
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeReferenceProvider', editor.document.uri, new vscode.Position(4, 0));
		assert.ok(result && result.length > 0, 'expected at least one reference');
		const lines = result.map(l => l.range.start.line).sort();
		assert.deepStrictEqual(lines, [4, 5], `expected references on both the definition (line 5) and its use (line 6), got lines: ${lines.join(', ')}`);
	});

	/**
	 * Simulates a real Ctrl+click at `pos` (via the actual "go to definition" command, not just resolving the
	 * provider) and reports what external URL, if any, it opened - intercepting `vscode.env.openExternal` rather
	 * than reading a DocumentLink, since package/function links are now real (redirect) Definitions: no permanent
	 * underline (only while Ctrl is held, like any other go-to-definition target), but still reliably click-through.
	 */
	async function simulateClickAndCaptureExternalOpen(editor: vscode.TextEditor, pos: vscode.Position): Promise<string | undefined> {
		const original = vscode.env.openExternal;
		let openedUrl: string | undefined;
		try {
			(vscode.env as { openExternal: typeof vscode.env.openExternal }).openExternal = (uri: vscode.Uri) => {
				openedUrl = uri.toString(true);
				return Promise.resolve(true);
			};
			editor.selection = new vscode.Selection(pos, pos);
			await vscode.window.showTextDocument(editor.document, { selection: editor.selection });
			await vscode.commands.executeCommand('editor.action.revealDefinition');
			await new Promise(resolve => setTimeout(resolve, 1000));
			return openedUrl;
		} finally {
			(vscode.env as { openExternal: typeof vscode.env.openExternal }).openExternal = original;
		}
	}

	// regression test: the old fake-Location trick for Ctrl+click-to-CRAN also opened the browser on mere Ctrl+hover.
	// Merely resolving the provider's Definition (what a hover-preview needs) must not open anything by itself -
	// only an actual navigation (a real tab opening) may trigger `openExternal` - see the redirect mechanism in
	// package-info.ts (`registerExternalRedirect`/`redirectUri`) for how this is kept structurally impossible.
	test('merely resolving a definition does not open anything - only a real click may', async() => {
		const editor = await openTestFile('definition-self-example.R'); // `library(ggplot2)` on line 1
		const original = vscode.env.openExternal;
		let called = false;
		try {
			(vscode.env as { openExternal: typeof vscode.env.openExternal }).openExternal = () => {
				called = true;
				return Promise.resolve(true);
			};
			await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, new vscode.Position(0, 9));
			await new Promise(resolve => setTimeout(resolve, 500));
		} finally {
			(vscode.env as { openExternal: typeof vscode.env.openExternal }).openExternal = original;
		}
		assert.strictEqual(called, false, 'merely resolving the definition must not have opened anything');
	});

	test('a real click on library()\'s package name opens its CRAN page, without leaving a stray tab open', async() => {
		const editor = await openTestFile('definition-self-example.R'); // `library(ggplot2)` on line 1
		const opened = await simulateClickAndCaptureExternalOpen(editor, new vscode.Position(0, 9));
		assert.strictEqual(opened, 'https://cran.r-project.org/package=ggplot2');
		const redirectTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'vscode-flowr-open-external');
		assert.strictEqual(redirectTabs.length, 0, `expected no leftover redirect tab, got: ${JSON.stringify(redirectTabs.map(t => t.label))}`);
	});

	// a base R package (shipped with R itself, e.g. `stats`) has no CRAN page - clicking it must not open anything
	test('a real click on a base R package loaded via library() does not open anything (it has no CRAN page)', async() => {
		const editor = await openTestFile('library-base-example.R'); // `library(stats)`
		const opened = await simulateClickAndCaptureExternalOpen(editor, new vscode.Position(0, 9));
		assert.strictEqual(opened, undefined, 'did not expect a CRAN link for the base package `stats`');
	});

	// a call to a package function has never had any click-through before; it must not be underlined in the
	// source (no DocumentLink), but a real click should still open its source, via the same redirect mechanism
	test('a real click on a call to a package function opens its source', async() => {
		const editor = await openTestFile('definition-self-example.R'); // `ggplot()` on line 3
		const opened = await simulateClickAndCaptureExternalOpen(editor, new vscode.Position(2, 2));
		assert.ok(opened?.startsWith('https://github.com/cran/ggplot2/'), `expected a ggplot2 GitHub source link, got: ${opened}`);
	});

	// regression test: `library(ggplot)` is a plausible typo of `ggplot2` - the hover must offer a "did you mean" guess, not just report unknown
	test('hovering an unresolved library() package suggests a close match when one exists', async() => {
		const editor = await openTestFile('library-typo-example.R');
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(0, 9));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const hint = contents.find(v => v.includes('ggplot'));
		assert.ok(hint?.includes('did you mean') && hint.includes('ggplot2'), `expected a "did you mean ggplot2" hint, got: ${JSON.stringify(contents)}`);
	});
});
