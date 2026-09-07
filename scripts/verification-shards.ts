import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readVerificationPlan } from "./verification-plan-contract.ts";

export type VerificationShard = { index: number; total: number; plan: string; files: string[] };
const TIMINGS = Type.Object({
	setupDurationMs: Type.Number({ minimum: 0 }),
	files: Type.Record(Type.String(), Type.Number({ exclusiveMinimum: 0 })),
});
const MAX_SHARDS = 16;

function cost(file: string, timing: ReadonlyMap<string, number>): number {
	return timing.get(file) ?? 1_000;
}

export function partitionFiles(
	files: readonly string[],
	timing: ReadonlyMap<string, number>,
	count: number,
): string[][] {
	if (!Number.isInteger(count) || count < 1 || count > MAX_SHARDS) throw new Error("Invalid shard count");
	const buckets = Array.from({ length: count }, () => {
		const files: string[] = [];
		return { files, durationMs: 0 };
	});
	const first = buckets[0];
	if (!first) throw new Error("No verification shards");
	for (const file of [...files].sort((a, b) => cost(b, timing) - cost(a, timing) || a.localeCompare(b))) {
		const bucket = buckets.reduce((best, current) => (current.durationMs < best.durationMs ? current : best), first);
		bucket.files.push(file);
		bucket.durationMs += cost(file, timing);
	}
	return buckets.filter((bucket) => bucket.files.length > 0).map((bucket) => bucket.files.sort());
}

function estimatedDuration(files: readonly string[], timing: ReadonlyMap<string, number>, count: number): number {
	return Math.max(
		0,
		...partitionFiles(files, timing, count).map((bucket) =>
			bucket.reduce((sum, file) => sum + cost(file, timing), 0),
		),
	);
}

export function estimateShardCount(files: readonly string[], timing: ReadonlyMap<string, number>): number {
	let count = 1;
	let duration = estimatedDuration(files, timing, count);
	// ponytail: bounded LPT estimates ignore runner queue variance; revise the cap from hosted measurements if it matters.
	for (let candidate = 2; candidate <= Math.min(MAX_SHARDS, files.length); candidate++) {
		const candidateDuration = estimatedDuration(files, timing, candidate);
		if (candidateDuration < duration) {
			count = candidate;
			duration = candidateDuration;
		}
	}
	return count;
}

export function writeVerificationShards(planPath: string, outputDirectory: string): VerificationShard[] {
	const root = process.cwd();
	const plan = readVerificationPlan(planPath, root);
	const recorded = Value.Parse(
		TIMINGS,
		JSON.parse(readFileSync(resolve(import.meta.dirname, "../config/verification-timings.json"), "utf8")),
	);
	const timing = new Map(Object.entries(recorded.files));
	const count = estimateShardCount(plan.files, timing);
	const buckets = plan.files.length ? partitionFiles(plan.files, timing, count) : [];
	mkdirSync(outputDirectory, { recursive: true });
	const shards = buckets.map((files, index) => {
		const shardPlan = { ...plan, mode: files.length === plan.files.length ? plan.mode : "selected", files };
		const path = resolve(outputDirectory, `plan-${index + 1}.json`);
		writeFileSync(path, `${JSON.stringify(shardPlan, null, 2)}\n`);
		return { index: index + 1, total: buckets.length, plan: relative(root, path), files };
	});
	writeFileSync(resolve(outputDirectory, "matrix.json"), `${JSON.stringify(shards, null, 2)}\n`);
	console.error(
		`Verification: ${plan.files.length} files, ${shards.length} shards; estimated tests ${Math.round(estimatedDuration(plan.files, timing, count))} ms + ${recorded.setupDurationMs} ms setup per concurrent runner (queue/installation not included).`,
	);
	return shards;
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: false,
		options: { plan: { type: "string" }, output: { type: "string" } },
	});
	if (!values.plan || !values.output) throw new Error("--plan and --output are required");
	console.log(JSON.stringify(writeVerificationShards(values.plan, values.output)));
}
