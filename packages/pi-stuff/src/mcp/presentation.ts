import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isJsonInputObject, type JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../shared/runtime-type.ts";
import { type SuiteToolPresentation, singleActivity } from "../tool-display/index.ts";

export interface McpPresentationArguments {
	action?: string;
	args?: object | string;
	connect?: string;
	describe?: string;
	includeSchemas?: boolean;
	limit?: number;
	offset?: number;
	search?: string;
	server?: string;
	tool?: string;
}

interface McpResultDetails {
	count?: number;
	error?: string;
	matches?: readonly JsonInputValue[];
	mode?: string;
	outputGuard?: { readonly truncated?: boolean };
}

function resultDetails(result: AgentToolResult<unknown>): McpResultDetails {
	if (!isJsonInputObject(result.details)) return {};
	const source = result.details;
	const details: McpResultDetails = {};
	if (isRuntimeNumber(source["count"])) details.count = source["count"];
	if (isRuntimeString(source["error"])) details.error = source["error"];
	if (Array.isArray(source["matches"])) details.matches = source["matches"];
	if (isRuntimeString(source["mode"])) details.mode = source["mode"];
	const outputGuard = source["outputGuard"];
	if (isJsonInputObject(outputGuard)) details.outputGuard = { truncated: outputGuard["truncated"] === true };
	return details;
}

function target(args: Readonly<McpPresentationArguments>): string {
	const tool = isRuntimeString(args["tool"]) ? args["tool"] : "";
	const server = isRuntimeString(args["server"]) ? args["server"] : "";
	if (tool) return server ? `${server}:${tool}` : tool;
	if (isRuntimeString(args["connect"])) return `connect ${args["connect"]}`;
	if (isRuntimeString(args["describe"])) return `describe ${args["describe"]}`;
	if (isRuntimeString(args["search"])) return `search ${args["search"]}`;
	return server || "status";
}

function resultIsError(_args: Readonly<McpPresentationArguments>, result: AgentToolResult<unknown>): boolean {
	return isRuntimeString(resultDetails(result).error);
}

function count(value: number | undefined): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function summarize(_args: Readonly<McpPresentationArguments>, result: AgentToolResult<unknown>): string {
	const details = resultDetails(result);
	if (isRuntimeString(details.error)) return "failed";
	const mode = isRuntimeString(details.mode) ? details.mode : "";
	const total = count(details.count);
	const matches = details.matches?.length;
	const truncated = details.outputGuard?.truncated === true;
	let summary = "done";
	if (mode === "search") summary = `${String(matches ?? total ?? 0)} matches`;
	else if (mode === "list") summary = `${String(total ?? 0)} tools`;
	else if (mode === "connect") summary = "connected";
	else if (mode === "status") summary = "status";
	return truncated ? `${summary} · clipped` : summary;
}

function issueSummary(
	_args: Readonly<McpPresentationArguments>,
	result: AgentToolResult<unknown>,
	state: string,
): string {
	const details = resultDetails(result);
	if (isRuntimeString(details.error) && details.error.trim()) return details.error.trim();
	for (const item of result.content) {
		if (item.type === "text" && item.text.trim()) return item.text.trim().split(/\r?\n/u)[0] ?? state;
	}
	return state;
}

export const MCP_PRESENTATION: SuiteToolPresentation<McpPresentationArguments, unknown> = {
	activity: {
		categories: ["connect-mcp", "invoke-mcp", "search-mcp"],
		classify: ({ args }) => {
			const label = target(args);
			if (isRuntimeString(args["connect"])) {
				return singleActivity("connect-mcp", { count: 1, target: label });
			}
			if (args["tool"] !== undefined) {
				return singleActivity("invoke-mcp", { count: 1, target: label });
			}
			return singleActivity("search-mcp", { count: 1, target: label });
		},
		summarizeIssue: issueSummary,
	},
	label: "MCP",
	resultIsError,
	runningSummary: "working",
	summarize,
	target,
};
