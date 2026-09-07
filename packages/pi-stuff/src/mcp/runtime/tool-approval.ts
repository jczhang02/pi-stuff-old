import * as Effect from "effect/Effect";
import type { JsonInputObject } from "../../shared/json-value.ts";
import { boundTerminalLine, boundTerminalText } from "../../tool-display/index.ts";
import { mcpNativePromise } from "./mcp-effect-runner.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import {
	getToolNameCandidates,
	type McpConfig,
	matchesToolPattern,
	resolveToolPrefix,
	type ToolMetadata,
} from "./types.ts";

export type ToolCallApprovalResult = { ok: true } | { ok: false; reason: "denied" | "approval_required_headless" };

export function isToolCallApprovalRequired(
	config: McpConfig,
	serverName: string,
	toolMeta: Pick<ToolMetadata, "originalName">,
): boolean {
	const definition = config.mcpServers[serverName];
	const approval = definition?.approveTools !== undefined ? definition.approveTools : config.settings?.approveTools;

	if (approval === true) return true;
	if (!Array.isArray(approval) || approval.length === 0) return false;

	const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix);
	return matchesToolPattern(getToolNameCandidates(toolMeta.originalName, serverName, prefix), approval);
}

export function ensureToolCallApproved(
	state: McpExtensionState,
	serverName: string,
	toolMeta: ToolMetadata,
	args: JsonInputObject | undefined,
	signal?: AbortSignal,
): Effect.Effect<ToolCallApprovalResult, Error> {
	if (!isToolCallApprovalRequired(state.config, serverName, toolMeta)) {
		return Effect.succeed({ ok: true });
	}

	const cacheKey = `${serverName}\u0000${toolMeta.originalName}`;
	if (state.approvedToolCalls.has(cacheKey)) {
		return Effect.succeed({ ok: true });
	}

	const ui = state.ui;
	if (!ui) {
		return Effect.succeed({ ok: false, reason: "approval_required_headless" });
	}

	const json = JSON.stringify(args ?? {}, null, 2);
	const preview = boundTerminalText(json, 500, "...");
	const title = `MCP: ${boundTerminalLine(serverName, 200)} wants to run ${boundTerminalLine(toolMeta.originalName, 200)}`;
	const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
	return mcpNativePromise(
		() => ui.select(`${title}\n\nArguments:\n${preview}`, ["Allow once", "Allow for session", "Deny"]),
		ownedSignal,
	).pipe(
		Effect.map((decision): ToolCallApprovalResult => {
			if (decision === "Allow once") return { ok: true };
			if (decision === "Allow for session") {
				state.approvedToolCalls.set(cacheKey, true);
				return { ok: true };
			}
			return { ok: false, reason: "denied" };
		}),
	);
}
