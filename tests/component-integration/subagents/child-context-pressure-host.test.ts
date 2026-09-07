import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildPiArgs, cleanupTempDir } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.js";
import { createRpcTransport } from "../../../scripts/magic-context-real-rpc.js";
import { disableSessionNamingForTest } from "../../../scripts/session-naming-test-settings.js";
import { verifyPiHostVersion } from "../../../scripts/verify-pi-host-provenance.js";
import { createAssistantMessage } from "../../fixtures/faux-provider.js";

const piBinary = process.env["PI_BIN"] ?? "/opt/pi-coding-agent/pi";
const suite = resolve(import.meta.dir, "../../../packages/pi-stuff/index.ts");
const provider = resolve(import.meta.dir, "../../fixtures/child-pressure-provider.ts");
const task = "Finish the established repair investigation, retaining findings and completed check identities.";
const assistant = createAssistantMessage("pi-stuff-child-pressure", "fixture-model");

function seedChild(cwd: string, root: string, kind: "fresh" | "fork"): string {
	let session = SessionManager.create(cwd, join(root, "sessions"));
	if (kind === "fork") {
		session.appendMessage({ role: "user", content: "Parent investigation preceding delegation.", timestamp: 1 });
		session.appendMessage(
			assistant([{ type: "text", text: "Delegate the remaining repair investigation." }], "stop"),
		);
		const leaf = session.getLeafId();
		if (!leaf) throw new Error("Missing parent leaf");
		const fork = session.createBranchedSession(leaf);
		if (!fork) throw new Error("Missing forked Session");
		session = SessionManager.open(fork);
	}
	session.appendModelChange("pi-stuff-child-pressure", "fixture-model");
	session.appendMessage({ role: "user", content: `Task: ${task}`, timestamp: 2 });
	for (let index = 0; index < 40; index++) {
		session.appendMessage(
			assistant(
				[
					{ type: "thinking", thinking: "Retain checked evidence.", thinkingSignature: "SIGNED_CHILD_EVIDENCE" },
					{
						type: "text",
						text: index === 19 ? "REPAIR_INITIAL_FINDING REPAIR_CHECK_INITIAL_PASS" : `Checked file ${index}.`,
					},
					{
						type: "toolCall",
						id: `check_${index}|signed_${index}`,
						name: "evidence_chunk",
						arguments: { round: index },
					},
				],
				"toolUse",
			),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: `check_${index}|signed_${index}`,
			toolName: "evidence_chunk",
			content: [
				{
					type: "text",
					text: `${index === 18 ? "REPAIR_CHECK_INITIAL_PASS" : "Checked successfully"}\n${"source inspection evidence ".repeat(300)}`,
				},
			],
			isError: false,
			timestamp: 3 + index,
		});
	}
	session.appendMessage(
		assistant(
			[{ type: "text", text: "Next useful action: verify remaining binding and produce the final report." }],
			"stop",
		),
	);
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing child Session");
	return file;
}

for (const kind of ["fresh", "fork"] as const) {
	test(`real ${kind} child retains findings, completed checks, and steering through repeated Magic pressure`, async () => {
		await verifyPiHostVersion(piBinary);
		const root = await mkdtemp(join(tmpdir(), `pi-child-pressure-${kind}-`));
		const cwd = join(root, "project");
		const agent = join(root, "agent");
		const config = join(root, "config", "cortexkit");
		await Promise.all([mkdir(cwd), mkdir(agent), mkdir(config, { recursive: true })]);
		await writeFile(
			join(config, "magic-context.jsonc"),
			JSON.stringify({
				dreamer: { disable: true },
				embedding: { provider: "off" },
				fail_closed_blocking: false,
				historian: { pi: { model: "pi-stuff-child-pressure/fixture-model", thinking_level: "off" } },
				pi: { subagent_extensions: [provider] },
				sidekick: { disable: true },
				todowrite: { enabled: false, overlay: false },
				historian_timeout_ms: 20000,
			}),
		);
		await writeFile(
			join(agent, "settings.json"),
			JSON.stringify({
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8192 },
				retry: { enabled: false },
			}),
		);
		await disableSessionNamingForTest(agent);
		const sessionFile = seedChild(cwd, root, kind);
		const built = buildPiArgs({
			baseArgs: ["--mode", "rpc", "--provider", "pi-stuff-child-pressure", "--no-prompt-templates", "--no-themes"],
			task,
			sessionEnabled: true,
			sessionFile,
			model: "pi-stuff-child-pressure/fixture-model",
			thinking: "off",
			inheritProjectContext: false,
			inheritSkills: false,
			codeModeEnabled: false,
			tools: ["evidence_chunk"],
			extensions: [provider],
			childBaseExtensionPath: suite,
			cwd,
			runId: `${kind}-pressure`,
			childAgentName: "worker",
			childIndex: 0,
		});
		// RPC supplies the task through the Host input event; all production child flags and environment stay intact.
		expect(built.args.pop()).toBe(`Task: ${task}`);
		const log = join(root, "requests.jsonl");
		const rpc = await createRpcTransport([piBinary, ...built.args], cwd, {
			...process.env,
			...built.env,
			HOME: root,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: undefined,
			XDG_CACHE_HOME: join(root, "cache"),
			PI_CODING_AGENT_DIR: agent,
			MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "data"),
			MAGIC_CONTEXT_LOG_PATH: join(root, "magic.log"),
			PI_STUFF_CHILD_PRESSURE_LOG: log,
			PI_OFFLINE: "1",
			HF_HUB_OFFLINE: "1",
			PI_TELEMETRY: "0",
		});
		let passed = false;
		try {
			await rpc.promptAndWait(`Task: ${task}`, 90000);
			expect((await readFile(sessionFile, "utf8")).includes("READY_FOR_STEERING"), root).toBe(true);
			await rpc.promptAndWait(
				"REPAIR_STEER_RECHECK_BINDINGS: recheck the remaining binding, then finish the original report including both completed checks.",
				90000,
			);
			const entries = SessionManager.open(sessionFile).getEntries();
			const compactions = entries.filter((entry) => entry.type === "compaction");
			expect(compactions.length, root).toBeGreaterThanOrEqual(2);
			expect(
				compactions.every((entry) => entry.fromHook),
				root,
			).toBe(true);
			const final = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
			const report = JSON.stringify(final);
			for (const value of [
				"FINAL_REPAIR_REPORT",
				"REPAIR_INITIAL_FINDING",
				"REPAIR_CHECK_INITIAL_PASS",
				"REPAIR_SECOND_FINDING",
				"REPAIR_CHECK_SECOND_PASS",
				"REPAIR_STEER_RECHECK_BINDINGS",
			])
				expect(report, root).toContain(value);
			const requests = await readFile(log, "utf8");
			expect(requests.match(/"kind":"historian"/g)?.length, root).toBeGreaterThanOrEqual(2);
			expect(requests, root).toContain('"kind":"overflow-second"');
			passed = true;
		} finally {
			await rpc.stop();
			await writeFile(join(root, "rpc.jsonl"), rpc.records.map((record) => JSON.stringify(record)).join("\n"));
			if (passed)
				expect(
					rpc.records.filter((record) => record.type === "extension_error"),
					root,
				).toEqual([]);
			cleanupTempDir(built.tempDir);
			if (passed) await rm(root, { recursive: true, force: true });
		}
	}, 210000);
}
