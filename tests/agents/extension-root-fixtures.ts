import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentWorkOrigin,
	listenForAgentWorkOriginQueries,
} from "../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";
import type { CommandDialogCoordinator } from "../../packages/pi-stuff/src/conversation-ui/index.js";
import { SELF_RENDERED_TRANSCRIPT_PADDING } from "../../packages/pi-stuff/src/conversation-ui/transcript.js";
import { isRuntimeFunction } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import type { PiStuffAgentsConfig } from "../../packages/pi-stuff/src/subagents/src/extension/config.js";
import registerAgents, {
	type ExtensionRootDependencies,
} from "../../packages/pi-stuff/src/subagents/src/extension/index.js";
import type { PublicAgentParams } from "../../packages/pi-stuff/src/subagents/src/extension/product-executor.js";
import type { CompletionNotification } from "../../packages/pi-stuff/src/subagents/src/runs/background/notify.js";
import {
	deriveLaunchRunId,
	type SubagentParamsLike,
} from "../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.js";
import { SUBAGENT_PARENT_SESSION_ENV } from "../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.js";
import type {
	AgentExecutionInvocation,
	GovernedAgentParams,
} from "../../packages/pi-stuff/src/subagents/src/runtime/agent-execution-coordinator.js";
import type { AgentGovernorLease } from "../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";
import { CurrentAgents } from "../../packages/pi-stuff/src/subagents/src/session/current-agents.js";
import {
	ASYNC_DIR,
	type AsyncJobState,
	type Details,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	type SubagentState,
} from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { captureExtensionHandlers, createExtensionApi } from "../fixtures/extension-api.js";
import { createExtensionCommandContext } from "../fixtures/extension-context.js";

interface HarnessEvent {
	readonly message?: { readonly role: string; readonly customType?: string; readonly details?: unknown };
	readonly reason?: string;
	readonly toolName?: string;
	readonly type: string;
}
type Handler = (event: HarnessEvent, ctx: ExtensionContext) => object | undefined;
type EntryRenderer = (...args: unknown[]) => object | undefined;

type TestMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

interface TestToolResult {
	readonly content: Array<{ readonly text: string; readonly type: string }>;
	readonly details?: unknown;
}

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type EventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type EventPayload = Parameters<EventListener>[0];
type AppendEntryData = Parameters<ExtensionAPI["appendEntry"]>[1];
type MessageOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

interface TestTool extends Tool {
	readonly label: string;
	execute(
		id: string,
		params: PublicAgentParams,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<TestToolResult>;
}

class EventBusHarness {
	readonly emissions: string[] = [];
	private readonly bus = createEventBus();
	private listeners = 0;
	readonly host: ExtensionAPI["events"] = {
		emit: (event, data) => {
			this.emissions.push(event);
			this.bus.emit(event, data);
		},
		on: (event, listener) => {
			this.listeners += 1;
			const unsubscribe = this.bus.on(event, listener);
			return () => {
				this.listeners -= 1;
				unsubscribe();
			};
		},
	};

	emit(event: string, data: EventPayload): void {
		this.host.emit(event, data);
	}

	on(event: string, listener: EventListener): () => void {
		return this.host.on(event, listener);
	}

	size(): number {
		return this.listeners;
	}
}

class ApiHarness {
	autoDeliverMessages = true;
	readonly commands = new Map<string, RegisteredCommand>();
	readonly entries: Array<{ customType: string; data: AppendEntryData }> = [];
	readonly entryRenderers = new Map<string, EntryRenderer>();
	readonly events = new EventBusHarness();
	readonly handlers = new Map<string, Handler[]>();
	readonly messages: Array<{ message: TestMessage; options: MessageOptions }> = [];
	readonly providerToolDescriptions = new Map<string, string>();
	readonly renderers: string[] = [];
	readonly tools = new Map<string, TestTool>();

	readonly api = createExtensionApi({
		events: this.events.host,
		on: captureExtensionHandlers(this.handlers),
		registerTool: (tool) => {
			// Pi snapshots ToolDefinition fields while rebuilding its provider-facing AgentTool registry.
			this.providerToolDescriptions.set(tool.name, tool.description);
			// SAFETY: this test registry erases only generic renderer state and invokes the original Tool unchanged.
			this.tools.set(tool.name, tool as TestTool);
		},
		registerCommand: (name, command) => {
			this.commands.set(name, command);
		},
		registerEntryRenderer: (name, renderer) => {
			// SAFETY: the harness calls the renderer with the same entry details registered for its custom type.
			this.entryRenderers.set(name, renderer as EntryRenderer);
		},
		registerMessageRenderer: (name: string) => this.renderers.push(name),
		appendEntry: (customType: string, data: AppendEntryData) => this.entries.push({ customType, data }),
		sendMessage: (message, options) => {
			this.messages.push({ message, options });
			if (this.autoDeliverMessages) {
				void this.fire("message_end", { type: "message_end", message: { ...message, role: "custom" } }).then(() =>
					this.fire("before_provider_request", { type: "before_provider_request" }),
				);
			}
		},
	});

	async fire(event: string, data: HarnessEvent, ctx = context()): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(data, ctx);
	}
}

interface HarnessOptions {
	backgroundGate?: Promise<void>;
	backgroundLifecycleAbort?: boolean | "throw";
	compatibility?: ExtensionRootDependencies["prepareGovernorCompatibility"];
	contextProjection?: string;
	coordinatorIdle?: Promise<void>;
	maintenance?: () => Promise<void> | void;
	monotonicNow?: () => number;
	governorLedgerExists?: boolean;
	governorReject?: boolean;
	restoreActive?: boolean;
	restoreGate?: Promise<void>;
	restoreFailure?: boolean;
	runtimeStartFailure?: boolean;
	settleFailure?: boolean;
	prepareGate?: Promise<void>;
	reconcileGate?: Promise<void>;
	foregroundGate?: Promise<void>;
	foregroundAsyncDir?: string;
	foregroundDetails?: Details;
}

interface RootHarness {
	readonly api: ApiHarness;
	readonly chrome: { registered: number; unregistered: number };
	readonly current: { disposed: number; refreshes: number; value: CurrentAgents | undefined };
	readonly directories: string[];
	readonly dialogs: Array<{ initialKey?: string; hasReader: boolean }>;
	readonly engineParams: SubagentParamsLike[];
	readonly engineOrigins: AgentWorkOrigin[];
	readonly governor: {
		binds: Array<{ sessionId: string; ownerAgentPath: readonly string[] }>;
		completions: unknown[];
		disposed: number;
		failures: number;
		prepares: Array<{ acknowledgeCost?: boolean; launchRunId: string; params: GovernedAgentParams }>;
		reconcileChecks: number;
		reconciles: number;
		settlements: number;
		starts: unknown[];
	};
	readonly notifier: { value: { deliver(result: CompletionNotification): Promise<boolean> } | undefined };
	readonly projectionOwnership: { delegated: boolean };
	readonly projections: string[];
	readonly roster: { contexts: number; disposed: number; suppressed: boolean[] };
	readonly state: { value: SubagentState | undefined };
	readonly supervisor: { disposed: number; started: number };
	readonly tracker: {
		completed: number;
		pollers: number;
		reset: number;
		restored: number;
		restoredSessions: string[];
		started: number;
	};
	readonly watcher: { primes: number; starts: number; stops: number };
}

const roots: RootHarness[] = [];
const temporaryDirectories = new Set<string>();

function config(): PiStuffAgentsConfig {
	return {
		maxSubagentDepth: 3,
		maxRunningAgents: 20,
	};
}

function context(
	entries: readonly SessionEntry[] = [],
	identity: { sessionFile?: string; sessionId?: string } = {},
): ExtensionCommandContext {
	return createExtensionCommandContext({
		cwd: "/project",
		sessionManager: {
			getBranch: () => [...entries],
			getEntries: () => [...entries],
			getSessionFile: () => identity.sessionFile ?? "/sessions/root.jsonl",
			getSessionId: () => identity.sessionId ?? "root-id",
		},
	});
}

function currentSessionId(root: RootHarness): string {
	const value = root.state.value?.currentSessionId;
	if (!value) throw new Error("Expected current physical session identity");
	return value;
}

function createHarnessState(): RootHarness {
	const api = new ApiHarness();
	const chrome = { registered: 0, unregistered: 0 };
	// SAFETY: this test controls the value and supplies every CurrentAgents member exercised by this case.
	const current = { disposed: 0, refreshes: 0, value: undefined as CurrentAgents | undefined };
	const directories: string[] = [];
	const dialogs: Array<{ initialKey?: string; hasReader: boolean }> = [];
	const engineParams: SubagentParamsLike[] = [];
	const engineOrigins: AgentWorkOrigin[] = [];
	const governor = {
		// SAFETY: this test controls the value and supplies every Array member exercised by this case.
		binds: [] as Array<{ sessionId: string; ownerAgentPath: readonly string[] }>,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		completions: [] as unknown[],
		disposed: 0,
		failures: 0,
		// SAFETY: this test controls the value and supplies every Array member exercised by this case.
		prepares: [] as Array<{ acknowledgeCost?: boolean; launchRunId: string; params: GovernedAgentParams }>,
		reconcileChecks: 0,
		reconciles: 0,
		settlements: 0,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		starts: [] as unknown[],
	};
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const notifier = { value: undefined as { deliver(result: CompletionNotification): Promise<boolean> } | undefined };
	const projectionOwnership = { delegated: false };
	const projections: string[] = [];
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const roster = { contexts: 0, disposed: 0, suppressed: [] as boolean[] };
	// SAFETY: this test controls the value and supplies every SubagentState member exercised by this case.
	const state = { value: undefined as SubagentState | undefined };
	const supervisor = { disposed: 0, started: 0 };
	const restoredSessions: string[] = [];
	const tracker = { completed: 0, pollers: 0, reset: 0, restored: 0, restoredSessions, started: 0 };
	const watcher = { primes: 0, starts: 0, stops: 0 };
	return {
		api,
		chrome,
		current,
		directories,
		dialogs,
		engineParams,
		engineOrigins,
		governor,
		notifier,
		projectionOwnership,
		projections,
		roster,
		state,
		supervisor,
		tracker,
		watcher,
	};
}

function createGovernorDependencies(
	options: HarnessOptions,
	governor: RootHarness["governor"],
): Pick<ExtensionRootDependencies, "createGovernorCoordinator" | "prepareGovernorCompatibility"> {
	return {
		createGovernorCoordinator: () => {
			const restoredLease: AgentGovernorLease = {
				acquiredAtMs: 1,
				agentPath: ["restored"],
				asyncDir: path.join(ASYNC_DIR, "restored"),
				childIndex: 0,
				leaseId: "restored-lease",
				logicalAgentId: "restored",
				mode: "spawn",
				ownerAgentPath: [],
				pid: 1,
				runtimeRunId: "restored",
				sessionId: "root-session",
			};
			return {
				bindSession: (identity) => governor.binds.push(identity),
				inspectExistingRuntimeLeases: async () =>
					options.restoreActive || options.restoreFailure || options.restoreGate ? [restoredLease] : [],
				prepare: async (input) => {
					const prepared: (typeof governor.prepares)[number] = {
						launchRunId: input.launchRunId,
						params: input.params,
					};
					if (input.acknowledgeCost === true) prepared.acknowledgeCost = true;
					governor.prepares.push(prepared);
					await options.prepareGate;
					if (options.governorReject)
						return { ok: false, message: "Agent limit reached; wait for one to finish." };
					if (input.params.action && input.params.action !== "resume") return { ok: true };
					// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
					return { ok: true, invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation };
				},
				observeAsyncStarted: async (event) => {
					governor.starts.push(event);
				},
				settle: async () => {
					governor.settlements += 1;
					if (options.settleFailure) throw Object.assign(new Error("injected settle EIO"), { code: "EIO" });
				},
				fail: async () => {
					governor.failures += 1;
				},
				complete: async (event) => {
					governor.completions.push(event);
				},
				reconcileDead: async () => {
					governor.reconciles += 1;
				},
				reconcileExisting: async () => {
					governor.reconcileChecks += 1;
					await options.reconcileGate;
					if (options.restoreActive || options.governorLedgerExists) governor.reconciles += 1;
				},
				dispose: () => {
					governor.disposed += 1;
				},
			};
		},
		prepareGovernorCompatibility:
			options.compatibility ??
			(async () => ({
				ok: true,
				importedLogicalAgentIds: [],
				legacyLedgerObserved: false,
			})),
	};
}

function createExecutorDependencies(
	options: HarnessOptions,
	state: RootHarness["state"],
	projectionOwnership: RootHarness["projectionOwnership"],
	engineParams: RootHarness["engineParams"],
	engineOrigins: RootHarness["engineOrigins"],
): Pick<ExtensionRootDependencies, "createExecutor"> {
	return {
		createExecutor: ({ projectContext, state: rootState }) => {
			state.value = rootState;
			projectionOwnership.delegated = isRuntimeFunction(projectContext);
			const backgroundLifecycleAbort = options.backgroundLifecycleAbort;
			return {
				execute: async (_id, params, _signal, _onUpdate, _ctx, hooks) => {
					engineParams.push(params);
					engineOrigins.push(hooks?.parentRunOrigin ?? "automatic");
					if (params.async === false && options.foregroundAsyncDir) {
						const launchRunId = params.launchRunId;
						if (!launchRunId) throw new Error("Expected a foreground launch run id");
						await hooks?.beforeForegroundStart?.({
							runId: launchRunId,
							asyncDir: options.foregroundAsyncDir,
							writerCount: options.foregroundDetails?.results.length ?? 1,
							abortStart: () => true,
						});
						await options.foregroundGate;
						// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
						return {
							content: [{ type: "text", text: "foreground engine receipt" }],
							details:
								options.foregroundDetails ??
								// SAFETY: this test controls the value and supplies every Details member exercised by this case.
								({
									mode: "single",
									runId: params.launchRunId,
									results: [{ agent: "worker", exitCode: 0, finalOutput: "done" }],
								} as Details),
						} as never;
					}
					await options.backgroundGate;
					// SAFETY: this test controls the value and supplies every Details member exercised by this case.
					const details = {
						mode: "single",
						results: [],
						asyncId: "run-1",
					} as Details;
					if (backgroundLifecycleAbort !== undefined) {
						Object.assign(details, {
							lifecycleBinding: {
								abortStart: () => {
									if (backgroundLifecycleAbort === "throw") {
										throw Object.assign(new Error("injected abort EIO"), { code: "EIO" });
									}
									return backgroundLifecycleAbort;
								},
							},
						});
					}
					// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
					return {
						content: [{ type: "text", text: "Async dir: /private/run" }],
						details,
					} as never;
				},
			};
		},
	};
}

function createTrackerDependencies(
	options: HarnessOptions,
	tracker: RootHarness["tracker"],
): Pick<ExtensionRootDependencies, "createTracker"> {
	let trackerGeneration = 0;
	return {
		createTracker: (_pi, rootState) => ({
			ensureObserver: () => {
				tracker.pollers += 1;
			},
			handleProcessTerminal: () => {},
			handleStatus: () => {},
			handleStarted: (data) => {
				tracker.started += 1;
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				const event = data as { id?: string; sessionId?: string };
				if (!event.id) return;
				const job: AsyncJobState = {
					asyncId: event.id,
					asyncDir: `/tmp/${event.id}`,
					status: "running",
					agents: ["worker"],
					startedAt: 1,
					updatedAt: 1,
				};
				if (event.sessionId) job.sessionId = event.sessionId;
				rootState.asyncJobs.set(event.id, job);
			},
			handleComplete: () => {
				tracker.completed += 1;
			},
			resetJobs: () => {
				trackerGeneration += 1;
				tracker.reset += 1;
				rootState.asyncJobs.clear();
				rootState.recentAgentJobs?.clear();
			},
			restoreActiveJobs: async (asyncDirectories?: readonly string[]) => {
				if (asyncDirectories !== undefined && asyncDirectories.length === 0) return;
				const generation = trackerGeneration;
				const sessionId = rootState.currentSessionId;
				tracker.restored += 1;
				await options.restoreGate;
				if (options.restoreFailure) throw Object.assign(new Error("injected restore EIO"), { code: "EIO" });
				if (generation !== trackerGeneration || rootState.currentSessionId !== sessionId) return;
				if (sessionId) tracker.restoredSessions.push(sessionId);
				if (!options.restoreActive) return;
				const job: AsyncJobState = {
					asyncId: "restored",
					asyncDir: "/tmp/restored",
					status: "running",
					agents: ["worker"],
					startedAt: 1,
					updatedAt: 1,
				};
				if (sessionId) job.sessionId = sessionId;
				rootState.asyncJobs.set("restored", job);
			},
		}),
	};
}

function createPresentationDependencies(
	options: HarnessOptions,
	harness: RootHarness,
): Pick<
	ExtensionRootDependencies,
	"createWatcher" | "createSupervisor" | "createCurrentAgents" | "createRoster" | "openDialog" | "projectContext"
> {
	const { current, dialogs, notifier, projections, roster, supervisor, watcher } = harness;
	return {
		createWatcher: ({ notifier: completionNotifier }) => {
			notifier.value = completionNotifier;
			return {
				startResultWatcher: () => {
					watcher.starts += 1;
					return true;
				},
				stopResultWatcher: () => {
					watcher.stops += 1;
				},
				primeExistingResults: () => {
					watcher.primes += 1;
				},
			};
		},
		createSupervisor: () => ({
			start: () => {
				supervisor.started += 1;
			},
			dispose: () => {
				supervisor.disposed += 1;
			},
		}),
		createCurrentAgents: (rootState, currentOptions) => {
			const value = new CurrentAgents(rootState, currentOptions);
			const refresh = value.refresh.bind(value);
			const dispose = value.dispose.bind(value);
			value.refresh = () => {
				current.refreshes += 1;
				refresh();
			};
			value.dispose = () => {
				current.disposed += 1;
				dispose();
			};
			current.value = value;
			return value;
		},
		createRoster: (_current, rosterOptions) => {
			expect(rosterOptions.onOpen).toBeTypeOf("function");
			return {
				createFooterTail: () => ({ dispose: () => {}, invalidate: () => {}, render: () => [] }),
				setContext: () => {
					roster.contexts += 1;
				},
				setFooterHosted: () => {},
				setSuppressed: (suppressed: boolean) => {
					roster.suppressed.push(suppressed);
				},
				dispose: () => {
					roster.disposed += 1;
				},
			};
		},
		openDialog: async (_ctx, _coordinator, _current, dialogOptions) => {
			const dialog: RootHarness["dialogs"][number] = {
				hasReader: isRuntimeFunction(dialogOptions.readTranscript),
			};
			if (dialogOptions.initialKey) dialog.initialKey = dialogOptions.initialKey;
			dialogs.push(dialog);
		},
		projectContext: async (audience) => {
			projections.push(audience);
			return {
				source: "magic-context",
				text: options.contextProjection ?? "",
				truncated: false,
			};
		},
	};
}

function createHarness(options: HarnessOptions = {}): RootHarness {
	const harness = createHarnessState();
	const { api, chrome, directories, engineParams, engineOrigins, governor, projectionOwnership, state, tracker } =
		harness;

	// SAFETY: this test controls the value and supplies every CommandDialogCoordinator member exercised by this case.
	const coordinator = {
		registerChrome: (_id: string, chromeValue: { setSuppressed(suppressed: boolean): void }) => {
			chrome.registered += 1;
			expect(chromeValue.setSuppressed).toBeTypeOf("function");
			return () => {
				chrome.unregistered += 1;
			};
		},
		whenIdle: () => options.coordinatorIdle ?? Promise.resolve(),
	} as CommandDialogCoordinator;

	const dependencies: Partial<ExtensionRootDependencies> = {
		isChildProcess: () => false,
		loadConfiguration: config,
		maintainRuntime: options.maintenance ?? (() => {}),
		monotonicNow: options.monotonicNow ?? (() => performance.now()),
		getCoordinator: () => coordinator,
		ensureDirectory: (directory) => {
			directories.push(directory);
			if (options.runtimeStartFailure)
				throw Object.assign(new Error("injected runtime directory EIO"), { code: "EIO" });
		},
		randomId: () => "control-id",
		...createGovernorDependencies(options, governor),
		...createExecutorDependencies(options, state, projectionOwnership, engineParams, engineOrigins),
		...createTrackerDependencies(options, tracker),
		...createPresentationDependencies(options, harness),
	};

	registerAgents(api.api, dependencies);
	roots.push(harness);
	return harness;
}

export type { CompletionNotification };
export {
	ApiHarness,
	ASYNC_DIR,
	config,
	context,
	createHarness,
	currentSessionId,
	deriveLaunchRunId,
	fs,
	listenForAgentWorkOriginQueries,
	os,
	path,
	RESULTS_DIR,
	registerAgents,
	SELF_RENDERED_TRANSCRIPT_PADDING,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_PARENT_SESSION_ENV,
	temporaryDirectories,
	validateToolArguments,
};

export async function cleanupExtensionRootFixtures(): Promise<void> {
	for (const root of roots.splice(0)) {
		await root.api.fire("session_shutdown", { reason: "quit", type: "session_shutdown" });
	}
	for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
	delete process.env[SUBAGENT_PARENT_SESSION_ENV];
}
