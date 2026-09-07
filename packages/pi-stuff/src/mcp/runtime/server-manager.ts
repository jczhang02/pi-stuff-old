import type { Client, ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { logger } from "./logger.ts";
import type { AuthStorageOptions } from "./mcp-auth.ts";
import { supportsOAuth } from "./mcp-auth-config.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { mcpNativePromise } from "./mcp-effect-runner.ts";
import { probeMcpEndpoint } from "./mcp-probe.ts";
import {
	createMcpTraceWriter,
	isMcpTraceEnabled,
	type McpTraceObserver,
	type McpTraceWriter,
	traceTransportKind,
	wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";
import {
	discoverMcpMetadata,
	metadataLimitMessage,
	normalizeMcpResource,
	normalizeMcpTool,
} from "./metadata-discovery.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { combineAbortSignals, type McpRuntimeOwner } from "./runtime-owner.ts";
import {
	isServerDisabled,
	type McpResource,
	type McpTool,
	type McpTraceSettings,
	type ServerDefinition,
	type Transport,
} from "./types.ts";
import {
	appendStderrTail,
	resolveCommandSecretsRecord,
	resolveConfigPath,
	resolveServerUrl,
	withStderrTail,
} from "./utils.ts";

export interface ServerConnection {
	client: Client;
	transport: Transport;
	terminateSession?: () => Promise<void>;
	definition: ServerDefinition;
	tools: McpTool[];
	resources: McpResource[];
	instructions?: string;
	lastUsedAt: number;
	inFlight: number;
	status: "connected" | "closed" | "needs-auth";
}

type MetadataListChangedListener = (serverName: string, reason: string) => void;

interface ManagedConnection {
	readonly connection: ServerConnection;
	readonly scope: Scope.Closeable;
}

function interruptFiberFailures<Value>(fibers: Array<Fiber.Fiber<Value, Error>>): Effect.Effect<unknown[]> {
	return Effect.gen(function* () {
		yield* Fiber.interruptAll(fibers);
		const exits = yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber));
		return exits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
	});
}

export class McpServerManager {
	private readonly defaultCwd: string | undefined;
	private readonly ownerScope: Scope.Closeable;
	private readonly connectFibers: FiberMap.FiberMap<string, ServerConnection, Error>;
	private readonly reconnectFibers: FiberMap.FiberMap<string, ServerConnection, Error>;
	private readonly closeFibers: FiberMap.FiberMap<string, void, Error>;
	private readonly fiberGate = Semaphore.makeUnsafe(1);
	private connections = new Map<string, ManagedConnection>();
	private metadataListChangedListener: MetadataListChangedListener | undefined;
	private authStorageOptions: AuthStorageOptions = {};
	private oauthRuntime: McpOAuthRuntime | undefined;
	private defaultRequestTimeoutMs: number | undefined;
	private runtimeSignal: AbortSignal | undefined;
	private closeGenerations = new Map<string, number>();
	private traceSettings: McpTraceSettings | undefined;
	private traceWriter: McpTraceWriter | undefined;
	private stopped = false;

	/** Default cwd for stdio servers without an explicit config `cwd`. */
	private constructor(
		ownerScope: Scope.Closeable,
		connectFibers: FiberMap.FiberMap<string, ServerConnection, Error>,
		reconnectFibers: FiberMap.FiberMap<string, ServerConnection, Error>,
		closeFibers: FiberMap.FiberMap<string, void, Error>,
		defaultCwd?: string,
	) {
		this.ownerScope = ownerScope;
		this.connectFibers = connectFibers;
		this.reconnectFibers = reconnectFibers;
		this.closeFibers = closeFibers;
		this.defaultCwd = defaultCwd;
	}

	static make(owner: McpRuntimeOwner, defaultCwd?: string): Effect.Effect<McpServerManager> {
		return Scope.provide(owner.scope)(
			Effect.gen(function* () {
				const connectFibers = yield* FiberMap.make<string, ServerConnection, Error>();
				const reconnectFibers = yield* FiberMap.make<string, ServerConnection, Error>();
				const closeFibers = yield* FiberMap.make<string, void, Error>();
				return new McpServerManager(owner.scope, connectFibers, reconnectFibers, closeFibers, defaultCwd);
			}),
		);
	}

	setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void {
		this.metadataListChangedListener = listener;
	}

	setRuntimeSignal(signal: AbortSignal | undefined): void {
		this.runtimeSignal = signal;
	}

	setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
		this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
	}

	setTraceConfig(settings: McpTraceSettings | undefined): void {
		this.traceSettings = settings;
	}

	setAuthStorageOptions(options: AuthStorageOptions): void {
		this.authStorageOptions = options;
	}

	setOAuthRuntime(runtime: McpOAuthRuntime): void {
		this.oauthRuntime = runtime;
	}

	getRequestOptions(name: string, signal?: AbortSignal): RequestOptions {
		const options = this.buildRequestOptions(this.connections.get(name)?.connection.definition, signal);
		return { ...options, timeout: options?.timeout ?? 0 };
	}

	private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
		if (definition?.requestTimeoutMs !== undefined) {
			return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
		}
		return this.defaultRequestTimeoutMs;
	}

	private buildRequestOptions(definition?: ServerDefinition, signal?: AbortSignal): RequestOptions | undefined {
		const timeout = this.getResolvedRequestTimeoutMs(definition);
		const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);

		if (!ownedSignal && timeout === undefined) {
			return undefined;
		}

		const options: RequestOptions = {};
		if (ownedSignal) options.signal = ownedSignal;
		if (timeout !== undefined) options.timeout = timeout;
		return options;
	}

	private singleFlight<Value, ErrorValue>(
		fibers: FiberMap.FiberMap<string, Value, ErrorValue>,
		name: string,
		program: Effect.Effect<Value, ErrorValue>,
	): Effect.Effect<Value, ErrorValue> {
		return this.fiberGate
			.withPermits(1)(
				Effect.gen(function* () {
					const existing = yield* FiberMap.get(fibers, name);
					if (Option.isSome(existing)) return existing.value;
					return yield* FiberMap.run(fibers, name, program);
				}),
			)
			.pipe(Effect.flatMap(Fiber.join));
	}

	private ensureConnectable(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
	): Effect.Effect<void, Error> {
		return Effect.try({
			try: () => {
				if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
				if (this.stopped) throw new Error("MCP server manager is closed");
				signal?.throwIfAborted();
			},
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
	}

	connectEffect(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
	): Effect.Effect<ServerConnection, Error> {
		const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
		return Effect.gen({ self: this }, function* () {
			yield* this.ensureConnectable(name, definition, ownedSignal);
			const closing = yield* FiberMap.get(this.closeFibers, name);
			if (Option.isSome(closing)) yield* Fiber.join(closing.value);
			yield* this.ensureConnectable(name, definition, ownedSignal);

			const existing = this.connections.get(name)?.connection;
			if (existing?.status === "connected") {
				existing.lastUsedAt = Date.now();
				return existing;
			}

			const generation = this.closeGenerations.get(name) ?? 0;
			const acquisition = this.createManagedConnection(name, definition, ownedSignal, ownedSignal).pipe(
				Effect.catch((error) =>
					definition.url ? this.enrichHttpConnectionError(definition, error, ownedSignal) : Effect.fail(error),
				),
			);
			let published = false;
			const attempt = Effect.acquireUseRelease(
				acquisition,
				(managed) =>
					Effect.gen({ self: this }, function* () {
						if ((this.closeGenerations.get(name) ?? 0) !== generation) {
							if (ownedSignal?.aborted) {
								const reason = ownedSignal.reason;
								return yield* Effect.fail(reason instanceof Error ? reason : new Error(String(reason)));
							}
							return yield* Effect.fail(new Error(`MCP connection for ${name} was closed while connecting`));
						}
						this.connections.set(name, managed);
						published = true;
						return managed.connection;
					}),
				(managed, exit) => (published ? Effect.void : Scope.close(managed.scope, exit)),
			);
			return yield* this.singleFlight(this.connectFibers, name, attempt);
		});
	}

	/**
	 * Reconnect a server whose connection was proven stale (e.g. by a 404
	 * "session no longer exists" response). Single-flight per server name —
	 * concurrent callers that raced to the same failure share one reconnect —
	 * and identity-guarded: `staleConnection` is only torn down if it is
	 * still the manager's current connection for `name`. If a concurrent
	 * reconnect (or an unrelated connect()) already replaced it with a fresh
	 * connection, that fresh connection is returned untouched.
	 */
	reconnectEffect(
		name: string,
		definition: ServerDefinition,
		staleConnection: ServerConnection,
		signal?: AbortSignal,
	): Effect.Effect<ServerConnection, Error> {
		const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
		return this.ensureConnectable(name, definition, ownedSignal).pipe(
			Effect.andThen(
				this.singleFlight(
					this.reconnectFibers,
					name,
					this.doReconnect(name, definition, staleConnection, ownedSignal),
				),
			),
		);
	}

	private doReconnect(
		name: string,
		definition: ServerDefinition,
		staleConnection: ServerConnection,
		signal?: AbortSignal,
	): Effect.Effect<ServerConnection, Error> {
		return Effect.gen({ self: this }, function* () {
			yield* this.ensureConnectable(name, definition, signal);
			const current = this.connections.get(name)?.connection;

			// Never tear down a connection we didn't prove stale: if the map no
			// longer holds the connection we were asked to replace, someone else
			// already reconnected (or connected) first.
			if (current !== staleConnection) {
				return current ?? (yield* this.connectEffect(name, definition, signal));
			}

			const staleInFlight = staleConnection.inFlight;
			yield* this.closeEffect(name);
			const fresh = yield* this.connectEffect(name, definition, signal);
			fresh.inFlight = Math.max(fresh.inFlight, staleInFlight);
			return fresh;
		});
	}

	private createTransport(
		name: string,
		definition: ServerDefinition,
		requestOptions: RequestOptions | undefined,
		signal?: AbortSignal,
		traceObserver?: McpTraceObserver,
	): Effect.Effect<
		{ readStderrTail: () => Buffer<ArrayBufferLike>; terminateSession?: () => Promise<void>; transport: Transport },
		Error
	> {
		return Effect.gen({ self: this }, function* () {
			let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			const configuredTransports = [definition.command, definition.url, definition.socket].filter(
				(value) => isRuntimeString(value) && value.length > 0,
			);
			if (configuredTransports.length !== 1) {
				return yield* Effect.fail(
					new Error(`Server ${name} must configure exactly one of command, url, or socket`),
				);
			}

			let transport: Transport;
			let terminateSession: (() => Promise<void>) | undefined;
			if (definition.command) {
				const { StdioClientTransport } = yield* mcpNativePromise(
					() => import("@modelcontextprotocol/sdk/client/stdio.js"),
					signal,
				);
				let command = definition.command;
				let args = definition.args ?? [];
				if (command === "npx" || command === "npm") {
					const resolved = yield* mcpNativePromise(
						(effectSignal) => resolveNpxBinary(command, args, effectSignal),
						signal,
					);
					if (resolved) {
						command = resolved.isJs ? "node" : resolved.binPath;
						args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
						logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
					}
				}
				const environment = yield* mcpNativePromise(
					(effectSignal) => resolveEnv(definition.env, name, effectSignal),
					signal,
				);
				transport = yield* Effect.try({
					try: () => {
						const cwd = resolveConfigPath(definition.cwd) ?? this.defaultCwd;
						const stdioOptions: StdioServerParameters = {
							command,
							args,
							env: environment,
							stderr: definition.debug ? "inherit" : "pipe",
						};
						if (cwd !== undefined) stdioOptions.cwd = cwd;
						const stdioTransport = new StdioClientTransport(stdioOptions);
						stdioTransport.stderr?.on("data", (chunk: Buffer | string) => {
							stderrTail = appendStderrTail(stderrTail, chunk);
						});
						return stdioTransport;
					},
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				});
			} else if (definition.url) {
				const { createHttpTransport, createSessionTerminator } = yield* mcpNativePromise(
					() => import("./mcp-http-transport.ts"),
					signal,
				);
				transport = yield* createHttpTransport({
					authStorageOptions: this.authStorageOptions,
					definition,
					oauthSignal: this.oauthRuntime?.signal,
					requestOptions,
					serverName: name,
					traceObserver,
				});
				terminateSession = createSessionTerminator(transport, name);
			} else {
				const { UnixSocketClientTransport } = yield* mcpNativePromise(
					() => import("./unix-socket-transport.ts"),
					signal,
				);
				transport = yield* Effect.try({
					try: () => {
						const socketPath = resolveConfigPath(definition.socket);
						if (!socketPath) throw new Error(`Server ${name} has no Unix socket path`);
						return new UnixSocketClientTransport(socketPath);
					},
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				});
			}

			if (traceObserver) {
				transport = wrapTransportWithMcpTrace(
					transport,
					name,
					traceTransportKind(definition, transport),
					traceObserver,
				);
			}
			return terminateSession
				? { readStderrTail: () => stderrTail, terminateSession, transport }
				: { readStderrTail: () => stderrTail, transport };
		}).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));
	}

	private createManagedConnection(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
		requestSignal?: AbortSignal,
	): Effect.Effect<ManagedConnection, Error> {
		return Effect.gen({ self: this }, function* () {
			const scope = yield* Scope.fork(this.ownerScope, "parallel");
			const exit = yield* Effect.exit(
				Scope.provide(scope)(this.createConnection(name, definition, signal, requestSignal)),
			);
			if (Exit.isSuccess(exit)) return { connection: exit.value, scope };

			const originalError = Cause.squash(exit.cause);
			const cleanupExit = yield* Effect.exit(Scope.close(scope, exit));
			if (Exit.isFailure(cleanupExit)) {
				return yield* Effect.fail(
					new AggregateError([originalError, Cause.squash(cleanupExit.cause)], "MCP connection setup failed"),
				);
			}
			return yield* Effect.fail(originalError instanceof Error ? originalError : new Error(String(originalError)));
		});
	}

	private createConnection(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
		requestSignal?: AbortSignal,
	): Effect.Effect<ServerConnection, Error, Scope.Scope> {
		return Effect.gen({ self: this }, function* () {
			signal?.throwIfAborted();
			const [{ Client: ClientConstructor }, { createJsonSchemaValidator }, { connectClient }] = yield* Effect.all(
				[
					mcpNativePromise(() => import("@modelcontextprotocol/sdk/client/index.js"), signal),
					mcpNativePromise(() => import("./json-schema-validator.ts"), signal),
					mcpNativePromise(() => import("./mcp-http-transport.ts"), signal),
				] as const,
				{ concurrency: "unbounded" },
			);
			const client = this.createClient(name, ClientConstructor, createJsonSchemaValidator());
			const tracingEnabled = isMcpTraceEnabled(definition, this.traceSettings);
			let traceWriter = tracingEnabled ? this.traceWriter : undefined;
			if (tracingEnabled && !traceWriter) {
				traceWriter = createMcpTraceWriter(this.defaultCwd, this.traceSettings ?? {});
				this.traceWriter = traceWriter;
			}
			const traceObserver: McpTraceObserver | undefined = traceWriter
				? { record: (event) => traceWriter.write(event) }
				: undefined;
			const requestOptions = this.buildRequestOptions(definition, requestSignal);
			const ownership = { connected: false, settled: false };
			let connection: ServerConnection | undefined;
			const resource = yield* Effect.acquireRelease(
				this.createTransport(name, definition, requestOptions, signal, traceObserver),
				({ transport }) => {
					if (!ownership.settled) {
						return mcpNativePromise(() => transport.close()).pipe(Effect.orDie);
					}
					if (!ownership.connected || !connection) return Effect.void;
					return this.disposeConnection(connection).pipe(Effect.orDie);
				},
				{ interruptible: true },
			);
			const { readStderrTail, terminateSession, transport } = resource;
			const connectExit = yield* Effect.uninterruptibleMask((restore) =>
				Effect.exit(restore(connectClient(client, transport, requestOptions))).pipe(
					Effect.tap((exit) =>
						Effect.sync(() => {
							ownership.settled = true;
							ownership.connected = Exit.isSuccess(exit);
						}),
					),
				),
			);
			if (Exit.isFailure(connectExit)) {
				const error = signal?.aborted ? signal.reason : Cause.squash(connectExit.cause);
				const unauthorized = definition.url
					? (yield* mcpNativePromise(() => import("./mcp-http-transport.ts"), signal)).isUnauthorizedHttpError(
							error,
						)
					: false;
				if (unauthorized && supportsOAuth(definition)) {
					return {
						client,
						transport,
						definition,
						tools: [],
						resources: [],
						lastUsedAt: Date.now(),
						inFlight: 0,
						status: "needs-auth",
					};
				}
				return yield* Effect.fail(withStderrTail(error, readStderrTail()));
			}

			const instructions = client.getInstructions?.();
			connection = {
				client,
				transport,
				definition,
				tools: [],
				resources: [],
				lastUsedAt: Date.now(),
				inFlight: 0,
				status: "connected",
			};
			if (terminateSession !== undefined) connection.terminateSession = terminateSession;
			if (instructions !== undefined) connection.instructions = instructions;
			const ownedConnection = connection;
			client.onclose = () => {
				if (this.connections.get(name)?.connection === ownedConnection) ownedConnection.status = "closed";
			};

			const { resources, tools } = yield* discoverMcpMetadata(client, requestOptions);
			ownedConnection.tools = tools;
			ownedConnection.resources = resources;
			return ownedConnection;
		});
	}

	private enrichHttpConnectionError<ErrorValue>(
		definition: ServerDefinition,
		error: ErrorValue,
		signal?: AbortSignal,
	): Effect.Effect<never, Error> {
		const originalError = error instanceof Error ? error : new Error(String(error));
		if (signal?.aborted) return Effect.fail(originalError);
		const serverUrl = resolveServerUrl(definition);
		if (!serverUrl) return Effect.fail(originalError);
		return probeMcpEndpoint(serverUrl).pipe(
			Effect.match({
				onFailure: () => originalError,
				onSuccess: (probe) =>
					new Error(`${originalError.message} — probe: ${probe.classification}`, { cause: error }),
			}),
			Effect.flatMap(Effect.fail),
		);
	}

	private createClient(
		serverName: string,
		ClientConstructor: typeof Client,
		jsonSchemaValidator: NonNullable<ClientOptions["jsonSchemaValidator"]>,
	): Client {
		let client: Client;
		const clientOptions: ClientOptions = {
			jsonSchemaValidator,
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						this.handleToolsListChanged(serverName, client, error, tools ?? null);
					},
				},
				resources: {
					onChanged: (error, resources) => {
						this.handleResourcesListChanged(serverName, client, error, resources ?? null);
					},
				},
			},
		};
		client = new ClientConstructor({ name: `pi-mcp-${serverName}`, version: "1.0.0" }, clientOptions);
		return client;
	}

	private handleToolsListChanged(
		serverName: string,
		client: Client,
		error: Error | null,
		tools: readonly Tool[] | null,
	): void {
		if (error) {
			logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${error.message}`);
			return;
		}
		if (!tools) return;
		const limit = metadataLimitMessage("tool", 1, tools.length);
		if (limit) {
			logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${limit}`);
			return;
		}
		const connection = this.connections.get(serverName)?.connection;
		if (!connection || connection.client !== client || connection.status !== "connected") return;
		connection.tools = tools.map(normalizeMcpTool);
		this.metadataListChangedListener?.(serverName, "tools-list-changed");
	}

	private handleResourcesListChanged(
		serverName: string,
		client: Client,
		error: Error | null,
		resources: readonly Resource[] | null,
	): void {
		if (error) {
			logger.debug(`MCP: resources/list_changed refresh failed for ${serverName}: ${error.message}`);
			return;
		}
		if (!resources) return;
		const limit = metadataLimitMessage("resource", 1, resources.length);
		if (limit) {
			logger.debug(`MCP: resources/list_changed refresh failed for ${serverName}: ${limit}`);
			return;
		}
		const connection = this.connections.get(serverName)?.connection;
		if (!connection || connection.client !== client || connection.status !== "connected") return;
		connection.resources = resources.map(normalizeMcpResource);
		this.metadataListChangedListener?.(serverName, "resources-list-changed");
	}

	closeEffect(name: string): Effect.Effect<void, Error> {
		return this.singleFlight(this.closeFibers, name, this.closeOnce(name));
	}

	private closeOnce(name: string): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
			const pending = yield* FiberMap.get(this.connectFibers, name);
			if (Option.isSome(pending)) {
				yield* Fiber.interrupt(pending.value);
				const exit = yield* Fiber.await(pending.value);
				if (Exit.isFailure(exit)) {
					const error = Cause.squash(exit.cause);
					if (this.containsCleanupFailure(error)) {
						return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)));
					}
				}
			}

			const managed = this.connections.get(name);
			if (!managed) return;
			managed.connection.status = "closed";
			this.connections.delete(name);
			const closeExit = yield* Effect.exit(Scope.close(managed.scope, Exit.void));
			if (Exit.isFailure(closeExit)) {
				const error = Cause.squash(closeExit.cause);
				return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private disposeConnection(connection: ServerConnection): Effect.Effect<void, AggregateError> {
		const terminateSession = connection.terminateSession;
		const terminate = terminateSession ? mcpNativePromise(terminateSession) : Effect.void;
		const release = Effect.exit(terminate).pipe(
			Effect.flatMap((terminateExit) =>
				Effect.exit(mcpNativePromise(() => connection.client.close())).pipe(
					Effect.map((clientExit) => [terminateExit, clientExit] as const),
				),
			),
		);
		const traceWriter = this.traceWriter;
		const flush = traceWriter ? mcpNativePromise(() => traceWriter.flush()) : Effect.void;
		return Effect.all([release, Effect.exit(flush)] as const, { concurrency: "unbounded" }).pipe(
			Effect.flatMap(([releaseExits, flushExit]) => {
				const exits = [...releaseExits, flushExit];
				const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
				return failures.length > 0
					? Effect.fail(new AggregateError(failures, "MCP connection cleanup failed"))
					: Effect.void;
			}),
		);
	}

	closeAllEffect(): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			this.stopped = true;
			const names = new Set([
				...this.closeGenerations.keys(),
				...this.connections.keys(),
				...[...this.connectFibers].map(([name]) => name),
			]);
			for (const name of names) {
				this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
			}
			const pendingFailures = yield* Effect.all(
				[
					interruptFiberFailures([...this.connectFibers].map(([, fiber]) => fiber)),
					interruptFiberFailures([...this.reconnectFibers].map(([, fiber]) => fiber)),
					interruptFiberFailures([...this.closeFibers].map(([, fiber]) => fiber)),
				],
				{ concurrency: "unbounded" },
			);

			const managed = [...this.connections.values()];
			this.connections.clear();
			for (const entry of managed) entry.connection.status = "closed";
			const closeExits = yield* Effect.forEach(
				managed,
				(entry) => Effect.exit(Scope.close(entry.scope, Exit.void)),
				{ concurrency: "unbounded" },
			);
			const scopeFailures = closeExits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
			const failures = [...pendingFailures.flat(), ...scopeFailures].filter((error) =>
				this.containsCleanupFailure(error),
			);
			const traceWriter = this.traceWriter;
			if (traceWriter) yield* mcpNativePromise(() => traceWriter.flush());
			if (failures.length > 0) {
				return yield* Effect.fail(new AggregateError(failures, "MCP manager cleanup failed"));
			}
		});
	}

	private containsCleanupFailure<ErrorValue>(error: ErrorValue): boolean {
		const pending: unknown[] = [error];
		const seen = new Set<unknown>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (!(current instanceof Error) || seen.has(current)) continue;
			seen.add(current);
			if (current instanceof AggregateError) {
				if (/cleanup failed|setup failed/.test(current.message)) return true;
				pending.push(...current.errors);
			}
			if (current.cause !== undefined) pending.push(current.cause);
		}
		return false;
	}

	getConnection(name: string): ServerConnection | undefined {
		return this.connections.get(name)?.connection;
	}

	getAllConnections(): Map<string, ServerConnection> {
		return new Map([...this.connections].map(([name, managed]) => [name, managed.connection]));
	}

	touch(name: string): void {
		const connection = this.connections.get(name)?.connection;
		if (connection) {
			connection.lastUsedAt = Date.now();
		}
	}

	incrementInFlight(name: string): void {
		const connection = this.connections.get(name)?.connection;
		if (connection) {
			connection.inFlight = (connection.inFlight ?? 0) + 1;
		}
	}

	decrementInFlight(name: string): void {
		const connection = this.connections.get(name)?.connection;
		if (connection?.inFlight) {
			connection.inFlight--;
		}
	}

	isIdle(name: string, timeoutMs: number): boolean {
		const connection = this.connections.get(name)?.connection;
		if (connection?.status !== "connected") return false;
		if (connection.inFlight > 0) return false;
		return Date.now() - connection.lastUsedAt > timeoutMs;
	}
}

/**
 * Resolve environment variables with interpolation.
 */
async function resolveEnv(
	env: Record<string, string> | undefined,
	serverName: string,
	signal?: AbortSignal,
): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) resolved[key] = value;
	}
	const overrides = await resolveCommandSecretsRecord(
		env,
		(key) => `MCP server "${serverName}" stdio env "${key}"`,
		signal,
	);
	return overrides ? { ...resolved, ...overrides } : resolved;
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
	return isRuntimeNumber(timeoutMs) && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}
