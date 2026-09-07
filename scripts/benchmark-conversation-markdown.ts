import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Markdown } from "@earendil-works/pi-tui";
import type {
	getMarkdownTheme,
	initTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { requireJsonInputValue } from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeFunction } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { handleBenchmarkMeta, writeBenchmarkReport } from "./benchmark-cli.js";

const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 5;
const BOOTSTRAP_ITERATIONS = 2_000;
const WIDTHS = [64, 100] as const;

interface MarkdownTransformContext {
	readonly availableWidth: number;
	readonly isStreaming: boolean;
	readonly messageType: "assistant" | "assistant-thinking" | "user";
}

type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

const NATIVE_THINKING_TRANSFORMER: MarkdownTransformer = (markdown) => markdown;

interface TransformerModule {
	transformConversationMarkdown: MarkdownTransformer;
}

interface HostMarkdownRuntime {
	readonly AssistantMessageComponent: typeof AssistantMessageComponent;
	readonly Markdown: typeof Markdown;
	readonly getMarkdownTheme: typeof getMarkdownTheme;
	readonly initTheme: typeof initTheme;
}

interface ThinkingLineModule {
	installThinkingLineDisplay: () => () => void;
}

interface Scenario {
	readonly feature?: true;
	readonly id: string;
	readonly isStreaming: boolean;
	readonly markdown: readonly string[];
	readonly messageType: MarkdownTransformContext["messageType"];
	readonly mode?: "render" | "transform";
	readonly rounds: number;
	readonly widths?: readonly number[];
}

interface TimingSummary {
	readonly maximum: number;
	readonly minimum: number;
	readonly p50: number;
	readonly p95: number;
}

interface ScenarioReport {
	readonly baselineMs: TimingSummary;
	readonly candidateMs: TimingSummary;
	readonly feature: boolean;
	readonly id: string;
	readonly medianRatioConfidence95: readonly [number, number];
	readonly regression: boolean;
	readonly slowerThanBaseline: boolean;
}

interface BenchmarkOptions {
	readonly output: string;
	readonly baselineRoot: string;
	readonly candidateRoot: string;
	readonly samples: number;
	readonly warmups: number;
}

interface SamplePair {
	readonly baselineMs: number;
	readonly candidateMs: number;
}

function fail(message: string): never {
	throw new Error(`Conversation Markdown benchmark failed: ${message}`);
}

function positiveInteger(value: string | undefined, flag: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 3 || parsed > 1_000) {
		fail(`${flag} must be an integer from 3 through 1000`);
	}
	return parsed;
}

function parseOptions(arguments_: readonly string[]): BenchmarkOptions {
	let baselineRoot = process.env["PI_STUFF_BENCHMARK_BASELINE"];
	let candidateRoot = process.cwd();
	let samples = DEFAULT_SAMPLES;
	let warmups = DEFAULT_WARMUPS;
	let output = ".artifacts/conversation-markdown-benchmark/latest.json";

	for (let index = 0; index < arguments_.length; index += 1) {
		const flag = arguments_[index];
		const value = arguments_[index + 1];
		switch (flag) {
			case "--output":
				if (!value) fail("--output requires a path");
				output = value;
				index += 1;
				break;
			case "--baseline-root":
				if (!value) fail("--baseline-root requires a path");
				baselineRoot = value;
				index += 1;
				break;
			case "--candidate-root":
				if (!value) fail("--candidate-root requires a path");
				candidateRoot = value;
				index += 1;
				break;
			case "--samples":
				samples = positiveInteger(value, flag, DEFAULT_SAMPLES);
				index += 1;
				break;
			case "--warmups":
				warmups = positiveInteger(value, flag, DEFAULT_WARMUPS);
				index += 1;
				break;
			default:
				fail(`unknown argument: ${String(flag)}`);
		}
	}
	if (!baselineRoot) fail("pass --baseline-root or PI_STUFF_BENCHMARK_BASELINE");
	return {
		output: resolve(output),
		baselineRoot: resolve(baselineRoot),
		candidateRoot: resolve(candidateRoot),
		samples,
		warmups,
	};
}

function conversationMarkdownModuleUrl(root: string): string {
	return pathToFileURL(resolve(root, "packages/pi-stuff/src/conversation-ui/conversation-markdown.ts")).href;
}

function thinkingLineModuleUrl(root: string): string {
	return pathToFileURL(resolve(root, "packages/pi-stuff/src/conversation-ui/thinking-line.ts")).href;
}

async function loadTransformer(root: string): Promise<MarkdownTransformer> {
	const moduleUrl = conversationMarkdownModuleUrl(root);
	// SAFETY: the benchmark loads the repository-owned module at the exact public export exercised by its focused tests.
	const module = (await import(moduleUrl)) as TransformerModule;
	return module.transformConversationMarkdown;
}

async function loadThinkingLineModule(root: string): Promise<ThinkingLineModule> {
	const moduleUrl = thinkingLineModuleUrl(root);
	// SAFETY: the benchmark loads the repository-owned module at the exact internal seam exercised by focused tests.
	const module = (await import(moduleUrl)) as ThinkingLineModule;
	if (!isRuntimeFunction(module.installThinkingLineDisplay)) {
		fail(`Thinking line installer is unavailable under ${root}`);
	}
	return module;
}

async function loadHostMarkdownRuntime(root: string): Promise<HostMarkdownRuntime> {
	const agentUrl = pathToFileURL(resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
	const tuiUrl = pathToFileURL(resolve(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href;
	const themeUrl = pathToFileURL(
		resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"),
	).href;
	// SAFETY: the benchmark loads the pinned Host packages from the two explicit repository roots and checks each used export.
	const agent = (await import(agentUrl)) as Pick<HostMarkdownRuntime, "AssistantMessageComponent">;
	// SAFETY: the benchmark loads the pinned Host packages from the two explicit repository roots and checks each used export.
	const tui = (await import(tuiUrl)) as Pick<HostMarkdownRuntime, "Markdown">;
	// SAFETY: the benchmark loads the pinned Host packages from the two explicit repository roots and checks each used export.
	const theme = (await import(themeUrl)) as Pick<HostMarkdownRuntime, "getMarkdownTheme" | "initTheme">;
	if (
		!isRuntimeFunction(agent.AssistantMessageComponent) ||
		!isRuntimeFunction(tui.Markdown) ||
		!isRuntimeFunction(theme.getMarkdownTheme) ||
		!isRuntimeFunction(theme.initTheme)
	) {
		fail(`Host Markdown runtime exports are unavailable under ${root}`);
	}
	return {
		AssistantMessageComponent: agent.AssistantMessageComponent,
		Markdown: tui.Markdown,
		getMarkdownTheme: theme.getMarkdownTheme,
		initTheme: theme.initTheme,
	};
}

function textOfLength(seed: string, length: number): string {
	if (length <= seed.length) return seed.slice(0, length);
	return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function streamingPrefixes(source: string, count: number): readonly string[] {
	return Array.from({ length: count }, (_value, index) =>
		source.slice(0, Math.max(1, Math.floor((source.length * (index + 1)) / count))),
	);
}

function chartSource(points: number): string {
	const rows = Array.from(
		{ length: points },
		(_value, index) => `point-${String(index + 1)} ${String((index % 17) - 8)}`,
	);
	return ["```chart", "type: line", "title: bounded series", "data:", ...rows, "```"].join("\n");
}

function treeSource(nodes: number): string {
	const rows = ["root"];
	for (let index = 1; index < nodes; index += 1) {
		const depth = index % 3 === 1 ? 1 : 2;
		rows.push(`${"  ".repeat(depth)}node-${String(index)}`);
	}
	return ["```tree", ...rows, "```"].join("\n");
}

function scenarios(): readonly Scenario[] {
	const prose = "Inspecting current behavior with CJK 内容 and emoji 🧪 while preserving structured Markdown.\n\n";
	const ordinaryFence = ["```typescript", textOfLength("const value = 42; // chart tree\n", 32_000), "```"].join("\n");
	const candidateWords = textOfLength(
		"chart and tree are ordinary prose here; no fenced visualization exists. ",
		32_000,
	);
	const stream = textOfLength(prose, 32_000);
	return [
		{
			id: "assistant-prose-1k",
			isStreaming: false,
			markdown: [textOfLength(prose, 1_024)],
			messageType: "assistant",
			rounds: 20,
		},
		{
			id: "assistant-prose-32k",
			isStreaming: false,
			markdown: [textOfLength(prose, 32_000)],
			messageType: "assistant",
			rounds: 1,
		},
		{
			id: "assistant-prose-128k",
			isStreaming: false,
			markdown: [textOfLength(prose, 128_000)],
			messageType: "assistant",
			mode: "transform",
			rounds: 1,
			widths: [100],
		},
		{
			id: "assistant-ordinary-fence",
			isStreaming: false,
			markdown: [ordinaryFence],
			messageType: "assistant",
			rounds: 1,
		},
		{
			id: "assistant-candidate-words",
			isStreaming: false,
			markdown: [candidateWords],
			messageType: "assistant",
			rounds: 1,
		},
		{
			id: "user-prose-32k",
			isStreaming: false,
			markdown: [textOfLength(prose, 32_000)],
			messageType: "user",
			rounds: 1,
		},
		{ id: "user-ordinary-fence", isStreaming: false, markdown: [ordinaryFence], messageType: "user", rounds: 1 },
		{
			feature: true,
			id: "thinking-32k",
			isStreaming: true,
			markdown: [textOfLength(prose, 32_000)],
			messageType: "assistant-thinking",
			rounds: 1,
		},
		{
			feature: true,
			id: "thinking-streaming-8k",
			isStreaming: true,
			markdown: streamingPrefixes(stream.slice(0, 8_000), 12),
			messageType: "assistant-thinking",
			rounds: 1,
			widths: [100],
		},
		{
			id: "assistant-streaming-8k",
			isStreaming: true,
			markdown: streamingPrefixes(stream.slice(0, 8_000), 12),
			messageType: "assistant",
			rounds: 1,
			widths: [100],
		},
		{
			feature: true,
			id: "chart-64-points",
			isStreaming: false,
			markdown: [chartSource(64)],
			messageType: "assistant",
			rounds: 5,
		},
		{
			feature: true,
			id: "tree-256-nodes",
			isStreaming: false,
			markdown: [treeSource(256)],
			messageType: "assistant",
			rounds: 3,
		},
	];
}

function renderThinkingScenario(
	host: HostMarkdownRuntime,
	transformer: MarkdownTransformer,
	scenario: Scenario,
): number {
	let checksum = 0;
	for (let round = 0; round < scenario.rounds; round += 1) {
		const component = new host.AssistantMessageComponent(undefined, false, host.getMarkdownTheme(), "• thoughts", 0, [
			transformer,
		]);
		for (const source of scenario.markdown) {
			const message: AssistantMessage = {
				api: "openai-completions",
				content: [{ type: "thinking", thinking: source }],
				model: "conversation-markdown-benchmark",
				provider: "fixture",
				role: "assistant",
				stopReason: scenario.isStreaming ? "pending" : "stop",
				timestamp: 0,
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
					input: 0,
					output: 0,
					totalTokens: 0,
				},
			};
			component.updateContent(message, scenario.isStreaming);
			for (const width of scenario.widths ?? WIDTHS) {
				const lines = component.render(width);
				checksum += lines.length + (lines[0]?.length ?? 0) + (lines.at(-1)?.length ?? 0);
			}
		}
	}
	return checksum;
}

function renderScenario(host: HostMarkdownRuntime, transformer: MarkdownTransformer, scenario: Scenario): number {
	if (scenario.messageType === "assistant-thinking" && scenario.mode !== "transform") {
		return renderThinkingScenario(host, transformer, scenario);
	}
	let checksum = 0;
	for (let round = 0; round < scenario.rounds; round += 1) {
		for (const source of scenario.markdown) {
			for (const width of scenario.widths ?? WIDTHS) {
				if (scenario.mode === "transform") {
					const output = transformer(source, {
						availableWidth: width,
						isStreaming: scenario.isStreaming,
						messageType: scenario.messageType,
					});
					checksum += output.length + (output.codePointAt(0) ?? 0);
					host.getMarkdownTheme().listBullet("- ");
					continue;
				}
				const markdown = new host.Markdown(source, 0, 0, host.getMarkdownTheme(), undefined, {
					transform: (value, availableWidth) =>
						transformer(value, {
							availableWidth,
							isStreaming: scenario.isStreaming,
							messageType: scenario.messageType,
						}),
				});
				const lines = markdown.render(width);
				checksum += lines.length + (lines[0]?.length ?? 0) + (lines.at(-1)?.length ?? 0);
			}
		}
	}
	return checksum;
}

function timedRun(host: HostMarkdownRuntime, transformer: MarkdownTransformer, scenario: Scenario): number {
	const started = performance.now();
	const checksum = renderScenario(host, transformer, scenario);
	if (!Number.isSafeInteger(checksum) || checksum <= 0) fail(`${scenario.id} produced no visible output`);
	return performance.now() - started;
}

function percentile(values: readonly number[], quantile: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
	return sorted[index] ?? Number.NaN;
}

function summary(values: readonly number[]): TimingSummary {
	return {
		maximum: percentile(values, 1),
		minimum: percentile(values, 1 / values.length),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
	};
}

function nextRandom(state: number): number {
	let value = state | 0;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	return value >>> 0;
}

function bootstrapMedianRatio(pairs: readonly SamplePair[]): readonly [number, number] {
	const medians: number[] = [];
	let randomState = 0x5f3759df;
	for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
		const ratios: number[] = [];
		for (let sample = 0; sample < pairs.length; sample += 1) {
			randomState = nextRandom(randomState);
			const pair = pairs[randomState % pairs.length];
			if (!pair || pair.baselineMs <= 0) fail("invalid benchmark sample");
			ratios.push(pair.candidateMs / pair.baselineMs);
		}
		medians.push(percentile(ratios, 0.5));
	}
	return [percentile(medians, 0.025), percentile(medians, 0.975)];
}

function benchmarkScenario(
	baselineHost: HostMarkdownRuntime,
	baseline: MarkdownTransformer,
	candidateHost: HostMarkdownRuntime,
	candidate: MarkdownTransformer,
	scenario: Scenario,
	warmups: number,
	samples: number,
): ScenarioReport {
	for (let index = 0; index < warmups; index += 1) {
		renderScenario(index % 2 === 0 ? baselineHost : candidateHost, index % 2 === 0 ? baseline : candidate, scenario);
		renderScenario(index % 2 === 0 ? candidateHost : baselineHost, index % 2 === 0 ? candidate : baseline, scenario);
	}

	const pairs: SamplePair[] = [];
	for (let index = 0; index < samples; index += 1) {
		if (index % 2 === 0) {
			pairs.push({
				baselineMs: timedRun(baselineHost, baseline, scenario),
				candidateMs: timedRun(candidateHost, candidate, scenario),
			});
		} else {
			const candidateMs = timedRun(candidateHost, candidate, scenario);
			pairs.push({ baselineMs: timedRun(baselineHost, baseline, scenario), candidateMs });
		}
	}
	const baselineMs = summary(pairs.map((pair) => pair.baselineMs));
	const candidateMs = summary(pairs.map((pair) => pair.candidateMs));
	const confidence = bootstrapMedianRatio(pairs);
	const slowerThanBaseline = confidence[0] > 1;
	return {
		baselineMs,
		candidateMs,
		feature: scenario.feature === true,
		id: scenario.id,
		medianRatioConfidence95: confidence,
		regression: scenario.feature !== true && slowerThanBaseline,
		slowerThanBaseline,
	};
}

function timedFreshImport(root: string): number {
	const moduleUrl = conversationMarkdownModuleUrl(root);
	const started = performance.now();
	const child = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(moduleUrl)})`], {
		cwd: root,
		stderr: "pipe",
		stdout: "ignore",
	});
	const elapsed = performance.now() - started;
	if (child.exitCode !== 0) {
		const error = new TextDecoder().decode(child.stderr).trim();
		fail(`fresh import exited ${String(child.exitCode)}: ${error.slice(0, 500)}`);
	}
	return elapsed;
}

function benchmarkFreshImport(
	baselineRoot: string,
	candidateRoot: string,
	warmups: number,
	samples: number,
): ScenarioReport {
	for (let index = 0; index < warmups; index += 1) {
		timedFreshImport(index % 2 === 0 ? baselineRoot : candidateRoot);
		timedFreshImport(index % 2 === 0 ? candidateRoot : baselineRoot);
	}
	const pairs: SamplePair[] = [];
	for (let index = 0; index < samples; index += 1) {
		if (index % 2 === 0) {
			pairs.push({ baselineMs: timedFreshImport(baselineRoot), candidateMs: timedFreshImport(candidateRoot) });
		} else {
			const candidateMs = timedFreshImport(candidateRoot);
			pairs.push({ baselineMs: timedFreshImport(baselineRoot), candidateMs });
		}
	}
	const baselineMs = summary(pairs.map((pair) => pair.baselineMs));
	const candidateMs = summary(pairs.map((pair) => pair.candidateMs));
	const confidence = bootstrapMedianRatio(pairs);
	const slowerThanBaseline = confidence[0] > 1;
	return {
		baselineMs,
		candidateMs,
		feature: false,
		id: "fresh-conversation-markdown-import",
		medianRatioConfidence95: confidence,
		regression: slowerThanBaseline,
		slowerThanBaseline,
	};
}

handleBenchmarkMeta(
	process.argv.slice(2),
	"usage: benchmark:capability:conversation-markdown --baseline-root <path> [--candidate-root <path>] [--samples <count>] [--warmups <count>] [--output <path>]",
	[
		"profile=offline; installed Pi libraries; no network or credentials; output=.artifacts/conversation-markdown-benchmark/latest.json",
		"fresh-conversation-markdown-import",
		...scenarios().map((scenario) => scenario.id),
	],
);
const options = parseOptions(process.argv.slice(2));
console.error(`Capability Benchmark: Conversation Markdown; offline; report: ${options.output}`);
const baselineHost = await loadHostMarkdownRuntime(options.baselineRoot);
const candidateHost = await loadHostMarkdownRuntime(options.candidateRoot);
const candidateThinkingLine = await loadThinkingLineModule(options.candidateRoot);
const uninstallCandidateThinkingLine = candidateThinkingLine.installThinkingLineDisplay();
baselineHost.initTheme("dark");
candidateHost.initTheme("dark");
process.stderr.write("Benchmarking fresh-conversation-markdown-import...\n");
const reports: ScenarioReport[] = [
	benchmarkFreshImport(options.baselineRoot, options.candidateRoot, options.warmups, options.samples),
];
const baseline = await loadTransformer(options.baselineRoot);
const candidate = await loadTransformer(options.candidateRoot);
const selectedScenarios = scenarios();
for (const scenario of selectedScenarios) {
	process.stderr.write(`Benchmarking ${scenario.id}...\n`);
	const scenarioBaseline = scenario.messageType === "assistant-thinking" ? NATIVE_THINKING_TRANSFORMER : baseline;
	reports.push(
		benchmarkScenario(
			baselineHost,
			scenarioBaseline,
			candidateHost,
			candidate,
			scenario,
			options.warmups,
			options.samples,
		),
	);
}
const confirmations: ScenarioReport[] = [];
for (const report of reports.filter((candidateReport) => candidateReport.regression)) {
	if (report.id === "fresh-conversation-markdown-import") {
		process.stderr.write("Confirming fresh-conversation-markdown-import...\n");
		confirmations.push(
			benchmarkFreshImport(options.baselineRoot, options.candidateRoot, options.warmups, options.samples),
		);
		continue;
	}
	const scenario = selectedScenarios.find((candidateScenario) => candidateScenario.id === report.id);
	if (!scenario) fail(`missing confirmation scenario ${report.id}`);
	process.stderr.write(`Confirming ${scenario.id}...\n`);
	const scenarioBaseline = scenario.messageType === "assistant-thinking" ? NATIVE_THINKING_TRANSFORMER : baseline;
	confirmations.push(
		benchmarkScenario(
			baselineHost,
			scenarioBaseline,
			candidateHost,
			candidate,
			scenario,
			options.warmups,
			options.samples,
		),
	);
}
const regressions = confirmations.filter((report) => report.regression);
uninstallCandidateThinkingLine();
await writeBenchmarkReport(
	options.output,
	requireJsonInputValue(
		{
			bootstrapIterations: BOOTSTRAP_ITERATIONS,
			confirmations,
			regressions: regressions.map((report) => report.id),
			reports,
			samples: options.samples,
			warmups: options.warmups,
		},
		"Conversation Markdown benchmark report",
	),
);
