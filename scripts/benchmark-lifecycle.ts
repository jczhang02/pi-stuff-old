import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { handleBenchmarkMeta } from "./benchmark-cli.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { prepareFixture } from "./lifecycle-benchmark-fixture.js";
import { cellKey, runSample, summaries } from "./lifecycle-benchmark-sampling.js";
import { CERTIFIED_PI_HOST_PROFILE } from "./pi-host-contract.js";
import { stageSupportedPiHost } from "./verify-pi-host-provenance.js";

export { lifecycleExpectProgram, lifecycleSessionFindings } from "./lifecycle-benchmark-fixture.js";
export { percentile, summarize } from "./lifecycle-benchmark-sampling.js";

const VARIANTS = ["host", "suite"] as const;
const SCENARIOS = ["fresh", "resume-short", "resume-long", "degraded"] as const;
const ACTIONS = ["exit", "ctrl-c", "reload", "reload-change", "prompt", "background-exit", "agent-exit"] as const;
const DEFAULT_SIZES = [
	{ columns: 100, rows: 32 },
	{ columns: 64, rows: 28 },
] as const;

export type Variant = (typeof VARIANTS)[number];
export type Scenario = (typeof SCENARIOS)[number];
export type Action = (typeof ACTIONS)[number];

export interface TerminalSize {
	readonly columns: number;
	readonly rows: number;
}

export interface LifecycleAcceptanceSelection {
	readonly actions: readonly Action[];
	readonly contextEnabled: boolean;
	readonly longSessionToolBytes: number;
	readonly longSessionTools: number;
	readonly samples: number;
	readonly scenarios: readonly Scenario[];
	readonly sizes: readonly TerminalSize[];
	readonly trace: boolean;
	readonly variants: readonly Variant[];
	readonly warmups: number;
}

export interface BenchmarkOptions extends LifecycleAcceptanceSelection {
	readonly acceptance: boolean;
	readonly output: string;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly promptRepetitions: number;
}

export interface LifecycleSample {
	readonly action: Action;
	readonly acknowledgementMs?: number;
	readonly columns: number;
	readonly interruptMs?: number;
	readonly iteration: number;
	readonly providerStartMs?: number;
	readonly reloadMs?: number;
	readonly responseMs?: number;
	readonly rows: number;
	readonly scenario: Scenario;
	readonly shutdownMs: number;
	readonly steadyAcknowledgementMs?: number;
	readonly steadyProviderStartMs?: number;
	readonly steadyResponseMs?: number;
	readonly startupMs: number;
	readonly suiteTrace?: readonly LifecycleTraceEvent[];
	readonly trace?: readonly HostTiming[];
	readonly variant: Variant;
	readonly warmup: boolean;
}

export interface MetricSummary {
	readonly maximum: number;
	readonly minimum: number;
	readonly p50: number;
	readonly p95: number;
	readonly samples: number;
}

export interface CellSummary {
	readonly acknowledgement?: MetricSummary;
	readonly action: Action;
	readonly columns: number;
	readonly interrupt?: MetricSummary;
	readonly providerStart?: MetricSummary;
	readonly reload?: MetricSummary;
	readonly response?: MetricSummary;
	readonly rows: number;
	readonly scenario: Scenario;
	readonly shutdown: MetricSummary;
	readonly steadyAcknowledgement?: MetricSummary;
	readonly steadyProviderStart?: MetricSummary;
	readonly steadyResponse?: MetricSummary;
	readonly startup: MetricSummary;
	readonly variant: Variant;
	readonly warmups: number;
}

export interface HostTiming {
	readonly label: string;
	readonly milliseconds: number;
	readonly namespace: string;
}

export interface LifecycleTraceEvent {
	readonly atMs: number;
	readonly label: string;
}

export interface SeededSessions {
	readonly long: string;
	readonly short: string;
	readonly traceExtension: string;
}

function fail(message: string): never {
	throw new Error(`Lifecycle benchmark failed: ${message}`);
}

const ROOT = resolve(import.meta.dir, "..");
const REPOSITORY_BUN_VERSION = "1.4.0";
const DEFAULT_PACKAGE = join(ROOT, "packages/pi-stuff");
const DEFAULT_SAMPLES = 3;
const DEFAULT_WARMUPS = 1;
const ACCEPTANCE_MINIMUM_LONG_SESSION_TOOLS = 6_000;
const ACCEPTANCE_MINIMUM_LONG_TOOL_BYTES = 8 * 1024;
const ACCEPTANCE_SUITE_STARTUP_OVERHEAD_MS = 2_250;
const DEFAULT_OUTPUT = join(ROOT, ".artifacts/lifecycle-benchmark/latest.json");

function boundedInteger(value: string | undefined, flag: string, minimum: number, maximum: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		fail(`${flag} must be an integer from ${String(minimum)} through ${String(maximum)}`);
	}
	return parsed;
}

function listValue<T extends string>(value: string | undefined, flag: string, allowed: readonly T[]): readonly T[] {
	if (!value) fail(`${flag} requires a comma-separated value`);
	const values = [
		...new Set(
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
	return values.map((entry) => {
		const selected = allowed.find((candidate) => candidate === entry);
		if (!selected) fail(`${flag} must contain only: ${allowed.join(", ")}`);
		return selected;
	});
}

function terminalSizes(value: string | undefined): readonly TerminalSize[] {
	if (!value) fail("--sizes requires comma-separated COLUMNSxROWS values");
	return value.split(",").map((entry) => {
		const match = /^(\d+)x(\d+)$/.exec(entry.trim());
		if (!match) fail(`invalid terminal size: ${entry}`);
		return {
			columns: boundedInteger(match[1], "columns", 40, 400),
			rows: boundedInteger(match[2], "rows", 12, 200),
		};
	});
}

function parseOptions(arguments_: readonly string[]): BenchmarkOptions {
	let acceptance = false;
	let actions: readonly Action[] = ACTIONS;
	let contextEnabled = true;
	let longSessionToolBytes = 0;
	let longSessionTools = 0;
	let output = DEFAULT_OUTPUT;
	let packagePath = DEFAULT_PACKAGE;
	let piBinary: string | undefined;
	let promptRepetitions = 1;
	let samples = DEFAULT_SAMPLES;
	let scenarios: readonly Scenario[] = SCENARIOS;
	let sizes: readonly TerminalSize[] = DEFAULT_SIZES;
	let trace = false;
	let variants: readonly Variant[] = VARIANTS;
	let warmups = DEFAULT_WARMUPS;

	for (let index = 0; index < arguments_.length; index += 1) {
		const flag = arguments_[index];
		const value = arguments_[index + 1];
		switch (flag) {
			case "--acceptance":
				acceptance = true;
				break;
			case "--disable-context":
				contextEnabled = false;
				break;
			case "--actions":
				actions = listValue(value, flag, ACTIONS);
				index += 1;
				break;
			case "--long-tools":
				longSessionTools = boundedInteger(value, flag, 0, 20_000);
				index += 1;
				break;
			case "--long-tool-bytes":
				longSessionToolBytes = boundedInteger(value, flag, 0, 1024 * 1024);
				if (longSessionToolBytes > 0 && longSessionToolBytes < 128) {
					fail("--long-tool-bytes must be 0 or at least 128");
				}
				index += 1;
				break;
			case "--output":
				if (!value) fail("--output requires a path");
				output = resolve(value);
				index += 1;
				break;
			case "--package":
				if (!value) fail("--package requires a path");
				packagePath = resolve(value);
				index += 1;
				break;
			case "--pi":
				if (!value) fail("--pi requires a path");
				piBinary = resolve(value);
				index += 1;
				break;
			case "--prompt-repetitions":
				promptRepetitions = boundedInteger(value, flag, 1, 100);
				index += 1;
				break;
			case "--samples":
				samples = boundedInteger(value, flag, 1, 100);
				index += 1;
				break;
			case "--scenarios":
				scenarios = listValue(value, flag, SCENARIOS);
				index += 1;
				break;
			case "--sizes":
				sizes = terminalSizes(value);
				index += 1;
				break;
			case "--trace":
				trace = true;
				break;
			case "--variants":
				variants = listValue(value, flag, VARIANTS);
				index += 1;
				break;
			case "--warmups":
				warmups = boundedInteger(value, flag, 0, 20);
				index += 1;
				break;
			default:
				fail(`unknown argument: ${String(flag)}`);
		}
	}
	if (acceptance && promptRepetitions !== 1) {
		fail("--prompt-repetitions is diagnostic-only and cannot be combined with --acceptance");
	}
	return {
		acceptance,
		actions,
		contextEnabled,
		longSessionToolBytes,
		longSessionTools,
		output,
		packagePath,
		piBinary: piBinary ?? resolvePiBinary(),
		promptRepetitions,
		samples,
		scenarios,
		sizes,
		trace,
		variants,
		warmups,
	};
}

const ACCEPTANCE_MINIMUM_SAMPLES = 3;

type BudgetedMetric =
	| "acknowledgement"
	| "interrupt"
	| "providerStart"
	| "reload"
	| "response"
	| "shutdown"
	| "steadyAcknowledgement"
	| "steadyProviderStart"
	| "steadyResponse"
	| "startup";

interface BudgetRule {
	readonly budget: number;
	readonly metric: BudgetedMetric;
}

const sameSize = (left: TerminalSize, right: TerminalSize) =>
	left.columns === right.columns && left.rows === right.rows;

function acceptanceCellKey(variant: Variant, scenario: Scenario, action: Action, size: TerminalSize): string {
	return [variant, scenario, action, `${String(size.columns)}x${String(size.rows)}`].join("/");
}

function acceptanceRequiresCell(action: Action, scenario: Scenario, size: TerminalSize): boolean {
	if (action === "background-exit" || action === "agent-exit") {
		return scenario === "fresh" || scenario === "resume-long";
	}
	if (action === "reload-change") return scenario === "fresh" && sameSize(size, DEFAULT_SIZES[0]);
	return true;
}

function budgetRules(cell: CellSummary): readonly BudgetRule[] {
	if (cell.variant !== "suite") return [];
	const longSession = cell.scenario === "resume-long";
	const rules: BudgetRule[] = [];
	if (cell.action !== "reload-change") {
		// Long-history startup is also constrained against the paired Host cell
		// below; its absolute time is dominated by Host transcript rendering.
		rules.push({ budget: longSession ? 12_000 : 2_700, metric: "startup" });
	}
	if (cell.action === "prompt") {
		rules.push(
			{ budget: 50, metric: "acknowledgement" },
			{ budget: longSession ? 2_300 : 800, metric: "providerStart" },
			{ budget: longSession ? 2_600 : 1_100, metric: "response" },
			{ budget: 15, metric: "steadyAcknowledgement" },
			{ budget: longSession ? 350 : 100, metric: "steadyProviderStart" },
			{ budget: longSession ? 550 : 150, metric: "steadyResponse" },
		);
	}
	if (cell.action === "exit" || cell.action === "ctrl-c") {
		rules.push({ budget: longSession ? 550 : cell.action === "ctrl-c" ? 250 : 150, metric: "shutdown" });
	}
	if (cell.action === "background-exit" || cell.action === "agent-exit") {
		rules.push({ budget: longSession ? 375 : 250, metric: "shutdown" });
	}
	if (cell.action === "agent-exit") rules.push({ budget: 1_000, metric: "interrupt" });
	if (cell.action === "reload") rules.push({ budget: longSession ? 2_500 : 200, metric: "reload" });
	if (cell.action === "reload-change") rules.push({ budget: 8_000, metric: "reload" });
	return rules;
}

function requiredMetrics(cell: CellSummary): readonly BudgetedMetric[] {
	return [
		"startup",
		"shutdown",
		...(cell.action === "reload" || cell.action === "reload-change" ? (["reload"] as const) : []),
		...(cell.action === "prompt"
			? ([
					"acknowledgement",
					"providerStart",
					"response",
					"steadyAcknowledgement",
					"steadyProviderStart",
					"steadyResponse",
				] as const)
			: []),
		...(cell.action === "agent-exit" ? (["interrupt"] as const) : []),
	];
}

export function lifecycleConfirmationTargets(cells: readonly CellSummary[]): CellSummary[] {
	const cellsByKey = new Map(
		cells.map((cell) => [acceptanceCellKey(cell.variant, cell.scenario, cell.action, cell), cell]),
	);
	return cells.filter((cell) => {
		if (
			budgetRules(cell).some(({ budget, metric }) => {
				const summary = cell[metric];
				return summary !== undefined && summary.p95 > budget;
			})
		) {
			return true;
		}
		if (cell.variant !== "suite") return false;
		const host = cellsByKey.get(acceptanceCellKey("host", cell.scenario, cell.action, cell));
		return host !== undefined && cell.startup.p95 - host.startup.p95 > ACCEPTANCE_SUITE_STARTUP_OVERHEAD_MS;
	});
}

function selectionFindings(selection: LifecycleAcceptanceSelection): string[] {
	const findings: string[] = [];
	const minimums = [
		[
			selection.samples < ACCEPTANCE_MINIMUM_SAMPLES,
			`coverage requires at least ${String(ACCEPTANCE_MINIMUM_SAMPLES)} measured samples per cell`,
		],
		[!selection.contextEnabled, "coverage requires the shipped Context capability to remain enabled"],
		[
			selection.longSessionTools < ACCEPTANCE_MINIMUM_LONG_SESSION_TOOLS,
			`coverage requires at least ${String(ACCEPTANCE_MINIMUM_LONG_SESSION_TOOLS)} historical Tool results`,
		],
		[
			selection.longSessionToolBytes < ACCEPTANCE_MINIMUM_LONG_TOOL_BYTES,
			`coverage requires at least ${String(ACCEPTANCE_MINIMUM_LONG_TOOL_BYTES)} bytes per historical Tool result`,
		],
		[selection.warmups < 1, "coverage requires at least one warmup per cell"],
		[!selection.trace, "coverage requires Host and Suite lifecycle tracing"],
	] as const;
	for (const [missing, message] of minimums) if (missing) findings.push(message);
	const dimensions: readonly (readonly [string, readonly string[], readonly string[]])[] = [
		["action", ACTIONS, selection.actions],
		["scenario", SCENARIOS, selection.scenarios],
		["variant", VARIANTS, selection.variants],
	];
	for (const [label, required, selected] of dimensions) {
		for (const value of required)
			if (!selected.includes(value)) findings.push(`coverage is missing ${label} ${value}`);
	}
	for (const size of DEFAULT_SIZES) {
		if (!selection.sizes.some((candidate) => sameSize(candidate, size))) {
			findings.push(`coverage is missing terminal ${String(size.columns)}x${String(size.rows)}`);
		}
	}
	return findings;
}

export function lifecycleAcceptanceFindings(
	selection: LifecycleAcceptanceSelection,
	cells: readonly CellSummary[],
	confirmationCells: readonly CellSummary[] = [],
): string[] {
	const findings = selectionFindings(selection);

	const cellsByKey = new Map(
		cells.map((cell) => [acceptanceCellKey(cell.variant, cell.scenario, cell.action, cell), cell]),
	);
	const confirmationsByKey = new Map(
		confirmationCells.map((cell) => [acceptanceCellKey(cell.variant, cell.scenario, cell.action, cell), cell]),
	);
	for (const target of lifecycleConfirmationTargets(cells)) {
		const key = acceptanceCellKey(target.variant, target.scenario, target.action, target);
		const confirmation = confirmationsByKey.get(key);
		if (confirmation && confirmation.warmups < selection.warmups) {
			findings.push(`${key} confirmation has only ${String(confirmation.warmups)} warmups`);
		}
	}
	const enforceBudget = (
		cell: CellSummary,
		metric: BudgetedMetric,
		summary: MetricSummary | undefined,
		budget: number,
	): void => {
		const key = acceptanceCellKey(cell.variant, cell.scenario, cell.action, cell);
		if (!summary) {
			findings.push(`${key} is missing ${metric}`);
			return;
		}
		if (summary.p95 > budget) {
			const confirmationCell = confirmationsByKey.get(key);
			const confirmation = confirmationCell?.[metric];
			if (
				confirmation &&
				confirmation.samples >= ACCEPTANCE_MINIMUM_SAMPLES &&
				confirmationCell.warmups >= selection.warmups &&
				confirmation.p95 <= budget
			) {
				return;
			}
			findings.push(`${key} ${metric} p95 ${summary.p95.toFixed(2)}ms exceeds ${String(budget)}ms`);
			if (confirmation && confirmation.samples < ACCEPTANCE_MINIMUM_SAMPLES) {
				findings.push(`${key} ${metric} confirmation has only ${String(confirmation.samples)} measured samples`);
			} else if (
				confirmation &&
				confirmationCell &&
				confirmationCell.warmups >= selection.warmups &&
				confirmation.p95 > budget
			) {
				findings.push(
					`${key} ${metric} confirmation p95 ${confirmation.p95.toFixed(2)}ms also exceeds ${String(budget)}ms`,
				);
			}
		}
	};

	for (const size of DEFAULT_SIZES) {
		for (const scenario of SCENARIOS) {
			for (const action of ACTIONS) {
				if (!acceptanceRequiresCell(action, scenario, size)) continue;
				const applicableVariants: readonly Variant[] =
					action === "background-exit" || action === "agent-exit" || action === "reload-change"
						? ["suite"]
						: VARIANTS;
				for (const variant of applicableVariants) {
					const key = acceptanceCellKey(variant, scenario, action, size);
					const cell = cellsByKey.get(key);
					if (!cell) {
						findings.push(`coverage has no measured cell ${key}`);
						continue;
					}
					if (cell.warmups < selection.warmups) {
						findings.push(`${key} has only ${String(cell.warmups)} warmups`);
					}
					for (const metric of requiredMetrics(cell)) {
						const summary = cell[metric];
						if (!summary) {
							findings.push(`${key} is missing ${metric}`);
						} else if (summary.samples < ACCEPTANCE_MINIMUM_SAMPLES) {
							findings.push(`${key} ${metric} has only ${String(summary.samples)} measured samples`);
						}
					}
					for (const { budget, metric } of budgetRules(cell)) {
						if (cell[metric]) enforceBudget(cell, metric, cell[metric], budget);
					}
					if (variant === "suite" && action !== "background-exit" && action !== "agent-exit") {
						const host = cellsByKey.get(acceptanceCellKey("host", scenario, action, size));
						if (host) {
							const budget = ACCEPTANCE_SUITE_STARTUP_OVERHEAD_MS;
							const overhead = cell.startup.p95 - host.startup.p95;
							const confirmation = confirmationsByKey.get(key);
							const confirmationPasses =
								confirmation !== undefined &&
								confirmation.startup.samples >= ACCEPTANCE_MINIMUM_SAMPLES &&
								confirmation.warmups >= selection.warmups &&
								confirmation.startup.p95 - host.startup.p95 <= budget;
							if (overhead > budget && !confirmationPasses) {
								findings.push(
									`${key} startup overhead ${overhead.toFixed(2)}ms exceeds Host by ${String(budget)}ms`,
								);
							}
						}
					}
				}
			}
		}
	}
	return findings;
}
function progress(sample: LifecycleSample, phase: "initial" | "confirmation" = "initial"): void {
	const suffix = [
		sample.reloadMs === undefined ? "" : ` reload=${sample.reloadMs.toFixed(1)}ms`,
		sample.interruptMs === undefined ? "" : ` interrupt=${sample.interruptMs.toFixed(1)}ms`,
		sample.acknowledgementMs === undefined ? "" : ` ack=${sample.acknowledgementMs.toFixed(1)}ms`,
		sample.providerStartMs === undefined ? "" : ` provider=${sample.providerStartMs.toFixed(1)}ms`,
		sample.responseMs === undefined ? "" : ` response=${sample.responseMs.toFixed(1)}ms`,
		sample.steadyAcknowledgementMs === undefined ? "" : ` steady-ack=${sample.steadyAcknowledgementMs.toFixed(1)}ms`,
		sample.steadyProviderStartMs === undefined ? "" : ` steady-provider=${sample.steadyProviderStartMs.toFixed(1)}ms`,
		sample.steadyResponseMs === undefined ? "" : ` steady-response=${sample.steadyResponseMs.toFixed(1)}ms`,
	].join("");
	console.error(
		`${phase === "confirmation" ? "confirmation " : ""}${sample.warmup ? "warmup" : "sample"} ${cellKey(sample)} #${String(sample.iteration + 1)} ` +
			`startup=${sample.startupMs.toFixed(1)}ms shutdown=${sample.shutdownMs.toFixed(1)}ms${suffix}`,
	);
}

async function runInitialSamples(
	options: BenchmarkOptions,
	benchmarkRoot: string,
	fixturePackage: string,
	seeded: SeededSessions,
): Promise<LifecycleSample[]> {
	const samples: LifecycleSample[] = [];
	for (const size of options.sizes) {
		for (const scenario of options.scenarios) {
			for (const action of options.actions) {
				if (options.acceptance && !acceptanceRequiresCell(action, scenario, size)) continue;
				for (let iteration = 0; iteration < options.warmups + options.samples; iteration += 1) {
					const warmup = iteration < options.warmups;
					const sampleIndex = warmup ? iteration : iteration - options.warmups;
					const applicableVariants =
						action === "background-exit" || action === "agent-exit" || action === "reload-change"
							? options.variants.filter((variant) => variant === "suite")
							: options.variants;
					const orderedVariants = iteration % 2 === 0 ? applicableVariants : [...applicableVariants].reverse();
					for (const variant of orderedVariants) {
						const sample = await runSample(
							options,
							benchmarkRoot,
							fixturePackage,
							seeded,
							variant,
							scenario,
							action,
							size,
							sampleIndex,
							warmup,
						);
						samples.push(sample);
						progress(sample);
					}
				}
			}
		}
	}
	return samples;
}

async function main(): Promise<void> {
	let options = parseOptions(Bun.argv.slice(2));
	if (
		options.actions.some(
			(action) => action === "background-exit" || action === "agent-exit" || action === "reload-change",
		) &&
		!options.variants.includes("suite")
	) {
		fail("background-exit, agent-exit, and reload-change require the suite variant");
	}
	if (Bun.version !== REPOSITORY_BUN_VERSION) {
		fail(`Bun ${REPOSITORY_BUN_VERSION} is required; received ${Bun.version}`);
	}
	const benchmarkRoot = await mkdtemp(join(tmpdir(), "pi-stuff-lifecycle-benchmark-"));
	const stagedHost = await stageSupportedPiHost(options.piBinary, benchmarkRoot).catch(async (cause: unknown) => {
		await rm(benchmarkRoot, { recursive: true, force: true });
		throw cause;
	});
	options = { ...options, piBinary: stagedHost.binaryPath };
	const projectDirectory = join(benchmarkRoot, "project");
	const fixturePackage = join(benchmarkRoot, "fixture-package");
	await Promise.all([
		mkdir(projectDirectory, { recursive: true }),
		mkdir(join(benchmarkRoot, "home"), { recursive: true }),
	]);
	const seeded = await prepareFixture(
		benchmarkRoot,
		projectDirectory,
		options.longSessionTools,
		options.longSessionToolBytes,
	);

	try {
		const samples = await runInitialSamples(options, benchmarkRoot, fixturePackage, seeded);
		const cellSummaries = summaries(samples);
		const confirmationSamples: LifecycleSample[] = [];
		const confirmationTargets = options.acceptance ? lifecycleConfirmationTargets(cellSummaries) : [];
		for (const target of confirmationTargets) {
			for (let iteration = 0; iteration < options.warmups + options.samples; iteration += 1) {
				const warmup = iteration < options.warmups;
				const sampleIndex = warmup ? iteration : iteration - options.warmups;
				const sample = await runSample(
					options,
					benchmarkRoot,
					fixturePackage,
					seeded,
					target.variant,
					target.scenario,
					target.action,
					target,
					sampleIndex,
					warmup,
					"confirmation",
				);
				confirmationSamples.push(sample);
				progress(sample, "confirmation");
			}
		}
		const confirmationSummaries = summaries(confirmationSamples);
		const acceptanceFindings = options.acceptance
			? lifecycleAcceptanceFindings(options, cellSummaries, confirmationSummaries)
			: [];
		const report = {
			schemaVersion: 6,
			generatedAt: new Date().toISOString(),
			host: { profile: CERTIFIED_PI_HOST_PROFILE },
			toolchain: { bun: Bun.version },
			startupModel: {
				processState: "Every sample starts a new Pi process with a cold process-local Suite module cache.",
				systemCacheState:
					"Each measured cell follows one retained preconditioning run and therefore measures a warm executable/filesystem-cache start without dropping global caches.",
			},
			options: { ...options, output: undefined, piBinary: undefined },
			acceptance: options.acceptance
				? {
						confirmationCells: confirmationTargets.map((cell) =>
							acceptanceCellKey(cell.variant, cell.scenario, cell.action, cell),
						),
						findings: acceptanceFindings,
						passed: acceptanceFindings.length === 0,
						requested: true,
					}
				: { requested: false },
			confirmations: {
				samples: confirmationSamples,
				summaries: confirmationSummaries,
			},
			notes: [
				"Every measurement uses a fresh Pi process and isolated Settings Layer.",
				"Warmups heat executable and filesystem caches; the benchmark does not mutate global kernel page-cache state.",
				"The host control loads only the deterministic fixture Package; the suite variant adds the Pi Stuff Package before it.",
				"All model responses are deterministic in-process fixtures; no credential or network call is used.",
				"Prompt actions measure both first-turn activation and a second same-process steady-state submission.",
				"Provider-start metrics are emitted before the deterministic Provider reads or serializes Context messages.",
				"Acceptance long Sessions retain exact 8 KiB representative Tool payloads instead of count-only placeholder results.",
				"Resource actions verify the tracked shell or Agent child settles after the measured parent shutdown.",
				"Every exit parses the resulting Session JSONL; completed work remains durable and cancelled foreground Agents retain their Tool call receipt.",
				"An initially over-budget cell receives one independent complete confirmation batch; only a repeated violation fails acceptance, and both batches remain in the report.",
			],
			samples,
			summaries: cellSummaries,
		};
		await mkdir(dirname(options.output), { recursive: true });
		await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		await rm(benchmarkRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	handleBenchmarkMeta(Bun.argv.slice(2), "usage: benchmark:capability:lifecycle [options]", [
		"startup",
		"steady-state",
		"cleanup",
	]);
	await main();
}
