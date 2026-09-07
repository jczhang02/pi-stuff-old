import { expect, test } from "bun:test";
import { estimateShardCount, partitionFiles } from "../../../scripts/verification-shards.ts";

test("sharding stops adding runners when the longest file fixes the completion time", () => {
	const timing = new Map([
		["a", 6_000],
		["b", 3_000],
		["c", 3_000],
		["d", 3_000],
		["e", 3_000],
	]);
	const files = [...timing.keys()];
	expect(estimateShardCount(files, timing)).toBe(3);
	expect(partitionFiles(files, timing, 3)).toEqual([["a"], ["b", "d"], ["c", "e"]]);
	expect(partitionFiles(files, timing, 1)).toEqual([files]);
	expect(() => partitionFiles(files, timing, 0)).toThrow();
});

test("aggregate rejects duplicated or incomplete shard evidence even with a complete file union", async () => {
	const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join, resolve } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-shard-reports-"));
	try {
		const files = [
			"tests/unit/repository/verification-plan.test.ts",
			"tests/unit/repository/verification-shards.test.ts",
		];
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
		const planPath = join(directory, "plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				version: 1,
				profile: "offline",
				base: head,
				head,
				mode: "selected",
				reason: "fixture",
				changedFiles: ["scripts/run-isolated-tests.ts"],
				files,
				acceptanceMatrix: "full",
			}),
		);
		const reports = files.map((file) => ({
			profile: "offline",
			status: "passed",
			acceptanceMatrix: "full",
			scope: { files: [file] },
			results: [{ file, exitCode: 0, executed: 1, skipped: 0, durationMs: 1 }],
		}));
		const first = join(directory, "first.json");
		const second = join(directory, "second.json");
		await writeFile(first, JSON.stringify(reports[0]));
		await writeFile(second, JSON.stringify(reports[1]));
		const output = join(directory, "combined.json");
		const run = (...paths: string[]) =>
			Bun.spawnSync([
				process.execPath,
				resolve("scripts/aggregate-test-reports.ts"),
				"--plan",
				planPath,
				"--output",
				output,
				...paths,
			]);
		expect(run(first, second).exitCode).toBe(0);
		expect(run(first, second, second).exitCode).toBe(1);
		for (const bad of [
			{ ...reports[1], status: "failed" },
			{ ...reports[1], notRun: [files[1]] },
			{ ...reports[1], cancelled: [files[1]] },
			{ ...reports[1], acceptanceMatrix: "representative" },
		]) {
			await writeFile(second, JSON.stringify(bad));
			expect(run(first, second).exitCode).toBe(1);
		}
		expect(run(first).exitCode).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
