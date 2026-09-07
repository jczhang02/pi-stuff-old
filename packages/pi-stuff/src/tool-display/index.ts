import {
	type ExtensionAPI,
	type ExtensionContext,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import {
	ensureUiSettingsCommand,
	getCommandDialogCoordinator,
	getHostSharedResource,
	type UiSettingRegistry,
} from "../conversation-ui/index.ts";
import { type EffectFoundation, type EffectScopeOwner, installEffectFoundation } from "../shared/effect-foundation.ts";
import { isRuntimeString } from "../shared/runtime-type.ts";
import { TOOL_ACTIVITY_TICK_MS } from "./activity-clock.ts";
import { registerBuiltins, resolveBuiltinHostSettings } from "./builtin-tools.ts";
import { installToolUiRuntime } from "./contract.ts";
import { TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT, TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT } from "./limits.ts";
import { registerHistoricalSuiteToolDefinitions } from "./registration.ts";
import { consumeResumeToolHandoff, prepareResumeToolHandoff, restoreResumeActiveToolOrder } from "./session-handoff.ts";
import { ToolUiSettingsStore } from "./settings.ts";
import { createToolDialogView } from "./tool-dialog.ts";
import { isRecordValue } from "./tool-value.ts";

const BUILTIN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
const TOOL_LIFECYCLE_STATES = Symbol.for("@jczhang02/pi-stuff-tools/lifecycle-states/v1");
const TOOL_LIFECYCLE_DISCOVERY_EVENT = "@jczhang02/pi-stuff-tools/lifecycle-discovery/v1";

interface ToolLifecycleState {
	active: boolean;
	activation?: symbol;
}

function toolLifecycleStates(): WeakMap<object, ToolLifecycleState> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, TOOL_LIFECYCLE_STATES)?.value;
	if (existing instanceof WeakMap) return existing;
	const created = new WeakMap<object, ToolLifecycleState>();
	Object.defineProperty(globalThis, TOOL_LIFECYCLE_STATES, {
		configurable: true,
		value: created,
		writable: true,
	});
	return created;
}

function releaseToolLifecycle(state: ToolLifecycleState, activation: symbol): void {
	if (state.activation !== activation) return;
	state.active = false;
	delete state.activation;
}

interface CurrentTranscript {
	readonly hasOlder: boolean;
	readonly messages: readonly unknown[];
	readonly toolNames: ReadonlySet<string>;
}

interface TranscriptPager {
	loadOlder(): CurrentTranscript;
}

const HISTORY_ENTRY_PAGE_LIMIT = 64;

function transcriptToolNames(messages: readonly unknown[]): ReadonlySet<string> {
	const toolNames = new Set<string>();
	for (const message of messages) {
		if (!isRecordValue(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let index = 0; index < Math.min(message.content.length, TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT); index += 1) {
			const part = message.content[index];
			if (isRecordValue(part) && part.type === "toolCall" && isRuntimeString(part.name)) {
				toolNames.add(part.name);
			}
		}
	}
	return toolNames;
}

function createTranscriptPager(ctx: ExtensionContext): TranscriptPager {
	const branch = ctx.sessionManager.getBranch();
	let cursor = branch.length;
	let pendingContentEnd: number | undefined;
	let pendingMessageIndex = -1;
	let pendingMessages: readonly unknown[] = [];
	return {
		loadOlder: () => {
			const newestFirst: unknown[] = [];
			let blockCount = 0;
			let messageCount = 0;
			let visitedEntries = 0;
			while (
				messageCount < TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT &&
				blockCount < TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT
			) {
				if (pendingMessageIndex < 0) {
					if (cursor <= 0 || visitedEntries >= HISTORY_ENTRY_PAGE_LIMIT) break;
					cursor -= 1;
					const entry = branch[cursor];
					if (!entry) continue;
					pendingMessages = sessionEntryToContextMessages(entry);
					pendingMessageIndex = pendingMessages.length - 1;
					pendingContentEnd = undefined;
					visitedEntries += 1;
					continue;
				}
				const message = pendingMessages[pendingMessageIndex];
				if (!message) {
					pendingMessageIndex -= 1;
					pendingContentEnd = undefined;
					continue;
				}
				if (isRecordValue(message) && message.role === "assistant" && Array.isArray(message.content)) {
					const end = Math.min(pendingContentEnd ?? message.content.length, message.content.length);
					const remaining = TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT - blockCount;
					const start = Math.max(0, end - remaining);
					newestFirst.push({ ...message, content: message.content.slice(start, end) });
					blockCount += Math.max(1, end - start);
					messageCount += 1;
					if (start > 0) pendingContentEnd = start;
					else {
						pendingMessageIndex -= 1;
						pendingContentEnd = undefined;
					}
					continue;
				}
				newestFirst.push(message);
				messageCount += 1;
				blockCount += 1;
				pendingMessageIndex -= 1;
				pendingContentEnd = undefined;
			}
			const messages = newestFirst.reverse();
			return {
				hasOlder: cursor > 0 || pendingMessageIndex >= 0,
				messages,
				toolNames: transcriptToolNames(messages),
			};
		},
	};
}

type InstalledToolUiRuntime = ReturnType<typeof installToolUiRuntime>;
type ResumeToolHandoff = ReturnType<typeof consumeResumeToolHandoff>;

function acquireToolUiSessionResources(
	registry: UiSettingRegistry,
	runtime: InstalledToolUiRuntime,
	settings: ToolUiSettingsStore,
	foundation: EffectFoundation,
	capability: EffectScopeOwner,
) {
	return Effect.gen(function* () {
		// Scope finalizers are LIFO: remove observers before awaiting persistence.
		yield* Effect.addFinalizer(() => settings.whenIdle());
		yield* Effect.addFinalizer(() => Effect.sync(() => runtime.suspend()));
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				settings.subscribe(() => {
					if (foundation.isCurrent(capability)) runtime.syncTimers();
				}),
			),
			(unsubscribe) => Effect.sync(unsubscribe),
		);
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				registry.register({
					description: "Show elapsed time while long-running tools work",
					get: () => String(settings.get().liveElapsed),
					id: "toolRunningTimer",
					label: "Tool running timer",
					order: 50,
					set: async (value) => {
						if (value !== "true" && value !== "false") {
							throw new Error(`Invalid toolRunningTimer value: ${value}`);
						}
						await runToolUiOperation(foundation, capability, settings.setLiveElapsed(value === "true"));
					},
					subscribe: (listener) => settings.subscribe(() => listener()),
					values: ["true", "false"],
				}),
			),
			(unregister) => Effect.sync(unregister),
		);
		const groupChanges = yield* Queue.sliding<void>(1);
		const toolChanges = yield* Queue.sliding<void>(1);
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				runtime.bindTimerWakes({
					groups: () => Queue.offerUnsafe(groupChanges, undefined),
					tools: () => Queue.offerUnsafe(toolChanges, undefined),
				}),
			),
			(unbind) => Effect.sync(unbind),
		);
		yield* Effect.forkScoped(
			runTimerLane(
				groupChanges,
				() => runtime.hasGroupPulseTimers(),
				() => runtime.tickGroupPulseTimers(),
			),
		);
		yield* Effect.forkScoped(
			runTimerLane(
				toolChanges,
				() => runtime.hasToolTimers(),
				() => runtime.tickToolTimers(),
			),
		);
	});
}

function runTimerLane(changes: Queue.Queue<void>, isActive: () => boolean, tick: () => void): Effect.Effect<never> {
	return Effect.gen(function* () {
		while (true) {
			while (!isActive()) yield* Queue.take(changes);
			const elapsed = yield* Effect.raceFirst(
				Effect.sleep(TOOL_ACTIVITY_TICK_MS).pipe(Effect.as(true)),
				Queue.take(changes).pipe(Effect.as(false)),
			);
			if (elapsed && isActive()) yield* Effect.sync(tick);
		}
	});
}

async function runToolUiOperation<Value, ErrorType>(
	foundation: EffectFoundation,
	capability: EffectScopeOwner,
	program: Effect.Effect<Value, ErrorType>,
): Promise<Value | undefined> {
	if (!foundation.isCurrent(capability)) return undefined;
	const operation = foundation.forkOperation(capability);
	const exit = await foundation.run(operation, program);
	await foundation.close(operation, exit);
	if (Exit.isSuccess(exit)) return foundation.isCurrent(capability) ? exit.value : undefined;
	if (Cause.hasInterrupts(exit.cause)) return undefined;
	throw Cause.squash(exit.cause);
}

function registerHistoryPageTools(pi: ExtensionAPI, transcript: CurrentTranscript): void {
	const activeTools = pi.getActiveTools();
	if (registerHistoricalSuiteToolDefinitions(pi, transcript.toolNames).length > 0) pi.setActiveTools(activeTools);
}

function resetHistoricalProjection(pi: ExtensionAPI, runtime: InstalledToolUiRuntime, ctx: ExtensionContext): void {
	const pager = createTranscriptPager(ctx);
	const transcript = pager.loadOlder();
	registerHistoryPageTools(pi, transcript);
	runtime.resetProjection(transcript.messages);
	runtime.configureHistoryLoader(() => {
		const page = pager.loadOlder();
		registerHistoryPageTools(pi, page);
		return page;
	}, transcript.hasOlder);
}

function isCurrentToolSession(foundation: EffectFoundation, ctx: ExtensionContext): boolean {
	const session = foundation.sessionFor(ctx.sessionManager);
	return Boolean(session && foundation.isCurrent(session));
}

function registerToolProjectionEvents(
	pi: ExtensionAPI,
	runtime: InstalledToolUiRuntime,
	resumeHandoff: ResumeToolHandoff,
	foundation: EffectFoundation,
): void {
	pi.on("session_start", (_event, ctx) => {
		if (!isCurrentToolSession(foundation, ctx)) return;
		const pager = createTranscriptPager(ctx);
		const transcript = pager.loadOlder();
		const replayOnlyNames = new Set(runtime.replayOnlyTools());
		registerBuiltins(pi, ctx.cwd, resolveBuiltinHostSettings(ctx.cwd, ctx.isProjectTrusted()));
		let restoredActiveTools: readonly string[] | undefined;
		if (resumeHandoff) {
			restoredActiveTools = restoreResumeActiveToolOrder(
				pi.getActiveTools().filter((name) => !replayOnlyNames.has(name)),
				resumeHandoff,
			);
		} else {
			const restoreActiveBuiltins = runtime.consumeReloadActiveTools();
			if (restoreActiveBuiltins) {
				const activeNonBuiltins = pi
					.getActiveTools()
					.filter((name) => !BUILTIN_TOOL_NAMES.has(name) && !replayOnlyNames.has(name));
				restoredActiveTools = [...activeNonBuiltins, ...restoreActiveBuiltins];
			}
		}
		const activeToolsBeforeReplay = restoredActiveTools ?? pi.getActiveTools();
		const registeredReplayNames = registerHistoricalSuiteToolDefinitions(pi, transcript.toolNames);
		if (restoredActiveTools || registeredReplayNames.length > 0) pi.setActiveTools([...activeToolsBeforeReplay]);
		runtime.resetProjection(transcript.messages);
		runtime.configureHistoryLoader(() => {
			const page = pager.loadOlder();
			registerHistoryPageTools(pi, page);
			return page;
		}, transcript.hasOlder);
	});
	pi.on("session_compact", (_event, ctx) => resetHistoricalProjection(pi, runtime, ctx));
	pi.on("session_tree", (_event, ctx) => resetHistoricalProjection(pi, runtime, ctx));
	pi.on("input", () => runtime.observeUserBoundary());
	pi.on("tool_execution_start", (event) => {
		if (runtime.hasActivityRenderer(event.toolName)) runtime.observeToolExecutionStart(event.toolCallId);
	});
	pi.on("tool_execution_update", (event) => {
		if (runtime.hasActivityRenderer(event.toolName)) {
			runtime.observeToolExecutionUpdate(event.toolCallId, event.partialResult);
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (runtime.hasActivityRenderer(event.toolName)) {
			runtime.observeToolExecutionEnd(
				event.toolCallId,
				event.isError ? { ...event.result, isError: true } : event.result,
			);
		}
	});
	pi.on("agent_start", () => runtime.startTurn());
	pi.on("message_update", (event) => runtime.observeAssistantEvent(event.assistantMessageEvent));
	pi.on("message_end", (event) => {
		if (
			event.message.role === "assistant" ||
			event.message.role === "bashExecution" ||
			event.message.role === "toolResult" ||
			event.message.role === "custom"
		) {
			runtime.indexMessage(event.message);
		}
	});
	pi.on("agent_end", () => runtime.endTurn());
}

export {
	activityKey,
	activityTarget,
	bashResultMovedToBackground,
	classifyBashActivity,
	classifyBashRetrievalActivity,
	classifyRetrievalGroupInvocation,
	type RetrievalGroupDisposition,
	singleActivity,
	type ToolActivityCategory,
	type ToolActivityClassifierInput,
	type ToolActivityItem,
	type ToolActivityMetadata,
	type ToolArguments,
} from "./activity.ts";
export { BASH_CODE_MODE_CONTRACT } from "./builtin-tools.ts";
export {
	getToolUiRuntime,
	type SuiteToolCatalogEntry,
	type SuiteToolCodeModeContract,
	type SuiteToolCodeModeExecutionEndStatus,
	type SuiteToolCodeModeLifecycle,
	type SuiteToolCodeModePassEndStatus,
	type SuiteToolDefinitionRegistry,
	type SuiteToolEnvelopeOperation,
	type SuiteToolInvocation,
	type SuiteToolInvocationResult,
	type SuiteToolPresentation,
	type SuiteToolRegistrationHost,
	type SuiteToolRegistrationTracker,
	type SuiteToolReplayDefinition,
	type SuiteToolSurfaceController,
	type SuiteToolTrackerHost,
	type ToolActivityDetailMode,
	type ToolActivityDetailView,
	type ToolActivityView,
	ToolUiRuntime,
	type ToolUiRuntimeHost,
} from "./contract.ts";
export {
	assertSuiteToolActivityCoverage,
	configureSuiteToolReplay,
	createSuiteToolRegistrationTracker,
	registerHistoricalSuiteToolDefinitions,
	registerSuiteOwnedTool,
	registerSuiteToolActivityMetadata,
	registerSuiteToolEnvelope,
	registerSuiteToolEnvelopeCompanion,
} from "./registration.ts";
export { CachedToolRow } from "./render.ts";
export {
	boundTerminalLine,
	boundTerminalText,
	compactTerminalPath,
	graphemePrefix,
	sanitizeTerminalText,
} from "./terminal.ts";
export { formatElapsed } from "./tool-text.ts";

export default async function piStuffTools(pi: ExtensionAPI): Promise<void> {
	const foundation = installEffectFoundation(pi);
	const lifecycle = getHostSharedResource<ToolLifecycleState>(
		pi.events,
		toolLifecycleStates(),
		TOOL_LIFECYCLE_DISCOVERY_EVENT,
		() => ({ active: false }),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
	if (lifecycle.active) return;
	const activation = Symbol("tool-display-lifecycle");
	lifecycle.active = true;
	lifecycle.activation = activation;
	try {
		const resumeHandoff = consumeResumeToolHandoff();
		const settings = await Effect.runPromise(ToolUiSettingsStore.load());
		const runtime = installToolUiRuntime(pi, settings);
		if (resumeHandoff) runtime.stageResumeToolDefinitions(resumeHandoff.toolDefinitions);
		const uiSettings = ensureUiSettingsCommand(pi);
		pi.on("session_start", async (_event, ctx) => {
			const session = foundation.sessionFor(ctx.sessionManager);
			if (!session) throw new Error("Tool UI Session Scope was not initialized.");
			if (!foundation.isCurrent(session)) return;
			const capability = foundation.forkCapability(session);
			const exit = await foundation.run(
				capability,
				acquireToolUiSessionResources(uiSettings, runtime, settings, foundation, capability),
			);
			if (Exit.isSuccess(exit)) return;
			await foundation.close(capability, exit);
			if (!Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
		});
		pi.registerCommand("tools", {
			description: "Inspect current-session Tool operations",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/tools requires interactive TUI mode.", "warning");
					return;
				}
				if (args.trim()) {
					ctx.ui.notify("/tools does not accept arguments.", "warning");
					return;
				}

				resetHistoricalProjection(pi, runtime, ctx);
				await getCommandDialogCoordinator(pi).show(ctx, createToolDialogView(runtime));
			},
		});

		registerToolProjectionEvents(pi, runtime, resumeHandoff, foundation);
		pi.on("session_shutdown", (event) => {
			if (event.reason === "reload") {
				runtime.prepareReload(pi.getActiveTools().filter((name) => BUILTIN_TOOL_NAMES.has(name)));
			} else {
				if (event.reason === "resume") {
					prepareResumeToolHandoff(pi.getActiveTools(), runtime.resumeToolDefinitions());
				}
				// Pi can emit session_shutdown while rebuilding the current transcript
				// for tree navigation. Keep the display projection available to the
				// surviving Tool components; the next session_start replaces it.
				runtime.suspend();
			}
			releaseToolLifecycle(lifecycle, activation);
		});
	} catch (error) {
		releaseToolLifecycle(lifecycle, activation);
		throw error;
	}
}
