import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HOST_SHUTDOWN_GRACE_MS } from "../../lifecycle-deadline.ts";
import { readHostProxyProperty } from "../../shared/host-proxy.ts";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeObject } from "../../shared/runtime-type.ts";
import { logger } from "./logger.ts";
import { formatTerminalError } from "./utils.ts";

export interface McpRuntimeOwner {
	readonly signal: AbortSignal;
	readonly scope: Scope.Closeable;
	isActive(): boolean;
	addCleanup(cleanup: () => void | Promise<void>): Effect.Effect<void>;
	addFinalizer(finalizer: Effect.Effect<unknown>): Effect.Effect<void>;
	stop(reason?: string): Effect.Effect<void>;
	throwIfInactive(): void;
}

export function createMcpRuntimeOwner(shutdownGraceMs = HOST_SHUTDOWN_GRACE_MS): McpRuntimeOwner {
	const controller = new AbortController();
	const scope = Scope.makeUnsafe("sequential");

	const reportCleanupFailure = <ErrorValue>(error: ErrorValue, late: boolean) => {
		logger.error(
			`MCP: ${late ? "late " : ""}runtime cleanup failed`,
			error instanceof Error ? error : new Error(formatTerminalError(error)),
		);
	};

	return {
		signal: controller.signal,
		scope,
		isActive: () => !controller.signal.aborted,
		addFinalizer: (finalizer) => Scope.addFinalizer(scope, finalizer),
		addCleanup: (cleanup) => {
			const late = controller.signal.aborted;
			const finalizer = Effect.tryPromise({
				try: () => Promise.resolve(cleanup()),
				catch: (error) => (error instanceof Error ? error : new Error(formatTerminalError(error))),
			}).pipe(
				Effect.catch((error) => (late ? Effect.sync(() => reportCleanupFailure(error, true)) : Effect.die(error))),
			);
			return Scope.addFinalizer(scope, finalizer);
		},
		stop: (reason = "MCP extension runtime stopped") =>
			Effect.suspend(() => {
				if (!controller.signal.aborted) controller.abort(new Error(reason));
				const finalizers = Scope.closeUnsafe(scope, Exit.interrupt());
				if (!finalizers) return Effect.void;
				return Effect.exit(finalizers).pipe(
					Effect.tap((exit) => {
						if (Exit.isSuccess(exit)) return Effect.void;
						return Effect.sync(() => reportCleanupFailure(Cause.squash(exit.cause), false));
					}),
					Effect.timeoutOption(Math.max(0, shutdownGraceMs)),
					Effect.asVoid,
				);
			}),
		throwIfInactive: () => controller.signal.throwIfAborted(),
	};
}

export function combineAbortSignals(signal: AbortSignal, ...signals: Array<AbortSignal | undefined>): AbortSignal;
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined;
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	return AbortSignal.any(active);
}

/** Fence session-bound UI calls after the owning extension runtime stops. */
export function createOwnedUi(ui: ExtensionUIContext, owner: McpRuntimeOwner): ExtensionUIContext {
	const proxies = new WeakMap<object, object>();
	const wrap = <Value extends object>(value: Value): Value => {
		const existing = proxies.get(value);
		if (existing) {
			// SAFETY: this cache stores only transparent proxies created for the exact same source object.
			return existing as Value;
		}

		const proxy = new Proxy(value, {
			get(target, property) {
				if (!owner.isActive()) return undefined;
				const member = readHostProxyProperty(target, property);
				if (isRuntimeFunction(member)) {
					return (...args: JsonInputValue[]) => {
						if (!owner.isActive()) return undefined;
						return member.apply(target, args);
					};
				}
				if (member !== null && isRuntimeObject(member)) {
					return owner.isActive() ? wrap(member) : undefined;
				}
				return owner.isActive() ? member : undefined;
			},
		});
		proxies.set(value, proxy);
		return proxy;
	};
	return wrap(ui);
}

export function isAbortError<ErrorValue>(error: ErrorValue, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && (error.name === "AbortError" || error.message === "MCP extension runtime stopped");
}
