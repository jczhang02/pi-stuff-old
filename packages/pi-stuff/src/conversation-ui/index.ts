import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { installEffectFoundation } from "../shared/effect-foundation.js";
import { getHostSharedResource } from "../shared/host-resource.js";
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeObject } from "../shared/runtime-type.js";
import {
	AgentRunOriginTracker,
	listenForActiveAgentWorkUserPromotions,
	listenForAgentWorkOriginQueries,
} from "./agent-run-origin.js";
import type { CommandDialogCoordinatorImplementation } from "./command-dialog.js";
import { getCommandDialogCoordinator } from "./command-dialog-registry.js";
import { registerConversationMarkdown } from "./conversation-markdown.js";
import { activateDiagnosticChannel, type DiagnosticChannel, getDiagnosticChannel } from "./diagnostics.js";
import { createDiagnosticsView } from "./diagnostics-dialog.js";
import { UiEffectOwner } from "./effect-owner.js";
import { globalWeakMap } from "./global-registry.js";
import {
	installUiSessionPresentation as installPresentation,
	type UiSessionPresentation,
} from "./session-presentation.js";
import {
	beginUiSettingsGeneration,
	registerOwnedUiSettings,
	type UiSettingRegistry,
	UiSettingsStore,
} from "./settings.js";
import { createUiSettingsView } from "./ui-settings-dialog.js";

export { getHostSharedResource } from "../shared/host-resource.js";
export {
	type AgentWorkOrigin,
	hasDirectUserActivation,
	promoteActiveAgentWorkToUser,
	readAgentWorkOrigin,
	readCurrentAgentWorkOrigin,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "./agent-run-origin.js";
export { getCommandDialogCoordinator } from "./command-dialog-registry.js";
export type {
	CommandDialogChrome,
	CommandDialogComponent,
	CommandDialogCoordinator,
	CommandDialogCoordinatorHost,
	CommandDialogKeybindings,
	CommandDialogPriority,
	CommandDialogShowOptions,
	CommandDialogView,
	CommandDialogViewContext,
	FooterFactory,
	FooterTailComponent,
	FooterTailFactory,
} from "./command-dialog-types.js";
export {
	activateDiagnosticChannel,
	DiagnosticChannel,
	type DiagnosticRecord,
	type DiagnosticReport,
	type DiagnosticSeverity,
	type DiagnosticVisibility,
	getDiagnosticChannel,
	reportDiagnostic,
} from "./diagnostics.js";
export {
	type CommandDialogKeyHelpEntry,
	type CommandDialogNavigation,
	type CommandDialogRowSections,
	commandDialogExitKeyHelp,
	commandDialogHintLines,
	commandDialogKeys,
	commandDialogListIndex,
	commandDialogListKeyHelp,
	commandDialogNavigation,
	commandDialogPrimaryKey,
	commandDialogReadKeyHelp,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogScrollOffset,
	commandDialogSectionHeading,
	fitCommandDialogRows,
	fitFixedCommandDialogRows,
	matchesCommandDialogCancel,
	matchesCommandDialogConfirm,
	matchesCommandDialogHelp,
	matchesCommandDialogPaneSwitch,
	renderCommandDialogKeyHelp,
	renderCommandDialogSplit,
	WIDE_COMMAND_DIALOG_MIN_WIDTH,
} from "./dialog-layout.js";
export {
	type GoalCoordinationSnapshot,
	listenForGoalCoordinationQueries,
	listenForPendingGoalResultQueries,
	readGoalCoordination,
} from "./goal-coordination.js";
export { createMarkdownRenderer } from "./markdown.js";
export {
	createPonytailDialogView,
	type PonytailDialogAction,
	type PonytailDialogOptions,
	type PonytailDialogSnapshot,
} from "./ponytail-dialog.js";
export {
	beginUiSettingsGeneration,
	getUiSettingRegistry,
	type RegisteredUiSetting,
	registerOwnedUiSettings,
	type UiSettingId,
	type UiSettingRegistry,
	type UiSettings,
	UiSettingsStore,
} from "./settings.js";
export {
	type CodexStatusChannel,
	type CodexStatusSnapshot,
	type CodexStatusSource,
	type ContextStatus,
	type ContextStatusChannel,
	type ContextStatusSnapshot,
	type ContextStatusSource,
	type GoalStatus,
	type GoalStatusChannel,
	type GoalStatusSnapshot,
	type GoalStatusSource,
	getCodexStatusChannel,
	getContextStatusChannel,
	getGoalStatusChannel,
} from "./statusline.js";
export {
	beginSuiteNativeCompactionPreflight,
	isSuiteNativeCompactionPreflight,
	registerSuiteAgentMessagePreparation,
	type SuiteAgentMessageOptions,
	type SuiteAgentMessagePreparation,
	sendSuiteAgentMessage,
} from "./suite-agent-message.js";
export {
	installSuiteSessionReadiness,
	markSuiteSessionReady,
	rejectSuiteSessionReadiness,
	whenSuiteSessionReady,
} from "./suite-lifecycle.js";

interface UiSettingsCommandState {
	active: boolean;
	activation?: symbol;
	registry?: UiSettingRegistry;
}

const UI_SETTINGS_COMMAND_STATES = Symbol.for("@jczhang02/pi-stuff-ui/settings-command-states/v1");
const UI_SETTINGS_COMMAND_STATE_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/settings-command-state-discovery/v1";
const UI_LIFECYCLE_STATES = Symbol.for("@jczhang02/pi-stuff-ui/lifecycle-states/v1");
const UI_LIFECYCLE_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/lifecycle-discovery/v1";
const USER_AGENT_RUN_SETTLED_EVENT = "@jczhang02/pi-stuff-ui/user-agent-run-settled/v1";
const USER_AGENT_RUN_SETTLED_SCHEMA = Type.Object(
	{ ctx: Type.Object({}, { additionalProperties: true }) },
	{ additionalProperties: true },
);

interface UiLifecycleState {
	active: boolean;
	activation?: symbol;
}

/** Observe a completed direct-user Agent run after the Host reaches a genuinely idle boundary. */
export function listenForUserAgentRunSettled(
	pi: Pick<ExtensionAPI, "events">,
	listener: (ctx: ExtensionContext) => void,
): () => void {
	const unsubscribe = pi.events.on(USER_AGENT_RUN_SETTLED_EVENT, (value) => {
		if (!Check(USER_AGENT_RUN_SETTLED_SCHEMA, value)) return;
		try {
			// SAFETY: this private event is emitted below with the live Host ExtensionContext.
			listener(value.ctx as ExtensionContext);
		} catch {
			// A derived usage refresh cannot be allowed to break Agent settlement.
		}
	});
	return isRuntimeFunction(unsubscribe) ? unsubscribe : () => {};
}

function publishUserAgentRunSettled(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): void {
	try {
		pi.events.emit(USER_AGENT_RUN_SETTLED_EVENT, { ctx });
	} catch {
		// A derived usage refresh cannot be allowed to break Agent settlement.
	}
}

const STATUSLINE_GIT_REFRESH_AFTER_USER_WORK_REQUEST =
	"@jczhang02/pi-stuff-ui/statusline-git-refresh-after-user-work-request/v1";
const STATUSLINE_GIT_REFRESH_LISTENERS = Symbol.for("@jczhang02/pi-stuff-ui/statusline-git-refresh-listeners/v1");
export const UI_RENDER_REQUEST_EVENT = "@jczhang02/pi-stuff-ui/render-request/v1";
const UI_RENDER_REQUEST_LISTENERS = Symbol.for("@jczhang02/pi-stuff-ui/render-request-listeners/v1");

function listenForStatuslineGitRefreshAfterUserWorkRequests(pi: ExtensionAPI, refresh: () => void): () => void {
	const listeners = globalWeakMap<() => void>(STATUSLINE_GIT_REFRESH_LISTENERS);
	listeners.get(pi.events)?.();

	let active = true;
	const unsubscribe = pi.events.on(STATUSLINE_GIT_REFRESH_AFTER_USER_WORK_REQUEST, () => {
		if (active) refresh();
	});
	const cleanup = (): void => {
		if (!active) return;
		active = false;
		if (isRuntimeFunction(unsubscribe)) unsubscribe();
		if (listeners.get(pi.events) === cleanup) listeners.delete(pi.events);
	};
	listeners.set(pi.events, cleanup);
	return cleanup;
}

/** Report completed user-initiated work whose Git observation may need to wait for Host idle. */
export function requestStatuslineGitRefreshAfterUserWork(pi: { readonly events?: ExtensionAPI["events"] }): void {
	try {
		pi.events?.emit(STATUSLINE_GIT_REFRESH_AFTER_USER_WORK_REQUEST, undefined);
	} catch {
		// A cosmetic refresh request cannot be allowed to break the caller's lifecycle.
	}
}

function listenForUiRenderRequests(pi: ExtensionAPI, render: (force: boolean) => void): () => void {
	const listeners = globalWeakMap<() => void>(UI_RENDER_REQUEST_LISTENERS);
	listeners.get(pi.events)?.();

	let active = true;
	const unsubscribe = pi.events.on(UI_RENDER_REQUEST_EVENT, (value) => {
		if (
			!active ||
			!isRuntimeObject(value) ||
			value === null ||
			!("force" in value) ||
			!isRuntimeBoolean(value.force) ||
			!("handled" in value) ||
			!isRuntimeBoolean(value.handled)
		)
			return;
		value.handled = true;
		render(value.force);
	});
	const cleanup = (): void => {
		if (!active) return;
		active = false;
		if (isRuntimeFunction(unsubscribe)) unsubscribe();
		if (listeners.get(pi.events) === cleanup) listeners.delete(pi.events);
	};
	listeners.set(pi.events, cleanup);
	return cleanup;
}

/** Request a normal-screen paint and report whether an active UI accepted it. */
export function requestUiRender(pi: Pick<ExtensionAPI, "events">, force = false): boolean {
	const request = { force, handled: false };
	try {
		pi.events.emit(UI_RENDER_REQUEST_EVENT, request);
	} catch {
		// A presentation handoff cannot be allowed to break Agent processing.
	}
	return request.handled;
}

/** Ensure every independently loadable Capability can contribute to one /ui list. */
export function ensureUiSettingsCommand(pi: ExtensionAPI): UiSettingRegistry {
	const coordinator = getCommandDialogCoordinator(pi);
	const commandStates = globalWeakMap<UiSettingsCommandState>(UI_SETTINGS_COMMAND_STATES);
	const state = getHostSharedResource<UiSettingsCommandState>(
		pi.events,
		commandStates,
		UI_SETTINGS_COMMAND_STATE_DISCOVERY_EVENT,
		() => ({ active: false }),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
	if (state.active && state.registry) return state.registry;
	const registry = beginUiSettingsGeneration(pi);
	const activation = Symbol("ui-settings-command");
	state.active = true;
	state.activation = activation;
	state.registry = registry;
	pi.on("session_shutdown", () => {
		if (state.activation !== activation) return;
		state.active = false;
		delete state.activation;
		delete state.registry;
	});
	pi.registerCommand("ui", {
		description: "Configure Pi Stuff UI",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/ui requires interactive TUI mode.", "warning");
				return;
			}
			await coordinator.show(
				ctx,
				createUiSettingsView(registry, {
					onPersistenceError: (message) => ctx.ui.notify(message, "error"),
				}),
			);
		},
	});
	return registry;
}

function registerDiagnosticsCommand(
	pi: ExtensionAPI,
	coordinator: CommandDialogCoordinatorImplementation,
	diagnostics: DiagnosticChannel,
): void {
	pi.registerCommand("diagnostics", {
		description: "Inspect Pi Stuff diagnostics",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diagnostics requires interactive TUI mode.", "warning");
				return;
			}
			diagnostics.acknowledgeNotices();
			await coordinator.show(ctx, createDiagnosticsView(diagnostics));
		},
	});
}

function installUiSurfaces(
	pi: ExtensionAPI,
	coordinator: CommandDialogCoordinatorImplementation,
	diagnostics: DiagnosticChannel,
): UiSettingRegistry {
	activateDiagnosticChannel(diagnostics);
	const registry = ensureUiSettingsCommand(pi);
	registerDiagnosticsCommand(pi, coordinator, diagnostics);
	registerConversationMarkdown(pi);
	return registry;
}

export default async function piStuffUi(pi: ExtensionAPI): Promise<void> {
	const effects = new UiEffectOwner(installEffectFoundation(pi));
	const lifecycle = getHostSharedResource<UiLifecycleState>(
		pi.events,
		globalWeakMap<UiLifecycleState>(UI_LIFECYCLE_STATES),
		UI_LIFECYCLE_DISCOVERY_EVENT,
		() => ({ active: false }),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
	if (lifecycle.active) return;
	const activation = Symbol("ui-lifecycle");
	lifecycle.active = true;
	lifecycle.activation = activation;
	try {
		await installUiCapability(pi, lifecycle, activation, effects);
	} catch (error) {
		if (lifecycle.activation === activation) {
			lifecycle.active = false;
			delete lifecycle.activation;
		}
		throw error;
	}
}

async function installUiCapability(
	pi: ExtensionAPI,
	lifecycle: UiLifecycleState,
	activation: symbol,
	effects: UiEffectOwner,
): Promise<void> {
	// SAFETY: this module's getter always returns the package-owned coordinator implementation.
	const coordinator = getCommandDialogCoordinator(pi) as CommandDialogCoordinatorImplementation;
	const diagnostics = getDiagnosticChannel(pi);
	const registry = installUiSurfaces(pi, coordinator, diagnostics);
	const settings = await Effect.runPromise(UiSettingsStore.load());
	let unregisterOwnedSettings: (() => void) | undefined = registerOwnedUiSettings(registry, settings, (program) =>
		effects.run(program),
	);
	let presentation: UiSessionPresentation | undefined;
	let sessionContext: ExtensionContext | undefined;
	const agentRunOrigin = new AgentRunOriginTracker();
	let agentSettlementPending = false;
	let userWorkGitRefreshPending = false;
	let gitRefreshDrainToken: object | undefined;
	let sessionGeneration = 0;
	let agentSettledObserverRegistered = false;
	let inputObserverRegistered = false;
	const scheduleGitRefreshAtQuietBoundary = (): void => {
		userWorkGitRefreshPending = true;
		if (!sessionContext || agentSettlementPending || gitRefreshDrainToken) return;
		const token = {};
		const generation = sessionGeneration;
		gitRefreshDrainToken = token;
		queueMicrotask(() => {
			if (gitRefreshDrainToken === token) gitRefreshDrainToken = undefined;
			if (generation !== sessionGeneration || !sessionContext || !userWorkGitRefreshPending) return;
			try {
				// Let all listeners finish before checking whether a later Extension enqueued Agent work.
				if (agentSettlementPending || !sessionContext.isIdle() || sessionContext.hasPendingMessages()) return;
			} catch {
				return;
			}
			userWorkGitRefreshPending = false;
			void presentation?.refreshGit();
		});
	};
	const stopListeners = [
		listenForStatuslineGitRefreshAfterUserWorkRequests(pi, scheduleGitRefreshAtQuietBoundary),
		listenForActiveAgentWorkUserPromotions(pi, () => agentRunOrigin.promoteActiveWorkToUser()),
		listenForAgentWorkOriginQueries(pi, () => agentRunOrigin.current()),
		listenForUiRenderRequests(pi, (force) => presentation?.requestRender(force)),
	];
	pi.on("session_start", (_event, ctx) => {
		// Register after every Capability so rejected input never enters attribution.
		if (!inputObserverRegistered) {
			inputObserverRegistered = true;
			pi.on("input", (event) => {
				agentRunOrigin.noteInput(event);
			});
		}
		// Register last so Goal continuation decides before this Host-idle check.
		if (!agentSettledObserverRegistered) {
			agentSettledObserverRegistered = true;
			pi.on("agent_settled", async () => {
				if (!sessionContext) return;
				try {
					if (!sessionContext.isIdle() || sessionContext.hasPendingMessages()) {
						userWorkGitRefreshPending ||= agentRunOrigin.hasUserWork();
						return;
					}
				} catch {
					userWorkGitRefreshPending ||= agentRunOrigin.hasUserWork();
					return;
				}
				agentSettlementPending = false;
				const completedUserAgentRun = agentRunOrigin.consumeRunIncludesUserWork();
				const shouldRefreshGit = completedUserAgentRun || userWorkGitRefreshPending;
				userWorkGitRefreshPending = false;
				// Pi awaits handlers sequentially; this bounded Git read finishes before
				// a later Extension can start its continuation.
				if (shouldRefreshGit) await presentation?.refreshGit();
				if (completedUserAgentRun) publishUserAgentRunSettled(pi, sessionContext);
			});
		}
		const repeatGoalClock = effects.bindSession(ctx);
		if (!repeatGoalClock) return;
		presentation?.dispose();
		sessionGeneration += 1;
		gitRefreshDrainToken = undefined;
		sessionContext = ctx;
		agentRunOrigin.reset();
		agentSettlementPending = false;
		userWorkGitRefreshPending = false;
		presentation = installPresentation(pi, ctx, settings, coordinator, diagnostics, repeatGoalClock);
	});
	pi.on("before_agent_start", (event) => {
		diagnostics.acknowledgeNotices();
		presentation?.updateContextFileCount(event.systemPromptOptions.contextFiles?.length);
	});
	pi.on("agent_start", () => {
		agentSettlementPending = true;
	});
	pi.on("turn_start", () => agentRunOrigin.noteTurnStart());
	pi.on("turn_end", () => agentRunOrigin.noteTurnEnd());
	pi.on("message_start", (event) => agentRunOrigin.noteMessageStart(event.message));
	pi.on("session_shutdown", async () => {
		for (const stop of stopListeners.splice(0)) stop();
		presentation?.dispose();
		presentation = undefined;
		sessionGeneration += 1;
		gitRefreshDrainToken = undefined;
		sessionContext = undefined;
		agentSettlementPending = false;
		userWorkGitRefreshPending = false;
		await effects.shutdown(settings.whenIdle());
		unregisterOwnedSettings?.();
		unregisterOwnedSettings = undefined;
		if (lifecycle.activation === activation) {
			lifecycle.active = false;
			delete lifecycle.activation;
		}
	});
}
