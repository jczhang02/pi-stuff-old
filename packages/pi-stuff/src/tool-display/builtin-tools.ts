import {
	type BashToolOptions,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { classifyBashActivity, singleActivity, skillReadName } from "./activity.ts";
import type { SuiteToolRegistrationHost } from "./contract.ts";
import { registerSuiteOwnedTool } from "./registration.ts";
import { describeBuiltinTarget, formatElapsed, summarizeBuiltin } from "./tool-text.ts";

const PROGRAMMATIC_READ = { replay: "record" } as const;
export const BASH_CODE_MODE_CONTRACT = { replay: "never" } as const;

export interface BuiltinHostSettings {
	readonly autoResizeImages: boolean;
	readonly shellCommandPrefix: string | undefined;
	readonly shellPath: string | undefined;
}

export interface BuiltinFactoryOverrides {
	readonly bash?: typeof createBashToolDefinition;
	readonly read?: typeof createReadToolDefinition;
}

export function resolveBuiltinHostSettings(
	cwd: string,
	projectTrusted: boolean,
	agentDir = getAgentDir(),
): BuiltinHostSettings {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return {
		autoResizeImages: settings.getImageAutoResize(),
		shellCommandPrefix: settings.getShellCommandPrefix(),
		shellPath: settings.getShellPath(),
	};
}

function registerBashBuiltin(
	pi: SuiteToolRegistrationHost,
	cwd: string,
	hostSettings: BuiltinHostSettings,
	factories: BuiltinFactoryOverrides,
): void {
	const bashOptions: BashToolOptions = {};
	if (hostSettings.shellCommandPrefix !== undefined) bashOptions.commandPrefix = hostSettings.shellCommandPrefix;
	if (hostSettings.shellPath !== undefined) bashOptions.shellPath = hostSettings.shellPath;
	const bash = (factories.bash ?? createBashToolDefinition)(cwd, bashOptions);
	registerSuiteOwnedTool(
		pi,
		bash,
		{
			activity: {
				categories: [
					"commit",
					"push",
					"merge",
					"rebase",
					"create-pr",
					"launch-background",
					"run-command",
					"read-file",
					"search-pattern",
					"list-directory",
				],
				classify: classifyBashActivity,
			},
			label: "Bash",
			runningSummary: (_args, durationMs) => `running ${formatElapsed(durationMs ?? 0)}`,
			summarize: (args, result, state, durationMs) => summarizeBuiltin("bash", args, result, state, durationMs),
			target: (args) => describeBuiltinTarget("bash", args),
			tracksElapsed: true,
		},
		BASH_CODE_MODE_CONTRACT,
	);
}

function registerReadBuiltin(
	pi: SuiteToolRegistrationHost,
	cwd: string,
	hostSettings: BuiltinHostSettings,
	factories: BuiltinFactoryOverrides,
): void {
	const read = (factories.read ?? createReadToolDefinition)(cwd, {
		autoResizeImages: hostSettings.autoResizeImages,
	});
	registerSuiteOwnedTool(
		pi,
		read,
		{
			activity: {
				categories: ["read-file"],
				classify: ({ args }) => singleActivity("read-file", { key: resolve(cwd, args.path), target: args.path }),
			},
			label: (args) => {
				const skill = skillReadName(cwd, args);
				return skill ? `Skill ${skill}` : "Read";
			},
			runningSummary: "reading",
			summarize: (args, result, state, durationMs) => {
				if (!skillReadName(cwd, args)) return summarizeBuiltin("read", args, result, state, durationMs);
				if (state === "success") return "loaded";
				return state === "error" ? "Failed to read SKILL.md" : state;
			},
			target: (args) => (skillReadName(cwd, args) ? "" : describeBuiltinTarget("read", args)),
		},
		PROGRAMMATIC_READ,
	);
}

export function registerBuiltins(
	pi: SuiteToolRegistrationHost,
	cwd: string,
	hostSettings: BuiltinHostSettings,
	factories: BuiltinFactoryOverrides = {},
	selectedNames?: ReadonlySet<string>,
): void {
	if (!selectedNames || selectedNames.has("read")) registerReadBuiltin(pi, cwd, hostSettings, factories);

	if (!selectedNames || selectedNames.has("write")) {
		const write = createWriteToolDefinition(cwd);
		registerSuiteOwnedTool(pi, write, {
			activity: {
				categories: ["change-file"],
				classify: ({ args }) => singleActivity("change-file", { key: resolve(cwd, args.path), target: args.path }),
			},
			label: "Write",
			runningSummary: "writing",
			summarize: (args, result, state, durationMs) => summarizeBuiltin("write", args, result, state, durationMs),
			target: (args) => describeBuiltinTarget("write", args),
		});
	}

	if (!selectedNames || selectedNames.has("edit")) {
		const edit = createEditToolDefinition(cwd);
		registerSuiteOwnedTool(pi, edit, {
			activity: {
				categories: ["change-file"],
				classify: ({ args }) => singleActivity("change-file", { key: resolve(cwd, args.path), target: args.path }),
			},
			label: "Edit",
			runningSummary: "editing",
			summarize: (args, result, state, durationMs) => summarizeBuiltin("edit", args, result, state, durationMs),
			target: (args) => describeBuiltinTarget("edit", args),
		});
	}

	if (!selectedNames || selectedNames.has("bash")) {
		registerBashBuiltin(pi, cwd, hostSettings, factories);
	}

	if (!selectedNames || selectedNames.has("grep")) {
		const grep = createGrepToolDefinition(cwd);
		registerSuiteOwnedTool(
			pi,
			grep,
			{
				activity: {
					categories: ["search-pattern"],
					classify: ({ args }) => singleActivity("search-pattern", { target: args.pattern }),
				},
				label: "Grep",
				runningSummary: "searching",
				summarize: (args, result, state, durationMs) => summarizeBuiltin("grep", args, result, state, durationMs),
				target: (args) => describeBuiltinTarget("grep", args),
			},
			PROGRAMMATIC_READ,
		);
	}

	if (!selectedNames || selectedNames.has("find")) {
		const find = createFindToolDefinition(cwd);
		registerSuiteOwnedTool(
			pi,
			find,
			{
				activity: {
					categories: ["search-pattern"],
					classify: ({ args }) => singleActivity("search-pattern", { target: args.pattern }),
				},
				label: "Find",
				runningSummary: "searching",
				summarize: (args, result, state, durationMs) => summarizeBuiltin("find", args, result, state, durationMs),
				target: (args) => describeBuiltinTarget("find", args),
			},
			PROGRAMMATIC_READ,
		);
	}

	if (!selectedNames || selectedNames.has("ls")) {
		const ls = createLsToolDefinition(cwd);
		registerSuiteOwnedTool(
			pi,
			ls,
			{
				activity: {
					categories: ["list-directory"],
					classify: ({ args }) => {
						const path = args.path ?? ".";
						return singleActivity("list-directory", { target: path });
					},
				},
				label: "List",
				runningSummary: "listing",
				summarize: (args, result, state, durationMs) => summarizeBuiltin("ls", args, result, state, durationMs),
				target: (args) => describeBuiltinTarget("ls", args),
			},
			PROGRAMMATIC_READ,
		);
	}
}

import { resolve } from "node:path";
