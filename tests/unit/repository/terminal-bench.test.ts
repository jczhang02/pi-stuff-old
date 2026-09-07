import { expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url).pathname;

test("Terminal-Bench preview selects the full Suite task set without running Harbor", () => {
	const result = Bun.spawnSync([process.execPath, "scripts/benchmark-terminal-bench.ts", "--list"], {
		cwd: root,
		env: { ...process.env, HARBOR_BIN: "/missing/harbor" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	const output = result.stdout.toString();
	expect(output).toContain("89 tasks");
	expect(output).toContain("main");
	expect(output).toContain("gpt-5.6-luna");
	expect(output).toContain("regex-log");
});

test("Terminal-Bench resume rejects edited protocol and missing Harbor state", async () => {
	const { createHash } = await import("node:crypto");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { verifyResume } = await import("../../../scripts/terminal-bench/run.js");
	const directory = await mkdtemp(join(tmpdir(), "terminal-bench-resume-"));
	try {
		const protocol = '{"tasks":["original"]}';
		await Bun.write(join(directory, "protocol.json"), protocol);
		await Bun.write(join(directory, "protocol.sha256"), createHash("sha256").update(protocol).digest("hex"));
		await expect(verifyResume(directory)).rejects.toThrow("original Harbor job state");
		await Bun.write(join(directory, "protocol.json"), '{"tasks":["edited"]}');
		await expect(verifyResume(directory)).rejects.toThrow("protocol changed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
