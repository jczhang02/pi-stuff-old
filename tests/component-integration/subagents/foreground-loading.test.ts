import { expect, test } from "bun:test";

test.each([
	["foreground/subagent-executor.ts", "foreground/launch-preparation.ts"],
	["foreground/launch-preparation.ts", "foreground/launch-model-planning.ts"],
	["foreground/launch-model-planning.ts", "background/resolved-task.ts"],
	["foreground/launch-builders.ts", "foreground/launch-model-planning.ts"],
	["foreground/launch-builders.ts", "foreground/foreground-lifecycle.ts"],
	["foreground/foreground-lifecycle.ts", "background/recovery-descriptor.ts"],
	["background/async-execution.ts", "background/recovery-descriptor.ts"],
	["background/async-execution.ts", "background/runner-process.ts"],
	["foreground/execution.ts", "background/subagent-runner.ts"],
	["background/subagent-runner.ts", "background/runner-finalization.ts"],
	["background/subagent-runner.ts", "background/runner-control.ts"],
	["background/subagent-runner.ts", "background/writer-process-lifecycle.ts"],
	["background/child-task-runner.ts", "background/child-process-engine.ts"],
	["background/child-process-engine.ts", "background/child-protocol-runtime.ts"],
])("keeps %s separate from its next cold execution stage", async (entry, next) => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import assert from "node:assert/strict";
await import(${JSON.stringify(`./packages/pi-stuff/src/subagents/src/runs/${entry}`)});
assert(!Object.keys(require.cache).some((path) => path.endsWith(${JSON.stringify(`/runs/${next}`)})),
	"The next execution stage was loaded before its event-loop boundary");
`,
		],
		{ cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
});
