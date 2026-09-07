import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SUBAGENT_CHILD_ENV } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.ts";

test("child entrypoint skips the unused root import without bypassing parent or override registration", () => {
	const entrypoint = resolve(import.meta.dir, "../../../packages/pi-stuff/src/subagents/index.ts");
	for (const { child, override, loadsRoot } of [
		{ child: "1", override: false, loadsRoot: false },
		{ child: "0", override: false, loadsRoot: true },
		{ child: "1", override: true, loadsRoot: true },
	]) {
		const source = String.raw`
import { plugin } from "bun";
plugin({
    name: "agents-root-import-boundary",
    setup(build) {
        build.onLoad({ filter: /\/subagents\/src\/extension\/index\.ts$/ }, () => {
            throw new Error("agents-root-import-observed");
        });
    },
});
const { default: register } = await import(${JSON.stringify(entrypoint)});
await register({}, ${override ? "{ isChildProcess: () => false }" : "{}"});
`;
		const result = Bun.spawnSync([process.execPath, "--eval", source], {
			env: { ...process.env, [SUBAGENT_CHILD_ENV]: child },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString().includes("agents-root-import-observed")).toBe(loadsRoot);
		expect(result.exitCode).toBe(loadsRoot ? 1 : 0);
	}
});
