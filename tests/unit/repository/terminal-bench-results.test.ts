import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonInputValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { archiveUnfinishedTrials, summarizeEvaluation } from "../../../scripts/terminal-bench/results.js";

async function trial(root: string, name: string, result?: JsonInputValue): Promise<string> {
	const path = join(root, name);
	await mkdir(join(path, "agent"), { recursive: true });
	if (result !== undefined) await writeFile(join(path, "result.json"), JSON.stringify(result));
	return path;
}

test("summarizes the fixed denominator and observes current plus archived calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "terminal-bench-results-"));
	await writeFile(join(root, "protocol.json"), JSON.stringify({ tasks: ["one", "two"], repetitions: 2 }));
	const job = join(root, "job");
	const interrupted = join(root, "interrupted");
	await mkdir(interrupted, { recursive: true });
	const passed = await trial(job, "one-1", { task_name: "one", verifier_result: { rewards: { reward: 1 } } });
	const failed = await trial(job, "two-1", {
		task_name: "two",
		exception_info: { exception_type: "AgentTimeoutError" },
	});
	await writeFile(
		join(passed, "agent/usage.jsonl"),
		`${JSON.stringify({ type: "call_started", id: "a" })}\n${JSON.stringify({ type: "call_finished", id: "a", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.000007 } }, pricing: { input: 1, output: 2 } })}\nmalformed\n`,
	);
	await writeFile(join(failed, "agent/usage.jsonl"), `${JSON.stringify({ type: "call_started", id: "b" })}\n`);
	await expect(summarizeEvaluation(root)).resolves.toMatchObject({
		denominator: 4,
		completed: 2,
		passed: 1,
		failed: 1,
		incomplete: 2,
		observedTokens: 5,
		observedCost: 0.000007,
		pendingCalls: 1,
		malformedUsageLogs: 1,
	});
});

test("archives malformed and missing trials while preserving valid failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "terminal-bench-archive-"));
	await mkdir(join(root, "job"), { recursive: true });
	await writeFile(join(root, "job/config.json"), "keep");
	await writeFile(join(root, "job/result.json"), "keep");
	const valid = await trial(join(root, "job"), "valid", {
		task_name: "one",
		exception_info: { exception_type: "AgentTimeoutError" },
	});
	await trial(join(root, "job"), "invalid", { task_name: "one" });
	await trial(join(root, "job"), "missing");
	await archiveUnfinishedTrials(root);
	await expect(readFile(join(valid, "result.json"), "utf8")).resolves.toContain("AgentTimeoutError");
	await expect(readFile(join(root, "job/config.json"), "utf8")).resolves.toBe("keep");
	await expect(readFile(join(root, "job/result.json"), "utf8")).resolves.toBe("keep");
	const moved = (await readdir(join(root, "interrupted"))).filter((name) => name.startsWith("invalid-")).length;
	const missingMoved = (await readdir(join(root, "interrupted"))).filter((name) => name.startsWith("missing-")).length;
	if (moved !== 1 || missingMoved !== 1) throw new Error("unfinished trial was not archived");
});
