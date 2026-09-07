import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type MonitorInput, startMonitor } from "../../../packages/pi-stuff/src/background-work/src/monitor.js";
import { BackgroundWorkRuntime } from "../../../packages/pi-stuff/src/background-work/src/runtime.js";
import type {
	SuiteAgentMessage,
	SuiteAgentMessageOptions,
} from "../../../packages/pi-stuff/src/conversation-ui/suite-agent-message.js";
import { createBackgroundWorkEffectOwner } from "../../work/runtime-fixtures.js";

const roots: string[] = [];
const servers: Bun.Server<unknown>[] = [];
const COMPLETION_DETAILS_SCHEMA = Type.Object(
	{
		outcomes: Type.Array(Type.Object({ status: Type.String() }, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-monitor-test-"));
	roots.push(root);
	const messages: Array<{ message: SuiteAgentMessage; options: SuiteAgentMessageOptions }> = [];
	const pi = {
		sendMessage: (message: SuiteAgentMessage, options?: SuiteAgentMessageOptions) => {
			messages.push({ message, options });
		},
	};
	const runtime = new BackgroundWorkRuntime({
		cwd: root,
		effects: createBackgroundWorkEffectOwner(),
		pi,
		sessionId: "monitor-test",
	});
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const context = {
		cwd: root,
		model: undefined,
		sessionManager: {
			getSessionFile: () => join(root, "session.jsonl"),
			getSessionId: () => "monitor-test",
		},
	} as ExtensionContext;
	return { context, messages, root, runtime };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for Monitor result");
}

function firstOutcomeStatus(messages: readonly { readonly message: SuiteAgentMessage }[]): string | undefined {
	const details = messages[0]?.message.details;
	return Check(COMPLETION_DETAILS_SCHEMA, details) ? details.outcomes[0]?.status : undefined;
}

async function run(input: MonitorInput): Promise<string> {
	const state = setup();
	await startMonitor(state.runtime, input, state.context);
	await waitUntil(() => state.messages.length === 1);
	const status = firstOutcomeStatus(state.messages);
	await state.runtime.shutdown();
	return status ?? "missing";
}

test("rejects an unrepresentable deadline before registering work", async () => {
	const state = setup();
	try {
		await expect(
			startMonitor(
				state.runtime,
				{ source: "file", target: join(state.root, "never"), timeoutSeconds: Number.MAX_VALUE },
				state.context,
			),
		).rejects.toThrow("Monitor timeout must be a positive, representable duration");
		expect(state.runtime.snapshot()).toHaveLength(0);
	} finally {
		await state.runtime.shutdown();
	}
});

describe("command Monitor", () => {
	test("completes on successful command evidence", async () => {
		expect(await run({ source: "command", successText: "READY", target: "printf READY", timeoutSeconds: 3 })).toBe(
			"completed",
		);
	});

	test("fails on explicit failure evidence", async () => {
		expect(await run({ failureText: "ERROR", source: "command", target: "printf ERROR", timeoutSeconds: 3 })).toBe(
			"failed",
		);
	});

	test("times out and terminates its owned command", async () => {
		expect(await run({ source: "command", target: "sleep 30", timeoutSeconds: 0.2 })).toBe("timed_out");
	});
});

describe("file and log Monitor", () => {
	test("bounds a user-visible description by terminal cells", async () => {
		const state = setup();
		const started = await startMonitor(
			state.runtime,
			{
				description: `\u001b[31m${"监控😀".repeat(40)}\u001b[0m`,
				source: "file",
				target: join(state.root, "never"),
				timeoutSeconds: 3,
			},
			state.context,
		);
		expect(visibleWidth(started.title)).toBeLessThanOrEqual(80);
		expect(started.title).not.toContain("\u001b");
		await state.runtime.stop(started.id);
		await state.runtime.shutdown();
	});

	test("treats an expected missing file or log as pending evidence", async () => {
		for (const source of ["file", "log"] as const) {
			const state = setup();
			const started = await startMonitor(
				state.runtime,
				{
					intervalSeconds: 0.1,
					source,
					target: join(state.root, `missing.${source}`),
					timeoutSeconds: 3,
				},
				state.context,
			);
			await waitUntil(
				() =>
					state.runtime.snapshot().find((item) => item.id === started.id)?.recentOutput ===
					`Waiting for ${source} to appear.`,
			);
			expect(state.runtime.snapshot().find((item) => item.id === started.id)?.status).toBe("running");
			expect(state.messages).toHaveLength(0);
			await state.runtime.stop(started.id);
			await state.runtime.shutdown();
		}
	});

	test("ignores pre-existing log text by default", async () => {
		const state = setup();
		const path = join(state.root, "service.log");
		writeFileSync(path, "READY from an old run\n");
		const started = await startMonitor(
			state.runtime,
			{
				intervalSeconds: 0.1,
				source: "log",
				successText: "READY",
				target: path,
				timeoutSeconds: 3,
			},
			state.context,
		);
		await Bun.sleep(250);
		const snapshot = state.runtime.snapshot().find((item) => item.id === started.id);
		expect(snapshot).toMatchObject({
			monitorSource: "log",
			monitorSuccessText: "READY",
			monitorTarget: path,
			monitorTimeoutSeconds: 3,
		});
		expect(state.messages).toHaveLength(0);
		appendFileSync(path, "READY from this run\n");
		await waitUntil(() => state.messages.length === 1);
		expect(firstOutcomeStatus(state.messages)).toBe("completed");
		await state.runtime.shutdown();
	});

	test("reports a permanent source error instead of polling forever", async () => {
		const state = setup();
		const directory = join(state.root, "not-a-file");
		mkdirSync(directory);
		await startMonitor(
			state.runtime,
			{
				intervalSeconds: 0.1,
				source: "file",
				successText: "READY",
				target: directory,
				timeoutSeconds: 3,
			},
			state.context,
		);
		await waitUntil(() => state.messages.length === 1);
		expect(firstOutcomeStatus(state.messages)).toBe("failed");
		await state.runtime.shutdown();
	});

	test("can be cancelled through the shared runtime", async () => {
		const state = setup();
		const started = await startMonitor(
			state.runtime,
			{
				intervalSeconds: 0.1,
				source: "file",
				target: join(state.root, "never"),
				timeoutSeconds: 3,
			},
			state.context,
		);
		const outcome = await state.runtime.stop(started.id);
		expect(outcome.status).toBe("stopped");
		await Bun.sleep(250);
		expect(state.messages).toHaveLength(0);
		await state.runtime.shutdown();
	});
});

describe("HTTP Monitor", () => {
	test("waits through a non-ready response and completes on body evidence", async () => {
		let ready = false;
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(ready ? "READY" : "booting", { status: ready ? 200 : 503 }),
		});
		servers.push(server);
		const state = setup();
		await startMonitor(
			state.runtime,
			{
				intervalSeconds: 0.1,
				source: "http",
				successText: "READY",
				target: `http://127.0.0.1:${String(server.port)}/health`,
				timeoutSeconds: 3,
			},
			state.context,
		);
		await Bun.sleep(250);
		expect(state.messages).toHaveLength(0);
		ready = true;
		await waitUntil(() => state.messages.length === 1);
		expect(firstOutcomeStatus(state.messages)).toBe("completed");
		await state.runtime.shutdown();
	});
});
