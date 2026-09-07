import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { type JsonInputObject, requireJsonInputValue } from "../../shared/json-value.ts";
import {
	clearFailure,
	getFailureAgeSeconds,
	getFailureMessage,
	lazyConnect,
	recordFailure,
	updateStatusBar,
} from "./init.ts";
import { mcpNativePromise } from "./mcp-effect-runner.ts";
import { guardedMcpDetails, guardMcpOutput, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import {
	attemptAutoAuth,
	disabledResult,
	getAuthRequiredMessage,
	missingServerResult,
	proxyTextResult,
} from "./proxy-modes.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { rankSuggestions } from "./search-ranking.ts";
import type { ServerConnection } from "./server-manager.ts";
import { SessionRecoveryAuthRequiredError, type SessionRecoveryDeps, withSessionRecovery } from "./session-recovery.ts";
import type { McpExtensionState } from "./state.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";
import { findToolByName, formatSchema, getToolNames } from "./tool-metadata.ts";
import {
	isImmediateCallToolResult,
	type McpCallToolResponse,
	resolveMcpResultContent,
	transformMcpContent,
} from "./tool-registrar.ts";
import { getServerPrefix, isServerDisabled, type ToolMetadata, type ToolPrefix } from "./types.ts";

type ProxyToolResult = AgentToolResult<JsonInputObject>;
type GuardOptions = ReturnType<typeof resolveMcpOutputGuardOptions>;

function textResult(text: string, details: JsonInputObject): ProxyToolResult {
	return proxyTextResult("call", text, details);
}

function authRequiredResult(message: string, details: JsonInputObject): ProxyToolResult {
	return textResult(message, { error: "auth_required", ...details, message });
}

class McpCall {
	private readonly state: McpExtensionState;
	private readonly toolName: string;
	private readonly args: JsonInputObject | undefined;
	private readonly serverOverride: string | undefined;
	private readonly getPiTools: (() => ToolInfo[]) | undefined;
	private readonly ownedSignal: AbortSignal | undefined;
	private readonly prefixMode: ToolPrefix;
	private serverName: string | undefined;
	private toolMeta: ToolMetadata | undefined;
	private callIdentity: JsonInputObject | undefined;
	private prefixMatchedServer: string | undefined;
	private autoAuthAttempted = false;
	private autoAuthFailure: string | undefined;
	private autoAuthSucceeded = false;

	constructor(
		state: McpExtensionState,
		toolName: string,
		args: JsonInputObject | undefined,
		serverOverride: string | undefined,
		getPiTools: (() => ToolInfo[]) | undefined,
		signal: AbortSignal | undefined,
	) {
		this.state = state;
		this.toolName = toolName;
		this.args = args;
		this.serverOverride = serverOverride;
		this.getPiTools = getPiTools;
		this.ownedSignal = combineAbortSignals(state.owner?.signal, signal);
		this.ownedSignal?.throwIfAborted();
		this.serverName = serverOverride;
		this.prefixMode = state.config.settings?.toolPrefix ?? "server";
	}

	run(): Effect.Effect<ProxyToolResult, Error> {
		return Effect.gen({ self: this }, function* () {
			const resolutionError = yield* this.resolveTarget();
			if (resolutionError) return resolutionError;
			if (!this.serverName || !this.toolMeta) {
				return yield* Effect.fail(new Error("MCP call target was not resolved"));
			}
			const { serverName, toolMeta } = this;
			this.callIdentity = toolMeta.resourceUri
				? { server: serverName, resourceUri: toolMeta.resourceUri }
				: { server: serverName, tool: toolMeta.originalName };

			const connectionError = yield* this.ensureConnection();
			if (connectionError) return connectionError;
			const approvalError = yield* this.ensureApproval();
			return approvalError ?? (yield* this.executeRequest());
		});
	}

	private target() {
		if (!this.serverName || !this.toolMeta || !this.callIdentity) {
			throw new Error("MCP call target was not resolved");
		}
		return { serverName: this.serverName, toolMeta: this.toolMeta, callIdentity: this.callIdentity };
	}

	private disabledResult(serverName: string, metadata?: ToolMetadata): ProxyToolResult {
		return disabledResult(
			"call",
			serverName,
			metadata
				? metadata.resourceUri
					? { resourceUri: metadata.resourceUri }
					: { tool: metadata.originalName }
				: { requestedTool: this.toolName },
		);
	}

	private resolveTarget(): Effect.Effect<ProxyToolResult | undefined, Error> {
		const cachedError = this.resolveCachedTarget();
		if (cachedError) return Effect.succeed(cachedError);
		return Effect.gen({ self: this }, function* () {
			const explicitError = yield* this.resolveExplicitTarget();
			if (explicitError) return explicitError;
			const prefixError = yield* this.resolvePrefixedTarget();
			if (prefixError) return prefixError;
			return !this.serverName || !this.toolMeta ? this.unresolvedTargetResult() : undefined;
		});
	}

	private resolveCachedTarget(): ProxyToolResult | undefined {
		if (this.serverName && !this.state.config.mcpServers[this.serverName]) {
			return missingServerResult("call", this.serverName, {
				error: "server_not_found",
				requestedTool: this.toolName,
			});
		}
		if (this.serverName) {
			this.toolMeta = findToolByName(this.state.toolMetadata.get(this.serverName), this.toolName);
			if (isServerDisabled(this.state.config.mcpServers[this.serverName])) {
				return this.disabledResult(this.serverName, this.toolMeta);
			}
			return;
		}

		let disabledMatch: { serverName: string; toolMeta: ToolMetadata } | undefined;
		for (const [serverName, metadata] of this.state.toolMetadata) {
			const toolMeta = findToolByName(metadata, this.toolName);
			if (!toolMeta) continue;
			if (isServerDisabled(this.state.config.mcpServers[serverName])) {
				disabledMatch ??= { serverName, toolMeta };
				continue;
			}
			this.serverName = serverName;
			this.toolMeta = toolMeta;
			return;
		}
		if (disabledMatch) return this.disabledResult(disabledMatch.serverName, disabledMatch.toolMeta);
	}

	private resolveExplicitTarget(): Effect.Effect<ProxyToolResult | undefined, Error> {
		const serverName = this.serverName;
		if (!serverName || this.toolMeta) return Effect.succeed(undefined);
		return Effect.gen({ self: this }, function* () {
			const connected = yield* this.connect(serverName);
			if (connected) {
				this.toolMeta = findToolByName(this.state.toolMetadata.get(serverName), this.toolName);
				if (!this.toolMeta && this.autoAuthSucceeded) return this.afterReconnectResult(serverName);
				return undefined;
			}
			if (this.autoAuthFailure || this.state.manager.getConnection(serverName)?.status === "needs-auth") {
				return this.authRequired(serverName, { server: serverName, requestedTool: this.toolName });
			}
			return this.backoffResult(serverName, { server: serverName, requestedTool: this.toolName });
		});
	}

	private resolvePrefixedTarget(): Effect.Effect<ProxyToolResult | undefined, Error> {
		if (this.serverName || this.toolMeta || this.prefixMode === "none") return Effect.succeed(undefined);
		const candidates = Object.keys(this.state.config.mcpServers)
			.filter((name) => !isServerDisabled(this.state.config.mcpServers[name]))
			.map((name) => ({ name, prefix: getServerPrefix(name, this.prefixMode) }))
			.filter(({ prefix }) => prefix && this.toolName.startsWith(`${prefix}_`))
			.sort((left, right) => right.prefix.length - left.prefix.length);

		return Effect.gen({ self: this }, function* () {
			for (const { name: serverName } of candidates) {
				const connection = this.state.manager.getConnection(serverName);
				if (getFailureAgeSeconds(this.state, serverName) !== null && connection?.status !== "needs-auth") continue;

				const connected = yield* this.connect(serverName);
				if (this.autoAuthFailure) {
					return this.authRequired(serverName, { server: serverName, requestedTool: this.toolName });
				}
				if (!connected) continue;
				this.prefixMatchedServer ??= serverName;
				this.toolMeta = findToolByName(this.state.toolMetadata.get(serverName), this.toolName);
				if (this.toolMeta) {
					this.serverName = serverName;
					return undefined;
				}
			}
		});
	}

	private unresolvedTargetResult(): ProxyToolResult {
		const nativeTool = !this.serverOverride
			? this.getPiTools?.().find((tool) => tool.name === this.toolName && tool.name !== "mcp")
			: undefined;
		if (nativeTool) {
			return textResult(
				`"${this.toolName}" is a native Pi tool. Call ${this.toolName} directly instead of using mcp({ tool: "${this.toolName}" }).`,
				{ error: "native_tool", requestedTool: this.toolName },
			);
		}

		const hintServer = this.serverName ?? this.prefixMatchedServer;
		const available = hintServer ? getToolNames(this.state, hintServer) : [];
		let message = `Tool "${this.toolName}" not found.`;
		message +=
			available.length > 0
				? ` Server "${hintServer}" has: ${available.join(", ")}`
				: ` Use mcp({ search: "..." }) to search.`;
		const suggestions = rankSuggestions(this.state, this.toolName, 5);
		if (suggestions.length > 0) message += ` Did you mean: ${suggestions.join(", ")}`;
		return textResult(message, {
			error: "tool_not_found",
			requestedTool: this.toolName,
			hintServer,
			suggestions,
		});
	}

	private autoAuthenticate(serverName: string): Effect.Effect<boolean, Error> {
		if (this.autoAuthAttempted) return Effect.succeed(false);
		this.autoAuthAttempted = true;
		return attemptAutoAuth(this.state, serverName, this.ownedSignal).pipe(
			Effect.map((result) => {
				this.autoAuthFailure = result.status === "failed" ? result.message : undefined;
				this.autoAuthSucceeded = result.status === "success";
				return this.autoAuthSucceeded;
			}),
		);
	}

	private connect(serverName: string, reason?: string): Effect.Effect<boolean, Error> {
		return Effect.gen({ self: this }, function* () {
			if (yield* lazyConnect(this.state, serverName, this.ownedSignal, reason)) return true;
			if (this.state.manager.getConnection(serverName)?.status !== "needs-auth") return false;
			if (!(yield* this.autoAuthenticate(serverName))) return false;
			yield* this.state.manager.closeEffect(serverName);
			clearFailure(this.state, serverName);
			return yield* lazyConnect(this.state, serverName, this.ownedSignal, reason);
		});
	}

	private authRequired(serverName: string, details: JsonInputObject): ProxyToolResult {
		return authRequiredResult(this.autoAuthFailure ?? getAuthRequiredMessage(this.state, serverName), details);
	}

	private backoffResult(serverName: string, details: JsonInputObject): ProxyToolResult | undefined {
		const failedAgo = getFailureAgeSeconds(this.state, serverName);
		if (failedAgo === null) return;
		return textResult(`Server "${serverName}" not available (last failed ${failedAgo}s ago)`, {
			error: "server_backoff",
			...details,
		});
	}

	private afterReconnectResult(serverName: string, hint?: string): ProxyToolResult {
		const suggestions = rankSuggestions(this.state, this.toolName, 5);
		const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
		return textResult(
			`Tool "${this.toolName}" not found on "${serverName}" after reconnect.${hint ? ` ${hint}` : ""}${suggestionText}`,
			{
				error: "tool_not_found_after_reconnect",
				server: serverName,
				requestedTool: this.toolName,
				suggestions,
			},
		);
	}

	private ensureConnection(): Effect.Effect<ProxyToolResult | undefined, Error> {
		const { callIdentity, serverName } = this.target();
		const connection = this.state.manager.getConnection(serverName);
		if (connection?.status === "connected") return Effect.succeed(undefined);
		const backoff = connection?.status === "needs-auth" ? undefined : this.backoffResult(serverName, callIdentity);
		if (backoff) return Effect.succeed(backoff);

		const definition = this.state.config.mcpServers[serverName];
		if (!definition) {
			return Effect.succeed(
				textResult(`Server "${serverName}" not connected`, {
					error: "server_not_connected",
					...callIdentity,
				}),
			);
		}

		return Effect.exit(this.connect(serverName, "proxy-call-reconnect")).pipe(
			Effect.map((exit) => {
				if (Exit.isFailure(exit)) {
					const failure = Cause.squash(exit.cause);
					const error = failure instanceof Error ? failure : new Error(String(failure));
					if (!isAbortError(error, this.ownedSignal)) recordFailure(this.state, serverName, error.message);
					updateStatusBar(this.state);
					return textResult(`Failed to connect to "${serverName}": ${error.message}`, {
						error: isAbortError(error, this.ownedSignal) ? "aborted" : "connect_failed",
						...callIdentity,
						message: error.message,
					});
				}
				if (!exit.value) {
					if (this.autoAuthFailure || this.state.manager.getConnection(serverName)?.status === "needs-auth") {
						return this.authRequired(serverName, callIdentity);
					}
					const message = getFailureMessage(this.state, serverName) ?? `Server "${serverName}" did not connect.`;
					return textResult(`Failed to connect to "${serverName}": ${message}`, {
						error: "connect_failed",
						...callIdentity,
						message,
					});
				}
				this.toolMeta = findToolByName(this.state.toolMetadata.get(serverName), this.toolName);
				if (this.toolMeta) return undefined;
				const available = getToolNames(this.state, serverName);
				const hint =
					available.length > 0
						? `Available tools on "${serverName}": ${available.join(", ")}`
						: `Server "${serverName}" has no tools.`;
				return this.afterReconnectResult(serverName, hint);
			}),
		);
	}

	private ensureApproval(): Effect.Effect<ProxyToolResult | undefined, Error> {
		const { serverName, toolMeta } = this.target();
		if (isServerDisabled(this.state.config.mcpServers[serverName])) {
			return Effect.succeed(this.disabledResult(serverName, toolMeta));
		}
		return ensureToolCallApproved(this.state, serverName, toolMeta, this.args, this.ownedSignal).pipe(
			Effect.map((approval) => {
				if (approval.ok) return undefined;
				const denied = approval.reason === "denied";
				const message = denied
					? `The user declined approval to run MCP tool "${toolMeta.originalName}" on server "${serverName}".`
					: `MCP tool "${toolMeta.originalName}" on server "${serverName}" is approval-gated and requires an interactive session.`;
				return textResult(message, {
					error: denied ? "approval_denied" : "approval_required",
					server: serverName,
					tool: toolMeta.originalName,
				});
			}),
		);
	}

	private recoverAuthConnection(): Effect.Effect<ServerConnection | undefined, Error> {
		const { serverName } = this.target();
		const current = this.state.manager.getConnection(serverName);
		if (current?.status === "connected") return Effect.succeed(current);
		return Effect.gen({ self: this }, function* () {
			if (!(yield* this.autoAuthenticate(serverName))) {
				if (this.autoAuthFailure) {
					return yield* Effect.fail(new SessionRecoveryAuthRequiredError(serverName, this.autoAuthFailure));
				}
				return this.state.manager.getConnection(serverName);
			}

			const definition = this.state.config.mcpServers[serverName];
			if (!definition) return undefined;
			const afterAuth = this.state.manager.getConnection(serverName);
			if (afterAuth?.status === "connected") return afterAuth;
			if (afterAuth?.status === "needs-auth") yield* this.state.manager.closeEffect(serverName);
			clearFailure(this.state, serverName);
			return yield* this.state.manager.connectEffect(serverName, definition, this.ownedSignal);
		});
	}

	private executeRequest(): Effect.Effect<ProxyToolResult, Error> {
		const { serverName, toolMeta } = this.target();
		const requestOptions =
			this.state.manager.getRequestOptions?.(serverName, this.ownedSignal) ??
			(this.ownedSignal ? { signal: this.ownedSignal } : undefined);
		const outputGuardOptions = resolveMcpOutputGuardOptions(this.state.config.settings);
		const recoveryDeps: SessionRecoveryDeps = {
			manager: this.state.manager,
			config: this.state.config,
			onNeedsAuth: () => this.recoverAuthConnection(),
		};
		if (this.ownedSignal) recoveryDeps.signal = this.ownedSignal;
		const request = Effect.acquireUseRelease(
			Effect.sync(() => {
				this.state.manager.touch(serverName);
				this.state.manager.incrementInFlight(serverName);
			}),
			() =>
				toolMeta.resourceUri
					? this.readResource(toolMeta.resourceUri, recoveryDeps, requestOptions, outputGuardOptions)
					: this.callTool(recoveryDeps, requestOptions, outputGuardOptions),
			() =>
				Effect.sync(() => {
					this.state.manager.decrementInFlight(serverName);
					this.state.manager.touch(serverName);
				}),
		);
		return request.pipe(
			Effect.catchCause((cause) => {
				const failure = Cause.squash(cause);
				const error = failure instanceof Error ? failure : new Error(String(failure));
				return this.failure(error, isAbortError(error, this.ownedSignal), outputGuardOptions);
			}),
		);
	}

	private readResource(
		resourceUri: string,
		recoveryDeps: SessionRecoveryDeps,
		requestOptions: RequestOptions | undefined,
		outputGuardOptions: GuardOptions,
	): Effect.Effect<ProxyToolResult, Error> {
		const { callIdentity, serverName } = this.target();
		const ownedSignal = this.ownedSignal;
		return Effect.gen(function* () {
			const result = yield* withSessionRecovery<ReadResourceResult>(recoveryDeps, serverName, (connection) =>
				mcpNativePromise(
					(effectSignal) =>
						connection.client.readResource({ uri: resourceUri }, { ...requestOptions, signal: effectSignal }),
					ownedSignal,
				),
			);
			const content = (result.contents ?? []).map((item) => ({
				type: "text" as const,
				text:
					"text" in item
						? item.text
						: "blob" in item
							? `[Binary data: ${item.mimeType ?? "unknown"}]`
							: JSON.stringify(item),
			}));
			const guarded = yield* mcpNativePromise(() =>
				guardMcpOutput(
					content.length > 0 ? content : [{ type: "text", text: "(empty resource)" }],
					outputGuardOptions,
				),
			);
			return {
				content: guarded.content,
				details: { mode: "call", ...callIdentity, ...guardedMcpDetails(guarded) },
			};
		});
	}

	private callTool(
		recoveryDeps: SessionRecoveryDeps,
		requestOptions: RequestOptions | undefined,
		outputGuardOptions: GuardOptions,
	): Effect.Effect<ProxyToolResult, Error> {
		const { callIdentity, serverName, toolMeta } = this.target();
		const ownedSignal = this.ownedSignal;
		const args = this.args;
		return Effect.gen(function* () {
			const result = yield* withSessionRecovery<McpCallToolResponse>(recoveryDeps, serverName, (connection) =>
				mcpNativePromise(
					(effectSignal) =>
						connection.client.callTool({ name: toolMeta.originalName, arguments: args ?? {} }, undefined, {
							...requestOptions,
							signal: effectSignal,
						}),
					ownedSignal,
				),
			);
			if (!isImmediateCallToolResult(result)) {
				return yield* Effect.fail(new Error("MCP task-based tool results are not supported by the proxy tool"));
			}
			const rawMcpResult = yield* Effect.try({
				try: () => requireJsonInputValue(result, "MCP tool result"),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			if (result.isError) {
				const content = transformMcpContent(result.content);
				const schemaText = toolMeta.inputSchema
					? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
					: "";
				const guarded = yield* mcpNativePromise(() =>
					guardMcpOutput(content.length > 0 ? content : [{ type: "text", text: "(empty result)" }], {
						...outputGuardOptions,
						prefix: "Error: ",
						suffix: schemaText,
						emptyTextFallback: "Tool execution failed",
						rawMcpResult,
					}),
				);
				return {
					content: guarded.content,
					details: { mode: "call", error: "tool_error", ...callIdentity, ...guardedMcpDetails(guarded) },
				};
			}

			const content = resolveMcpResultContent(result);
			const guarded = yield* mcpNativePromise(() =>
				guardMcpOutput(content.length > 0 ? content : [{ type: "text", text: "(empty result)" }], {
					...outputGuardOptions,
					rawMcpResult,
				}),
			);
			return {
				content: guarded.content,
				details: { mode: "call", ...guardedMcpDetails(guarded), ...callIdentity },
			};
		});
	}

	private failure(error: Error, aborted: boolean, guardOptions: GuardOptions): Effect.Effect<ProxyToolResult, Error> {
		const { callIdentity, serverName, toolMeta } = this.target();
		if (error instanceof SessionRecoveryAuthRequiredError) {
			const message = error.authMessage ?? getAuthRequiredMessage(this.state, serverName);
			return Effect.succeed(
				authRequiredResult(message, { ...callIdentity, autoAuthAttempted: this.autoAuthAttempted }),
			);
		}
		const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
		return mcpNativePromise(() =>
			guardMcpOutput([{ type: "text", text: error.message }], {
				...guardOptions,
				prefix: "Failed to call tool: ",
				suffix: schemaText,
			}),
		).pipe(
			Effect.map((guarded) => ({
				content: guarded.content,
				details: {
					mode: "call",
					error: aborted ? "aborted" : "call_failed",
					...callIdentity,
					message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : error.message,
					...guardedMcpDetails(guarded),
				},
			})),
		);
	}
}

export function executeCall(
	state: McpExtensionState,
	toolName: string,
	args?: JsonInputObject,
	serverOverride?: string,
	getPiTools?: () => ToolInfo[],
	signal?: AbortSignal,
): Effect.Effect<ProxyToolResult, Error> {
	return Effect.try({
		try: () => new McpCall(state, toolName, args, serverOverride, getPiTools, signal),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(Effect.flatMap((call) => call.run()));
}
