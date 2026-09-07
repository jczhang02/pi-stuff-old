import { join, resolve } from "node:path";
import { resolvePiBinary } from "./installed-tools.ts";
import { PiRpcClient } from "./pi-rpc-client.js";

const ROOT = resolve(import.meta.dir, "..");
const PONYTAIL_PACKAGE = join(ROOT, "packages/pi-stuff");
const OBSERVER_EXTENSION = join(ROOT, "tests/fixtures/ponytail-benchmark-observer.ts");
const COMMAND_TIMEOUT_MS = 60_000;
const HOST_STARTUP_TIMEOUT_MS = 5 * 60_000;
const CASE_TIMEOUT_MS = 15 * 60_000;

export const PONYTAIL_BENCHMARK_PROVIDER = "jcapi";
export const PONYTAIL_BENCHMARK_MODEL = "openrouter/stealth/ox-alpha";

export function buildPonytailBenchmarkEnvironment(
	base: NodeJS.ProcessEnv,
	runtime: string,
	temporary: string,
	observerLog: string,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...base,
		XDG_RUNTIME_DIR: runtime,
		TMPDIR: temporary,
		PI_STUFF_CODE_MODE_DEFAULT: "off",
		PI_STUFF_PONYTAIL_BENCHMARK_LOG: observerLog,
	};
	for (const key of Object.keys(environment)) {
		if (
			key.startsWith("PONYTAIL_") ||
			key.startsWith("PI_SUBAGENT_PARENT_") ||
			key === "PI_STUFF_PONYTAIL_MODE" ||
			key === "PI_STUFF_CODE_MODE_FROZEN"
		) {
			delete environment[key];
		}
	}
	environment["PONYTAIL_DEFAULT_MODE"] = "off";
	environment["PONYTAIL_HIDE_STATUS"] = "0";
	environment["PONYTAIL_QUIET_STARTUP"] = "1";
	return environment;
}

export class PonytailBenchmarkRpc extends PiRpcClient {
	constructor(project: string, sessions: string, runtime: string, temporary: string, observerLog: string) {
		super({
			executable: resolvePiBinary(),
			arguments: [
				"--mode",
				"rpc",
				"--approve",
				"--no-extensions",
				"--no-context-files",
				"--no-prompt-templates",
				"--no-skills",
				"--extension",
				PONYTAIL_PACKAGE,
				"--extension",
				OBSERVER_EXTENSION,
				"--tools",
				"read,write,edit,bash",
				"--provider",
				PONYTAIL_BENCHMARK_PROVIDER,
				"--model",
				PONYTAIL_BENCHMARK_MODEL,
				"--thinking",
				"medium",
				"--session-dir",
				sessions,
			],
			commandTimeoutMs: COMMAND_TIMEOUT_MS,
			cwd: project,
			environment: buildPonytailBenchmarkEnvironment(process.env, runtime, temporary, observerLog),
			failurePrefix: "Ponytail behavior benchmark failed",
			settleTimeoutMs: CASE_TIMEOUT_MS,
			startupTimeoutMs: HOST_STARTUP_TIMEOUT_MS,
		});
	}
}
