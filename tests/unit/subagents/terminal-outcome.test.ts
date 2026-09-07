import { expect, test } from "bun:test";
import { terminalStatusFromResult } from "../../../packages/pi-stuff/src/subagents/src/runs/background/result-file.js";
import {
	classifyAgentFailure,
	terminalOutcome,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/terminal-outcome.js";
import type { AsyncStatus } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";

test("classifies abnormal Agent endings without inventing completion", () => {
	const cases = [
		["ENOSPC: no space left on device", "storage"],
		["context window overflow", "context"],
		["protocol_invalid_event: malformed event", "protocol"],
		["deadline timed out", "timeout"],
		["Automatic Agent expansion needs attention", "cost_guard"],
		["Tool budget hard limit reached", "explicit_budget"],
		["503 Service Unavailable", "provider"],
		["process exited with code 1", "process"],
		["unclassified failure", "unknown"],
	] as const;
	for (const [reason, expected] of cases) expect(classifyAgentFailure(reason)).toBe(expected);

	expect(
		terminalOutcome({
			runId: "run",
			index: 2,
			success: false,
			error: "503 Service Unavailable",
			sessionFile: "/retained/session.jsonl",
		}),
	).toEqual({
		state: "incomplete",
		class: "provider",
		reason: "503 Service Unavailable",
		continuation: { target: { id: "run", index: 2 }, resumeSupported: true },
	});
	expect(terminalOutcome({ runId: "run", index: 2, success: false, stopped: true })).toMatchObject({
		state: "failed",
		class: "stopped",
		continuation: { resumeSupported: false },
	});
	expect(terminalOutcome({ runId: "run", index: 2, success: true })).toMatchObject({
		state: "completed",
		class: "completed",
	});
});

test("round-trips cumulative usage and continuation through result-file recovery", () => {
	const status: AsyncStatus = {
		lifecycleArtifactVersion: 3,
		mode: "single",
		runId: "run",
		sessionId: "parent",
		startedAt: 1_000,
		state: "running",
		steps: [{ agent: "reviewer", startedAt: 1_000, status: "running" }],
	};
	const cumulativeUsage = {
		turns: 9,
		toolCalls: 14,
		inputTokens: 1_200,
		outputTokens: 80,
		reportedCostUsd: 0.75,
		modelAttempts: 2,
		resumes: 1,
	};
	const outcome = terminalOutcome({
		runId: "run",
		index: 0,
		success: false,
		error: "context window overflow",
		sessionFile: "retained.jsonl",
	});
	const recovered = terminalStatusFromResult(
		status,
		"/tmp/run.json",
		"run",
		3_000,
		JSON.stringify({
			id: "run",
			state: "failed",
			success: false,
			results: [
				{
					agent: "reviewer",
					success: false,
					exitCode: 1,
					error: "context window overflow",
					sessionFile: "retained.jsonl",
					cumulativeUsage,
					terminalOutcome: outcome,
				},
			],
		}),
	);

	expect(recovered).toMatchObject({
		state: "failed",
		steps: [
			{
				status: "failed",
				cumulativeUsage,
				terminalOutcome: outcome,
			},
		],
	});
});
