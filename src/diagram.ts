import * as vscode from 'vscode'
import { establishInternalSession, flowrSession } from './extension'

export function registerDiagramCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.dataflow', async() => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor) {
			if(!flowrSession) {
				await establishInternalSession()
			}
			const mermaid = await flowrSession?.retrieveDataflowMermaid(activeEditor)
			if(mermaid) {
				createWebview('flowr-dataflow', 'Dataflow Graph', mermaid)
			}
		}
	}))
}

function createWebview(id: string, name: string, mermaid: string) : vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(id, name, vscode.ViewColumn.Beside, {
		enableScripts: true
	})
	panel.webview.html = createDocument(mermaid)
	return panel
}

function createDocument(mermaid: string) {
	const theme = vscode.window.activeColorTheme.kind == vscode.ColorThemeKind.Light ? 'default' : 'dark'
	return `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
	<script>
		mermaid.initialize({
			theme: '${theme}',
		})
	</script>
	<pre class="mermaid">
    	${mermaid}
	</pre>
</body>
</html>`
}