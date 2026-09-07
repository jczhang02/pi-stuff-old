import magicContextFactory from "@cortexkit/pi-magic-context";
import type {
	MagicContextCommandDefinition,
	MagicContextEventHandler,
	MagicContextEventMap,
	MagicContextEventName,
	MagicContextEventRegistration,
	MagicContextExtensionAPI,
	MagicContextExtensionContext,
	MagicContextToolDefinition,
	MagicContextToolInfo,
} from "./magic-context-types.ts";
import { MagicWorkerContextStore } from "./magic-worker-context.ts";
import {
	MAGIC_WORKER_PROTOCOL_VERSION,
	type MagicWorkerCommandName,
	type MagicWorkerCommandRequest,
	type MagicWorkerEventRequest,
	type MagicWorkerEventResult,
	type MagicWorkerInitializeRequest,
	type MagicWorkerInvocationRequest,
	type MagicWorkerMessage,
	type MagicWorkerRequest,
	type MagicWorkerToolName,
	type MagicWorkerToolRequest,
	magicWorkerCommandName,
	magicWorkerToolName,
} from "./magic-worker-protocol.ts";

type HandlerRegistry = {
	readonly [Name in MagicContextEventName]: MagicContextEventHandler<Name>[];
};

const handlers: HandlerRegistry = {
	agent_end: [],
	before_agent_start: [],
	context: [],
	message_end: [],
	session_before_compact: [],
	session_before_switch: [],
	session_compact: [],
	session_shutdown: [],
	session_start: [],
	tool_execution_end: [],
	tool_execution_start: [],
	tool_result: [],
};
const commands = new Map<MagicWorkerCommandName, MagicContextCommandDefinition>();
const tools = new Map<MagicWorkerToolName, MagicContextToolDefinition>();
const controllers = new Map<number, AbortController>();
let hostTools: MagicContextToolInfo[] = [];
let initialized = false;

const MAGIC_CONTEXT_SOURCE: MagicContextToolInfo["sourceInfo"] = {
	origin: "package",
	path: "@cortexkit/pi-magic-context",
	scope: "temporary",
	source: "@cortexkit/pi-magic-context",
};

// Pi never initializes child Extensions inside the Context Engine Worker, so upstream child-init events have no publisher here.
const isolatedWorkerEvents: MagicContextExtensionAPI["events"] = {
	emit: () => undefined,
	on: () => () => undefined,
};

function send(message: MagicWorkerMessage): void {
	postMessage(message);
}

const contexts = new MagicWorkerContextStore(send);

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function sendError(id: number, cause: unknown): void {
	send({
		error: errorText(cause),
		id,
		stack: cause instanceof Error ? cause.stack : undefined,
		type: "error",
	});
}

function registerEvent(...registration: MagicContextEventRegistration): void {
	switch (registration[0]) {
		case "agent_end":
			handlers.agent_end.push(registration[1]);
			break;
		case "before_agent_start":
			handlers.before_agent_start.push(registration[1]);
			break;
		case "context":
			handlers.context.push(registration[1]);
			break;
		case "message_end":
			handlers.message_end.push(registration[1]);
			break;
		case "session_before_compact":
			handlers.session_before_compact.push(registration[1]);
			break;
		case "session_before_switch":
			handlers.session_before_switch.push(registration[1]);
			break;
		case "session_compact":
			handlers.session_compact.push(registration[1]);
			break;
		case "session_shutdown":
			handlers.session_shutdown.push(registration[1]);
			break;
		case "session_start":
			handlers.session_start.push(registration[1]);
			break;
		case "tool_execution_end":
			handlers.tool_execution_end.push(registration[1]);
			break;
		case "tool_execution_start":
			handlers.tool_execution_start.push(registration[1]);
			break;
		case "tool_result":
			handlers.tool_result.push(registration[1]);
	}
}

function registerCommand(name: MagicWorkerCommandName, definition: MagicContextCommandDefinition): void {
	const supportedName = magicWorkerCommandName(name);
	if (!supportedName) throw new Error(`Magic Context registered unsupported command '${name}'.`);
	commands.set(supportedName, definition);
}

function registerTool(tool: MagicContextToolDefinition): void {
	const supportedName = magicWorkerToolName(tool.name);
	if (!supportedName) throw new Error(`Magic Context registered unsupported Tool '${tool.name}'.`);
	tools.set(supportedName, tool);
}

function workerToolInfo(tool: MagicContextToolDefinition): MagicContextToolInfo {
	const info: MagicContextToolInfo = {
		description: tool.description,
		name: tool.name,
		parameters: tool.parameters,
		sourceInfo: MAGIC_CONTEXT_SOURCE,
	};
	if (tool.promptGuidelines !== undefined) info.promptGuidelines = [...tool.promptGuidelines];
	return info;
}

function workerPi(): MagicContextExtensionAPI {
	return {
		appendEntry: (customType, data) => contexts.sendEffect({ args: [customType, data], name: "appendEntry" }),
		events: isolatedWorkerEvents,
		getAllTools: () => [...hostTools, ...[...tools.values()].map(workerToolInfo)],
		on: registerEvent,
		registerCommand,
		registerEntryRenderer: () => {
			throw new Error("Magic Context entry rendering remains owned by the Pi Host.");
		},
		registerTool,
		sendMessage: (message, options) => contexts.sendEffect({ args: [message, options], name: "sendMessage" }),
		sendUserMessage: (content, options) => contexts.sendEffect({ args: [content, options], name: "sendUserMessage" }),
	};
}

async function initialize(request: MagicWorkerInitializeRequest): Promise<void> {
	if (initialized) throw new Error("Magic Context worker was initialized more than once.");
	if (request.protocolVersion !== MAGIC_WORKER_PROTOCOL_VERSION) {
		throw new Error(
			`Magic Context worker protocol ${String(request.protocolVersion)} does not match ${String(MAGIC_WORKER_PROTOCOL_VERSION)}.`,
		);
	}
	hostTools = request.hostTools.map((tool) => {
		const info: MagicContextToolInfo = {
			description: tool.description,
			name: tool.name,
			parameters: tool.parameters,
			sourceInfo: tool.sourceInfo,
		};
		if (tool.promptGuidelines) info.promptGuidelines = [...tool.promptGuidelines];
		return info;
	});
	await magicContextFactory(workerPi());
	initialized = true;
	send({
		commands: [...commands.entries()].map(([name, command]) => ({ name, description: command.description })),
		events: registeredEvents(),
		id: request.id,
		protocolVersion: MAGIC_WORKER_PROTOCOL_VERSION,
		tools: [...tools.values()].map((tool) => ({
			constrainedSampling: tool.constrainedSampling,
			description: tool.description,
			executionMode: tool.executionMode,
			label: tool.label,
			name: tool.name,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			promptSnippet: tool.promptSnippet,
			renderShell: tool.renderShell,
		})),
		type: "ready",
	});
}

function registeredEvents(): MagicContextEventName[] {
	const events: MagicContextEventName[] = [];
	if (handlers.agent_end.length > 0) events.push("agent_end");
	if (handlers.before_agent_start.length > 0) events.push("before_agent_start");
	if (handlers.context.length > 0) events.push("context");
	if (handlers.message_end.length > 0) events.push("message_end");
	if (handlers.session_before_compact.length > 0) events.push("session_before_compact");
	if (handlers.session_before_switch.length > 0) events.push("session_before_switch");
	if (handlers.session_compact.length > 0) events.push("session_compact");
	if (handlers.session_shutdown.length > 0) events.push("session_shutdown");
	if (handlers.session_start.length > 0) events.push("session_start");
	if (handlers.tool_execution_end.length > 0) events.push("tool_execution_end");
	if (handlers.tool_execution_start.length > 0) events.push("tool_execution_start");
	if (handlers.tool_result.length > 0) events.push("tool_result");
	return events;
}

async function runHandlers<Name extends MagicContextEventName>(
	registered: readonly MagicContextEventHandler<Name>[],
	event: MagicContextEventMap[Name]["event"],
	ctx: MagicContextExtensionContext,
): Promise<MagicContextEventMap[Name]["result"] | undefined> {
	let result: MagicContextEventMap[Name]["result"] | undefined;
	for (const handler of registered) {
		const next = await handler(event, ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

async function invokeEvent(
	request: MagicWorkerEventRequest,
	ctx: MagicContextExtensionContext,
	controller: AbortController,
): Promise<MagicWorkerEventResult> {
	switch (request.name) {
		case "agent_end":
			return { event: request.name, result: await runHandlers(handlers.agent_end, request.event, ctx) };
		case "before_agent_start":
			return {
				event: request.name,
				result: await runHandlers(handlers.before_agent_start, request.event, ctx),
			};
		case "context":
			return { event: request.name, result: await runHandlers(handlers.context, request.event, ctx) };
		case "message_end": {
			const result = await runHandlers(handlers.message_end, request.event, ctx);
			return { event: request.name, result: result ?? { message: request.event.message } };
		}
		case "session_before_compact":
			return {
				event: request.name,
				result: await runHandlers(
					handlers.session_before_compact,
					{ ...request.event, signal: controller.signal },
					ctx,
				),
			};
		case "session_before_switch":
			return {
				event: request.name,
				result: await runHandlers(handlers.session_before_switch, request.event, ctx),
			};
		case "session_compact":
			return { event: request.name, result: await runHandlers(handlers.session_compact, request.event, ctx) };
		case "session_shutdown":
			return { event: request.name, result: await runHandlers(handlers.session_shutdown, request.event, ctx) };
		case "session_start":
			return { event: request.name, result: await runHandlers(handlers.session_start, request.event, ctx) };
		case "tool_execution_end":
			return {
				event: request.name,
				result: await runHandlers(handlers.tool_execution_end, request.event, ctx),
			};
		case "tool_execution_start":
			return {
				event: request.name,
				result: await runHandlers(handlers.tool_execution_start, request.event, ctx),
			};
		case "tool_result":
			return { event: request.name, result: await runHandlers(handlers.tool_result, request.event, ctx) };
	}
}

async function invokeCommand(request: MagicWorkerCommandRequest, ctx: MagicContextExtensionContext): Promise<void> {
	const command = commands.get(request.name);
	if (!command) throw new Error(`Magic Context command '${request.name}' is not registered.`);
	await command.handler(request.args, ctx);
}

async function invokeTool(
	request: MagicWorkerToolRequest,
	ctx: MagicContextExtensionContext,
	controller: AbortController,
) {
	const tool = tools.get(request.name);
	if (!tool) throw new Error(`Magic Context Tool '${request.name}' is not registered.`);
	return tool.execute(
		request.toolCallId,
		request.args,
		controller.signal,
		(update) => {
			send({ id: request.id, type: "tool-update", update });
		},
		ctx,
	);
}

async function invoke(request: MagicWorkerInvocationRequest, controller: AbortController): Promise<void> {
	try {
		if (!initialized) throw new Error("Magic Context worker received work before initialization.");
		if (request.type === "event") {
			const result = await contexts.run(request, controller, (ctx) => invokeEvent(request, ctx, controller));
			send({ id: request.id, result, type: "event-result" });
		} else if (request.type === "command") {
			await contexts.run(request, controller, (ctx) => invokeCommand(request, ctx));
			send({ id: request.id, type: "command-result" });
		} else {
			const result = await contexts.run(request, controller, (ctx) => invokeTool(request, ctx, controller));
			send({ id: request.id, result, type: "tool-result" });
		}
	} finally {
		controllers.delete(request.id);
		if (
			request.type === "event" &&
			(request.name === "session_before_switch" || request.name === "session_shutdown") &&
			request.context.session.id
		) {
			contexts.deleteSession(request.context.session.id);
		}
	}
}

let queue = Promise.resolve();

addEventListener("message", (message: MessageEvent<MagicWorkerRequest>): void => {
	const request = message.data;
	if (request.type === "cancel") {
		controllers.get(request.id)?.abort();
		return;
	}
	if (request.type === "session-entry" || request.type === "session-snapshot") {
		queue = queue.then(() => {
			if (request.type === "session-entry") contexts.updateSession(request);
			else contexts.replaceSession(request);
		});
		return;
	}
	if (request.type === "initialize") {
		queue = queue.then(() => initialize(request)).catch((cause: unknown) => sendError(request.id, cause));
		return;
	}
	const controller = new AbortController();
	controllers.set(request.id, controller);
	queue = queue.then(() => invoke(request, controller)).catch((cause: unknown) => sendError(request.id, cause));
});
