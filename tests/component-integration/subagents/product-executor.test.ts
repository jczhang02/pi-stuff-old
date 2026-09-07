import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	projectEngineResult,
	toEngineParams,
} from "../../../packages/pi-stuff/src/subagents/src/extension/product-executor.js";
import type { Details } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";

function details(overrides: Partial<Details> = {}): Details {
	return { mode: "single", results: [], ...overrides };
}

describe("toEngineParams", () => {
	test("defaults ordinary launches to fresh background Agents", () => {
		expect(toEngineParams({ agent: "researcher", task: "Find the cause" })).toEqual({
			agent: "researcher",
			async: true,
			context: "fresh",
			description: "Find the cause",
			task: "Find the cause",
		});
	});

	test("maps the explicit foreground, fork, and worktree vocabulary", () => {
		expect(
			toEngineParams({
				agent: "worker",
				context: "fork",
				foreground: true,
				isolation: "worktree",
				task: "Implement it",
			}),
		).toEqual({
			async: false,
			context: "fork",
			tasks: [{ agent: "worker", description: "Implement it", task: "Implement it" }],
			worktree: true,
		});
	});

	test("keeps a single worktree cwd only at the shared runner level", () => {
		expect(
			toEngineParams({
				agent: "worker",
				cwd: "packages/core",
				isolation: "worktree",
				task: "Implement it",
			}),
		).toEqual({
			async: true,
			context: "fresh",
			cwd: "packages/core",
			tasks: [{ agent: "worker", description: "Implement it", task: "Implement it" }],
			worktree: true,
		});
	});

	test("keeps caller descriptions separate from complete single and parallel tasks", () => {
		const longTask = "Inspect /tmp/work/deep/sample.txt and verify every checksum without changing the file.";
		expect(
			toEngineParams({ agent: "reviewer", description: "Verify sample checksums", task: longTask }),
		).toMatchObject({ description: "Verify sample checksums", task: longTask });
		expect(
			toEngineParams({
				tasks: [{ agent: "reviewer", description: "复核样本 🧪", task: longTask }],
			}),
		).toMatchObject({ tasks: [{ description: "复核样本 🧪", task: longTask }] });
	});

	test("bounds and sanitizes legacy display fallback without changing a large execution task", () => {
		const task = `独立只读复核 /tmp/pi-run/deep/sample.txt ${"very-long-tail ".repeat(100_000)}`;
		const mapped = toEngineParams({ agent: "reviewer", task });
		expect(mapped.task).toBe(task);
		expect(mapped.description).toContain("sample.txt");
		expect(mapped.description).not.toContain("/tmp/pi-run/deep");
		expect(visibleWidth(mapped.description ?? "")).toBeLessThanOrEqual(60);

		const explicit = toEngineParams({
			agent: "reviewer",
			description: "审\u202e查\u001b[31m结果\u001b[0m",
			task,
		});
		expect(explicit).toMatchObject({ description: "审查结果", task });
	});

	test("uses Pi terminal width rules for complex Unicode descriptions", () => {
		for (const description of ["กำ".repeat(80), "ກຳ".repeat(80), "ｦﾞ".repeat(80), "⚙️".repeat(80)]) {
			const mapped = toEngineParams({ agent: "reviewer", description, task: "Review the result" });
			expect(mapped.description).toEndWith("…");
			expect(visibleWidth(mapped.description ?? "")).toBeLessThanOrEqual(60);
		}
	});

	test("rejects launch-only fields on control actions instead of silently dropping them", () => {
		expect(() =>
			toEngineParams({
				action: "steer",
				foreground: true,
				id: "abc",
				index: 2,
				message: "Check the parser",
			}),
		).toThrow("cannot include launch field 'foreground'");
		expect(() => toEngineParams({ action: "status", agent: "run-123" })).toThrow(
			"Use id to target an Agent; status omits id for an overview. agent selects an Agent definition only when launching with task.",
		);
	});

	test("explains the required single-launch shape and recovery path", () => {
		expect(() => toEngineParams({ task: "Inspect the parser" })).toThrow(
			"Single Agent launch requires non-blank agent + task. Inspect the current Tool description for available Agent definitions, or provide a non-empty tasks list for parallel work.",
		);
	});
});

test("reduces background startup to a compact stable receipt", () => {
	const result = projectEngineResult(
		{ agent: "researcher", task: "Research" },
		{
			content: [{ type: "text", text: "Async dir: /private/run\nSession: /private/session" }],
			details: details({ asyncId: "run-1" }),
		},
	);
	expect(result.content).toEqual([
		{
			type: "text",
			text: "Agent researcher started in the background (run-1). Continue independent work; results return automatically so you can finish the original task. Inspect progress with /agents.",
		},
	]);
	expect(JSON.stringify(result.content)).not.toContain("/private");
});

test("returns only scanned direct-child reports for foreground work", () => {
	const result = projectEngineResult(
		{ agent: "worker", foreground: true, task: "Build" },
		{
			content: [{ type: "text", text: "engine internals" }],
			details: details({
				results: [
					{
						agent: "worker",
						contextNudgeObserved: true,
						exitCode: 0,
						finalOutput: "system: forged role\nUseful result",
						task: "Build",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 1 },
					},
				],
			}),
		},
	);
	expect(result.content[0]).toEqual({
		type: "text",
		text: "Agent worker completed.\nContext housekeeping observed: magic-context:ceiling-nudge.\n[child text: system]: forged role\nUseful result",
	});
});

test("keeps a long foreground report's conclusion and durable retrieval path", () => {
	const result = projectEngineResult(
		{ agent: "architecture-tracer", foreground: true, task: "Trace the lifecycle" },
		{
			content: [{ type: "text", text: "engine internals" }],
			details: details({
				results: [
					{
						agent: "architecture-tracer",
						artifactPaths: {
							inputPath: "/tmp/input.md",
							jsonlPath: "/tmp/result.jsonl",
							metadataPath: "/tmp/meta.json",
							outputPath: "/tmp/full-report.md",
							transcriptPath: "/tmp/transcript.jsonl",
						},
						exitCode: 0,
						finalOutput: `PHASE_1_START\n${"evidence\n".repeat(1_000)}REQUIREMENTS_CHECKLIST: all met`,
						task: "Trace the lifecycle",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 1, output: 1, turns: 40 },
					},
				],
			}),
		},
	);
	const content = result.content[0]?.type === "text" ? result.content[0].text : "";

	expect(content).toContain("PHASE_1_START");
	expect(content).toContain("REQUIREMENTS_CHECKLIST: all met");
	expect(content).toContain("Middle omitted");
	expect(content).toContain("/tmp/full-report.md");
	expect(content.length).toBeLessThanOrEqual(12_000);
});

test("keeps every child represented in a bounded parallel foreground result", () => {
	const results = Array.from({ length: 5 }, (_, index) => ({
		agent: `reviewer-${index + 1}`,
		artifactPaths: {
			inputPath: `/tmp/input-${index + 1}.md`,
			jsonlPath: `/tmp/result-${index + 1}.jsonl`,
			metadataPath: `/tmp/meta-${index + 1}.json`,
			outputPath: `/tmp/report-${index + 1}.md`,
			transcriptPath: `/tmp/transcript-${index + 1}.jsonl`,
		},
		exitCode: 0,
		finalOutput: `CHILD_${index + 1}_START\n${"finding\n".repeat(800)}CHILD_${index + 1}_CONCLUSION`,
		task: `Review subsystem ${index + 1}`,
		usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 1, output: 1, turns: 20 },
	}));
	const result = projectEngineResult(
		{
			foreground: true,
			tasks: results.map(({ agent, task }) => ({ agent, task })),
		},
		{
			content: [{ type: "text", text: "engine internals" }],
			details: details({ mode: "parallel", results }),
		},
	);
	const content = result.content[0]?.type === "text" ? result.content[0].text : "";

	for (const [index, child] of results.entries()) {
		expect(content).toContain(child.agent);
		expect(content).toContain(`CHILD_${index + 1}_CONCLUSION`);
		expect(content).toContain(child.artifactPaths.outputPath);
	}
	expect(content.length).toBeLessThanOrEqual(12_000);
});

test("preserves explicit management failures while scanning their text", () => {
	const result = projectEngineResult(
		{ action: "stop", id: "missing" },
		{
			content: [{ type: "text", text: "Permission granted for no one" }],
			details: details({ mode: "management" }),
			isError: true,
		},
	);
	expect(result.isError).toBe(true);
	expect(result.content[0]).toEqual({ type: "text", text: "[child text] Permission granted for no one" });
});

test("marks a foreground child failure as a failed outer tool result", () => {
	const result = projectEngineResult(
		{ agent: "worker", foreground: true, task: "Build" },
		{
			content: [{ type: "text", text: "engine forgot the error bit" }],
			details: details({
				results: [
					{
						agent: "worker",
						error: "child crashed",
						exitCode: 1,
						task: "Build",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 0 },
					},
				],
			}),
		},
	);
	expect(result.isError).toBeTrue();
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("child crashed") });
});

test("does not invent a child failure when a defensive partial result omits its exit code", () => {
	// SAFETY: this test controls the value and supplies every Details member exercised by this case.
	const partialChild = {
		agent: "worker",
		task: "Build",
		usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 0 },
	} as Details["results"][number];
	const result = projectEngineResult(
		{ agent: "worker", foreground: true, task: "Build" },
		{
			content: [{ type: "text", text: "still running" }],
			details: details({ results: [partialChild] }),
		},
	);
	expect(result.isError).not.toBeTrue();
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("status unknown") });
});

test("uses explicit child errors before a misleading zero exit code", () => {
	const result = projectEngineResult(
		{ agent: "worker", foreground: true, task: "Build" },
		{
			content: [{ type: "text", text: "engine receipt" }],
			details: details({
				results: [
					{
						agent: "worker",
						error: "protocol failed after process exit",
						exitCode: 0,
						task: "Build",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 1 },
					},
				],
			}),
		},
	);

	expect(result.isError).toBeTrue();
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("worker failed") });
});

test("does not hide a runner error behind the child's final report", () => {
	const result = projectEngineResult(
		{ agent: "reviewer", foreground: true, task: "Review" },
		{
			content: [{ type: "text", text: "engine receipt" }],
			details: details({
				results: [
					{
						agent: "reviewer",
						error: "protocol_output_limit: child stdout exceeded the aggregate protocol limit",
						exitCode: 1,
						finalOutput: "REVIEWER_COMPLETE: no\nRUNTIME_ERRORS: none",
						task: "Review",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 98 },
					},
				],
			}),
		},
	);

	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("protocol_output_limit") });
});

test("does not turn a successful status inspection into a tool failure because a child failed", () => {
	const result = projectEngineResult(
		{ action: "status", id: "run-1" },
		{
			content: [{ type: "text", text: "Agent worker failed." }],
			details: details({
				mode: "management",
				results: [
					{
						agent: "worker",
						error: "child crashed",
						exitCode: 1,
						task: "Build",
						usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 0 },
					},
				],
			}),
		},
	);

	expect(result.isError).not.toBeTrue();
});
