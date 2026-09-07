import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSyntheticSourceInfo, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createNativeSupervisorChannel as createNativeSupervisorChannelNative,
	garbageCollectSupervisorChannel,
	resolveSupervisorChannelDir,
} from "../../packages/pi-stuff/src/subagents/src/intercom/native-supervisor-channel.js";
import { shardedDurableClaimName } from "../../packages/pi-stuff/src/subagents/src/shared/durable-claim.js";
import { type SubagentState, TEMP_ROOT_DIR } from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { getToolUiRuntime } from "../../packages/pi-stuff/src/tool-display/index.js";
import { captureExtensionHandlers, createExtensionApi } from "../fixtures/extension-api.js";
import { createExtensionContext } from "../fixtures/extension-context.js";
import { createTestAgentEffectOwner } from "./agent-effect-owner-fixture.js";

const directories: string[] = [];

type NativeSupervisorChannelOptions = NonNullable<Parameters<typeof createNativeSupervisorChannelNative>[3]>;

function createNativeSupervisorChannel(
	pi: ExtensionAPI,
	state: SubagentState,
	options: NativeSupervisorChannelOptions = {},
) {
	return createNativeSupervisorChannelNative(pi, state, createTestAgentEffectOwner(), options);
}

interface SupervisorRequestFixture {
	readonly agent: string;
	readonly childIndex: number;
	readonly createdAt: number;
	readonly expectsReply: boolean;
	readonly expiresAt?: number;
	readonly id: string;
	readonly interview?: object;
	readonly message: string;
	readonly orchestratorSessionId?: string;
	readonly reason: "interview_request" | "need_decision" | "progress_update";
	readonly runId: string;
	readonly type: "subagent.supervisor.request";
}

function legacyChannel(runId: string, agent = "worker", childIndex = 0): string {
	return path.join(TEMP_ROOT_DIR, "supervisor-channels", `${runId}-${agent}-${childIndex}`);
}

function writeRequest(channelDir: string, request: SupervisorRequestFixture): string {
	const requests = path.join(channelDir, "requests");
	const replies = path.join(channelDir, "replies");
	fs.mkdirSync(requests, { recursive: true, mode: 0o700 });
	fs.mkdirSync(replies, { recursive: true, mode: 0o700 });
	const file = path.join(requests, `${request.id}.json`);
	fs.writeFileSync(file, `${JSON.stringify(request)}\n`, { mode: 0o600 });
	directories.push(channelDir);
	return file;
}

interface HarnessInput {
	primary: string;
	legacyFile: string;
	legacyRunIds: ReadonlySet<string>;
	logicalSessionId?: string;
	startedAtMs: number;
	sendMessage?: ExtensionAPI["sendMessage"];
}

function harness(input: HarnessInput) {
	type TestHandlerResult = object | undefined | Promise<object | undefined>;
	type TestHandler = (...args: never[]) => TestHandlerResult;
	const messages: Array<{ customType?: string; details?: unknown }> = [];
	const tools = new Map<string, ToolDefinition>();
	let activeTools: string[] = [];
	const handlers = new Map<string, TestHandler[]>();
	const sessionCalls = { getEntries: 0, getSessionFile: 0 };
	const sessionManager = {
		getEntries: () => {
			sessionCalls.getEntries += 1;
			return [];
		},
		getSessionFile: () => {
			sessionCalls.getSessionFile += 1;
			return input.legacyFile;
		},
		getSessionId: () => input.logicalSessionId ?? "header-b",
	};
	const ctx = createExtensionContext({
		cwd: path.dirname(input.legacyFile),
		sessionManager,
	});
	const state: SubagentState = {
		baseCwd: ctx.cwd,
		completionSeen: new Map(),
		currentSessionId: input.primary,
		currentSessionScope: {
			sessionId: input.primary,
			governorSessionId: input.primary,
			legacyGovernorSessionId: input.logicalSessionId ?? "header-b",
			legacyArtifactSessionId: input.legacyFile,
			startedAtMs: input.startedAtMs,
			legacyRunIds: input.legacyRunIds,
		},
		lastUiContext: ctx,
		lastForegroundControlId: null,
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
	};
	const api = createExtensionApi({
		getActiveTools: () => [...activeTools],
		getAllTools: () =>
			[...tools.values()].map(({ description, name, parameters }) => ({
				description,
				name,
				parameters,
				sourceInfo: createSyntheticSourceInfo(`/test/${name}`, { source: "extension" }),
			})),
		registerTool: (tool) => {
			if (!tools.has(tool.name)) activeTools.push(tool.name);
			// SAFETY: The harness stores the Host-validated definition and only invokes it through ToolDefinition.
			tools.set(tool.name, tool as ToolDefinition);
		},
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		on: captureExtensionHandlers(handlers),
		sendMessage:
			input.sendMessage ?? ((message: { customType?: string; details?: unknown }) => messages.push(message)),
	});
	return {
		api,
		ctx,
		messages,
		sessionCalls,
		state,
		tools,
		run: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler();
		},
	};
}

function sessionHarness(input: Omit<HarnessInput, "legacyFile">) {
	const root = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "supervisor-session-"));
	directories.push(root);
	const sessionFile = path.join(root, "parent.jsonl");
	fs.writeFileSync(sessionFile, "");
	return { ...harness({ ...input, legacyFile: sessionFile }), sessionFile };
}

function baseRequest(id: string, runId: string, createdAt: number): SupervisorRequestFixture {
	return {
		type: "subagent.supervisor.request",
		id,
		createdAt,
		reason: "progress_update",
		message: `progress from ${runId}`,
		expectsReply: false,
		orchestratorSessionId: "header-b",
		runId,
		agent: "worker",
		childIndex: 0,
	};
}

export type { ExtensionAPI, SupervisorRequestFixture, ToolDefinition };
export {
	baseRequest,
	createNativeSupervisorChannel,
	directories,
	fs,
	garbageCollectSupervisorChannel,
	getToolUiRuntime,
	harness,
	legacyChannel,
	path,
	randomUUID,
	resolveSupervisorChannelDir,
	sessionHarness,
	shardedDurableClaimName,
	TEMP_ROOT_DIR,
	writeRequest,
};

export function cleanupNativeSupervisorFixtures(): void {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
}
