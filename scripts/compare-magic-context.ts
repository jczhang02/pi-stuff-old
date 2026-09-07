import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Check } from "typebox/value";
import { handleBenchmarkMeta } from "./benchmark-cli.js";
import { balancedArmOrder, comparePairedSamples, PAIRED_COMPARISON_THRESHOLDS } from "./benchmark-statistics.js";
import { MAGIC_CONTEXT_BENCHMARK_REPORT_SCHEMA, numericMagicContextMetrics } from "./magic-context-benchmark-core.js";

type Arm = "baseline" | "candidate";
const DEFAULT_OUTPUT = resolve(".artifacts/magic-context-comparison/latest.json");

interface ArmSample {
	readonly packageVersion: string;
	readonly values: ReadonlyMap<string, number>;
}

interface ArmSamples {
	readonly baseline: readonly ArmSample[];
	readonly candidate: readonly ArmSample[];
}

function integer(raw: string | undefined, fallback: number, name: string, minimum: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer of at least ${String(minimum)}.`);
	}
	return value;
}

async function readArmSample(path: string): Promise<ArmSample> {
	const report: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Check(MAGIC_CONTEXT_BENCHMARK_REPORT_SCHEMA, report) || report.raw.length !== 1) {
		throw new Error(`Magic Context arm report ${path} has an invalid shape.`);
	}
	const sample = report.raw[0];
	if (!sample) {
		throw new Error(`Magic Context arm report ${path} must contain exactly one sample.`);
	}
	return { packageVersion: report.packageVersion, values: numericMagicContextMetrics(sample) };
}

async function runArm(root: string, arm: Arm, iteration: number, directory: string): Promise<ArmSample> {
	const output = join(directory, `${String(iteration)}-${arm}.json`);
	const child = Bun.spawnSync(
		[
			process.execPath,
			join(root, "scripts", "benchmark-magic-context.ts"),
			"--samples",
			"1",
			"--warmups",
			"0",
			"--output",
			output,
		],
		{ cwd: root, stderr: "pipe", stdout: "pipe" },
	);
	if (child.exitCode !== 0) {
		throw new Error(
			`${arm} Magic Context sample ${String(iteration)} failed:\n${child.stdout.toString()}\n${child.stderr.toString()}`,
		);
	}
	return readArmSample(output);
}

function compareArms(samples: ArmSamples) {
	const baseline = samples.baseline;
	const candidate = samples.candidate;
	if (baseline.length !== candidate.length || baseline.length < 3) {
		throw new Error("Magic Context comparison requires at least three complete sample pairs.");
	}
	const names = [...(baseline[0]?.values.keys() ?? [])].sort();
	return Object.fromEntries(
		names.map((name) => {
			const pairs = baseline.map((sample, index) => {
				const baselineValue = sample.values.get(name);
				const candidateValue = candidate[index]?.values.get(name);
				if (baselineValue === undefined || candidateValue === undefined) {
					throw new Error(`Magic Context comparison is missing ${name} pair ${String(index)}.`);
				}
				return { baseline: baselineValue, candidate: candidateValue };
			});
			return [name, comparePairedSamples(pairs)];
		}),
	);
}

async function main(): Promise<void> {
	handleBenchmarkMeta(
		process.argv.slice(2),
		"usage: compare-magic-context --baseline <report> --candidate <report> [--output <path>]",
		["paired-metric-comparison"],
	);
	const { values } = parseArgs({
		options: {
			baseline: { type: "string" },
			candidate: { type: "string" },
			output: { type: "string" },
			samples: { type: "string" },
			warmups: { type: "string" },
		},
		strict: true,
	});
	if (!values.baseline || !values.candidate)
		throw new Error("--baseline and --candidate worktree roots are required.");
	const roots = {
		baseline: resolve(values.baseline),
		candidate: resolve(values.candidate),
	};
	const measuredCount = integer(values.samples, 10, "--samples", 3);
	const warmupCount = integer(values.warmups, 3, "--warmups", 0);
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-magic-context-comparison-"));
	try {
		const baselineSamples: ArmSample[] = [];
		const candidateSamples: ArmSample[] = [];
		const measured = { baseline: baselineSamples, candidate: candidateSamples };
		for (let iteration = 0; iteration < measuredCount + warmupCount; iteration += 1) {
			for (const arm of balancedArmOrder<Arm>(["baseline", "candidate"], iteration)) {
				const sample = await runArm(roots[arm], arm, iteration, directory);
				if (iteration >= warmupCount) measured[arm].push(sample);
			}
		}
		const report = `${JSON.stringify(
			{
				arms: {
					baseline: { packageVersion: measured.baseline[0]?.packageVersion, root: roots.baseline },
					candidate: { packageVersion: measured.candidate[0]?.packageVersion, root: roots.candidate },
				},
				comparisons: compareArms(measured),
				raw: {
					baseline: measured.baseline.map(({ packageVersion, values }) => ({
						packageVersion,
						values: Object.fromEntries(values),
					})),
					candidate: measured.candidate.map(({ packageVersion, values }) => ({
						packageVersion,
						values: Object.fromEntries(values),
					})),
				},
				samples: measuredCount,
				thresholds: PAIRED_COMPARISON_THRESHOLDS,
				warmups: warmupCount,
			},
			null,
			2,
		)}\n`;
		await mkdir(dirname(resolve(values.output ?? DEFAULT_OUTPUT)), { recursive: true });
		await writeFile(resolve(values.output ?? DEFAULT_OUTPUT), report);
		process.stdout.write(report);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
