import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { Check } from "typebox/value";
import { getContextStatusChannel, reportDiagnostic, type SuiteAgentMessageOptions } from "../conversation-ui/index.ts";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { isRuntimeObject } from "../shared/runtime-type.ts";
import { registerSuiteOwnedTool, registerSuiteToolActivityMetadata } from "../tool-display/index.ts";
import { MAGIC_TOOL_LABELS, MAGIC_TOOL_NAME_SET, MAGIC_TOOL_NAMES } from "./activity.ts";
import { ContextCommandRuntime, type MagicCommandDefinition } from "./command-runtime.ts";
import type { MagicCompactionResult } from "./magic-context-types.ts";
import {
	addCompactMagicContextPrompt,
	COMPACT_PROMPT_EVENT_SCHEMA,
	type ContextRuntimeDependencies,
	type LooseEventHandler,
	MAGIC_TOOL_HANDOFF_PARAMETERS,
	type MagicRegistrationPlan,
	magicCommandContext,
	magicPiAdapter,
	quietMagicContext,
} from "./magic-runtime.ts";
import { NativeContextPreflight } from "./native-preflight.ts";
import type { ContextProjection, ContextProjectionAudience, ContextProjectionOptions } from "./projection.ts";
import { ContextProjectionRuntime, type MagicContextEventResult, type MagicContextHandler } from "./projection.ts";
import { applyContextPromptContributions, stripContextPromptContributions } from "./prompt-contributions.ts";
import { ContextRecovery } from "./recovery.ts";
import {
	type ContextActivationTrigger,
	type ContextCapabilityState,
	type ContextStatusSnapshot,
	contextStatusWithContinuity,
	nativeContextStatus,
} from "./status.ts";
import { magicToolPresentation } from "./tool-presentation.ts";

export interface ContextCapability {
	status(): ContextStatusSnapshot;
	activate(ctx: ExtensionContext, trigger: ContextActivationTrigger): Promise<ContextStatusSnapshot>;
	projectCurrentContext(
		audience: ContextProjectionAudience,
		ctx: ExtensionContext,
		options?: ContextProjectionOptions,
	): Promise<ContextProjection>;
}

export interface ContextCapabilityRegistry {
	readonly contexts: WeakMap<object, ContextCapabilityRuntime>;
	readonly capabilities: WeakMap<ContextCapabilityRuntime, ContextCapability>;
	readonly owners: WeakMap<object, ContextCapabilityRuntime>;
	readonly runtimes: Set<ContextCapabilityRuntime>;
}

interface ContextRuntimeBoundary {
	readonly activate: (ctx: ExtensionContext, trigger: ContextActivationTrigger) => Promise<ContextStatusSnapshot>;
}

type SharedFlight<A> = { readonly deferred: Deferred.Deferred<A> };

interface ActivationFlight extends SharedFlight<ContextStatusSnapshot> {
	readonly trigger: ContextActivationTrigger;
	retryTrigger?: ContextActivationTrigger;
}

function nativeEffect<A>(operation: () => A | PromiseLike<A>): Effect.Effect<A, unknown> {
	return Effect.tryPromise({ try: async () => operation(), catch: (error) => error });
}

function ownerKey(pi: ExtensionAPI): object {
	return isRuntimeObject(pi.events) && pi.events !== null ? pi.events : pi;
}

export class ContextCapabilityRuntime {
	private readonly pi: ExtensionAPI;
	private readonly dependencies: ContextRuntimeDependencies;
	private state: ContextStatusSnapshot = { state: "dormant", engine: "native" };
	private activation: ActivationFlight | undefined;
	private cleanup: SharedFlight<void> | undefined;
	private readonly sessionStarts = Semaphore.makeUnsafe(1);
	private generation = 0;
	private sessionVersion = 0;
	private readonly boundary: ContextRuntimeBoundary;
	private readonly commandRuntime: ContextCommandRuntime;
	private readonly magicCommands = new Map<string, MagicCommandDefinition>();
	private magicContextHandler: MagicContextHandler | undefined;
	private readonly magicTools = new Map<string, ToolDefinition>();
	private magicCompactionHandlers: LooseEventHandler[] = [];
	private magicSessionStartHandlers: LooseEventHandler[] = [];
	private magicShutdownHandlers: LooseEventHandler[] = [];
	private sessionStart: SessionStartEvent | undefined;
	private sessionContext: ExtensionContext | undefined;
	private shutdown: { event: SessionShutdownEvent; ctx: ExtensionContext } | undefined;
	private disposed = false;
	private readonly projectionRuntime: ContextProjectionRuntime;
	private readonly registry: ContextCapabilityRegistry;
	private readonly owner: object;
	private readonly ownedContexts = new Set<object>();
	private readonly nativePreflight: NativeContextPreflight;
	private directInputActivationPending = false;
	private magicPromptInstalledForSession = false;
	private readonly recovery: ContextRecovery;
	private readonly magicEventHandlers = new Map<string, LooseEventHandler[]>();
	private readonly registeredMagicEvents = new Set<string>();

	constructor(
		pi: ExtensionAPI,
		dependencies: ContextRuntimeDependencies,
		registry: ContextCapabilityRegistry,
		boundary: ContextRuntimeBoundary,
	) {
		this.pi = pi;
		this.recovery = new ContextRecovery(getContextStatusChannel(pi));
		this.boundary = boundary;
		this.commandRuntime = new ContextCommandRuntime(pi, {
			activate: (ctx) => this.boundary.activate(ctx, "input").then(() => undefined),
			commands: this.magicCommands,
			currentContext: () => this.sessionContext,
			error: () => this.state.error,
			continuityDetail: () => this.status().continuityDetail,
			quietContext: magicCommandContext,
		});
		this.projectionRuntime = new ContextProjectionRuntime({
			activate: (ctx) => this.activate(ctx, "projection").pipe(Effect.asVoid),
			current: () => ({
				active: this.state.engine === "magic-context",
				generation: this.generation,
				handler: this.magicContextHandler,
			}),
			fail: (error, trigger) => this.setDegraded(error, trigger),
			quietContext: (ctx) => quietMagicContext(ctx),
			succeed: (trigger) => {
				this.state = {
					state: "active",
					engine: "magic-context",
					trigger: trigger === "automatic-turn" ? (this.state.trigger ?? trigger) : trigger,
				};
			},
		});
		this.dependencies = dependencies;
		this.nativePreflight = new NativeContextPreflight(dependencies.readNativeCompactionSettings);
		this.registry = registry;
		this.owner = ownerKey(pi);
	}

	status(): ContextStatusSnapshot {
		return contextStatusWithContinuity(
			this.state,
			this.sessionContext,
			this.dependencies.readNativeCompactionSettings,
		);
	}

	private setNative(trigger?: ContextActivationTrigger): void {
		this.state =
			trigger === undefined ? { state: "native", engine: "native" } : { state: "native", engine: "native", trigger };
	}

	private setDegraded(cause: unknown, trigger: ContextActivationTrigger | undefined): void {
		const error = cause instanceof Error ? cause.message : String(cause);
		this.state =
			trigger === undefined
				? { state: "degraded", engine: "magic-context", error }
				: { state: "degraded", engine: "magic-context", trigger, error };
	}

	noteInput(source: InputEvent["source"]): ContextCapabilityState {
		this.projectionRuntime.noteInput(source);
		if (source !== "extension") this.directInputActivationPending = true;
		return this.state.state;
	}

	consumeDirectInputActivation(): boolean {
		const pending = this.directInputActivationPending;
		this.directInputActivationPending = false;
		return pending;
	}

	yieldForInteractivePaint(): Effect.Effect<boolean> | undefined {
		return this.projectionRuntime.yieldForInteractivePaint();
	}

	registerToolHandoffs(): void {
		if (this.dependencies.magicSubagent()) {
			for (const name of MAGIC_TOOL_NAMES) {
				registerSuiteToolActivityMetadata(this.pi, name, magicToolPresentation(name).activity);
			}
			return;
		}
		for (const name of MAGIC_TOOL_NAMES) {
			registerSuiteOwnedTool(
				this.pi,
				{
					name,
					label: MAGIC_TOOL_LABELS.get(name) ?? name,
					description: "Pi Stuff Context tool; its implementation activates before the next provider boundary.",
					parameters: MAGIC_TOOL_HANDOFF_PARAMETERS,
					execute: async () => {
						return {
							content: [
								{
									type: "text" as const,
									text: "Magic Context is unavailable; retry after restoring Context.",
								},
							],
							details: undefined,
							isError: true,
						};
					},
				},
				magicToolPresentation(name),
			);
		}
	}

	private deactivateToolHandoffs(): void {
		this.pi.setActiveTools(this.pi.getActiveTools().filter((name) => !MAGIC_TOOL_NAME_SET.has(name)));
	}

	private activateMagicTools(): void {
		this.pi.setActiveTools(
			this.pi.getActiveTools().filter((name) => !MAGIC_TOOL_NAME_SET.has(name) || this.magicTools.has(name)),
		);
	}

	captureSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.sessionVersion++;
		const previousSessionManager = this.sessionContext?.sessionManager;
		if (previousSessionManager && previousSessionManager !== ctx.sessionManager) {
			if (this.registry.contexts.get(previousSessionManager) === this) {
				this.registry.contexts.delete(previousSessionManager);
			}
			this.ownedContexts.delete(previousSessionManager);
		}
		this.recovery.clear();
		this.sessionStart = { ...event };
		this.sessionContext = ctx;
		this.projectionRuntime.invalidate(true);
		this.directInputActivationPending = false;
		this.magicPromptInstalledForSession = false;
		this.registry.contexts.set(ctx.sessionManager, this);
		this.ownedContexts.add(ctx.sessionManager);
		if (this.magicTools.size > 0) this.activateMagicTools();
	}

	startSession(event: SessionStartEvent, ctx: ExtensionContext): Effect.Effect<void> {
		return this.sessionStarts.withPermit(this.startSessionNow(event, ctx));
	}

	private startSessionNow(event: SessionStartEvent, ctx: ExtensionContext): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.disposed) return Effect.void;
			const forwardsToActiveMagic = this.state.state === "active" && this.magicContextHandler !== undefined;
			this.captureSessionStart(event, ctx);
			if (!forwardsToActiveMagic) return this.activate(ctx, "startup").pipe(Effect.asVoid);
			const generation = this.generation;
			const handlers = this.magicSessionStartHandlers;
			return Effect.gen({ self: this }, function* () {
				for (const handler of handlers) {
					yield* nativeEffect(() => handler(event, quietMagicContext(ctx)));
					if (!this.isCurrentGeneration(generation)) return;
				}
			}).pipe(
				Effect.catch((error) =>
					this.isCurrentGeneration(generation) ? this.handleCommittedFailure(error, ctx) : Effect.void,
				),
			);
		});
	}

	invalidateProjection(): void {
		this.projectionRuntime.invalidate(true);
	}

	dispose(event?: SessionShutdownEvent, ctx?: ExtensionContext): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.disposed) return Effect.void;
			this.disposed = true;
			const trigger = this.state.trigger;
			this.setNative(trigger);
			this.sessionContext = undefined;
			this.generation++;
			this.magicSessionStartHandlers = [];
			this.magicCompactionHandlers = [];
			if (event && ctx) this.shutdown = { event, ctx };
			this.projectionRuntime.invalidate(true);
			for (const key of this.ownedContexts) {
				if (this.registry.contexts.get(key) === this) this.registry.contexts.delete(key);
			}
			this.ownedContexts.clear();
			if (this.registry.owners.get(this.owner) === this) this.registry.owners.delete(this.owner);
			this.registry.runtimes.delete(this);
			const activation = this.activation;
			const cleanup = this.cleanup;
			const handlers = this.magicShutdownHandlers.splice(0);
			const pending = [
				activation ? Deferred.await(activation.deferred).pipe(Effect.asVoid) : Effect.void,
				cleanup ? Deferred.await(cleanup.deferred) : Effect.void,
				this.nativePreflight.wait(),
				this.sessionStarts.withPermit(Effect.void),
				event && ctx
					? Effect.forEach(
							handlers,
							(handler) => nativeEffect(() => handler(event, quietMagicContext(ctx))).pipe(Effect.ignore),
							{ concurrency: "unbounded", discard: true },
						)
					: Effect.void,
			];
			return Effect.all(pending, { concurrency: "unbounded", discard: true }).pipe(
				Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS),
				Effect.asVoid,
			);
		});
	}

	activate(ctx: ExtensionContext, trigger: ContextActivationTrigger): Effect.Effect<ContextStatusSnapshot> {
		return Effect.suspend(() => {
			if (this.disposed) return Effect.succeed({ state: "native", engine: "native" });
			const cleanup = this.cleanup;
			if (cleanup) {
				return Deferred.await(cleanup.deferred).pipe(Effect.flatMap(() => this.activate(ctx, trigger)));
			}
			if (this.dependencies.magicSubagent()) {
				this.setNative(trigger);
				return Effect.succeed(this.status());
			}
			if (this.state.state === "active" || this.state.state === "native") return Effect.succeed(this.status());
			if (this.magicContextHandler) return Effect.succeed(this.status());
			if (this.state.state === "degraded") {
				if (trigger !== "input" && trigger !== "startup") return Effect.succeed(this.status());
				return this.handleCommittedFailure(this.state.error, ctx).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							this.state = { state: "loading", engine: "magic-context", trigger };
						}),
					),
					Effect.andThen(this.activate(ctx, trigger)),
				);
			}
			const current = this.activation;
			if (current) {
				if (trigger !== "automatic-turn" && current.trigger === "automatic-turn") current.retryTrigger = trigger;
				return Deferred.await(current.deferred).pipe(
					Effect.flatMap((result) =>
						trigger !== "automatic-turn" &&
						current.trigger === "automatic-turn" &&
						result.state === "dormant" &&
						!this.disposed
							? this.activate(ctx, trigger)
							: Effect.succeed(result),
					),
				);
			}

			this.state = { state: "loading", engine: "magic-context", trigger };
			const generation = ++this.generation;
			const sessionStart = this.sessionStart ? { ...this.sessionStart } : undefined;
			const flight: ActivationFlight = {
				deferred: Deferred.makeUnsafe<ContextStatusSnapshot>(),
				trigger,
			};
			this.activation = flight;
			return this.startMagicContext(ctx, trigger, generation, sessionStart).pipe(
				Effect.flatMap((result) => {
					const retryTrigger = flight.retryTrigger;
					if (retryTrigger && result.state === "dormant" && !this.disposed) {
						if (this.activation === flight) this.activation = undefined;
						return this.activate(ctx, retryTrigger);
					}
					return Effect.succeed(result);
				}),
				Effect.onExit((exit) => Deferred.done(flight.deferred, exit)),
				Effect.ensuring(
					Effect.sync(() => {
						if (this.activation === flight) this.activation = undefined;
					}),
				),
			);
		});
	}

	prepareSuiteAgentMessage(
		activation: "automatic" | "direct-user",
		options: SuiteAgentMessageOptions,
	): Effect.Effect<void> {
		const ctx = this.sessionContext;
		if (!ctx) return Effect.void;
		let idle = false;
		try {
			idle = ctx.isIdle();
		} catch {
			// A partial Host context must fail toward preserving model context.
		}
		const startsOrJoinsAgentWork = options?.triggerTurn === true || !idle;
		if (!startsOrJoinsAgentWork) return Effect.void;
		return this.activate(ctx, activation === "direct-user" ? "input" : "automatic-turn").pipe(
			Effect.flatMap(() =>
				options?.triggerTurn === true && idle && this.state.engine === "native"
					? this.nativePreflight.run(ctx)
					: Effect.void,
			),
		);
	}

	stageSuiteCustomContextGuidance(options: SuiteAgentMessageOptions): symbol | undefined {
		if (options?.triggerTurn !== true || this.state.state !== "active" || this.magicPromptInstalledForSession) {
			return undefined;
		}
		try {
			if (!this.sessionContext?.isIdle()) return undefined;
		} catch {
			return undefined;
		}
		return this.projectionRuntime.stageSuiteCustomContextGuidance();
	}

	cancelSuiteCustomContextGuidance(token: symbol): void {
		this.projectionRuntime.cancelSuiteCustomContextGuidance(token);
	}
	projectCurrentContext(
		audience: ContextProjectionAudience,
		ctx: ExtensionContext,
		options?: ContextProjectionOptions,
	): Effect.Effect<ContextProjection> {
		return this.projectionRuntime.projectCurrent(audience, ctx, options);
	}

	private startMagicContext(
		ctx: ExtensionContext,
		trigger: ContextActivationTrigger,
		generation: number,
		sessionStart: SessionStartEvent | undefined,
	): Effect.Effect<ContextStatusSnapshot> {
		const plan: MagicRegistrationPlan = { commands: new Map(), handlers: [], tools: [], shutdownComplete: false };
		let committed = false;
		const transaction = Effect.gen({ self: this }, function* () {
			const preparation = yield* nativeEffect(() =>
				this.dependencies.prepareMagicContext(ctx, {
					allowConfigurationMutation: trigger !== "automatic-turn" && trigger !== "startup",
				}),
			);
			if (preparation === "deferred") {
				if (!this.isCurrentGeneration(generation)) return nativeContextStatus(trigger);
				this.state = { state: "dormant", engine: "native" };
				return this.status();
			}
			const module = yield* nativeEffect(() => this.dependencies.loadMagicContext());
			if (!this.isCurrentGeneration(generation)) {
				yield* this.rollbackRegistrationPlan(plan, ctx);
				return nativeContextStatus(trigger);
			}
			const magicPi = magicPiAdapter(this.pi, plan, (data) => this.commandRuntime.captureStatus(data));
			yield* nativeEffect(() =>
				module.default(magicPi, (cause) => {
					if (!committed || !this.isCurrentGeneration(generation)) return;
					this.magicContextHandler = undefined;
					this.projectionRuntime.invalidate(true);
					this.setDegraded(cause, this.state.trigger);
					// The failed Worker closes itself. Recovery owns the single replacement transaction.
				}),
			);
			if (!this.isCurrentGeneration(generation)) {
				yield* this.rollbackRegistrationPlan(plan, ctx);
				return nativeContextStatus(trigger);
			}
			// Session startup is part of the activation transaction. Running it before
			// commit lets a partial upstream startup fail open without leaving Magic
			// registered as the active Context owner.
			yield* this.replaySessionStart(plan, sessionStart, ctx);
			if (!this.isCurrentGeneration(generation)) {
				yield* this.rollbackRegistrationPlan(plan, ctx);
				return nativeContextStatus(trigger);
			}
			if (plan.handlers.length === 0 && plan.tools.length === 0 && plan.commands.size === 0) {
				this.setNative(trigger);
				return this.status();
			}
			if (!plan.contextHandler) {
				yield* this.rollbackRegistrationPlan(plan, ctx);
				if (!this.isCurrentGeneration(generation)) return nativeContextStatus(trigger);
				this.deactivateToolHandoffs();
				this.setDegraded("Magic Context did not register its context adapter.", trigger);
				return this.status();
			}
			yield* Effect.try({
				try: () => this.commitRegistrationPlan(plan),
				catch: (error) => error,
			});
			committed = true;
			this.state = { state: "active", engine: "magic-context", trigger };
			return this.status();
		});
		return transaction.pipe(
			Effect.catch((error) =>
				this.rollbackRegistrationPlan(plan, ctx).pipe(
					Effect.map(() => {
						if (!this.isCurrentGeneration(generation)) return nativeContextStatus(trigger);
						this.magicContextHandler = undefined;
						this.deactivateToolHandoffs();
						this.setDegraded(error, trigger);
						return this.status();
					}),
				),
			),
		);
	}

	private replaySessionStart(
		plan: MagicRegistrationPlan,
		event: SessionStartEvent | undefined,
		ctx: ExtensionContext,
	): Effect.Effect<void, unknown> {
		if (!event) return Effect.void;
		return Effect.forEach(
			plan.handlers,
			(staged) =>
				staged.event === "session_start"
					? nativeEffect(() => staged.handler(event, quietMagicContext(ctx))).pipe(Effect.asVoid)
					: Effect.void,
			{ discard: true },
		);
	}

	handleCommittedFailure(cause: unknown, ctx: ExtensionContext): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.disposed) return Effect.void;
			const current = this.cleanup;
			if (current) return Deferred.await(current.deferred);
			const generation = ++this.generation;
			this.projectionRuntime.invalidate(true);
			this.commandRuntime.clearActive();
			this.magicCommands.clear();
			this.magicEventHandlers.clear();
			this.magicContextHandler = undefined;
			this.magicSessionStartHandlers = [];
			this.magicCompactionHandlers = [];
			this.magicTools.clear();
			const handlers = this.magicShutdownHandlers.splice(0);
			this.state = { state: "loading", engine: "magic-context", trigger: "startup" };
			const cleanup = { deferred: Deferred.makeUnsafe<void>() };
			this.cleanup = cleanup;
			return Effect.forEach(
				handlers,
				(handler) =>
					nativeEffect(() => handler({ type: "session_shutdown", reason: "reload" }, quietMagicContext(ctx))).pipe(
						Effect.ignore,
					),
				{ discard: true },
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						if (this.isCurrentGeneration(generation)) this.setDegraded(cause, "startup");
					}),
				),
				Effect.onExit((exit) => Deferred.done(cleanup.deferred, exit)),
				Effect.ensuring(
					Effect.sync(() => {
						if (this.cleanup === cleanup) this.cleanup = undefined;
					}),
				),
			);
		});
	}

	private isCurrentGeneration(generation: number): boolean {
		return !this.disposed && this.generation === generation;
	}

	private rollbackRegistrationPlan(plan: MagicRegistrationPlan, ctx: ExtensionContext): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (plan.shutdownComplete) return Effect.void;
			plan.shutdownComplete = true;
			const event: SessionShutdownEvent = this.shutdown?.event ?? { type: "session_shutdown", reason: "reload" };
			return Effect.forEach(
				plan.handlers,
				({ event: name, handler }) =>
					name === "session_shutdown"
						? nativeEffect(() => handler(event, quietMagicContext(this.shutdown?.ctx ?? ctx))).pipe(Effect.ignore)
						: Effect.void,
				{ discard: true },
			);
		});
	}

	private commitRegistrationPlan(plan: MagicRegistrationPlan): void {
		const activeBefore = this.pi.getActiveTools();
		this.magicContextHandler = plan.contextHandler;
		for (const [name, definition] of plan.commands) this.magicCommands.set(name, definition);
		for (const tool of plan.tools) {
			this.magicTools.set(tool.name, tool);
			registerSuiteOwnedTool(this.pi, tool, magicToolPresentation(tool.name));
		}
		for (const { event, handler } of plan.handlers) {
			if (event === "session_start") {
				this.magicSessionStartHandlers.push(handler);
				continue;
			}
			if (event === "session_shutdown") {
				this.magicShutdownHandlers.push(handler);
				continue;
			}
			if (event === "session_before_compact") {
				this.magicCompactionHandlers.push(handler);
				continue;
			}
			if (event === "context") continue;
			const handlers = this.magicEventHandlers.get(event) ?? [];
			handlers.push(handler);
			this.magicEventHandlers.set(event, handlers);
			if (!this.registeredMagicEvents.has(event)) {
				this.registeredMagicEvents.add(event);
				this.registerMagicHandler(event);
			}
		}
		this.pi.setActiveTools(
			activeBefore.filter((name) => !MAGIC_TOOL_NAME_SET.has(name) || this.magicTools.has(name)),
		);
	}

	projectMagicContext(event: ContextEvent, ctx: ExtensionContext): Effect.Effect<MagicContextEventResult | undefined> {
		const sessionVersion = this.sessionVersion;
		return Effect.gen({ self: this }, function* () {
			if (this.state.state === "native" || this.state.state === "dormant") return;
			let attempt = yield* this.projectionRuntime.projectMagicEvent(event, ctx);
			if (this.disposed || sessionVersion !== this.sessionVersion) return;
			if (!attempt?.full) {
				attempt = yield* this.recovery.run(
					this.restartMagic(ctx).pipe(
						Effect.andThen(Effect.suspend(() => this.projectionRuntime.projectMagicEvent(event, ctx))),
					),
				);
			}
			if (this.disposed || sessionVersion !== this.sessionVersion) return;
			if (!attempt?.full) return yield* Effect.fail(new Error(this.state.error ?? "Magic projection unavailable."));
			this.recovery.clear();
			return attempt.result;
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					if (this.disposed || sessionVersion !== this.sessionVersion) return;
					this.setDegraded(error, "automatic-turn");
					ctx.abort();
					ctx.ui.notify(
						`Context could not recover: ${this.state.error}. The Session and current input are preserved.`,
						"error",
					);
					return undefined;
				}),
			),
		);
	}

	private restartMagic(ctx: ExtensionContext): Effect.Effect<void, unknown> {
		return this.recovery.restart(
			this.handleCommittedFailure(new Error(this.state.error ?? "Magic Worker unavailable."), ctx).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						this.state = { state: "loading", engine: "magic-context" };
					}),
				),
				Effect.andThen(this.activate(ctx, "automatic-turn")),
				Effect.flatMap((state) =>
					state.state === "active"
						? Effect.void
						: Effect.fail(new Error(state.error ?? `Magic Worker restart remained ${state.state}.`)),
				),
			),
		);
	}

	compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Effect.Effect<MagicCompactionResult | undefined> {
		if (this.state.state === "native" || this.state.state === "dormant") return Effect.succeed(undefined);
		const sessionVersion = this.sessionVersion;
		const invoke = Effect.tryPromise({
			try: async (signal) => {
				const generation = this.generation;
				if (!this.magicContextHandler) throw new Error("Magic Worker is unavailable for compaction.");
				for (const handler of this.magicCompactionHandlers) {
					const result = await handler({ ...event, signal }, quietMagicContext(ctx));
					if (!this.isCurrentGeneration(generation) || sessionVersion !== this.sessionVersion || signal.aborted)
						throw new Error("Context compaction was cancelled.");
					// SAFETY: these handlers were registered only for Pi's session_before_compact event.
					const compacted = result as MagicCompactionResult | undefined;
					if (compacted?.compaction || compacted?.cancel) return compacted;
				}
				return { cancel: true };
			},
			catch: (error) => error,
		});
		const recover = invoke.pipe(
			Effect.catch((error) =>
				!this.disposed &&
				sessionVersion === this.sessionVersion &&
				!this.magicContextHandler &&
				!event.signal.aborted
					? this.restartMagic(ctx).pipe(Effect.andThen(invoke))
					: Effect.fail(error),
			),
		);
		return (event.reason === "overflow" ? this.recovery.run(recover, "compacting") : invoke).pipe(
			Effect.tap((result) =>
				Effect.sync(() => {
					if (result.compaction && sessionVersion === this.sessionVersion) this.recovery.clear();
				}),
			),
			Effect.catch((error) =>
				Effect.sync(() => {
					if (this.disposed || sessionVersion !== this.sessionVersion || event.signal?.aborted)
						return { cancel: true };
					this.setDegraded(error, this.state.trigger);
					if (!event.signal.aborted)
						ctx.ui.notify(
							`Context could not recover: ${this.state.error}. The Session and current input are preserved.`,
							"error",
						);
					return { cancel: true };
				}),
			),
			Effect.onExit(() =>
				Effect.sync(() => {
					if (event.signal?.aborted && sessionVersion === this.sessionVersion) this.recovery.clear();
				}),
			),
		);
	}

	currentProviderProjectionToken(): symbol | undefined {
		return this.projectionRuntime.currentProviderProjectionToken();
	}

	private registerMagicHandler(event: string): void {
		// SAFETY: names and handlers come from Magic's Pi extension registration.
		const register = this.pi.on.bind(this.pi) as (name: string, value: LooseEventHandler) => void;
		register(event, async (rawEvent, ctx) => {
			const generation = this.generation;
			let result: Awaited<ReturnType<LooseEventHandler>>;
			for (const handler of this.magicEventHandlers.get(event) ?? []) {
				try {
					const next =
						event === "before_agent_start"
							? await this.beforeAgentStart(handler, rawEvent, ctx)
							: await handler(rawEvent, quietMagicContext(ctx));
					if (!this.isCurrentGeneration(generation)) return;
					result = next ?? result;
				} catch (error) {
					// Optional lifecycle work does not own foreground cancellation or Worker restart.
					reportDiagnostic({
						capability: "Context",
						error,
						key: `magic-event:${event}`,
						severity: "warning",
						summary: `Magic Context ${event} failed`,
						visibility: "silent",
					});
				}
			}
			return result;
		});
	}

	private async beforeAgentStart(
		handler: LooseEventHandler,
		rawEvent: Parameters<LooseEventHandler>[0],
		ctx: ExtensionContext,
	) {
		this.magicPromptInstalledForSession = true;
		this.projectionRuntime.clearSuiteCustomContextGuidance();
		const withoutContributions = Check(COMPACT_PROMPT_EVENT_SCHEMA, rawEvent)
			? { ...rawEvent, systemPrompt: stripContextPromptContributions(this.pi, rawEvent.systemPrompt) }
			: rawEvent;
		const magicEvent = addCompactMagicContextPrompt(withoutContributions);
		const result = await handler(magicEvent, quietMagicContext(ctx));
		if (!Check(COMPACT_PROMPT_EVENT_SCHEMA, magicEvent)) return result;
		// SAFETY: this handler was registered by Magic for before_agent_start.
		const beforeAgentResult = result as BeforeAgentStartEventResult | undefined;
		const magicSystemPrompt = beforeAgentResult?.systemPrompt ?? magicEvent.systemPrompt;
		const contributed = await applyContextPromptContributions(
			this.pi,
			// SAFETY: before_agent_start preserves Host fields; only the checked systemPrompt is replaced.
			{ ...magicEvent, systemPrompt: magicSystemPrompt } as BeforeAgentStartEvent,
			ctx,
		);
		return contributed?.systemPrompt ? { ...beforeAgentResult, systemPrompt: contributed.systemPrompt } : result;
	}
}
