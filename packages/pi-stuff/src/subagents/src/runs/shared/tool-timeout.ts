import { isRuntimeNumber, isRuntimeString } from "../../../../shared/runtime-type.ts";

export const TOOL_TIMEOUT_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TOOL_TIMEOUT_EXEMPT_TOOLS = new Set(["contact_supervisor", "intercom", "bg_wait"]);

export function effectiveToolTimeoutMs(
	toolName: string | undefined,
	configuredToolTimeoutMs: number | undefined,
): number | undefined {
	if (toolName && TOOL_TIMEOUT_EXEMPT_TOOLS.has(toolName)) return undefined;
	return configuredToolTimeoutMs;
}

export function formatToolTimeoutMessage(toolName: string, timeoutMs: number): string {
	return `Tool '${toolName}' exceeded its timeout of ${timeoutMs}ms.`;
}

export function toolTimeoutCallKey(event: { toolCallId?: unknown; toolName?: unknown }, fallbackId: number): string {
	return isRuntimeString(event.toolCallId) && event.toolCallId.length > 0
		? `id:${event.toolCallId}`
		: `anon:${String(event.toolName ?? "tool")}:${fallbackId}`;
}

export function resolveToolTimeoutMs(input: {
	callValue?: unknown;
	agentValue?: number | undefined;
	envValue?: string | undefined;
}) {
	let label = "toolTimeoutMs";
	let raw = input.callValue;
	if (raw === undefined) {
		label = "agent.toolTimeoutMs";
		raw = input.agentValue;
	}
	if (raw === undefined && input.envValue?.trim()) {
		label = TOOL_TIMEOUT_ENV;
		raw = Number(input.envValue);
	}
	if (raw === undefined) return {};
	if (!isRuntimeNumber(raw) || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMER_DELAY_MS) {
		return { error: `${label} must be a positive integer no larger than ${MAX_TIMER_DELAY_MS}.` };
	}
	return { toolTimeoutMs: raw };
}
