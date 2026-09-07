import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { isRuntimeNumber } from "../../shared/runtime-type.ts";
import { logger } from "./logger.ts";
import { hasPendingAuth } from "./mcp-auth-flow.ts";
import type { McpServerManager } from "./server-manager.ts";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import { formatTerminalError, sanitizeTerminalText } from "./utils.ts";

export type ReconnectCallback = (serverName: string) => void;
export type ReconnectFailureCallback = <ErrorValue>(serverName: string, error: ErrorValue) => void;

export class McpLifecycleManager {
	private readonly manager: McpServerManager;
	private readonly hasPendingAuthForServer: typeof hasPendingAuth;
	private keepAliveServers = new Map<string, ServerDefinition>();
	private allServers = new Map<string, ServerDefinition>();
	private serverSettings = new Map<string, { idleTimeout?: number }>();
	private globalIdleTimeout = 10 * 60 * 1000;
	private onReconnect: ReconnectCallback | undefined;
	private onReconnectFailure: ReconnectFailureCallback | undefined;
	private onIdleShutdown: ((serverName: string) => void) | undefined;
	private stopped = false;

	constructor(manager: McpServerManager, hasPendingAuthForServer = hasPendingAuth) {
		this.manager = manager;
		this.hasPendingAuthForServer = hasPendingAuthForServer;
	}

	setReconnectCallback(callback: ReconnectCallback): void {
		this.onReconnect = callback;
	}

	setReconnectFailureCallback(callback: ReconnectFailureCallback): void {
		this.onReconnectFailure = callback;
	}

	markKeepAlive(name: string, definition: ServerDefinition): void {
		if (isServerDisabled(definition)) return;
		this.keepAliveServers.set(name, definition);
	}

	registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
		if (isServerDisabled(definition)) return;
		this.allServers.set(name, definition);
		if (settings?.idleTimeout !== undefined) this.serverSettings.set(name, settings);
	}

	setGlobalIdleTimeout(minutes: number): void {
		this.globalIdleTimeout = minutes * 60 * 1000;
	}

	setIdleShutdownCallback(callback: (serverName: string) => void): void {
		this.onIdleShutdown = callback;
	}

	startHealthChecks(
		signalOrInterval?: AbortSignal | number,
		maybeIntervalMs = 30000,
	): Effect.Effect<void, never, Scope.Scope> {
		const signal = isRuntimeNumber(signalOrInterval) ? undefined : signalOrInterval;
		const intervalMs = isRuntimeNumber(signalOrInterval) ? signalOrInterval : maybeIntervalMs;
		this.stopped = false;
		if (signal?.aborted) {
			this.stopped = true;
			return Effect.void;
		}
		const iteration = Effect.sleep(Math.max(0, intervalMs)).pipe(
			Effect.andThen(this.checkConnections(signal)),
			Effect.catch((error) =>
				Effect.sync(() => {
					logger.error(
						"MCP: Health check failed",
						error instanceof Error ? error : new Error(formatTerminalError(error)),
					);
				}),
			),
		);
		let loop: Effect.Effect<void, never> = Effect.forever(iteration);
		if (signal) {
			const aborted = Effect.callback<void>((resume) => {
				const stop = () => {
					this.stopped = true;
					resume(Effect.void);
				};
				if (signal.aborted) {
					stop();
					return;
				}
				signal.addEventListener("abort", stop, { once: true });
				return Effect.sync(() => signal.removeEventListener("abort", stop));
			});
			loop = Effect.raceFirst(loop, aborted);
		}
		return Effect.forkScoped(loop).pipe(Effect.asVoid);
	}

	private checkConnections(signal?: AbortSignal): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			if (this.stopped || signal?.aborted) return;
			for (const [name, definition] of this.keepAliveServers) {
				if (isServerDisabled(definition)) continue;
				const connection = this.manager.getConnection(name);
				if (connection?.status === "connected") continue;
				if (this.hasPendingAuthForServer(name)) {
					logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
					continue;
				}
				const outcome = yield* this.manager.connectEffect(name, definition, signal).pipe(
					Effect.map(() => ({ ok: true as const })),
					Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
				);
				if (this.stopped || signal?.aborted) return;
				if (outcome.ok) {
					logger.debug(`Reconnected to ${name}`);
					this.onReconnect?.(name);
					continue;
				}
				this.onReconnectFailure?.(name, outcome.error);
				const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
				logger.error(
					`MCP: Failed to reconnect to ${name}`,
					outcome.error instanceof Error ? outcome.error : new Error(sanitizeTerminalText(message)),
					{ server: name },
				);
			}

			for (const [name] of this.allServers) {
				if (this.keepAliveServers.has(name)) continue;
				const timeout = this.getIdleTimeout(name);
				if (timeout > 0 && this.manager.isIdle(name, timeout)) {
					yield* this.manager.closeEffect(name);
					if (this.stopped || signal?.aborted) return;
					this.onIdleShutdown?.(name);
				}
			}
		});
	}

	private getIdleTimeout(name: string): number {
		const perServer = this.serverSettings.get(name)?.idleTimeout;
		if (perServer !== undefined) return perServer * 60 * 1000;
		return this.globalIdleTimeout;
	}

	gracefulShutdown(): Effect.Effect<void, Error> {
		return Effect.suspend(() => {
			this.stopped = true;
			this.onReconnect = undefined;
			this.onReconnectFailure = undefined;
			this.onIdleShutdown = undefined;
			return this.manager.closeAllEffect();
		});
	}
}
