import { afterEach, expect, test } from "bun:test";
import {
	boundStreamedRecentOutput,
	cleanupToolPresentationFixtures,
	createAgentToolPresentation,
	extractToolArgsPreview,
	isRuntimeFunction,
	isWellFormed,
	visibleWidth,
} from "../../agents/tool-presentation-fixtures.js";

afterEach(cleanupToolPresentationFixtures);

test("Agent Tool rows use short targets and honest lifecycle summaries", () => {
	const presentation = createAgentToolPresentation();
	const fullTask = "Inspect /tmp/pi-run/deep/sample.txt and verify every checksum without changing the file.";
	expect(presentation.target?.({ agent: "reviewer", description: "Verify sample checksums", task: fullTask })).toBe(
		"launch · reviewer · Verify sample checksums",
	);
	expect(
		presentation.target?.({
			tasks: [
				{ agent: "reviewer", description: "复核样本 🧪", task: fullTask },
				{ agent: "writer", description: "Update fixture docs", task: "Update every relevant fixture document." },
			],
		}),
	).toBe("launch · reviewer · 复核样本 🧪, writer · Update fixture docs");
	expect(
		presentation.target?.({
			tasks: [
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				{} as never,
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				{ agent: undefined, description: undefined, task: undefined } as never,
				{ agent: "reviewer", task: "Inspect the partial payload." },
			],
		}),
	).toBe("launch · reviewer · Inspect the partial payload.");
	expect(presentation.target?.({ agent: "reviewer", foreground: true, task: "Review" })).toBe(
		"run · reviewer · Review",
	);
	expect(presentation.target?.({})).toBe("");
	const longReport = {
		content: [
			{ type: "text" as const, text: "Agent general-purpose returned a deliberately long final report.".repeat(20) },
		],
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		details: { asyncId: "run-1", mode: "parallel", results: [] } as never,
	};
	expect(presentation.summarize?.({ agent: "reviewer", task: fullTask }, longReport, "success", 18_000)).toBe(
		"launched",
	);
	expect(
		presentation.summarize?.(
			{
				tasks: [
					{ agent: "reviewer", task: fullTask },
					{ agent: "writer", task: "Update fixture docs." },
				],
			},
			longReport,
			"success",
			18_000,
		),
	).toBe("2 launched");
	expect(
		presentation.summarize?.({ agent: "reviewer", foreground: true, task: fullTask }, longReport, "success", 18_000),
	).toBe("finished · 18s");
	expect(presentation.summarize?.({ action: "resume", id: "run-1" }, longReport, "success", 18_000)).toBe("resumed");
	expect(presentation.summarize?.({ action: "steer", id: "run-1" }, longReport, "success", 18_000)).toBe("sent");
	expect(presentation.summarize?.({ action: "stop", id: "run-1" }, longReport, "success", 18_000)).toBe("stopped");
	expect(presentation.summarize?.({ action: "status", id: "run-1" }, longReport, "success", 18_000)).toBe("checked");
	expect(presentation.summarize?.({}, longReport, "cancelled", 18_000)).toBe("cancelled");
});

test("Agent expansion lists full member tasks and bounds foreground evidence through the shared renderer", () => {
	const presentation = createAgentToolPresentation();
	const parallelArgs = {
		tasks: [
			{ agent: "reviewer", task: "Review the complete change." },
			{ agent: "tester", task: "Run the complete test matrix." },
		],
	};
	const launched = {
		content: [{ type: "text" as const, text: "2 Agents started." }],
		// SAFETY: this fixture supplies the exact Agent result fields read by presentation.
		details: { asyncId: "run-2", mode: "parallel", results: [] } as never,
	};
	expect(presentation.detailLines?.(parallelArgs, launched, "success")).toEqual([
		"reviewer · Review the complete change. · launched",
		"tester · Run the complete test matrix. · launched",
	]);
	const foreground = {
		content: [
			{
				type: "text" as const,
				text: "Agent reviewer completed.\nVerified the implementation.\nAll checks passed.",
			},
		],
		// SAFETY: this fixture supplies the exact Agent result fields read by presentation.
		// SAFETY: this fixture supplies the exact public Agent result fields read by presentation.
		details: {
			mode: "single",
			results: [{ agent: "reviewer", error: undefined, exitCode: 0, task: "Review the complete change." }],
		} as never,
	};
	expect(
		presentation.detailLines?.(
			{ agent: "reviewer", foreground: true, task: "Review the complete change." },
			foreground,
			"success",
		),
	).toEqual([
		"reviewer · Review the complete change. · finished",
		"",
		"Verified the implementation.",
		"All checks passed.",
	]);
	expect(
		presentation.detailSections?.({ agent: "reviewer", foreground: true, task: "Review" }, foreground, "success"),
	).toEqual([
		{ lines: ["reviewer · Review · finished"], title: "Task" },
		{ lines: ["Verified the implementation.", "All checks passed."], title: "Result" },
	]);

	const grouped = {
		content: [
			{
				type: "text" as const,
				text: "1. reviewer — completed\nReview evidence.\n\n2. tester — completed\nTest evidence.",
			},
		],
		// SAFETY: this fixture supplies the exact public Agent result fields read by presentation.
		details: {
			mode: "parallel",
			results: [
				{ agent: "reviewer", exitCode: 0, task: "Review the complete change." },
				{ agent: "tester", exitCode: 0, task: "Run the complete test matrix." },
			],
		} as never,
	};
	const groupedDetail = presentation.detailLines?.({ ...parallelArgs, foreground: true }, grouped, "success") ?? [];
	expect(groupedDetail.join("\n")).toContain("Review evidence.");
	expect(groupedDetail.join("\n")).toContain("Test evidence.");
	expect(groupedDetail.join("\n")).not.toMatch(/\d+\..+completed/u);
});

test("Agent Tool activities reflect launches, refusals, and foreground runs", () => {
	const presentation = createAgentToolPresentation();
	const fullTask = "Inspect /tmp/pi-run/deep/sample.txt and verify every checksum without changing the file.";
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const backgroundActivities = presentation.activity?.classify({
		args: { agent: "reviewer", task: fullTask },
		result: { content: [], details: { asyncId: "run-1", mode: "single", results: [] } },
		state: "success",
		toolCallId: "agent-background",
	} as never);
	expect(backgroundActivities).toHaveLength(1);
	expect(backgroundActivities?.[0]).toMatchObject({ category: "launch-agent", count: 1 });
	const parallelArgs = {
		tasks: [
			{ agent: "reviewer", task: "Review the change." },
			{ agent: "tester", task: "Run the tests." },
			{ agent: "writer", task: "Check the docs." },
		],
	};
	expect(isRuntimeFunction(presentation.label) ? presentation.label(parallelArgs) : presentation.label).toBe("Agents");
	expect(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		presentation.activity?.classify({
			args: parallelArgs,
			state: "running",
			toolCallId: "agent-streaming",
		} as never),
	).toEqual([]);
	const refused = {
		content: [{ type: "text" as const, text: "Fork preflight refused before any Agent launched." }],
		details: { mode: "parallel" as const, results: [] },
		isError: true,
	};
	expect(presentation.resultIsError?.(parallelArgs, refused)).toBeTrue();
	expect(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		presentation.activity?.classify({
			args: parallelArgs,
			result: refused,
			state: "error",
			toolCallId: "agent-refused",
		} as never),
	).toEqual([]);
	const launched = {
		content: [{ type: "text" as const, text: "3 Agents started in the background (run-2)." }],
		details: { asyncId: "run-2", mode: "parallel" as const, results: [] },
	};
	expect(presentation.resultIsError?.(parallelArgs, launched)).toBeFalse();
	expect(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		presentation.activity?.classify({
			args: parallelArgs,
			result: launched,
			state: "success",
			toolCallId: "agent-launched",
		} as never),
	).toEqual([
		{
			category: "launch-agent",
			count: 3,
			target: "launch · reviewer · Review the change., tester · Run the tests., writer · Check the docs.",
		},
	]);
	expect(presentation.summarize?.(parallelArgs, launched, "success", 18_000)).toBe("3 launched");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const foregroundActivities = presentation.activity?.classify({
		args: { ...parallelArgs, foreground: true },
		result: { content: [], details: { mode: "parallel", results: [{}, {}] } },
		state: "success",
		toolCallId: "agent-foreground",
	} as never);
	expect(foregroundActivities).toEqual([
		{
			category: "run-agent",
			count: 2,
			target: "run · reviewer · Review the change., tester · Run the tests., writer · Check the docs.",
		},
	]);
	expect(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		presentation.activity?.classify({
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			args: { tasks: [{} as never] },
			state: "running",
			toolCallId: "agent-partial",
		} as never),
	).toEqual([]);
});

test("Agent Tool activities omit pre-launch cancellation and classify controls", () => {
	const presentation = createAgentToolPresentation();
	const fullTask = "Inspect /tmp/pi-run/deep/sample.txt and verify every checksum without changing the file.";
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const cancelledBeforeLaunch = presentation.activity?.classify({
		args: { agent: "reviewer", foreground: true, task: fullTask },
		result: {
			content: [{ type: "text", text: "Cancelled before launch" }],
			details: { mode: "single", results: [] },
		},
		state: "cancelled",
		toolCallId: "agent-cancelled-before-launch",
	} as never);
	expect(cancelledBeforeLaunch).toEqual([]);
	for (const [action, category] of [
		["status", "check-agent"],
		["steer", "steer-agent"],
		["stop", "stop-agent"],
		["resume", "resume-agent"],
	] as const) {
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		const managedActivities = presentation.activity?.classify({
			args: { action, id: "run-1" },
			result: { content: [], details: { mode: "control", results: [] } },
			state: "success",
			toolCallId: `agent-${action}`,
		} as never);
		expect(managedActivities?.[0]).toMatchObject({ category });
	}
});

test("bounds live Agent arguments and streamed text by grapheme and terminal cells", () => {
	const args = extractToolArgsPreview({ query: "😀".repeat(31) });
	const output = boundStreamedRecentOutput([`\u001b[31m${"界".repeat(1_100)}\u001b[0m`])[0] ?? "";
	for (const [value, width] of [
		[args, 60],
		[output, 2_000],
	] as const) {
		expect(visibleWidth(value)).toBeLessThanOrEqual(width);
		expect(isWellFormed(value)).toBeTrue();
		expect(value).not.toContain("\u001b");
	}
	expect(args).toEndWith("...");
	expect(output).toEndWith("… [truncated]");

	const presentation = createAgentToolPresentation();
	const issue = presentation.summarize?.(
		{ agent: "reviewer", foreground: true, task: "Inspect" },
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		{ content: [{ type: "text", text: `\u001b[31m${"失败".repeat(100)}\u001b[0m` }], details: {} as never },
		"error",
		1,
	);
	expect(visibleWidth(issue ?? "")).toBeLessThanOrEqual(160);
	expect(issue).not.toContain("\u001b");
});
