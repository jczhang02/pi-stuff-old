import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePiBinary } from "./installed-tools.ts";
import { createRpcTransport } from "./magic-context-real-rpc.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.js";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const provider = join(root, "tests/fixtures/pi-host-seams-provider.ts");
const TIMEOUT_MS = 20_000;

interface SeamRecord {
	readonly origin?: string;
	readonly phase?: string;
}

function fail(message: string): never {
	throw new Error(`Pi ${CERTIFIED_PI_VERSION} Host seam verification failed: ${message}`);
}

export async function readSeamRecords(path: string): Promise<SeamRecord[]> {
	return (await readFile(path, "utf8").catch(() => ""))
		.split("\n")
		.slice(0, -1)
		.filter(Boolean)
		.map((line) => {
			// SAFETY: the fixture is the sole writer and emits only the SeamRecord fields read below.
			return JSON.parse(line) as SeamRecord;
		});
}

async function waitForRecord(path: string, phase: string): Promise<SeamRecord> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const record = (await readSeamRecords(path)).find((candidate) => candidate.phase === phase);
		if (record) return record;
		await Bun.sleep(20);
	}
	fail(`timed out waiting for ${phase}`);
}

async function waitForPersistedOrdering(sessionDirectory: string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	let lines: string[] = [];
	while (Date.now() < deadline) {
		const files = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
		lines = (await Promise.all(files.map((name) => readFile(join(sessionDirectory, name), "utf8")))).flatMap(
			(content) => content.split("\n").filter(Boolean),
		);
		const toolResult = (toolCallId: string) =>
			lines.findIndex((line) => line.includes('"role":"toolResult"') && line.includes(toolCallId));
		const backgroundResult = toolResult("ordering-background");
		const gateResult = toolResult("ordering-gate");
		const notification = lines.findIndex(
			(line) =>
				line.includes("pi-stuff-background-work-result") && line.toLowerCase().includes("ordering completion"),
		);
		if (backgroundResult >= 0 && gateResult >= 0 && notification >= 0) {
			if (notification <= Math.max(backgroundResult, gateResult)) {
				fail("triggerTurn:false message preceded a Tool result in the persisted Session");
			}
			return;
		}
		await Bun.sleep(20);
	}
	fail(`timed out waiting for persisted ordering evidence (${String(lines.length)} Session entries)`);
}

export async function verifyPiHostSeams(options: {
	readonly packagePath: string;
	readonly piBinary: string;
}): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-host-seams-"));
	const agentDirectory = join(temporaryDirectory, "agent");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const log = join(temporaryDirectory, "seams.jsonl");
	let rpc: Awaited<ReturnType<typeof createRpcTransport>> | undefined;
	try {
		await Promise.all([mkdir(agentDirectory), mkdir(sessionDirectory), writeFile(log, "")]);
		await disableSessionNamingForTest(agentDirectory);
		await writeFile(
			join(agentDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", packages: [resolve(options.packagePath)] }, null, "\t")}\n`,
			{ mode: 0o600 },
		);
		rpc = await createRpcTransport(
			[
				options.piBinary,
				"--mode",
				"rpc",
				"--offline",
				"--no-context-files",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-approve",
				"--tools",
				"bash,ordering_gate",
				"--provider",
				"pi-stuff-host-seams",
				"--model",
				"fixture-model",
				"--session-dir",
				sessionDirectory,
				"--extension",
				provider,
			],
			temporaryDirectory,
			{
				...process.env,
				PI_CODING_AGENT_DIR: agentDirectory,
				PI_OFFLINE: "1",
				PI_STUFF_HOST_SEAMS_LOG: log,
				PI_TELEMETRY: "0",
				TERM: "dumb",
			},
		);

		const clearFrom = 0;
		await rpc.waitFor((record) => record.type === "agent_start", { from: clearFrom });
		await rpc.send({ message: "STALE_USER_AFTER_CLEAR", type: "follow_up" });
		const cleared = await rpc.send({ type: "clear_queue" });
		if (!JSON.stringify(cleared.data).includes("STALE_USER_AFTER_CLEAR")) {
			fail(`clear_queue did not return the queued follow-up: ${JSON.stringify(cleared)}`);
		}
		await rpc.waitFor((record) => record.type === "agent_settled", { from: clearFrom, timeoutMs: TIMEOUT_MS });
		const origin = await waitForRecord(log, "clear-origin");
		if (origin.origin !== "automatic") fail(`queue-clear attribution did not fail closed: ${JSON.stringify(origin)}`);

		await rpc.promptAndWait("ORDERING_DURING_TOOL", TIMEOUT_MS);
		await waitForPersistedOrdering(sessionDirectory);
		const extensionError = rpc.records.find((record) => record.type === "extension_error");
		if (extensionError) fail(`Pi reported an Extension error: ${JSON.stringify(extensionError)}`);
	} finally {
		await rpc?.stop();
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	await verifyPiHostSeams({
		packagePath: resolve(root, "packages/pi-stuff"),
		piBinary: resolvePiBinary(),
	});
	console.log(`Certified Pi ${CERTIFIED_PI_VERSION} queue-clear origin and Tool-phase message ordering`);
}
