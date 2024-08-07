
// The class in this file is used to provide content for the reconstruction editor
//
// The content of files is updated by us using the .updateContents() method.
//
// The content of a file is requested by vscode using the .provideTextDocumentContent() method,
// when the corresponding URI is opened.
//
// To show a file, use the showUri function, defined below.

import * as vscode from 'vscode'

export const flowrScheme = 'flowr'

export class ReconstructionContentProvider implements vscode.TextDocumentContentProvider {

	listeners: ((e: vscode.Uri) => unknown)[] = []

	contents: Map<string, string> = new Map()

	onDidChange(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
		this.listeners.push(listener)
		const dispo = new vscode.Disposable(() => {
			this.listeners = this.listeners.filter(l => l !== listener)
		})
		return dispo
	}

	notifyListeners(uri: vscode.Uri): void {
		for(const listener of this.listeners){
			listener(uri)
		}
	}

	updateContents(uri: vscode.Uri, content?: string) {
		if(content !== undefined){
			this.contents.set(uri.toString(), content)
		} else {
			this.contents.delete(uri.toString())
		}
		this.notifyListeners(uri)
	}

	provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
		return this.contents.get(uri.toString())
	}
}

export function makeUri(authority: string, path: string){
	if(authority && path && !path.startsWith('/')){
		path = '/' + path
	}
	const uri = vscode.Uri.from({
		scheme:    flowrScheme,
		authority: authority,
		path:      path
	})
	return uri
}

export async function showUri(uri: vscode.Uri, language: string = 'r', viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<Thenable<vscode.TextEditor>> {
	for(const editor of vscode.window.visibleTextEditors){
		if(editor.document.uri.toString() === uri.toString()){
			return editor
		}
	}
	const doc = await vscode.workspace.openTextDocument(uri)
	await vscode.languages.setTextDocumentLanguage(doc, language)
	return await vscode.window.showTextDocument(doc, {
		viewColumn: viewColumn
	})
}

let reconstructionContentProvider: ReconstructionContentProvider | undefined
export function getReconstructionContentProvider(): ReconstructionContentProvider {
	if(!reconstructionContentProvider) {
		reconstructionContentProvider = new ReconstructionContentProvider()
		vscode.workspace.registerTextDocumentContentProvider(flowrScheme, reconstructionContentProvider)
	}
	return reconstructionContentProvider
}

