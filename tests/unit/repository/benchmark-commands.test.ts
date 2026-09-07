import { describe, expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url).pathname;
const commands = [
	"benchmark-conversation-markdown",
	"benchmark-lifecycle",
	"benchmark-magic-context",
	"benchmark-ponytail",
	"benchmark-tool-activity",
	"benchmark-terminal-bench",
	"compare-magic-context",
] as const;

function run(name: string, argument: string) {
	return Bun.spawnSync([process.execPath, `${root}scripts/${name}.ts`, argument], {
		cwd: root,
		stderr: "pipe",
		stdout: "pipe",
	});
}

describe("benchmark command boundaries", () => {
	test("help and list are metadata-only", () => {
		for (const name of commands) {
			for (const argument of ["--help", "--list"]) {
				const result = run(name, argument);
				expect(result.exitCode).toBe(0);
				expect(result.stdout.toString()).not.toContain("failed");
			}
		}
	}, 30_000);

	test("unknown options fail", () => {
		for (const name of commands) expect(run(name, "--unknown").exitCode).not.toBe(0);
	});

	test("live benchmarks require an explicit live profile", () => {
		const result = Bun.spawnSync(
			[process.execPath, `${root}scripts/benchmark-ponytail.ts`, "--output", "/tmp/benchmark.json"],
			{ cwd: root, stderr: "pipe", stdout: "pipe" },
		);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("--profile live");
	});
});
