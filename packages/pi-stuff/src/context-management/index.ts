import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	getContextStatusChannel,
	getHostSharedResource,
	hasDirectUserActivation,
	registerSuiteAgentMessagePreparation,
	reportDiagnostic,
} from "../conversation-ui/index.ts";
import { deferToHostTurn } from "../lifecycle-deadline.ts";
import { type EffectFoundation, installEffectFoundation } from "../shared/effect-foundation.ts";
import { type MagicContextPreparation, type MagicContextPreparationOptions, prepareMagicContext } from "./config.ts";
import type { MagicModule, NativeCompactionSettings } from "./magic-runtime.ts";
import { loadMagicContextWorker } from "./magic-worker-client.ts";
import type { ContextProjection, ContextProjectionAudience, ContextProjectionOptions } from "./projection.ts";
import { estimateProjectionTokens, extractMagicProjection, formatProjection, nativeProjection } from "./projection.ts";
import { applyContextPromptContributions } from "./prompt-contributions.ts";
import { registerContextProviderBoundary } from "./provider-boundary.ts";
import { type ContextCapability, type ContextCapabilityRegistry, ContextCapabilityRuntime } from "./runtime.ts";
import type { ContextCapabilityState } from "./status.ts";

export type { NativeCompactionSettings } from "./magic-runtime.ts";
export type {
	ContextProjection,
	ContextProjectionAudience,
	ContextProjectionOptions,
} from "./projection.ts";
export type { ContextCapability } from "./runtime.ts";
export type { ContextActivationTrigger, ContextCapabilityState, ContextStatusSnapshot } from "./status.ts";

const CONTEXT_CAPABILITY_REGISTRY = Symbol.for("@jczhang02/pi-stuff-context/runtime/v2");
const CONTEXT_CAPABILITY_DISCOVERY_EVENT = "@jczhang02/pi-stuff-context/runtime-discovery/v1";

const MAGIC_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";

export interface ContextCapabilityDependencies {
	readonly loadMagicContext?: () => Promise<MagicModule>;
	readonly magicSubagent?: () => boolean;
	readonly prepareMagicContext?: (
		ctx: ExtensionContext,
		options: MagicContextPreparationOptions,
	) => Promise<MagicContextPreparation | undefined>;
	readonly readNativeCompactionSettings?: (ctx: ExtensionContext) => NativeCompactionSettings | undefined;
}

function capabilityRegistry(): ContextCapabilityRegistry {
	// SAFETY: this package-owned symbol slot is initialized only with ContextCapabilityRegistry.
	const root = globalThis as {
		[key: symbol]: ContextCapabilityRegistry | undefined;
	};
	root[CONTEXT_CAPABILITY_REGISTRY] ??= {
		capabilities: new WeakMap(),
		contexts: new WeakMap(),
		owners: new WeakMap(),
		runtimes: new Set(),
	};
	return root[CONTEXT_CAPABILITY_REGISTRY];
}

function nativeCapability(): ContextCapability {
	return {
		status: () => ({ state: "native", engine: "native" }),
		activate: async () => ({ state: "native", engine: "native" }),
		projectCurrentContext: async (audience, ctx, options) => nativeProjection(audience, ctx, options),
	};
}

function readNativeCompactionSettings(ctx: ExtensionContext): NativeCompactionSettings {
	return SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	}).getCompactionSettings();
}

export function getContextCapability(ctx: ExtensionContext): ContextCapability {
	const registry = capabilityRegistry();
	const runtime = registry.contexts.get(ctx.sessionManager);
	return (runtime && registry.capabilities.get(runtime)) ?? nativeCapability();
}

export async function projectCurrentContext(
	audience: ContextProjectionAudience,
	ctx: ExtensionContext,
	options?: ContextProjectionOptions,
): Promise<ContextProjection> {
	const registry = capabilityRegistry();
	const runtime = registry.contexts.get(ctx.sessionManager);
	const capability = runtime ? registry.capabilities.get(runtime) : undefined;
	return (capability ?? nativeCapability()).projectCurrentContext(audience, ctx, options);
}

async function runContextOwned(
	foundation: EffectFoundation,
	ctx: Pick<ExtensionContext, "sessionManager">,
	program: Effect.Effect<void>,
): Promise<void> {
	const session = foundation.sessionFor(ctx.sessionManager);
	if (!session || !foundation.isCurrent(session)) return;
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program);
	await foundation.close(operation, exit);
	if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
		reportDiagnostic({
			capability: "Context",
			error: Cause.squash(exit.cause),
			key: "owned-effect",
			severity: "error",
			summary: "A Session-owned Context operation failed",
			visibility: "silent",
		});
	}
}

function requiresInputActivation(state: ContextCapabilityState): boolean {
	return state !== "active" && state !== "native";
}

function deferInputActivation(
	runtime: ContextCapabilityRuntime,
	foundation: EffectFoundation,
	ctx: ExtensionContext,
): void {
	deferToHostTurn(() => {
		if (!runtime.consumeDirectInputActivation()) return;
		if (requiresInputActivation(runtime.status().state)) {
			void runContextOwned(foundation, ctx, runtime.activate(ctx, "input"));
		}
	});
}

function registerContextProjection(pi: ExtensionAPI, runtime: ContextCapabilityRuntime): void {
	pi.on("context", (event, ctx) => {
		const interactivePaint = runtime.yieldForInteractivePaint();
		return Effect.runPromise(
			interactivePaint
				? interactivePaint.pipe(
						Effect.flatMap((current) =>
							current ? runtime.projectMagicContext(event, ctx) : Effect.succeed(undefined),
						),
					)
				: runtime.projectMagicContext(event, ctx),
		);
	});
}

export default async function piStuffContext(
	pi: ExtensionAPI,
	dependencies: ContextCapabilityDependencies = {},
): Promise<void> {
	const registry = capabilityRegistry();
	const foundation = installEffectFoundation(pi, { deferShutdown: true });
	const magicSubagent = dependencies.magicSubagent ?? (() => process.env[MAGIC_SUBAGENT_ENV] === "1");
	let created = false;
	let runtime: ContextCapabilityRuntime;
	const boundary = {
		activate: (ctx: ExtensionContext, trigger: Parameters<ContextCapability["activate"]>[1]) =>
			Effect.runPromise(runtime.activate(ctx, trigger)),
	};
	runtime = getHostSharedResource(
		pi.events,
		registry.owners,
		CONTEXT_CAPABILITY_DISCOVERY_EVENT,
		() => {
			created = true;
			return new ContextCapabilityRuntime(
				pi,
				{
					loadMagicContext: dependencies.loadMagicContext ?? loadMagicContextWorker,
					magicSubagent,
					readNativeCompactionSettings: dependencies.readNativeCompactionSettings ?? readNativeCompactionSettings,
					prepareMagicContext:
						dependencies.prepareMagicContext ??
						(dependencies.loadMagicContext ? async () => undefined : prepareMagicContext),
				},
				registry,
				boundary,
			);
		},
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
	if (!created) return;
	registry.runtimes.add(runtime);
	registry.capabilities.set(runtime, {
		status: () => runtime.status(),
		activate: boundary.activate,
		projectCurrentContext: (audience, ctx, options) =>
			Effect.runPromise(runtime.projectCurrentContext(audience, ctx, options)),
	});
	const unregisterSuiteAgentMessagePreparation = registerSuiteAgentMessagePreparation(pi, {
		prepare: (origin, options) => Effect.runPromise(runtime.prepareSuiteAgentMessage(origin, options)),
		stage: (options) => {
			const token = runtime.stageSuiteCustomContextGuidance(options);
			return token ? () => runtime.cancelSuiteCustomContextGuidance(token) : undefined;
		},
	});
	pi.on("session_shutdown", (event, ctx) => {
		status.clear();
		unregisterSuiteAgentMessagePreparation();
		return Effect.runPromise(runtime.dispose(event, ctx));
	});
	const status = getContextStatusChannel(pi);
	registerContextProviderBoundary(pi, runtime, status);
	runtime.registerToolHandoffs();

	pi.on("session_start", (event, ctx) => {
		status.clear();
		return Effect.runPromise(runtime.startSession(event, ctx));
	});
	registerContextProjection(pi, runtime);
	pi.on("session_compact", () => {
		status.clear();
		runtime.invalidateProjection();
	});
	pi.on("session_tree", () => {
		status.clear();
		runtime.invalidateProjection();
	});
	pi.on("input", (event, ctx) => {
		const state = runtime.noteInput(event.source);
		// A later Extension may still handle an Extension-authored input, in which
		// case Pi never starts an Agent turn. Defer that path to the authoritative
		// before_agent_start boundary so a display-only or rejected continuation
		// cannot initialize or write Magic Context state. Direct user input starts
		// activation without delaying the Host's input acknowledgement.
		if (event.source !== "extension" && requiresInputActivation(state)) {
			deferInputActivation(runtime, foundation, ctx);
		}
	});
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "custom") return;
		try {
			// Pi also emits message_start for idle, non-triggering display entries.
			if (ctx.isIdle()) return;
		} catch {
			// A real Pi Host supplies this boundary. A partial third-party wrapper
			// fails toward preserving context for accepted custom Agent work.
		}
		await boundary.activate(ctx, hasDirectUserActivation(event.message) ? "input" : "automatic-turn");
	});
	// Pi checks compaction after input interception but before before_agent_start.
	// This lightweight gate joins the activation already started by input, so an
	// immediate first submission can paint without allowing native compaction to
	// race ahead of Magic Context.
	pi.on("session_before_compact", async (event, ctx) => {
		const trigger = runtime.consumeDirectInputActivation() ? "input" : "automatic-turn";
		try {
			// Cancelling the wait does not cancel Session-owned initialization or a healthy Worker.
			return await Effect.runPromise(
				Effect.tryPromise(() => boundary.activate(ctx, trigger)).pipe(
					Effect.andThen(Effect.suspend(() => runtime.compact(event, ctx))),
				),
				{ signal: event.signal },
			);
		} catch {
			return { cancel: true };
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const trigger = runtime.consumeDirectInputActivation() ? "input" : "automatic-turn";
		await Effect.runPromise(runtime.activate(ctx, trigger));
		return applyContextPromptContributions(pi, event, ctx);
	});
}

export { registerContextPromptContributor } from "./prompt-contributions.ts";

export const __test = {
	async clear(): Promise<void> {
		const registry = capabilityRegistry();
		await Promise.all(Array.from(registry.runtimes, (runtime) => Effect.runPromise(runtime.dispose())));
		// SAFETY: this package-owned symbol slot contains only ContextCapabilityRegistry.
		const root = globalThis as { [key: symbol]: ContextCapabilityRegistry | undefined };
		delete root[CONTEXT_CAPABILITY_REGISTRY];
	},
	extractMagicProjection,
	estimateProjectionTokens,
	formatProjection,
	requiresInputActivation,
};
