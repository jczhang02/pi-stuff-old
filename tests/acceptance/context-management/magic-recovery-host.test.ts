import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { createRpcTransport } from "../../../scripts/magic-context-real-rpc.js";
import { disableSessionNamingForTest } from "../../../scripts/session-naming-test-settings.ts";
import { verifyPiHostVersion } from "../../../scripts/verify-pi-host-provenance.js";
import { ZERO_USAGE } from "../../fixtures/faux-provider.js";

const suite = resolve(import.meta.dir, "../../../packages/pi-stuff");
const provider = resolve(import.meta.dir, "../../fixtures/context-pty-provider.ts");
const piBinary = resolvePiBinary();
beforeAll(async () => {
	await verifyPiHostVersion(piBinary);
});

function seedHistory(cwd: string, sessions: string, large: boolean): string {
	const session = SessionManager.create(cwd, sessions);
	session.appendModelChange("pi-stuff-context-pty", "fixture-model");
	for (let index = 0; index < 40; index++) {
		session.appendMessage({
			role: "user",
			content: `Past decision ${index}: ${"history evidence ".repeat(large ? 1_000 : 100)}`,
			timestamp: Date.now(),
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Completed work ${index}.` }],
			api: "openai-completions",
			provider: "pi-stuff-context-pty",
			model: "fixture-model",
			stopReason: "stop",
			usage: ZERO_USAGE,
			timestamp: Date.now(),
		} satisfies AssistantMessage);
	}
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected persisted recovery fixture.");
	return file;
}

async function fixture(mode = "recover") {
	const root = await mkdtemp(join(tmpdir(), "pi-magic-recovery-"));
	const config = join(root, "config", "cortexkit");
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd), mkdir(agent)]);
	await writeFile(
		join(config, "magic-context.jsonc"),
		JSON.stringify({
			dreamer: { disable: true },
			embedding: { provider: "off" },
			fail_closed_blocking: false,
			historian: { pi: { model: "pi-stuff-context-pty/fixture-model", thinking_level: "off" } },
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
	const session = seedHistory(cwd, join(root, "sessions"), mode === "multi-step");
	const requestLog = join(root, "requests.jsonl");
	const magicLog = join(root, "magic.log");
	const rpc = await createRpcTransport(
		[
			piBinary,
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"-e",
			resolve(import.meta.dir, "../../fixtures/context-recovery-fault.ts"),
			"-e",
			mode === "host-cancel"
				? resolve(import.meta.dir, "../../fixtures/context-cancel-host.ts")
				: mode === "direct"
					? Bun.resolveSync("@cortexkit/pi-magic-context", suite)
					: suite,
			"-e",
			provider,
			"--provider",
			"pi-stuff-context-pty",
			"--model",
			"fixture-model",
			"--session",
			session,
		],
		cwd,
		{
			...process.env,
			HOME: root,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: undefined,
			XDG_CACHE_HOME: join(root, "cache"),
			PI_CODING_AGENT_DIR: agent,
			MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "data"),
			MAGIC_CONTEXT_LOG_PATH: magicLog,
			PI_STUFF_CONTEXT_PTY_LOG: requestLog,
			PI_STUFF_CONTEXT_RECOVERY_MODE: mode,
			PI_STUFF_CONTEXT_RECOVERY_DELAY: mode === "cancel" ? "10000" : "0",
			PI_OFFLINE: "1",
			HF_HUB_OFFLINE: "1",
			PI_TELEMETRY: "0",
		},
	);
	return { root, rpc, session, requestLog, magicLog };
}

for (const mode of ["recover", "direct", "multi-step", "tools", "transient", "worker-crash", "lost-ack"]) {
	test(`real Pi retries accepted input after genuine Magic-only overflow compaction (${mode})`, async () => {
		const f = await fixture(mode);
		try {
			const records = await f.rpc.promptAndWait("MAGIC_RECOVERY_ACCEPTED_INPUT", 60000);
			const transcript = await readFile(f.session, "utf8");
			const requests = await readFile(f.requestLog, "utf8");
			expect(records.filter((record) => record.type === "tool_execution_start")).toHaveLength(
				mode === "tools" ? 1 : 0,
			);
			if (mode === "tools") {
				expect(await readFile(join(f.root, "project", "recovery-effect.txt"), "utf8")).toBe("effect\n");
				expect(requests.match(/RECOVERY_TOOL_RESULT/g)?.length).toBeGreaterThanOrEqual(2);
			}
			if (mode === "transient") expect(requests.match(/"type":"historian-transient-failure"/g)).toHaveLength(1);
			if (mode === "multi-step") expect(requests.match(/"type":"historian"/g)?.length).toBeGreaterThan(1);
			if (mode === "worker-crash" || mode === "lost-ack") {
				const evidence = requests
					.split("\n")
					.filter((line) => line.startsWith('{"type":"worker-') || line.startsWith('{"type":"lost-'))
					.join("\n");
				expect(
					requests.match(/"type":"worker-start"/g),
					`${evidence}\n${JSON.stringify(records.filter((record) => record.type === "extension_ui_request" || record.type === "extension_error" || record.type === "compaction_end"))}`,
				).toHaveLength(2);
				expect(requests.match(/"type":"historian"/g)).toHaveLength(1);
				expect(requests).toContain(mode === "lost-ack" ? '"type":"lost-compaction-ack"' : '"type":"worker-crash"');
			}
			expect(transcript, await readFile(f.magicLog, "utf8")).toContain("MAGIC_RECOVERY_CONTINUED");
			expect(requests.match(/"type":"recovery-request"/g)).toHaveLength(2);
			expect(requests).toContain('"type":"historian"');
			const entries = SessionManager.open(f.session).getEntries();
			const compactions = entries.filter((entry) => entry.type === "compaction");
			expect(compactions).toHaveLength(1);
			expect(compactions[0]?.fromHook).toBe(true);
			expect(compactions[0]?.summary).toContain("Preserved");
			expect(
				entries.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes("MAGIC_RECOVERY_ACCEPTED_INPUT"),
				),
			).toHaveLength(1);
		} finally {
			await f.rpc.stop();
			await rm(f.root, { recursive: true, force: true });
		}
	}, 90000);
}

for (const mode of ["uncertain-ack", "no-progress"]) {
	test(`real Pi preserves input and stops when Magic recovery is ${mode}`, async () => {
		const f = await fixture(mode);
		try {
			const records = await f.rpc.promptAndWait("MAGIC_RECOVERY_ACCEPTED_INPUT", 60000);
			const transcript = await readFile(f.session, "utf8");
			const requests = await readFile(f.requestLog, "utf8");
			expect(transcript).toContain("MAGIC_RECOVERY_ACCEPTED_INPUT");
			expect(transcript).not.toContain("MAGIC_RECOVERY_CONTINUED");
			expect(requests.match(/"type":"recovery-request"/g)).toHaveLength(1);
			expect(
				SessionManager.open(f.session)
					.getEntries()
					.filter((entry) => entry.type === "compaction"),
			).toHaveLength(0);
			const errors = records.filter(
				(record) =>
					record.type === "extension_ui_request" &&
					record["method"] === "notify" &&
					record["notifyType"] === "error",
			);
			expect(errors).toHaveLength(1);
			expect(JSON.stringify(errors)).toContain(
				mode === "uncertain-ack" ? "completion is uncertain" : "no forward progress",
			);
		} finally {
			await f.rpc.stop();
			await rm(f.root, { recursive: true, force: true });
		}
	}, 90000);
}

test("real Pi stops on the second overflow without losing accepted input", async () => {
	const f = await fixture("exhaust");
	try {
		await f.rpc.promptAndWait("MAGIC_RECOVERY_ACCEPTED_INPUT", 60000);
		const requests = await readFile(f.requestLog, "utf8");
		expect(requests.match(/"type":"recovery-request"/g)).toHaveLength(2);
		const transcript = await readFile(f.session, "utf8");
		expect(transcript).not.toContain("MAGIC_RECOVERY_CONTINUED");
		expect(transcript).toContain("MAGIC_RECOVERY_ACCEPTED_INPUT");
		expect(
			SessionManager.open(f.session)
				.getEntries()
				.filter((entry) => entry.type === "compaction"),
		).toHaveLength(1);
	} finally {
		await f.rpc.stop();
		await rm(f.root, { recursive: true, force: true });
	}
}, 90000);

test("cancelling Magic recovery leaves subsequent queue delivery to Pi", async () => {
	const f = await fixture("cancel");
	try {
		await f.rpc.send({ type: "prompt", message: "MAGIC_RECOVERY_ACCEPTED_INPUT" });
		await f.rpc.waitFor((record) => record.type === "compaction_start" && record["reason"] === "overflow", {
			timeoutMs: 30000,
		});
		await f.rpc.send({ type: "follow_up", message: "QUEUED_RECOVERY_INPUT" });
		await f.rpc.send({ type: "abort" });
		const queue = await f.rpc.send({ type: "clear_queue" });
		expect(JSON.stringify(queue)).not.toContain("QUEUED_RECOVERY_INPUT");
		expect(await readFile(f.session, "utf8")).toContain("MAGIC_RECOVERY_ACCEPTED_INPUT");
		expect(await readFile(f.session, "utf8")).toContain("QUEUED_RECOVERY_INPUT");
		expect((await readFile(f.requestLog, "utf8")).match(/"type":"recovery-request"/g)).toHaveLength(2);
		expect(
			SessionManager.open(f.session)
				.getEntries()
				.filter((entry) => entry.type === "compaction"),
		).toHaveLength(0);
	} finally {
		await f.rpc.stop();
		await rm(f.root, { recursive: true, force: true });
	}
}, 60000);

test("Host-only control reproduces queue continuation after compaction cancellation", async () => {
	const f = await fixture("host-cancel");
	try {
		await f.rpc.send({ type: "prompt", message: "MAGIC_RECOVERY_ACCEPTED_INPUT" });
		await f.rpc.waitFor((record) => record.type === "compaction_start" && record["reason"] === "overflow", {
			timeoutMs: 30000,
		});
		await f.rpc.send({ type: "follow_up", message: "QUEUED_RECOVERY_INPUT" });
		await f.rpc.send({ type: "abort" });
		const queue = await f.rpc.send({ type: "clear_queue" });
		expect(JSON.stringify(queue)).not.toContain("QUEUED_RECOVERY_INPUT");
		expect(await readFile(f.session, "utf8")).toContain("MAGIC_RECOVERY_CONTINUED");
		expect((await readFile(f.requestLog, "utf8")).match(/"type":"recovery-request"/g)).toHaveLength(2);
	} finally {
		await f.rpc.stop();
		await rm(f.root, { recursive: true, force: true });
	}
}, 60000);
