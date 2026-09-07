import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isJsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { PiRpcClient } from "../../../scripts/pi-rpc-client.ts";

const PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");
const PROVIDER = resolve(import.meta.dir, "../../fixtures/status-output-provider.ts");
const PI_BIN = process.env["PI_BIN"] ?? "/opt/pi-coding-agent/pi";

async function waitForBackgroundCompletion(rpc: PiRpcClient): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const completed = rpc.events.findIndex(
			(event) =>
				event["type"] === "message_end" &&
				isJsonInputObject(event["message"]) &&
				event["message"]["customType"] === "pi-stuff-agent-complete",
		);
		if (completed >= 0 && rpc.events.slice(completed + 1).some((event) => event["type"] === "agent_settled")) return;
		await Bun.sleep(100);
	}
	throw new Error("Background completion was not delivered and settled.");
}

async function runStatusOutputAcceptance(foreground: boolean): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-status-output-"));
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await mkdir(sessions);
	await writeFile(
		join(agentDir, "agents", "status-worker.md"),
		`---\nname: status-worker\ndescription: retained report fixture\nmodel: pi-stuff-status-output/fixture-model\ntools:\nsubagentOnlyExtensions: ${PROVIDER}\ninheritProjectContext: false\ninheritSkills: false\n---\nReturn the retained report.\n`,
	);
	const rpc = new PiRpcClient({
		arguments: [
			"--mode",
			"rpc",
			"--offline",
			"--approve",
			"--no-skills",
			"--no-context-files",
			"--tools",
			"read,subagent",
			"--extension",
			PACKAGE,
			"--extension",
			PROVIDER,
			"--provider",
			"pi-stuff-status-output",
			"--model",
			"fixture-model",
			"--session-dir",
			sessions,
			"--session-id",
			"status-output",
		],
		commandTimeoutMs: 20_000,
		cwd: root,
		environment: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_STUFF_STATUS_OUTPUT_LOG: join(root, "status.txt"),
			PI_STUFF_STATUS_OUTPUT_FOREGROUND: foreground ? "1" : "0",
		},
		executable: PI_BIN,
		failurePrefix: "status output acceptance",
		settleTimeoutMs: 30_000,
		startupTimeoutMs: 20_000,
	});
	let passed = false;
	try {
		await rpc.promptAndSettle("Verify the retained report locator and read the complete report tail.");
		if (!foreground) {
			await waitForBackgroundCompletion(rpc);
			await rpc.promptAndSettle(
				"INSPECT_COMPLETED_REPORT: inspect status and read the completed background report.",
			);
		}
		expect(rpc.events.some((event) => JSON.stringify(event).includes("STATUS_OUTPUT_READ_OK"))).toBe(true);
		const statusResponses = await readFile(join(root, "status.txt"), "utf8");
		expect(statusResponses).toContain("Output:");
		expect(statusResponses).toContain("Progress (excerpt)");
		expect(statusResponses).not.toContain("STATUS_OUTPUT_TAIL_MARKER");
		const sessionFile = (await readdir(sessions)).find((name) => name.endsWith("_status-output.jsonl"));
		expect(sessionFile).toBeDefined();
		if (!sessionFile) throw new Error("Pi session file was not created.");
		const session = await readFile(join(sessions, sessionFile), "utf8");
		expect(session).toContain("STATUS_OUTPUT_READ_OK");
		expect(session).toContain("STATUS_OUTPUT_TAIL_MARKER");
		passed = true;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nDebug root retained at ${root}\nPi stderr: ${rpc.stderr()}`,
		);
	} finally {
		await rpc.close();
		if (passed) await rm(root, { recursive: true, force: true });
	}
}

test(
	"real Pi foreground status exposes a retained report locator and read returns its complete tail",
	() => runStatusOutputAcceptance(true),
	90_000,
);

test(
	"real Pi background status exposes a retained report locator and read returns its complete tail",
	() => runStatusOutputAcceptance(false),
	90_000,
);
