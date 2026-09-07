import { describe, expect, test } from "bun:test";
import {
	buildPiArgs,
	PI_STUFF_AGENT_PATH_ENV,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.ts";
import {
	getPiSpawnCommand,
	PI_CODING_AGENT_PACKAGE,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/pi-spawn.ts";

describe("Pi child Host inheritance", () => {
	test("reuses the running standalone Pi executable instead of its package-resolved development Host", () => {
		const standaloneHost = "/opt/pi-coding-agent/pi";
		const oldPackageRoot = "/workspace/node_modules/@earendil-works/pi-coding-agent";
		const oldCli = `${oldPackageRoot}/dist/cli.js`;

		expect(
			getPiSpawnCommand(["--mode", "json", "-p"], {
				argv1: "/$bunfs/root/pi",
				execPath: standaloneHost,
				env: {},
				existsSync: (candidate) => candidate === standaloneHost || candidate === oldCli,
				realpathSync: (candidate) => candidate,
				resolvePackageJson: () => `${oldPackageRoot}/package.json`,
				readFileSync: () => JSON.stringify({ name: PI_CODING_AGENT_PACKAGE, bin: { pi: "dist/cli.js" } }),
			}),
		).toEqual({ command: standaloneHost, args: ["--mode", "json", "-p"] });
	});
});

test("Agents gives same-name sibling processes stable unique path components", () => {
	const previousAgentPath = process.env[PI_STUFF_AGENT_PATH_ENV];
	process.env[PI_STUFF_AGENT_PATH_ENV] = "root-run:0";
	const buildChildPath = (runId?: string, childIndex?: number): string | undefined => {
		const options: Parameters<typeof buildPiArgs>[0] = {
			baseArgs: [],
			task: "path identity test",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			childAgentName: "general",
		};
		if (runId) options.runId = runId;
		if (childIndex !== undefined) options.childIndex = childIndex;
		return buildPiArgs(options).env[PI_STUFF_AGENT_PATH_ENV];
	};

	try {
		expect(buildChildPath("parallel-run", 1)).toBe("root-run:0 › parallel-run:1");
		expect(buildChildPath("parallel-run", 2)).toBe("root-run:0 › parallel-run:2");
		expect(buildChildPath()).toBe("root-run:0");
	} finally {
		if (previousAgentPath === undefined) delete process.env[PI_STUFF_AGENT_PATH_ENV];
		else process.env[PI_STUFF_AGENT_PATH_ENV] = previousAgentPath;
	}
});
