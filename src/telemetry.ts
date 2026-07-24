import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isWeb, updateStatusBar } from './extension';
import { getConfig, Settings } from './settings';

export abstract class Telemetry {

	abstract start(userPseudonym: string): void;

	abstract stop(): void | Promise<void>;

	abstract event(event: TelemetryEvent, args: Omit<TelemetryEventArgs, 'timestamp'>): void;

}

export class NoTelemetry extends Telemetry {
	start(): void {}
	stop(): void {}
	event(): void {}
}

/**
 * Settings-driven recording mode: streams every event as one chronological timeline into a local JSON file,
 * so error MWEs and study sessions can be replayed. The file never leaves the machine.
 */
export class RecordingTelemetry extends Telemetry {

	private readonly outputChannel: vscode.OutputChannel;
	public readonly filePath:       string;
	private readonly meta:          Record<string, unknown> = {};
	private readonly events:        TimelineEntry[] = [];
	private flushTimer:             ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(outputChannel: vscode.OutputChannel, filePath: string) {
		super();
		this.outputChannel = outputChannel;
		this.filePath = filePath;
	}

	start(userPseudonym: string): void {
		this.meta.acronym = userPseudonym;
		this.meta.started = new Date().toISOString();
		this.meta.vscodeVersion = vscode.version;
		this.meta.platform = typeof process === 'object' ? process.platform : 'web';
		this.meta.workspace = vscode.workspace.workspaceFolders?.map(f => f.uri.toString());
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		// snapshot everything already open, so the timeline is self-contained from its first entry
		for(const document of vscode.workspace.textDocuments) {
			if(document.uri.scheme !== 'output') {
				this.event(TelemetryEvent.OpenedDocument, { document: document.uri.toString(), languageId: document.languageId, alreadyOpen: true, ...contentSnapshot(document) });
			}
		}
		this.flush();
		this.outputChannel.appendLine(`[Recording] Started recording to ${this.filePath}`);
	}

	event(event: TelemetryEvent, args: Omit<TelemetryEventArgs, 'timestamp'>): void {
		if(this.stopped) {
			return;
		}
		this.events.push({ event, timestamp: Date.now(), ...args });
		this.flushTimer ??= setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, 1000);
	}

	private flush(): void {
		try {
			fs.writeFileSync(this.filePath, JSON.stringify({ ...this.meta, events: this.events }));
		} catch(e) {
			this.outputChannel.appendLine(`[Recording] Failed to write ${this.filePath}: ${(e as Error).message}`);
		}
	}

	stop(): void {
		if(this.stopped) {
			return;
		}
		this.stopped = true;
		if(this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.meta.stopped = new Date().toISOString();
		this.flush();
		this.outputChannel.appendLine(`[Recording] Stopped recording to ${this.filePath}`);
	}

}

export enum TelemetryEvent {
	UsedCommand = 'used-command',
	OpenedDocument = 'opened-document',
	ClosedDocument = 'closed-document',
	SavedDocument = 'saved-document',
	ChangedActiveEditor = 'changed-active-editor',
	ChangedVisibleEditors = 'changed-visible-editors',
	ChangedSelection = 'changed-selection',
	ChangedVisibleRanges = 'changed-visible-ranges',
	ChangedFile = 'changed-file',
	ChangedConfiguration = 'changed-configuration',
	ChangedWindowState = 'changed-window-state',
	ChangedDiagnostics = 'changed-diagnostics',
	OpenedTerminal = 'opened-terminal',
	ClosedTerminal = 'closed-terminal'
}

export interface TelemetryEventArgs extends Record<string, unknown> {
	timestamp: number
}

interface TimelineEntry extends TelemetryEventArgs {
	event: TelemetryEvent
}

export let telemetry: Telemetry = new NoTelemetry();

function telemetryActive(): boolean {
	return !(telemetry instanceof NoTelemetry);
}

/** documents whose content is already on record - later states are reconstructible from the change deltas */
const snapshotted = new Set<string>();

function contentSnapshot(document: vscode.TextDocument): { content?: string, version: number } {
	const key = document.uri.toString();
	if(snapshotted.has(key)) {
		return { version: document.version };
	}
	snapshotted.add(key);
	return { content: document.getText(), version: document.version };
}

/**
 * Starts/stops the recording mode according to the current settings. A new timeline file
 * `<acronym>-<timestamp>.json` is created in the configured directory (or the first workspace folder).
 */
export function syncRecordingFromConfig(output: vscode.OutputChannel): void {
	const enabled = getConfig().get<boolean>(Settings.RecordingEnabled, false);
	if(enabled && telemetry instanceof NoTelemetry) {
		if(isWeb()) {
			void vscode.window.showWarningMessage('The flowR recording mode is only available in desktop VS Code.');
			return;
		}
		const directory = getConfig().get<string>(Settings.RecordingDirectory)?.trim() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if(!directory) {
			void vscode.window.showWarningMessage(`The flowR recording mode needs an open workspace folder or the "${Settings.Category}.${Settings.RecordingDirectory}" setting to know where to store recordings.`);
			return;
		}
		const acronym = (getConfig().get<string>(Settings.RecordingAcronym)?.trim() || 'flowr').replace(/[^\w.-]+/g, '_');
		const filePath = path.join(directory, `${acronym}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
		snapshotted.clear();
		const recording = new RecordingTelemetry(output, filePath);
		telemetry = recording;
		recording.start(acronym);
		updateStatusBar();
		void vscode.window.showInformationMessage(`flowR is recording this session locally to ${filePath}.`);
	} else if(!enabled && telemetry instanceof RecordingTelemetry) {
		const filePath = telemetry.filePath;
		telemetry.stop();
		telemetry = new NoTelemetry();
		updateStatusBar();
		void vscode.window.showInformationMessage(`Stopped the flowR recording; the timeline is saved to ${filePath}.`, 'Open Recording').then(choice => {
			if(choice) {
				void vscode.window.showTextDocument(vscode.Uri.file(filePath));
			}
		});
	}
}

/**
 *
 */
export function registerTelemetry(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(d => {
		if(telemetryActive() && d.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.OpenedDocument, {
				document:   d.uri.toString(),
				languageId: d.languageId,
				...contentSnapshot(d)
			});
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(d => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.OpenedDocument, { document: d.uri.toString() });
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(d => {
		snapshotted.delete(d.uri.toString());
		if(telemetryActive() && d.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ClosedDocument, { document: d.uri.toString(), version: d.version });
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(d => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ClosedDocument, { document: d.uri.toString() });
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d => {
		if(telemetryActive() && d.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.SavedDocument, { document: d.uri.toString(), version: d.version });
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		if(telemetryActive() && e.document.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ChangedFile, {
				document: e.document.uri.toString(),
				// full text only the first time a document is seen; afterwards the deltas suffice
				...contentSnapshot(e.document),
				changes:  e.contentChanges,
				reason:   e.reason
			});
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeNotebookDocument(e => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ChangedFile, {
				document:    e.notebook.uri.toString(),
				changes:     e.contentChanges,
				cellChanges: e.cellChanges
			});
		}
	}));

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => {
		if(telemetryActive() && e?.document.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ChangedActiveEditor, {
				document: e?.document.uri.toString(),
				...(e ? contentSnapshot(e.document) : {})
			});
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(e => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ChangedActiveEditor, { document: e?.notebook.uri.toString() });
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ChangedVisibleEditors, { documents: editors.map(e => e.document.uri.toString()) });
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
		if(telemetryActive() && e.textEditor.document.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ChangedSelection, {
				document:   e.textEditor.document.uri.toString(),
				selections: e.selections,
				kind:       e.kind
			});
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeNotebookEditorSelection(e => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ChangedSelection, {
				document:   e.notebookEditor.notebook.uri.toString(),
				selections: e.selections
			});
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(e => {
		if(telemetryActive() && e.textEditor.document.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ChangedVisibleRanges, {
				document:      e.textEditor.document.uri.toString(),
				visibleRanges: e.visibleRanges
			});
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ChangedWindowState, { focused: state.focused });
		}
	}));
	context.subscriptions.push(vscode.window.onDidOpenTerminal(t => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.OpenedTerminal, { name: t.name });
		}
	}));
	context.subscriptions.push(vscode.window.onDidCloseTerminal(t => {
		if(telemetryActive()) {
			telemetry.event(TelemetryEvent.ClosedTerminal, { name: t.name, exitCode: t.exitStatus?.code });
		}
	}));
	context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => {
		if(telemetryActive()) {
			const diagnostics = e.uris.filter(u => u.scheme !== 'output').map(uri => ({
				document:    uri.toString(),
				diagnostics: vscode.languages.getDiagnostics(uri).map(d => ({ range: d.range, message: d.message, severity: d.severity, source: d.source }))
			}));
			if(diagnostics.length) {
				telemetry.event(TelemetryEvent.ChangedDiagnostics, { diagnostics });
			}
		}
	}));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if(telemetryActive()) {
			const affectsFlowr = e.affectsConfiguration(Settings.Category);
			telemetry.event(TelemetryEvent.ChangedConfiguration, {
				affectsFlowr,
				...(affectsFlowr ? { flowrConfig: JSON.parse(JSON.stringify(getConfig())) as unknown } : {})
			});
		}
		if(e.affectsConfiguration(`${Settings.Category}.recording`)) {
			syncRecordingFromConfig(output);
		}
	}));
	context.subscriptions.push(new vscode.Disposable(() => {
		if(telemetry instanceof RecordingTelemetry) {
			telemetry.stop();
		}
	}));
	syncRecordingFromConfig(output);
}
