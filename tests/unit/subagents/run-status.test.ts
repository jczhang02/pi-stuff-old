import { expect, test } from "bun:test";
import {
	inspectSubagentStatus,
	type RunStatusResult,
	type RunStatusState,
	resolveLegacyAgentTarget,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/run-status.js";
import type { AsyncJobState } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";

function createState(sessionId: string | null = "root-session"): RunStatusState {
	return {
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
	};
}

function asyncJob(id: string, status: AsyncJobState["status"], overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: id,
		asyncDir: `/secret/logs/${id}`,
		status,
		sessionId: "root-session",
		agents: [id],
		startedAt: 1_000,
		updatedAt: 4_000,
		...overrides,
	};
}

function resultText(result: RunStatusResult): string {
	const first = result.content[0];
	if (first?.type !== "text") throw new Error("Expected a text status result.");
	return first.text;
}

test("resolves only unique legacy row keys to the public Agent Target pair", () => {
	const state = createState();
	state.asyncJobs.set(
		"parallel",
		asyncJob("parallel", "running", {
			steps: [
				{ index: 0, agent: "scout", status: "running", label: "Research" },
				{ index: 1, agent: "reviewer", status: "running", label: "Review" },
			],
		}),
	);
	expect(resolveLegacyAgentTarget({ id: "parallel:1" }, { state })).toEqual({ id: "parallel", index: 1 });
	expect(resolveLegacyAgentTarget({ id: "parallel", index: 1 }, { state })).toEqual({
		id: "parallel",
		index: 1,
	});
	expect(resolveLegacyAgentTarget({ id: "parallel:9" }, { state })).toEqual({ id: "parallel:9" });
	const unavailable = inspectSubagentStatus({ id: "parallel:9" }, { state });
	expect(unavailable.isError).toBe(true);
	expect(resultText(unavailable)).toBe("Agent 'parallel:9' is not available in the current session.");

	state.asyncJobs.set("canonical", asyncJob("duplicate:0", "running"));
	state.asyncJobs.set("legacy", asyncJob("duplicate", "running"));
	expect(() => resolveLegacyAgentTarget({ id: "duplicate:0" }, { state })).toThrow("is ambiguous");
});

test("lists only direct children from the current session", () => {
	const state = createState();
	state.asyncJobs.set(
		"live",
		asyncJob("live", "running", {
			description: "Inspect the current implementation",
			sessionFile: "/secret/sessions/live.jsonl",
			steps: [
				{
					agent: "scout",
					status: "running",
					label: "Inspect the current implementation",
					model: "private/model-name",
					transcriptPath: "/secret/transcripts/live.md",
				},
			],
			nestedChildren: [
				{
					id: "nested-child",
					parentRunId: "live",
					parentStepIndex: 0,
					depth: 1,
					path: [],
					state: "running",
				},
			],
		}),
	);
	state.asyncJobs.set("foreign", asyncJob("foreign", "running", { sessionId: "another-session" }));
	state.recentAgentJobs?.set(
		"done",
		asyncJob("done", "complete", {
			steps: [{ agent: "writer", status: "completed", label: "Write the report" }],
		}),
	);

	const result = inspectSubagentStatus({ action: "status" }, { state, now: () => 5_000 });
	const text = resultText(result);

	expect(result.isError).toBeUndefined();
	expect(result.details).toEqual({ mode: "management", results: [] });
	expect(text).toContain("Current Agents (2)");
	expect(text).toContain("id=live · index=0 · scout · running · 4s");
	expect(text).toContain("id=done · index=0 · writer · completed · 3s");
	expect(text).not.toContain("live:0");
	expect(text).not.toContain("nested-child");
	expect(text).not.toContain("foreign");
	expect(text).not.toMatch(/fleet|transcript:|session:|model:|budget:|\/secret|\.log/i);
});

test("returns one compact Agent when id and index identify a child", () => {
	const state = createState();
	state.asyncJobs.set(
		"parallel",
		asyncJob("parallel", "running", {
			steps: [
				{
					index: 0,
					agent: "scout",
					status: "running",
					label: "Research the behavior",
					startedAt: 1_000,
					recentOutput: ["Mapped the behavior."],
				},
				{
					index: 1,
					agent: "reviewer",
					status: "running",
					label: "Review the implementation",
					startedAt: 2_000,
					recentOutput: ["Found one issue."],
				},
			],
		}),
	);

	const indexed = inspectSubagentStatus({ action: "status", id: "parallel", index: 1 }, { state, now: () => 5_000 });
	const indexedText = resultText(indexed);
	expect(indexedText).toBe(
		"id=parallel · index=1 · reviewer · running · 3s\nTask: Review the implementation\nProgress: Found one issue.",
	);
	expect(indexedText).not.toContain("scout");

	const exact = inspectSubagentStatus({ action: "status", id: "parallel:0" }, { state, now: () => 5_000 });
	expect(resultText(exact)).toContain("id=parallel · index=0 · scout · running · 4s");
});

test("shows bounded path-safe terminal failure without stale progress", () => {
	const state = createState();
	state.recentAgentJobs?.set(
		"failed-review",
		asyncJob("failed-review", "failed", {
			steps: [
				{
					index: 0,
					agent: "reviewer",
					status: "failed",
					label: "Review /workspace/private/project/implementation.ts",
					error: "protocol_invalid_event: message_end message.role is invalid at /workspace/private/project/session.jsonl",
					cumulativeUsage: {
						turns: 66,
						toolCalls: 94,
						inputTokens: 1_000_000,
						outputTokens: 12_180,
						reportedCostUsd: 4.16343,
						modelAttempts: 1,
						resumes: 0,
					},
					terminalOutcome: {
						state: "incomplete",
						class: "protocol",
						reason:
							"protocol_invalid_event: message_end message.role is invalid at /workspace/private/project/session.jsonl",
						continuation: {
							target: { id: "failed-review", index: 0 },
							resumeSupported: true,
							acknowledgementRequired: true,
						},
					},
					recentOutput: ["Still reading /workspace/private/project/earlier-file.ts."],
				},
			],
		}),
	);

	const result = inspectSubagentStatus({ action: "status", id: "failed-review" }, { state, now: () => 5_000 });
	const text = resultText(result);

	expect(text).toContain("Task: Review implementation.ts");
	expect(text).toContain("Outcome [protocol/incomplete]: protocol_invalid_event: message_end message.role is invalid");
	expect(text).toContain(
		"Usage: 66 turns · 94 Tools · 1000000 input + 12180 output tokens · reported cost $4.163430 · 1 attempts · 0 resumes",
	);
	expect(text).toContain("Recovery: id=failed-review · index=0 · resumable · acknowledgement required");
	expect(text).not.toContain("Progress:");
	expect(text).not.toContain("/workspace/private");
	expect(text.length).toBeLessThan(1_500);
});

test("redacts only absolute path tokens in model-visible status text", () => {
	const state = createState();
	state.asyncJobs.set(
		"mixed-paths",
		asyncJob("mixed-paths", "running", {
			steps: [
				{
					agent: "scout",
					status: "running",
					label: "Inspect https://example.test/a/b, repo/src/index.ts, input/output, /workspace/private/a.ts, and C:\\Users\\me\\b.ts",
					recentOutput: [
						"See https://example.test/c/d and repo/src/result.ts beside /tmp/private/result.ts and D:\\secret\\result.txt",
					],
				},
			],
		}),
	);

	const text = resultText(inspectSubagentStatus({ action: "status", id: "mixed-paths" }, { state, now: () => 5_000 }));

	expect(text).toContain("https://example.test/a/b, repo/src/index.ts, input/output, a.ts, and b.ts");
	expect(text).toContain("https://example.test/c/d and repo/src/result.ts beside result.ts and result.txt");
	expect(text).not.toMatch(/\/workspace\/private|C:\\Users|\/tmp\/private|D:\\secret/u);
});

test("keeps a multi-Agent run compact when no child index is given", () => {
	const state = createState();
	state.asyncJobs.set(
		"parallel",
		asyncJob("parallel", "running", {
			steps: [
				{ index: 0, agent: "scout", status: "running", label: "Research" },
				{ index: 1, agent: "reviewer", status: "pending", label: "Review" },
			],
		}),
	);

	const result = inspectSubagentStatus({ action: "status", id: "parallel" }, { state, now: () => 5_000 });
	const text = resultText(result);

	expect(text).toContain("Agents in parallel (2)");
	expect(text).toContain("id=parallel · index=0 · scout");
	expect(text).toContain("id=parallel · index=1 · reviewer");
});

test("rejects invalid or unavailable selectors without searching old runs", () => {
	const state = createState();
	state.asyncJobs.set("foreign", asyncJob("foreign", "running", { sessionId: "another-session" }));

	const missing = inspectSubagentStatus({ action: "status", id: "foreign" }, { state, now: () => 5_000 });
	expect(missing.isError).toBe(true);
	expect(resultText(missing)).toBe("Agent 'foreign' is not available in the current session.");

	const indexOnly = inspectSubagentStatus({ action: "status", index: 0 }, { state, now: () => 5_000 });
	expect(indexOnly.isError).toBe(true);
	expect(resultText(indexOnly)).toBe("Agent status index requires an id.");

	const empty = inspectSubagentStatus({ action: "status" }, { state, now: () => 5_000 });
	expect(empty.isError).toBeUndefined();
	expect(resultText(empty)).toBe("No Agents are available in the current session.");
});
