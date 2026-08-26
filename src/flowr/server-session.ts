import * as net from 'net';
import * as vscode from 'vscode';
import type { FlowrMessage } from '@eagleoutice/flowr/cli/repl/server/messages/all-messages';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { establishInternalSession, isWeb, updateStatusBar } from '../extension';
import type { ConnectionType } from '../settings';
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast';
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg';
import type { FlowrSession, SliceReturn } from './utils';
import { consolidateNewlines, makeSliceElements, selectionsToNodeIds } from './utils';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { DataflowGraphJson } from '@eagleoutice/flowr/dataflow/graph/graph';
import { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { FlowrHelloResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/message-hello';
import type { FileAnalysisResponseMessageJson } from '@eagleoutice/flowr/cli/repl/server/messages/message-analysis';
import type { Queries, QueryResults, SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import { DataflowMermaid } from '@eagleoutice/flowr/util/mermaid/dfg';
import { BiMap } from '@eagleoutice/flowr/util/collections/bimap';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import type { QueryResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/message-query';
import type { PipelineOutput } from '@eagleoutice/flowr/core/steps/pipeline/pipeline';
import type { DEFAULT_SLICING_PIPELINE } from '@eagleoutice/flowr/core/steps/pipeline/default-pipelines';
import { getConfig, isVerbose, Settings } from '../settings';
import type { DiagramSelectionMode } from './diagrams/diagram-definitions';
import type { CfgSimplificationPassName } from '@eagleoutice/flowr/control-flow/cfg-simplification';
import { MermaidDefaultMarkStyle } from '@eagleoutice/flowr/util/mermaid/info';
import type { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';

export class FlowrServerSession implements FlowrSession {

	public state:        'inactive' | 'connecting' | 'connected' | 'not connected';
	public flowrVersion: string | undefined;
	public rVersion:     string | undefined;
	public working:      boolean = false;

	private readonly outputChannel: vscode.OutputChannel;
	private connection:             Connection | undefined;
	private idCounter = 0;

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;

		this.state = 'inactive';
		updateStatusBar();
	}

	async initialize() {
		this.state = 'connecting';
		updateStatusBar();

		const configType = getConfig().get<ConnectionType>(Settings.ServerConnectionType, 'auto');
		this.connect(configType, configType);

		// the first response will be flowR's hello message
		return this.awaitResponse().then(r => {
			const info = JSON.parse(r) as FlowrHelloResponseMessage;
			this.rVersion = info.versions.r;
			this.flowrVersion = info.versions.flowr;
			updateStatusBar();
		});
	}

	setWorking(working: boolean): void {
		this.working = working;
		updateStatusBar();
	}

	public destroy(): void {
		this.connection?.destroy();
	}

	private connect(configType: ConnectionType, typeToUse: ConnectionType): void {
		let host = getConfig().get<string>(Settings.ServerHost, 'localhost');
		const port = getConfig().get<number>(Settings.ServerPort, 1042);
		// we also set configType when overriding the type to use because that's the only one we want to try even in auto mode!
		if(host.startsWith('ws://')){
			host = host.substring(5);
			configType = typeToUse = 'websocket';
		} else if(host.startsWith('wss://')){
			host = host.substring(6);
			configType = typeToUse = 'websocket-secure';
		}
		const [base, suff] = splitHost(host);
		this.outputChannel.appendLine(`Connecting to flowR server using ${typeToUse} at ${base}:${port}/${suff}/`);
		// if the type is auto, we still start with a (secure!) websocket connection first
		this.connection = !isWeb() && typeToUse === 'tcp' ? new TcpConnection() : new WsConnection(typeToUse !== 'websocket');
		this.connection.connect(host, port, () => {
			this.state = 'connected';
			updateStatusBar();
			this.outputChannel.appendLine('Connected to flowR server');
		});
		this.connection.on('error', e => {
			this.outputChannel.appendLine(`flowR server error: ${(e as Error).message}`);

			if(configType == 'auto' && this.connection instanceof WsConnection) {
				// retry with tcp if we're in auto mode and the ws secure and normal ws connections failed
				this.connect(configType, this.connection.secure ? 'websocket' : 'tcp');
			} else {
				this.state = 'inactive';
				updateStatusBar();

				const useLocal = 'Use local shell instead';
				const openSettings = 'Open connection settings';
				void vscode.window.showErrorMessage(`The flowR server connection reported an error: ${(e as Error).message}`, openSettings, useLocal)
					.then(v => {
						if(v === useLocal) {
							void establishInternalSession();
						} else if(v === openSettings) {
							void vscode.commands.executeCommand( 'workbench.action.openSettings', 'vscode-flowr.server' );
						}
					});
			}
		});
		this.connection.on('close', () => {
			this.outputChannel.appendLine('flowR server connection closed');
			this.state = 'not connected';
			updateStatusBar();
		});
		this.connection.on('data', str => this.handleResponse(String(str)));
	}

	private currentMessageBuffer = '';
	handleResponse(message: string): void {
		if(!message.endsWith('\n')) {
			this.currentMessageBuffer += message;
			return;
		}
		message = this.currentMessageBuffer + message;
		this.currentMessageBuffer = '';
		if(isVerbose()) {
			this.outputChannel.appendLine('Received: ' + message);
		}
		this.onceOnLineReceived?.(message);
		this.onceOnLineReceived = undefined;
		this.setWorking(false);
		updateStatusBar();
	}

	private onceOnLineReceived: undefined | ((line: string) => void);

	sendCommand(command: object): boolean {
		if(this.connection) {
			if(isVerbose()) {
				this.outputChannel.appendLine('Sending: ' + JSON.stringify(command));
			}
			this.connection.write(JSON.stringify(command) + '\n');
			return true;
		}
		return false;
	}

	async sendCommandWithResponse<Target>(command: FlowrMessage): Promise<Target> {
		this.setWorking(true);
		updateStatusBar();
		const response = this.awaitResponse();
		this.sendCommand(command);
		return JSON.parse(await response) as Target;
	}

	awaitResponse(): Promise<string> {
		return new Promise(resolve => {
			this.onceOnLineReceived = resolve;
		});
	}

	async retrieveCallgraphMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified = false): Promise<string> {
		const { result, ast, dfi, hasError } = await this.retrieveQuery(document, [{ type: 'call-graph' }]);

		if(hasError || !ast || !dfi) {
			return '';
		}

		const selectionNodes = selectionsToNodeIds(ast.ast.files.map(f => f.root), selections);

		return DataflowMermaid.convert({
			graph:               DataflowGraph.fromJson(result['call-graph'].graph as unknown as DataflowGraphJson),
			simplified,
			includeEnvironments: false,
			includeOnlyIds:      selectionMode === 'hide' ? selectionNodes : undefined,
			mark:                selectionMode === 'highlight' ? new Set(selectionNodes?.values().map(v => String(v))) : undefined,
		}).string;
	}


	async retrieveDataflowMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified = false): Promise<string> {
		const response = await this.requestFileAnalysis(document);
		const selectionNodes = selectionsToNodeIds(response.results.normalize.ast.files.map(f => f.root), selections);

		return DataflowMermaid.convert({
			graph:               DataflowGraph.fromJson(response.results.dataflow.graph as unknown as DataflowGraphJson),
			simplified,
			includeEnvironments: false,
			includeOnlyIds:      selectionMode === 'hide' ? selectionNodes : undefined,
			mark:                selectionMode === 'highlight' ? new Set(selectionNodes?.values().map(v => String(v))) : undefined,
		}).string;
	}

	async retrieveAstMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode): Promise<string> {
		const response = await this.requestFileAnalysis(document);
		const selectionNodes = selectionsToNodeIds(response.results.normalize.ast.files.map(f => f.root), selections);

		return normalizedAstToMermaid(response.results.normalize.ast, {
			includeOnlyIds: selectionMode === 'hide' ? selectionNodes : undefined,
			mark:           selectionMode === 'highlight' ? selectionNodes : undefined,
		});
	}

	async retrieveCfgMermaid(document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified: boolean, _: CfgSimplificationPassName[]): Promise<string> {
		const response = await this.requestFileAnalysis(document);
		const selectionNodes = selectionsToNodeIds(response.results.normalize.ast.files.map(f => f.root), selections);

		if(response.cfg === undefined) {
			return '';
		}

		const normalize: NormalizedAst = {
			...response.results.normalize,
			idMap: new BiMap()
		};
		return cfgToMermaid(response.cfg, normalize, {
			includeOnlyIds: selectionMode === 'hide' ? selectionNodes : undefined,
			mark:           selectionMode === 'highlight' ? selectionNodes : undefined,
			simplify:       simplified,
			markStyle:      MermaidDefaultMarkStyle
		});
	}

	async retrieveSlice(criteria: SlicingCriteria, direction: SliceDirection, document: vscode.TextDocument): Promise<SliceReturn> {
		const response = await this.requestFileAnalysis(document);
		const includeCallees = getConfig().get<boolean>(Settings.SliceIncludeCallees, false);
		const inlineSources = getConfig().get<boolean>(Settings.SliceInlineSources, false);
		// now we want to collect all ids from response in a map again (id -> location)
		const idToLocation = new Map<NodeId, SourceRange>();
		const nodes = response.results.normalize.ast.files.map(f => f.root);
		RNode.visitAst(nodes, n => {
			// backwards compat for server versions before 2.0.2, which used a "flavor" rather than a "named" boolean
			if(n.flavor === 'named') {
				n['name' + 'd'] = true;
			}

			if(n.location) {
				idToLocation.set(n.info.id, n.location);
			}
		});

		const sliceResponse = await this.sendCommandWithResponse<QueryResponseMessage>({
			type:        'request-query',
			'id':        String(this.idCounter++),
			'filetoken': '@tmp',
			query:       [{
				type:      'static-slice',
				criteria:  criteria,
				direction: direction,
				includeCallees,
				inlineSources
			}]
		});
		const result = Object.values(sliceResponse.results['static-slice'].results)[0] as PipelineOutput<typeof DEFAULT_SLICING_PIPELINE>;

		const sliceElements = makeSliceElements(result.slice.result, id => idToLocation.get(id));

		if(isVerbose()) {
			this.outputChannel.appendLine('[Slice (Server)] Contains Ids: ' + JSON.stringify([...result.slice.result]));
		}
		return {
			code: typeof result.reconstruct.code === 'string' ? result.reconstruct.code : result.reconstruct.code.join('\n'),
			sliceElements
		};
	}

	private async requestFileAnalysis(document: vscode.TextDocument, filetoken = '@tmp'): Promise<FileAnalysisResponseMessageJson> {
		return await this.sendCommandWithResponse<FileAnalysisResponseMessageJson>({
			type:     'request-file-analysis',
			id:       String(this.idCounter++),
			filename: document.fileName,
			filetoken,
			format:   'json',
			cfg:      true,
			content:  consolidateNewlines(document.getText())
		});
	}

	public async retrieveQuery<T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>): Promise<{ result: QueryResults<T>, hasError: boolean, dfi?: DataflowInformation, ast?: NormalizedAst }> {
		await this.requestFileAnalysis(document, '@query');
		return {
			result: await this.sendCommandWithResponse({
				type:      'request-query',
				id:        String(this.idCounter++),
				filetoken: '@query',
				query
			}),
			hasError: false
		};
	}

	runRepl(_output: Omit<FlowrReplOptions, 'parser'>): Promise<void> {
		vscode.window.showErrorMessage('The flowR server session does not support REPLs at the moment');
		return Promise.resolve();
	}
}

interface Connection {
	connect(host: string, port: number, connectionListener: () => void): void;
	on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
	write(data: string): void;
	destroy(): void
}

class TcpConnection implements Connection {

	private socket: net.Socket | undefined;

	connect(host: string, port: number, connectionListener: () => void): void {
		this.socket = net.createConnection(port, host, connectionListener);
	}

	on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void): void {
		this.socket?.on(event, listener);
	}

	write(data: string): void {
		this.socket?.write(data);
	}

	destroy(): void {
		this.socket?.destroy();
	}
}


/**
 * splits foo.com/bar into ['foo.com', 'bar']
 */
function splitHost(baseHost: string): [string, string] {
	const split = baseHost.split('/');
	return [split[0], split.slice(1).join('/')];
}

class WsConnection implements Connection {
	public readonly secure: boolean;
	private socket:         WebSocket | undefined;

	constructor(secure: boolean) {
		this.secure = secure;
	}

	connect(host: string, port: number, connectionListener: () => void): void {
		const [base, suff] = splitHost(host);
		this.socket = new WebSocket(`${this.secure ? 'wss' : 'ws'}://${base}:${port}/${suff}/`);
		this.socket.addEventListener('open', connectionListener);
	}

	on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void): void {
		this.socket?.addEventListener(event == 'data' ? 'message' : event, e => listener((e as MessageEvent)?.data ?? e));
	}

	write(data: string): void {
		this.socket?.send(data);
	}

	destroy(): void {
		this.socket?.close();
	}

}
