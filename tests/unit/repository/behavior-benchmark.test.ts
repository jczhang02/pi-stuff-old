import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BenchmarkCaseResult,
	benchmarkInventoryFiles,
	buildPonytailBenchmarkEnvironment,
	evaluatePonytailBenchmark,
	initializeBenchmarkInventory,
	oneSidedSignTestPValue,
	PONYTAIL_BENCHMARK_RUNS,
	PONYTAIL_BENCHMARK_SCENARIOS,
	skillCommands,
	snapshotBenchmarkFiles,
} from "../../../scripts/benchmark-ponytail.js";
import { providerToolNames } from "../../fixtures/ponytail-benchmark-observer.js";

function cases(valid = true): BenchmarkCaseResult[] {
	return PONYTAIL_BENCHMARK_RUNS.map((run, index) => ({
		...run,
		sequence: index + 1,
		valid,
		durationMs: 1,
		metrics: {
			files: 1,
			nonBlankLines: run.mode === "ultra" ? 4 : 10,
			characters: run.mode === "ultra" ? 80 : 200,
			structuralDeclarations: 0,
		},
	}));
}

test("freezes three tasks, three repetitions, and eighteen one-shot Sessions", () => {
	expect(PONYTAIL_BENCHMARK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
		"future-channel",
		"request-id",
		"retry",
	]);
	expect(PONYTAIL_BENCHMARK_RUNS).toHaveLength(18);
	for (const scenario of PONYTAIL_BENCHMARK_SCENARIOS) {
		for (let repetition = 1; repetition <= 3; repetition++) {
			const pair = PONYTAIL_BENCHMARK_RUNS.filter(
				(run) => run.scenario === scenario.id && run.repetition === repetition,
			);
			expect(pair.map((run) => run.mode).sort()).toEqual(["off", "ultra"]);
		}
	}
});

test("keeps every production, test, and hidden-check fixture syntactically valid", () => {
	const typescript = new Bun.Transpiler({ loader: "ts" });
	const javascript = new Bun.Transpiler({ loader: "js" });
	for (const scenario of PONYTAIL_BENCHMARK_SCENARIOS) {
		for (const [path, source] of Object.entries(scenario.files)) {
			if (path.endsWith(".ts")) expect(() => typescript.transformSync(source)).not.toThrow();
		}
		expect(() =>
			javascript.transformSync(scenario.hiddenCheck.replace("__TARGET__", JSON.stringify("file:///fixture.ts"))),
		).not.toThrow();
	}
});

test("normalizes native skill: commands and excludes extension aliases", () => {
	expect(
		skillCommands([
			{ name: "ponytail-review", source: "extension" },
			{ name: "skill:ponytail-review", source: "skill" },
			{ name: "skill:ponytail", source: "skill" },
			{ name: "skill:unrelated", source: "skill" },
		]),
	).toEqual(["ponytail", "ponytail-review"]);
});

test("observes every direct or OpenAI-style Provider Tool", () => {
	expect(
		providerToolNames({
			tools: [
				{ function: { name: "read" }, type: "function" },
				{ name: "custom-tool" },
				{ function: { name: "bash" }, type: "function" },
			],
		}),
	).toEqual(["bash", "custom-tool", "read"]);
});

test("clears inherited Ponytail controls before applying benchmark defaults", () => {
	const environment = buildPonytailBenchmarkEnvironment(
		{
			PONYTAIL_DEFAULT_MODE: "ultra",
			PONYTAIL_FUTURE_OVERRIDE: "leak",
			PONYTAIL_HIDE_STATUS: "1",
			PONYTAIL_QUIET_STARTUP: "0",
			PI_STUFF_CODE_MODE_FROZEN: "on",
			PI_STUFF_PONYTAIL_MODE: "ultra",
			PI_SUBAGENT_PARENT_SESSION: "parent",
		},
		"/runtime",
		"/temporary",
		"/observer",
	);
	expect(environment).toMatchObject({
		PONYTAIL_DEFAULT_MODE: "off",
		PONYTAIL_HIDE_STATUS: "0",
		PONYTAIL_QUIET_STARTUP: "1",
		PI_STUFF_CODE_MODE_DEFAULT: "off",
		PI_STUFF_PONYTAIL_BENCHMARK_LOG: "/observer",
		TMPDIR: "/temporary",
		XDG_RUNTIME_DIR: "/runtime",
	});
	expect(environment["PONYTAIL_FUTURE_OVERRIDE"]).toBeUndefined();
	expect(environment["PI_STUFF_CODE_MODE_FROZEN"]).toBeUndefined();
	expect(environment["PI_STUFF_PONYTAIL_MODE"]).toBeUndefined();
	expect(environment["PI_SUBAGENT_PARENT_SESSION"]).toBeUndefined();
});

test("does not follow symlinks while snapshotting model output", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-ponytail-snapshot-"));
	try {
		const project = join(root, "project");
		await mkdir(join(project, "src"), { recursive: true });
		await writeFile(join(project, "src/index.ts"), "export const safe = true;\n");
		await writeFile(join(root, "private.txt"), "must-not-leak\n");
		await symlink(join(root, "private.txt"), join(project, "src/private.ts"));
		const inventory = join(root, "inventory.git");
		initializeBenchmarkInventory(project, inventory);
		expect(await snapshotBenchmarkFiles(project, benchmarkInventoryFiles(project, inventory))).toEqual({
			"src/index.ts": "export const safe = true;\n",
			"src/private.ts": "<non-regular-file>",
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("uses a one-sided exact sign test", () => {
	expect(oneSidedSignTestPValue(8, 9)).toBeCloseTo(0.01953125, 10);
	expect(oneSidedSignTestPValue(7, 9)).toBeCloseTo(0.08984375, 10);
	expect(() => oneSidedSignTestPValue(10, 9)).toThrow("invalid sign-test counts");
});

test("requires paired correctness, nine pairs, six non-ties, and p <= 0.05", () => {
	const strong = evaluatePonytailBenchmark(cases());
	expect(strong.verdict).toMatchObject({
		allCorrect: true,
		pairedCases: 9,
		ultraLower: 9,
		ultraHigher: 0,
		nonTies: 9,
		strongEffect: true,
	});
	const invalid = cases();
	const first = invalid[0];
	if (!first) throw new Error("missing fixture case");
	invalid[0] = { ...first, valid: false };
	expect(evaluatePonytailBenchmark(invalid).verdict).toMatchObject({
		allCorrect: false,
		strongEffect: false,
	});
});
