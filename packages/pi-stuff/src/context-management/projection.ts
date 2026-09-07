import type { ContextEvent, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { isRuntimeSymbol } from "../shared/runtime-type.ts";
import { addCompactMagicContextMessage } from "./magic-runtime.ts";
import {
	type AgentMessage,
	type ContextProjection,
	type ContextProjectionAudience,
	type ContextProjectionOptions,
	currentAgentMessages,
	estimateProjectionTokens,
	extractMagicProjection,
	formatProjection,
	nativeProjection,
	projectionKey,
	projectMemoryOnly,
} from "./projection-format.ts";

export type { ContextProjection, ContextProjectionAudience, ContextProjectionOptions };
export { estimateProjectionTokens, extractMagicProjection, formatProjection, nativeProjection };

export interface MagicContextEventResult {
	readonly messages?: AgentMessage[];
}

export interface MagicProjectionAttempt {
	readonly full: string | undefined;
	readonly result: MagicContextEventResult | undefined;
}

export type MagicContextHandler = (
	event: ContextEvent,
	ctx: ExtensionContext,
) => MagicContextEventResult | undefined | Promise<MagicContextEventResult | undefined>;

interface ProjectionHostSnapshot {
	readonly active: boolean;
	readonly generation: number;
	readonly handler: MagicContextHandler | undefined;
}

type ContextProjectionTrigger = "automatic-turn" | "projection";

interface ContextProjectionRuntimeHost {
	readonly activate: (ctx: ExtensionContext) => Effect.Effect<void>;
	readonly current: () => ProjectionHostSnapshot;
	readonly fail: (error: Error, trigger: ContextProjectionTrigger) => void;
	readonly quietContext: (ctx: ExtensionContext) => ExtensionContext;
	readonly succeed: (trigger: ContextProjectionTrigger) => void;
}

interface ProjectionFlight {
	readonly generation: number;
	readonly deferred: Deferred.Deferred<string | undefined>;
}

export class ContextProjectionRuntime {
	private generation = 0;
	private readonly flights = new Map<string, ProjectionFlight>();
	private readonly host: ContextProjectionRuntimeHost;
	private interactivePaintPending = false;
	/** Last valid project-memory snapshot, captured only by the normal Magic context event. */
	private readonly memories = new Map<string, string>();
	private readonly projections = new Map<string, string>();
	private providerProjectionToken: symbol | undefined;
	private readonly suiteCustomContextGuidance = new Set<symbol>();

	constructor(host: ContextProjectionRuntimeHost) {
		this.host = host;
	}

	invalidate(clearMemories: boolean): number {
		this.generation++;
		for (const { deferred } of this.flights.values()) {
			Deferred.doneUnsafe(deferred, Effect.succeed(undefined));
		}
		this.flights.clear();
		this.projections.clear();
		this.invalidateProviderProjection();
		if (clearMemories) {
			this.interactivePaintPending = false;
			this.memories.clear();
			this.suiteCustomContextGuidance.clear();
		}
		return this.generation;
	}

	stageSuiteCustomContextGuidance(): symbol {
		const token = Symbol("suite-custom-context-guidance");
		this.suiteCustomContextGuidance.add(token);
		return token;
	}

	cancelSuiteCustomContextGuidance(token: symbol): void {
		this.suiteCustomContextGuidance.delete(token);
	}

	clearSuiteCustomContextGuidance(): void {
		this.suiteCustomContextGuidance.clear();
	}

	private consumeSuiteCustomContextGuidance(): boolean {
		const token = this.suiteCustomContextGuidance.values().next().value;
		if (!isRuntimeSymbol(token)) return false;
		this.suiteCustomContextGuidance.delete(token);
		return true;
	}

	noteInput(source: InputEvent["source"]): void {
		// Every submitted prompt starts a new branch snapshot. The automatic Context
		// event will repopulate this cache before tools run; retaining the previous
		// turn's projection could otherwise omit the user's newest decision.
		this.invalidate(false);
		this.interactivePaintPending = source === "interactive";
	}

	yieldForInteractivePaint(): Effect.Effect<boolean> | undefined {
		if (!this.interactivePaintPending) return;
		this.interactivePaintPending = false;
		const generation = this.host.current().generation;
		return Effect.callback((resume) => {
			const pending = setImmediate(() => resume(Effect.succeed(this.host.current().generation === generation)));
			return Effect.sync(() => clearImmediate(pending));
		});
	}

	private capture(ctx: ExtensionContext, full: string): void {
		const key = projectionKey(ctx);
		this.projections.set(key, full);
		const memory = projectMemoryOnly(full);
		if (memory) this.memories.set(key, memory);
		else this.memories.delete(key);
	}

	private remove(ctx: ExtensionContext): void {
		const key = projectionKey(ctx);
		this.projections.delete(key);
		this.memories.delete(key);
	}

	private invalidateProviderProjection(): void {
		this.providerProjectionToken = undefined;
	}

	currentProviderProjectionToken(): symbol | undefined {
		return this.providerProjectionToken;
	}

	projectMagicEvent(event: ContextEvent, ctx: ExtensionContext): Effect.Effect<MagicProjectionAttempt | undefined> {
		const { generation, handler } = this.host.current();
		if (!handler) {
			this.invalidateProviderProjection();
			return Effect.succeed(undefined);
		}
		this.invalidateProviderProjection();
		return this.runProjection(event, ctx, handler, generation, this.invalidate(false), "automatic-turn").pipe(
			Effect.map((attempt) => {
				if (!attempt.full) {
					return attempt;
				}
				const result =
					attempt.result && this.consumeSuiteCustomContextGuidance()
						? {
								...attempt.result,
								messages: addCompactMagicContextMessage(attempt.result.messages ?? event.messages),
							}
						: attempt.result;
				this.providerProjectionToken = result ? Symbol("provider-projection") : undefined;
				return { ...attempt, result };
			}),
		);
	}

	projectCurrent(
		audience: ContextProjectionAudience,
		ctx: ExtensionContext,
		options?: ContextProjectionOptions,
	): Effect.Effect<ContextProjection> {
		// Magic's handler is stateful, so caller-owned snapshots never invoke it.
		// BTW may reuse only project memory captured by the normal Context event;
		// forked Agents use a bounded native envelope from the frozen snapshot.
		if (options?.sourceMessages !== undefined) {
			if (audience === "btw" && this.host.current().active) {
				const memory = this.memories.get(projectionKey(ctx));
				if (memory) {
					return Effect.succeed({ source: "magic-context", ...formatProjection(memory, audience, options) });
				}
			}
			return Effect.succeed(nativeProjection(audience, ctx, options));
		}
		return this.host.activate(ctx).pipe(
			Effect.flatMap(() =>
				Effect.suspend(() => {
					const key = projectionKey(ctx);
					const cached = this.projections.get(key);
					const { generation, handler } = this.host.current();
					const projectionGeneration = this.generation;
					if (cached || !handler || this.host.current().generation !== generation) {
						return Effect.succeed(cached);
					}
					const current = this.flights.get(key);
					if (current?.generation === projectionGeneration) return Deferred.await(current.deferred);
					const flight: ProjectionFlight = {
						deferred: Deferred.makeUnsafe<string | undefined>(),
						generation: projectionGeneration,
					};
					this.flights.set(key, flight);
					return this.createProjection(ctx, handler, generation, projectionGeneration).pipe(
						Effect.onExit((exit) => Deferred.done(flight.deferred, exit)),
						Effect.ensuring(
							Effect.sync(() => {
								if (this.flights.get(key) === flight) this.flights.delete(key);
							}),
						),
					);
				}),
			),
			Effect.map((full) => full ?? this.projections.get(projectionKey(ctx))),
			Effect.map((full) => {
				if (full) return { source: "magic-context", ...formatProjection(full, audience, options) };
				if (this.host.current().active)
					throw new Error("Magic Context projection is unavailable; raw history was not substituted.");
				return nativeProjection(audience, ctx, options);
			}),
		);
	}

	private createProjection(
		ctx: ExtensionContext,
		handler: MagicContextHandler,
		generation: number,
		projectionGeneration: number,
	): Effect.Effect<string | undefined> {
		const event: ContextEvent = { type: "context", messages: currentAgentMessages(ctx) };
		return this.runProjection(event, ctx, handler, generation, projectionGeneration, "projection").pipe(
			Effect.map((attempt) => attempt.full),
		);
	}

	private runProjection(
		event: ContextEvent,
		ctx: ExtensionContext,
		handler: MagicContextHandler,
		generation: number,
		projectionGeneration: number,
		trigger: ContextProjectionTrigger,
	): Effect.Effect<MagicProjectionAttempt> {
		return Effect.tryPromise({
			try: async () => handler(event, this.host.quietContext(ctx)),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		}).pipe(
			Effect.flatMap((result) =>
				Effect.try({
					try: () => {
						if (!this.isCurrentProjection(generation, projectionGeneration)) {
							return { full: undefined, result: undefined };
						}
						const full = extractMagicProjection(result?.messages ?? event.messages);
						if (!full) throw new Error("Magic Context produced no valid history projection.");
						this.capture(ctx, full);
						this.host.succeed(trigger);
						return { full, result };
					},
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				}),
			),
			Effect.catch((error) => {
				if (!this.isCurrentProjection(generation, projectionGeneration)) {
					return Effect.succeed({ full: undefined, result: undefined });
				}
				if (trigger === "automatic-turn") this.remove(ctx);
				this.host.fail(error, trigger);
				return Effect.succeed({ full: undefined, result: undefined });
			}),
		);
	}

	private isCurrentProjection(generation: number, projectionGeneration: number): boolean {
		return this.host.current().generation === generation && this.generation === projectionGeneration;
	}
}
