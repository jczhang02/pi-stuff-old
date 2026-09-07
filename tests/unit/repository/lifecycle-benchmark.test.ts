import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	type Action,
	type CellSummary,
	type LifecycleAcceptanceSelection,
	lifecycleAcceptanceFindings,
	lifecycleConfirmationTargets,
	lifecycleExpectProgram,
	lifecycleSessionFindings,
	percentile,
	type Scenario,
	summarize,
	type TerminalSize,
	type Variant,
} from "../../../scripts/benchmark-lifecycle.js";

const ACTIONS = ["exit", "ctrl-c", "reload", "reload-change", "prompt", "background-exit", "agent-exit"] as const;
const SCENARIOS = ["fresh", "resume-short", "resume-long", "degraded"] as const;
const SIZES = [
	{ columns: 100, rows: 32 },
	{ columns: 64, rows: 28 },
] as const;
const VARIANTS = ["host", "suite"] as const;

function metric(p95 = 1) {
	return { maximum: p95, minimum: 1, p50: 1, p95, samples: 3 };
}

function selection(overrides: Partial<LifecycleAcceptanceSelection> = {}): LifecycleAcceptanceSelection {
	return {
		actions: ACTIONS,
		contextEnabled: true,
		longSessionToolBytes: 8_192,
		longSessionTools: 6_500,
		samples: 3,
		scenarios: SCENARIOS,
		sizes: SIZES,
		trace: true,
		variants: VARIANTS,
		warmups: 1,
		...overrides,
	};
}

function cell(variant: Variant, scenario: Scenario, action: Action, size: TerminalSize): CellSummary {
	const result: CellSummary = {
		action,
		columns: size.columns,
		rows: size.rows,
		scenario,
		shutdown: metric(),
		startup: metric(),
		variant,
		warmups: 1,
	};
	if (action === "prompt") {
		Object.assign(result, {
			acknowledgement: metric(),
			providerStart: metric(),
			response: metric(),
			steadyAcknowledgement: metric(),
			steadyProviderStart: metric(),
			steadyResponse: metric(),
		});
	}
	if (action === "agent-exit") Object.assign(result, { interrupt: metric() });
	if (action === "reload" || action === "reload-change") Object.assign(result, { reload: metric() });
	return result;
}

function acceptanceCells(): CellSummary[] {
	return SIZES.flatMap((size) =>
		SCENARIOS.flatMap((scenario) =>
			ACTIONS.flatMap((action) => {
				if (
					((action === "background-exit" || action === "agent-exit") &&
						scenario !== "fresh" &&
						scenario !== "resume-long") ||
					(action === "reload-change" && (scenario !== "fresh" || size.columns !== 100 || size.rows !== 32))
				) {
					return [];
				}
				const variants: readonly Variant[] =
					action === "background-exit" || action === "agent-exit" || action === "reload-change"
						? ["suite"]
						: VARIANTS;
				return variants.map((variant) => cell(variant, scenario, action, size));
			}),
		),
	);
}

function sessionEntries(messages: readonly object[] = []): unknown[] {
	return [
		{ type: "session", version: 3 },
		{
			type: "model_change",
			provider: "pi-stuff-lifecycle-benchmark",
			modelId: "fixture-model",
		},
		...messages.map((message) => ({ type: "message", message })),
	];
}

test("waits for real Editor input instead of sleeping after visible markers", () => {
	for (const action of ACTIONS) {
		const program = lifecycleExpectProgram(action, false);
		expect(program).toContain("wait_for_initial_editor");
		expect(program).toContain("must_editor_ready");
		expect(program.match(/set timeout 0/gu)).toHaveLength(2);
		expect(program).not.toMatch(/after (?:60|80)\\b/u);
	}
	const prompt = lifecycleExpectProgram("prompt", false);
	expect(prompt).toContain(`puts "PS5BW_METRIC \${name}_us`);
	expect(prompt).toContain('must_expect "PS5BW_INPUT_ACK_PS5BW_FIRST_PROMPT"');
	expect(prompt).toContain(
		'must_expect_prompt_ready "PS5BW_EDITOR_CLEARED_PS5BW_FIRST_PROMPT" "PS5BW_PROVIDER_START_FIRST"',
	);
	expect(prompt).toContain("report_metric provider_start");
	expect(prompt).toContain("report_metric steady_provider_start");
	expect(prompt).toContain('must_editor_ready "PS5BW_STEADY_EDITOR_READY"');
	expect(prompt).toContain('must_editor_ready "PS5BW_SHUTDOWN_EDITOR_READY"');
	const ctrlC = lifecycleExpectProgram("ctrl-c", false);
	expect(ctrlC.split('send -- "\\003"')).toHaveLength(3);
	const agentExit = lifecycleExpectProgram("agent-exit", false);
	expect(agentExit).toContain("must_file $env(PS5BW_AGENT_SHELL_PID)");
	expect(agentExit).toContain("must_file $env(PS5BW_AGENT_DESCENDANT_PID)");
	expect(agentExit).toContain('send -- "\\003"');
	expect(agentExit).toContain('must_editor_ready "PS5BW_AGENT_EXIT_EDITOR_READY"');
	expect(agentExit).toContain("report_metric interrupt");
});

test("aggregates repeated steady Prompt timings inside one real Host process", () => {
	const program = lifecycleExpectProgram("prompt", false, 5);
	expect(program).toContain("for {set steady_iteration 0} {$steady_iteration < 5} {incr steady_iteration}");
	expect(program).toContain('set steady_prompt "PS5BW_STEADY_PROMPT_$steady_iteration"');
	expect(program).toContain("set acknowledged [clock microseconds]");
	expect(program).toContain("return [list [expr {$acknowledged - $started}]");
	expect(program).toContain("lappend steady_acknowledgements");
	expect(program).toContain("report_metric steady_acknowledgement 0 [nearest_rank_p50 $steady_acknowledgements]");
});

test("timestamps the first input acknowledgement before waiting for Editor clear", () => {
	const program = lifecycleExpectProgram("prompt", false);
	const acknowledgement = "set first_acknowledged [clock microseconds]";
	const editorReady =
		'must_expect_prompt_ready "PS5BW_EDITOR_CLEARED_PS5BW_FIRST_PROMPT" "PS5BW_PROVIDER_START_FIRST"';
	expect(program).toContain(acknowledgement);
	expect(program.indexOf(acknowledgement)).toBeLessThan(program.indexOf(editorReady));
	expect(program).toContain("report_metric acknowledgement $response_started $first_acknowledged");
	const steadyAcknowledgement = "set steady_acknowledged [clock microseconds]";
	const steadyEditorReady =
		'must_expect_prompt_ready "PS5BW_EDITOR_CLEARED_PS5BW_SECOND_PROMPT" "PS5BW_PROVIDER_START_SECOND"';
	expect(program).toContain(steadyAcknowledgement);
	expect(program.indexOf(steadyAcknowledgement)).toBeLessThan(program.indexOf(steadyEditorReady));
	expect(program).toContain("report_metric steady_acknowledgement $steady_response_started $steady_acknowledged");
});

test("settles the final Editor clear before starting timed work", () => {
	const program = lifecycleExpectProgram("prompt", false);
	expect(program).toContain('send -- "\\025"\n                after 20\n                return');
});

test("rejects an invalid repeated Prompt count at the benchmark CLI boundary", () => {
	const result = Bun.spawnSync(
		["bun", join(import.meta.dir, "../../../scripts/benchmark-lifecycle.ts"), "--prompt-repetitions", "0"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).not.toBe(0);
	expect(`${result.stdout.toString()}\n${result.stderr.toString()}`).toContain(
		"--prompt-repetitions must be an integer from 1 through 100",
	);
});

test("keeps repeated Prompt aggregation outside certifying acceptance", () => {
	const result = Bun.spawnSync(
		[
			"bun",
			join(import.meta.dir, "../../../scripts/benchmark-lifecycle.ts"),
			"--acceptance",
			"--prompt-repetitions",
			"2",
			"--pi",
			join(import.meta.dir, "missing-pi"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).not.toBe(0);
	expect(`${result.stdout.toString()}\n${result.stderr.toString()}`).toContain(
		"--prompt-repetitions is diagnostic-only and cannot be combined with --acceptance",
	);
});

test("uses nearest-rank percentiles", () => {
	const values = Array.from({ length: 20 }, (_value, index) => index + 1);
	expect(percentile(values, 0.5)).toBe(10);
	expect(percentile(values, 0.95)).toBe(19);
});

test("reports bounded, rounded summaries", () => {
	expect(summarize([3.456, 1.234, 2.345])).toEqual({
		maximum: 3.46,
		minimum: 1.23,
		p50: 2.35,
		p95: 3.46,
		samples: 3,
	});
});

test("accepts only a complete traced matrix within every p95 budget", () => {
	expect(lifecycleAcceptanceFindings(selection(), acceptanceCells())).toEqual([]);
});

test("reports bypassed coverage and the exact over-budget cell", () => {
	const cells = acceptanceCells().map((candidate) => {
		if (candidate.variant !== "suite") return candidate;
		if (candidate.scenario === "resume-long" && candidate.columns === 64) {
			if (candidate.action === "reload") return { ...candidate, reload: metric(2_501) };
			if (candidate.action === "background-exit") return { ...candidate, shutdown: metric(376) };
		}
		if (candidate.scenario === "fresh" && candidate.columns === 100) {
			if (candidate.action === "ctrl-c") return { ...candidate, shutdown: metric(251) };
			if (candidate.action === "reload-change") return { ...candidate, reload: metric(8_001) };
		}
		return candidate;
	});
	const findings = lifecycleAcceptanceFindings(
		selection({
			actions: ACTIONS.filter((action) => action !== "agent-exit"),
			contextEnabled: false,
			longSessionToolBytes: 0,
			longSessionTools: 0,
			trace: false,
		}),
		cells,
	);
	expect(findings).toContain("coverage requires Host and Suite lifecycle tracing");
	expect(findings).toContain("coverage requires the shipped Context capability to remain enabled");
	expect(findings).toContain("coverage requires at least 6000 historical Tool results");
	expect(findings).toContain("coverage requires at least 8192 bytes per historical Tool result");
	expect(findings).toContain("coverage is missing action agent-exit");
	expect(findings).toContain("suite/fresh/ctrl-c/100x32 shutdown p95 251.00ms exceeds 250ms");
	expect(findings).toContain("suite/fresh/reload-change/100x32 reload p95 8001.00ms exceeds 8000ms");
	expect(findings).toContain("suite/resume-long/reload/64x28 reload p95 2501.00ms exceeds 2500ms");
	expect(findings).toContain("suite/resume-long/background-exit/64x28 shutdown p95 376.00ms exceeds 375ms");
});

test("accepts a one-batch scheduler outlier only after an independent confirmation passes", () => {
	const cells = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" &&
		candidate.scenario === "fresh" &&
		candidate.action === "exit" &&
		candidate.columns === 64
			? { ...candidate, startup: metric(2_701) }
			: candidate,
	);
	const target = cells.find(
		(candidate) =>
			candidate.variant === "suite" &&
			candidate.scenario === "fresh" &&
			candidate.action === "exit" &&
			candidate.columns === 64,
	);
	if (!target) throw new Error("missing lifecycle test target");
	expect(lifecycleConfirmationTargets(cells)).toEqual([target]);
	expect(lifecycleAcceptanceFindings(selection(), cells, [cell("suite", "fresh", "exit", SIZES[1])])).toEqual([]);
});

test("still fails a performance regression repeated by the confirmation batch", () => {
	const cells = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" &&
		candidate.scenario === "fresh" &&
		candidate.action === "exit" &&
		candidate.columns === 64
			? { ...candidate, startup: metric(2_701) }
			: candidate,
	);
	const confirmation = { ...cell("suite", "fresh", "exit", SIZES[1]), startup: metric(2_702) };
	const findings = lifecycleAcceptanceFindings(selection(), cells, [confirmation]);
	expect(findings).toContain("suite/fresh/exit/64x28 startup p95 2701.00ms exceeds 2700ms");
	expect(findings).toContain("suite/fresh/exit/64x28 startup confirmation p95 2702.00ms also exceeds 2700ms");
});

test("bounds Suite startup against the paired Host baseline", () => {
	const freshCells = acceptanceCells().map((candidate) => {
		if (candidate.scenario !== "fresh" || candidate.action !== "exit" || candidate.columns !== 100) {
			return candidate;
		}
		return { ...candidate, startup: metric(candidate.variant === "host" ? 439 : 2_690) };
	});
	const freshTarget = freshCells.find(
		(candidate) =>
			candidate.variant === "suite" &&
			candidate.scenario === "fresh" &&
			candidate.action === "exit" &&
			candidate.columns === 100,
	);
	if (!freshTarget) throw new Error("missing paired lifecycle test target");
	expect(lifecycleConfirmationTargets(freshCells)).toEqual([freshTarget]);
	expect(lifecycleAcceptanceFindings(selection(), freshCells)).toContain(
		"suite/fresh/exit/100x32 startup overhead 2251.00ms exceeds Host by 2250ms",
	);

	const cells = acceptanceCells().map((candidate) => {
		if (candidate.scenario !== "resume-long" || candidate.action !== "exit" || candidate.columns !== 100) {
			return candidate;
		}
		return { ...candidate, startup: metric(candidate.variant === "host" ? 5_000 : 7_251) };
	});
	expect(lifecycleAcceptanceFindings(selection(), cells)).toContain(
		"suite/resume-long/exit/100x32 startup overhead 2251.00ms exceeds Host by 2250ms",
	);
});

test("requires complete samples and warmups for every action metric and its confirmation", () => {
	const cells = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" && candidate.scenario === "fresh" && candidate.action === "prompt"
			? { ...candidate, response: { ...metric(), samples: 2 }, warmups: 0 }
			: candidate,
	);
	expect(lifecycleAcceptanceFindings(selection(), cells)).toContain(
		"suite/fresh/prompt/100x32 response has only 2 measured samples",
	);
	expect(lifecycleAcceptanceFindings(selection(), cells)).toContain("suite/fresh/prompt/100x32 has only 0 warmups");

	const overBudget = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" &&
		candidate.scenario === "fresh" &&
		candidate.action === "exit" &&
		candidate.columns === 64
			? { ...candidate, startup: metric(2_701) }
			: candidate,
	);
	const shortConfirmation = {
		...cell("suite", "fresh", "exit", SIZES[1]),
		startup: { ...metric(2_600), samples: 2 },
	};
	expect(lifecycleAcceptanceFindings(selection(), overBudget, [shortConfirmation])).toContain(
		"suite/fresh/exit/64x28 startup confirmation has only 2 measured samples",
	);
	const coldConfirmation = { ...cell("suite", "fresh", "exit", SIZES[1]), warmups: 0 };
	expect(lifecycleAcceptanceFindings(selection(), overBudget, [coldConfirmation])).toContain(
		"suite/fresh/exit/64x28 confirmation has only 0 warmups",
	);
});

test("requires every Host and Suite action metric", () => {
	const cells = acceptanceCells().map((candidate) => {
		if (
			candidate.variant !== "host" ||
			candidate.scenario !== "fresh" ||
			candidate.action !== "prompt" ||
			candidate.columns !== 100
		) {
			return candidate;
		}
		const { steadyResponse: _steadyResponse, ...withoutSteadyResponse } = candidate;
		return withoutSteadyResponse;
	});
	expect(lifecycleAcceptanceFindings(selection(), cells)).toContain(
		"host/fresh/prompt/100x32 is missing steadyResponse",
	);
});

test("enforces steady-state prompt latency budgets", () => {
	const cells = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" &&
		candidate.scenario === "fresh" &&
		candidate.action === "prompt" &&
		candidate.columns === 100
			? {
					...candidate,
					providerStart: metric(801),
					steadyAcknowledgement: metric(16),
					steadyProviderStart: metric(101),
					steadyResponse: metric(151),
				}
			: candidate,
	);
	const findings = lifecycleAcceptanceFindings(selection(), cells);
	expect(findings).toContain("suite/fresh/prompt/100x32 steadyAcknowledgement p95 16.00ms exceeds 15ms");
	expect(findings).toContain("suite/fresh/prompt/100x32 providerStart p95 801.00ms exceeds 800ms");
	expect(findings).toContain("suite/fresh/prompt/100x32 steadyProviderStart p95 101.00ms exceeds 100ms");
	expect(findings).toContain("suite/fresh/prompt/100x32 steadyResponse p95 151.00ms exceeds 150ms");
});

test("enforces foreground Agent interrupt latency", () => {
	const cells = acceptanceCells().map((candidate) =>
		candidate.variant === "suite" &&
		candidate.scenario === "fresh" &&
		candidate.action === "agent-exit" &&
		candidate.columns === 100
			? { ...candidate, interrupt: metric(1_001) }
			: candidate,
	);
	expect(lifecycleAcceptanceFindings(selection(), cells)).toContain(
		"suite/fresh/agent-exit/100x32 interrupt p95 1001.00ms exceeds 1000ms",
	);
});

test("requires durable resumed history and matching Background Tool receipts", () => {
	const entries = sessionEntries([
		{ role: "assistant", content: [{ type: "text", text: "PS5BW_SESSION_TAIL_long" }] },
		{ role: "user", content: "PS5BW_BACKGROUND_PROMPT" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "ps5bw-background-launch", name: "bash", arguments: {} }],
		},
		{ role: "toolResult", toolCallId: "ps5bw-background-launch", content: [] },
		{ role: "assistant", content: [{ type: "text", text: "PS5BW_BACKGROUND_READY" }] },
	]);
	expect(lifecycleSessionFindings(entries, "background-exit", "resume-long")).toEqual([]);
	expect(
		lifecycleSessionFindings(
			entries.filter((entry) => !JSON.stringify(entry).includes("toolResult")),
			"background-exit",
			"resume-long",
		),
	).toContain("Session JSONL lost Tool result receipt ps5bw-background-launch");
});

test("requires the real-shape long Session to retain every seeded Tool result", () => {
	const findings = lifecycleSessionFindings(
		sessionEntries([
			{ role: "assistant", content: [{ type: "text", text: "PS5BW_SESSION_TAIL_long" }] },
			{ role: "toolResult", toolCallId: "ps5bw-history-tool-0", content: [] },
		]),
		"exit",
		"resume-long",
		6_500,
	);
	expect(findings).toContain("Session JSONL retained only 1 of 6500 historical Tool results");
});

test("requires representative long Tool payloads to retain exact content and size", () => {
	const toolResult = (index: number, text: string) => ({
		role: "toolResult",
		toolCallId: `ps5bw-history-tool-${String(index)}`,
		content: [{ type: "text", text }],
	});
	const payload = (index: number) => `PS5BW_HISTORY_PAYLOAD_${String(index)}\n${"x".repeat(8_192)}`.slice(0, 8_192);
	const findings = lifecycleSessionFindings(
		sessionEntries([
			{ role: "assistant", content: [{ type: "text", text: "PS5BW_SESSION_TAIL_long" }] },
			toolResult(0, payload(0)),
			toolResult(3_250, payload(3_250)),
			toolResult(6_499, "PS5BW_HISTORY_PAYLOAD_6499\nshort"),
		]),
		"exit",
		"resume-long",
		6_500,
		8_192,
	);
	expect(findings).toContain("Session JSONL retained only 3 of 6500 historical Tool results");
	expect(findings).toContain("Session JSONL historical Tool 6499 has 32 bytes instead of 8192");
	expect(findings).not.toContain("Session JSONL lost historical Tool payload marker 0");
	expect(findings).not.toContain("Session JSONL lost historical Tool payload marker 3250");
});

test("accepts a cancelled foreground Agent without an invented Tool result", () => {
	const entries = sessionEntries([
		{ role: "user", content: "PS5BW_AGENT_PROMPT" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "ps5bw-agent-launch", name: "subagent", arguments: {} }],
		},
	]);
	expect(lifecycleSessionFindings(entries, "agent-exit", "fresh")).toEqual([]);
});

test("requires both measured prompt submissions to remain durable", () => {
	const findings = lifecycleSessionFindings(
		sessionEntries([
			{ role: "user", content: "PS5BW_FIRST_PROMPT" },
			{ role: "assistant", content: [{ type: "text", text: "PS5BW_FIRST_PROMPT_DONE" }] },
		]),
		"prompt",
		"fresh",
	);
	expect(findings).toContain("Session JSONL lost marker PS5BW_SECOND_PROMPT");
	expect(findings).toContain("Session JSONL lost marker PS5BW_SECOND_PROMPT_DONE");
});

test("requires completed prompt markers after reload", () => {
	const findings = lifecycleSessionFindings(
		sessionEntries([{ role: "user", content: "PS5BW_RELOAD_PROMPT" }]),
		"reload",
		"fresh",
	);
	expect(findings).toContain("Session JSONL lost marker PS5BW_PROMPT_DONE");
});
