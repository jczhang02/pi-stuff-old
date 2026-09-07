import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function prepareGoalTests(repositoryRoot: string): Promise<string> {
	const outputDirectory = join(repositoryRoot, ".artifacts", "goal-upstream-tests");
	await rm(outputDirectory, { recursive: true, force: true });
	await run(
		process.execPath,
		["node_modules/typescript/bin/tsc", "-p", "config/typescript/goal-upstream-run.json"],
		repositoryRoot,
	);
	await writeFile(
		join(outputDirectory, "packages/pi-stuff/src/conversation-ui/index.js"),
		`export * from "../../../../tests/goal-upstream/ui-node-shim.js";\n`,
	);
	return outputDirectory;
}

async function run(command: string, arguments_: string[], cwd: string) {
	const process = Bun.spawn([command, ...arguments_], {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await process.exited;
	if (exitCode !== 0) {
		throw new Error(`${command} ${arguments_.join(" ")} exited with status ${exitCode}`);
	}
}
