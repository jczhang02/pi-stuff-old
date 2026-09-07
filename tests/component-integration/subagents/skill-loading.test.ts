import { expect, test } from "bun:test";

test("loads filesystem Skill resolution only when a launch requests Skills", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import assert from "node:assert/strict";
const { buildAsyncSingleRunnerWork } = await import("./packages/pi-stuff/src/subagents/src/runs/background/runner-work.ts");
const loaded = () => Object.keys(require.cache).some((path) => path.endsWith("/agents/skills.ts"));
const cwd = process.cwd();
const input = {
	agent: "worker",
	task: "Inspect the implementation",
	agentConfig: {
		name: "worker",
		description: "Synthetic worker",
		source: "project",
		filePath: cwd + "/worker.md",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
	},
	ctx: { pi: {}, cwd, currentSessionId: "skill-loading-fixture" },
	maxSubagentDepth: 2,
};
const withoutSkills = await buildAsyncSingleRunnerWork("without-skills", input);
assert(!("error" in withoutSkills));
assert.deepEqual(withoutSkills.work.task.skills, []);
assert.equal(loaded(), false, "A Skill-free launch loaded filesystem discovery");
const rejected = await buildAsyncSingleRunnerWork("with-skills", { ...input, skills: ["pi-subagents"] });
assert.deepEqual(rejected, { error: "Skills not found: pi-subagents" });
assert.equal(loaded(), true, "Requested Skills must use the real resolver");
`,
		],
		{ cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
});
