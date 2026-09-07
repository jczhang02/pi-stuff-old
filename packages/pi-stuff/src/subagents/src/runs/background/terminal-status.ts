/** Reconstruct terminal background status from durable semantic evidence. */

import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { readBoundedOwnedFile } from "../../shared/private-directory.ts";
import type { AsyncStatus, ProcessTerminalV1 } from "../../shared/types.ts";
import { MAX_ASYNC_STATUS_FILE_BYTES } from "../../shared/utils.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";

const MAX_NESTED_RESULT_FILE_BYTES = 32 * 1024 * 1024;

interface SemanticResult {
	state?: unknown;
	success?: unknown;
	startedAt?: unknown;
	endedAt?: unknown;
	error?: unknown;
	mode?: unknown;
	timedOut?: unknown;
	stopped?: unknown;
}

interface RawTerminalStatus {
	runId?: unknown;
	mode?: unknown;
	state?: unknown;
	startedAt?: unknown;
}
function finiteTimestamp<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function semanticResultState(value: SemanticResult): AsyncStatus["state"] | undefined {
	if ((value.state === "complete" || value.state === "completed") && value.success !== false) {
		return "complete";
	}
	if (value.state === "failed" || value.state === "paused" || value.state === "stopped") {
		return value.state;
	}
	return value.success === true ? "complete" : value.success === false ? "failed" : undefined;
}

/**
 * Reconstruct only semantic state when status.json cannot be read. A process
 * close proof establishes lifecycle completion, never task success by itself.
 */
export function buildNestedTerminalFallbackStatus(
	config: Pick<BackgroundRunnerConfig, "id" | "resultPath" | "work">,
	processTerminal: ProcessTerminalV1,
	now = Date.now(),
): AsyncStatus {
	let result: SemanticResult | undefined;
	try {
		const parsed = parseJsonValue(readBoundedOwnedFile(config.resultPath, MAX_NESTED_RESULT_FILE_BYTES));
		if (parsed && isRuntimeObject(parsed) && !Array.isArray(parsed)) {
			// SAFETY: the parsed JSON object is read only through the semantic-result fields validated below.
			result = parsed as SemanticResult;
		}
	} catch {
		// The conservative fallback below is authoritative when no semantic result exists.
	}
	const semanticState = result ? semanticResultState(result) : undefined;
	const state = semanticState ?? "failed";
	const observedAt = processTerminal.state === "observed" ? processTerminal.observedAt : now;
	const startedAt = finiteTimestamp(result?.startedAt) ?? observedAt;
	const endedAt = finiteTimestamp(result?.endedAt) ?? observedAt;
	const error =
		isRuntimeString(result?.error) && result.error.trim()
			? result.error
			: semanticState
				? undefined
				: "Agent runner exited without a readable semantic result or status.";
	const status: AsyncStatus = {
		runId: config.id,
		mode: result?.mode === "single" || result?.mode === "parallel" ? result.mode : config.work.mode,
		state,
		startedAt,
		endedAt,
		lastUpdate: endedAt,
		processTerminal,
	};
	if (error) status.error = error;
	if (result?.timedOut === true) status.timedOut = true;
	if (state === "stopped" || result?.stopped === true) status.stopped = true;
	return status;
}

function isTerminalAsyncStatus<Value>(value: Value, runId: string): value is Value & AsyncStatus {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return false;
	// SAFETY: the non-array object guard permits inspection through the terminal-status schema's optional raw fields.
	const status = value as Value & RawTerminalStatus;
	return (
		status.runId === runId &&
		(status.mode === "single" || status.mode === "parallel") &&
		(status.state === "complete" ||
			status.state === "failed" ||
			status.state === "paused" ||
			status.state === "stopped") &&
		finiteTimestamp(status.startedAt) !== undefined
	);
}

export function resolveNestedTerminalStatus(
	config: Pick<BackgroundRunnerConfig, "asyncDir" | "id" | "resultPath" | "work">,
	processTerminal: ProcessTerminalV1,
): AsyncStatus {
	try {
		const parsed = parseJsonValue(
			readBoundedOwnedFile(path.join(config.asyncDir, "status.json"), MAX_ASYNC_STATUS_FILE_BYTES),
		);
		if (!isTerminalAsyncStatus(parsed, config.id)) throw new Error("invalid terminal Agent status");
		return Object.assign({}, parsed, { processTerminal });
	} catch {
		return buildNestedTerminalFallbackStatus(config, processTerminal);
	}
}
