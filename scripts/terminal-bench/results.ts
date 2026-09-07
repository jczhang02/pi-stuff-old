import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

const COUNT = Type.Number({ minimum: 0 });
const USAGE = Type.Object({
	input: COUNT,
	output: COUNT,
	cacheRead: COUNT,
	cacheWrite: COUNT,
	totalTokens: COUNT,
	cost: Type.Object({ total: COUNT }),
});
const CALL = Type.Object({
	type: Type.Union([Type.Literal("call_started"), Type.Literal("call_finished")]),
	id: Type.String({ minLength: 1 }),
	usage: Type.Optional(USAGE),
});
const TRIAL = Type.Object({
	task_name: Type.String({ minLength: 1 }),
	exception_info: Type.Optional(Type.Union([Type.Null(), Type.Object({ exception_type: Type.String() })])),
	verifier_result: Type.Optional(
		Type.Union([
			Type.Null(),
			Type.Object({
				rewards: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Number())]),
			}),
		]),
	),
});
const PROTOCOL = Type.Object({
	tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
	repetitions: Type.Integer({ minimum: 1 }),
});

async function outcome(path: string): Promise<{ task: string; passed: boolean } | undefined> {
	if (!(await Bun.file(path).exists())) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(path).text());
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (!Check(TRIAL, value)) return undefined;
	const exception = value.exception_info?.exception_type;
	if (exception && exception !== "AgentTimeoutError") return undefined;
	const reward = value.verifier_result?.rewards?.["reward"];
	if (reward !== 0 && reward !== 1 && exception !== "AgentTimeoutError") return undefined;
	return { task: basename(value.task_name), passed: reward === 1 };
}

async function trialDirectories(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

export async function archiveUnfinishedTrials(directory: string): Promise<void> {
	const interrupted = join(directory, "interrupted");
	await mkdir(interrupted, { recursive: true });
	for (const trial of await trialDirectories(join(directory, "job"))) {
		if (!(await outcome(join(trial, "result.json")))) {
			await rename(trial, join(interrupted, `${basename(trial)}-${randomUUID()}`));
		}
	}
}

async function summarizeUsage(directories: string[]) {
	const started = new Set<string>();
	const finished = new Map<string, string>();
	let observedTokens = 0;
	let observedCost = 0;
	let malformedUsageLogs = 0;
	let missingUsageCalls = 0;
	let usageFiles = 0;
	for (const directory of directories) {
		const path = join(directory, "agent", "usage.jsonl");
		if (!(await Bun.file(path).exists())) continue;
		usageFiles++;
		for (const line of (await Bun.file(path).text()).split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				malformedUsageLogs++;
				continue;
			}
			if (!Check(CALL, entry)) {
				malformedUsageLogs++;
				continue;
			}
			if (entry.type === "call_started") {
				started.add(entry.id);
				continue;
			}
			const previous = finished.get(entry.id);
			if (previous) {
				if (previous !== line) malformedUsageLogs++;
				continue;
			}
			finished.set(entry.id, line);
			if (entry.usage) {
				observedTokens += entry.usage.totalTokens;
				observedCost += entry.usage.cost.total;
			} else missingUsageCalls++;
		}
	}
	return {
		observedTokens,
		observedCost,
		malformedUsageLogs,
		usageFiles,
		pendingCalls: [...started].filter((id) => !finished.has(id)).length + missingUsageCalls,
		calls: finished.size,
	};
}

export async function summarizeEvaluation(directory: string) {
	const protocol: unknown = await Bun.file(join(directory, "protocol.json")).json();
	if (!Check(PROTOCOL, protocol)) throw new Error("Invalid Terminal-Bench protocol.json");
	const expected = new Set(protocol.tasks);
	const seen = new Map<string, number>();
	const current = await trialDirectories(join(directory, "job"));
	const interrupted = await trialDirectories(join(directory, "interrupted"));
	let passed = 0;
	let failed = 0;
	let invalidTrials = 0;
	let duplicateTrials = 0;
	let missingUsageTrials = 0;
	for (const trial of current) {
		const result = await outcome(join(trial, "result.json"));
		if (!result || !expected.has(result.task)) {
			invalidTrials++;
			continue;
		}
		const count = (seen.get(result.task) ?? 0) + 1;
		seen.set(result.task, count);
		if (count > protocol.repetitions) {
			duplicateTrials++;
			continue;
		}
		if (!(await Bun.file(join(trial, "agent", "usage.jsonl")).exists())) missingUsageTrials++;
		if (result.passed) passed++;
		else failed++;
	}
	const denominator = protocol.tasks.length * protocol.repetitions;
	return {
		denominator,
		completed: passed + failed,
		passed,
		failed,
		incomplete: denominator - passed - failed,
		invalidTrials,
		duplicateTrials,
		missingUsageTrials,
		interruptedAttempts: interrupted.length,
		...(await summarizeUsage([...current, ...interrupted])),
	};
}

export type EvaluationReport = Awaited<ReturnType<typeof summarizeEvaluation>>;
