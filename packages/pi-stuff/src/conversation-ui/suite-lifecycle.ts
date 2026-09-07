import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Guard } from "typebox/guard";
import { readHostProxyProperty } from "../shared/host-proxy.ts";

type SessionManager = ExtensionContext["sessionManager"];

interface ReadinessGate {
	readonly deferred: Deferred.Deferred<boolean>;
	readonly sessionManager: SessionManager;
	resolve(ready: boolean): void;
}

interface ReadinessState {
	activation: symbol | undefined;
	api: ExtensionAPI | undefined;
	current: ReadinessGate | undefined;
	installed: boolean;
}

const READINESS_STATES = new WeakMap<object, ReadinessState>();

function stateFor(pi: Pick<ExtensionAPI, "events">): ReadinessState {
	let state = READINESS_STATES.get(pi.events);
	if (!state) {
		state = { activation: undefined, api: undefined, current: undefined, installed: false };
		READINESS_STATES.set(pi.events, state);
	}
	return state;
}

function createGate(sessionManager: SessionManager): ReadinessGate {
	const deferred = Deferred.makeUnsafe<boolean>();
	return {
		deferred,
		resolve: (ready) => Deferred.doneUnsafe(deferred, Effect.succeed(ready)),
		sessionManager,
	};
}

function createReadinessApi(pi: ExtensionAPI): ExtensionAPI {
	type ReadinessHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;
	// SAFETY: Pi's `on` overloads erase to one `(event, handler)` runtime method; this adapter forwards
	// non-session handlers unchanged and invokes only `session_start` through ReadinessHandler.
	const register = pi.on.bind(pi) as (event: string, handler: ReadinessHandler) => void;
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on") {
				return (event: string, handler: ReadinessHandler): void => {
					if (event !== "session_start") {
						register(event, handler);
						return;
					}
					register(event, async (sessionEvent, ctx) => {
						try {
							await handler(sessionEvent, ctx);
						} catch (error) {
							rejectSuiteSessionReadiness(pi, ctx);
							throw error;
						}
					});
				};
			}
			const value = readHostProxyProperty(target, property);
			return Guard.IsFunction(value) ? value.bind(target) : value;
		},
	});
}

/**
 * Register the first Suite session observer and return the API used by every
 * Capability. Its session_start wrapper records any earlier handler failure so
 * the final readiness marker cannot release Goal startup into a partial Suite.
 */
export function installSuiteSessionReadiness(pi: ExtensionAPI): ExtensionAPI {
	const state = stateFor(pi);
	state.api ??= createReadinessApi(pi);
	if (state.installed) return state.api;
	const activation = Symbol("suite-session-readiness");
	state.activation = activation;
	state.installed = true;
	pi.on("session_start", (_event, ctx) => {
		if (state.activation !== activation) return;
		state.current?.resolve(false);
		state.current = createGate(ctx.sessionManager);
	});
	pi.on("session_shutdown", () => {
		if (state.activation !== activation) return;
		state.current?.resolve(false);
		state.current = undefined;
	});
	return state.api;
}

/** Resolve only after every Suite Capability's session_start handler has settled. */
export function markSuiteSessionReady(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): void {
	const state = READINESS_STATES.get(pi.events);
	if (!state?.installed || state.current?.sessionManager !== ctx.sessionManager) return;
	state.current.resolve(true);
}

/** Reject startup work when the aggregate Suite cannot prove a safe session. */
export function rejectSuiteSessionReadiness(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): void {
	const state = READINESS_STATES.get(pi.events);
	if (!state?.installed || state.current?.sessionManager !== ctx.sessionManager) return;
	state.current.resolve(false);
}

/** Standalone Capability loading has no Suite barrier and is ready immediately. */
export function whenSuiteSessionReady(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): Effect.Effect<boolean> {
	const state = READINESS_STATES.get(pi.events);
	if (!state?.installed) return Effect.succeed(true);
	if (state.current?.sessionManager !== ctx.sessionManager) return Effect.succeed(false);
	return Deferred.await(state.current.deferred);
}
