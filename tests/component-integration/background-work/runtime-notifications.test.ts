import { afterEach, expect, test } from "bun:test";
import {
	attributedRuntime,
	type BackgroundMonitorActivity,
	Check,
	COMPLETION_DETAILS_SCHEMA,
	cleanupRuntimeFixtures,
	context,
	type DeliveredMessage,
	existsSync,
	isForegroundBashResult,
	join,
	mkdirSync,
	processExists,
	readAgentWorkOrigin,
	readFileSync,
	renameSync,
	runtime,
	startMonitor,
	temporaryRoot,
	waitUntil,
	writeFileSync,
} from "../../work/runtime-fixtures.js";

afterEach(cleanupRuntimeFixtures);

test("moves only the active foreground Bash command and then cleans its process tree", async () => {
	const root = temporaryRoot();
	const active = runtime(root);
	const execution = active.executeBash({ command: "sleep 30" }, context(root));
	await Bun.sleep(100);
	expect(active.detachActiveForeground()).toBe(true);
	expect(active.detachActiveForeground()).toBe(false);
	const result = await execution;
	const text = result.content.find((item) => item.type === "text");
	expect(text?.type === "text" ? text.text : "").toContain("manually moved to background task");
	expect(active.snapshot()).toHaveLength(1);
	await active.shutdown();
	expect(active.snapshot()).toHaveLength(0);
});

const foregroundTerminalCases = [
	{ command: "sleep 0.2; printf 'FOREGROUND-HANDOFF-DONE\n'", status: "completed" },
	{ command: "sleep 0.2; printf 'FOREGROUND-HANDOFF-FAILED\n' >&2; exit 7", status: "failed" },
	{ command: "sleep 30", status: "timed_out", timeoutSeconds: 0.2 },
] as const;

for (const handoff of ["automatic", "manual"] as const) {
	for (const terminalCase of foregroundTerminalCases) {
		test(`${handoff} foreground handoff wakes after it is ${terminalCase.status}`, async () => {
			const root = temporaryRoot();
			const messages: DeliveredMessage[] = [];
			const active = runtime(root, messages, handoff === "automatic" ? 50 : 10_000);
			try {
				const input = { command: terminalCase.command };
				if ("timeoutSeconds" in terminalCase) {
					Object.assign(input, { timeoutSeconds: terminalCase.timeoutSeconds });
				}
				const execution = active.executeBash(input, context(root));
				if (handoff === "manual") {
					await Bun.sleep(50);
					expect(active.detachActiveForeground()).toBe(true);
				}
				const result = await execution;
				expect(isForegroundBashResult(result)).toBe(false);
				await waitUntil(() => messages.length === 1);
				const delivered = messages[0];
				if (!delivered) throw new Error("Foreground Handoff result was not delivered");
				const details = delivered.message.details;
				if (!Check(COMPLETION_DETAILS_SCHEMA, details)) {
					throw new Error("Foreground Handoff details are invalid");
				}
				expect(details.outcomes[0]?.status).toBe(terminalCase.status);
				expect(delivered.options).toEqual({ deliverAs: "steer", triggerTurn: true });
			} finally {
				await active.shutdown();
			}
		});
	}
}

test("refreshes Git after a user-attributed Background Shell finishes after its parent settles", async () => {
	const root = temporaryRoot();
	const marker = join(root, "user-background-edit");
	const messages: DeliveredMessage[] = [];
	let deliveryAttempts = 0;
	let origin: "automatic" | "user" = "user";
	const { active, readRefreshRequests } = attributedRuntime(
		root,
		() => origin,
		messages,
		(message, options) => {
			deliveryAttempts += 1;
			if (deliveryAttempts === 1) throw new Error("injected delivery failure");
			messages.push({ message, options });
		},
	);
	try {
		await active.executeBash(
			{
				command: `sleep 0.2; printf 'edited\n' > ${JSON.stringify(marker)}`,
				runInBackground: true,
			},
			context(root),
		);
		expect(existsSync(marker)).toBeFalse();
		origin = "automatic";

		await waitUntil(() => existsSync(marker) && messages.length === 1);
		expect(readRefreshRequests()).toBe(1);
		expect(deliveryAttempts).toBe(2);
		const delivered = messages[0];
		if (!delivered) throw new Error("Background Shell result was not delivered");
		const details = delivered.message.details;
		if (!Check(COMPLETION_DETAILS_SCHEMA, details)) throw new Error("Background Shell details are invalid");
		expect(readAgentWorkOrigin(delivered.message)).toBe("user");
		expect(details.outcomes[0]?.parentRunOrigin).toBeUndefined();
		expect(delivered.options?.triggerTurn).toBeFalse();
	} finally {
		await active.shutdown();
	}
});

test("does not refresh Git or wake the Agent after an automatic Background Shell finishes", async () => {
	const root = temporaryRoot();
	const marker = join(root, "automatic-background-edit");
	const messages: DeliveredMessage[] = [];
	const { active, readRefreshRequests } = attributedRuntime(root, () => "automatic", messages);
	try {
		await active.executeBash(
			{
				command: `sleep 0.1; printf 'edited\n' > ${JSON.stringify(marker)}`,
				runInBackground: true,
			},
			context(root),
		);
		await waitUntil(() => existsSync(marker) && messages.length === 1);
		expect(readRefreshRequests()).toBe(0);
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const delivered = messages[0] as { message: object; options: { triggerTurn: boolean } };
		expect(readAgentWorkOrigin(delivered.message)).toBe("automatic");
		expect(delivered.options.triggerTurn).toBeFalse();
	} finally {
		await active.shutdown();
	}
});

test("kills TERM-ignoring descendants during session shutdown", async () => {
	const root = temporaryRoot();
	const childPath = join(root, "child.pid");
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	await active.executeBash(
		{
			command: `trap '' TERM HUP INT; sh -c 'trap "" TERM HUP INT; while :; do sleep 1; done' & echo $! > ${JSON.stringify(childPath)}; wait`,
			runInBackground: true,
		},
		context(root),
	);
	await waitUntil(() => existsSync(childPath));
	const childPid = Number(readFileSync(childPath, "utf-8").trim());
	expect(processExists(childPid)).toBe(true);
	await active.shutdown();
	await waitUntil(() => !processExists(childPid));
	expect(messages).toEqual([]);
	expect(existsSync(join(root, ".pi", "tasks"))).toBe(true);
	expect(readFileSync(childPath, "utf-8").trim()).toBe(String(childPid));
});

test("delivers a one-shot file Monitor result without conversational polling", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	const target = join(root, "ready.log");
	const started = await startMonitor(
		active,
		{
			intervalSeconds: 0.1,
			source: "file",
			successText: "READY",
			target,
			timeoutSeconds: 3,
		},
		context(root),
	);
	expect(active.snapshot().map((item) => item.id)).toContain(started.id);
	writeFileSync(target, "booting\nREADY\n");
	await waitUntil(() => active.snapshot().length === 0);
	await waitUntil(() => messages.length === 1);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const delivered = messages[0] as {
		message: { details: { outcomes: Array<{ status: string }> } };
		options: { triggerTurn: boolean };
	};
	expect(delivered.message.details.outcomes[0]?.status).toBe("completed");
	expect(delivered.options.triggerTurn).toBe(true);
	expect(active.readOutput(started.id)).toContain("observed its condition");
	expect((await active.stop(started.id)).status).toBe("completed");
	await active.shutdown();
});

test("a timed-out Monitor does not strand a later foreground handoff result", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages, 50);
	try {
		const execution = active.executeBash(
			{ command: "sleep 0.8; printf 'FOREGROUND-HANDOFF-AFTER-MONITOR\n'" },
			context(root),
		);
		expect(isForegroundBashResult(await execution)).toBe(false);
		await startMonitor(
			active,
			{
				intervalSeconds: 0.1,
				source: "file",
				successText: "NEVER",
				target: join(root, "never-created"),
				timeoutSeconds: 0.2,
			},
			context(root),
		);

		await waitUntil(() => messages.length === 1);
		expect(messages[0]?.message.details).toMatchObject({
			outcomes: [{ kind: "monitor", status: "timed_out" }],
		});
		expect(messages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });

		await waitUntil(() => messages.length === 2);
		expect(messages[1]?.message.details).toMatchObject({
			outcomes: [{ kind: "shell", status: "completed" }],
		});
		expect(messages[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	} finally {
		await active.shutdown();
	}
});

test("batches nearby Shell outcomes without losing a foreground handoff wake", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages, 50);
	try {
		const foreground = await active.executeBash({ command: "sleep 0.6; printf 'REQUIRED-SHELL\n'" }, context(root));
		expect(isForegroundBashResult(foreground)).toBe(false);
		await active.executeBash(
			{ command: "sleep 0.53; printf 'INDEPENDENT-SHELL\n'", runInBackground: true },
			context(root),
		);

		await waitUntil(() => active.snapshot().length === 0);
		await waitUntil(() => messages.length === 1);
		await Bun.sleep(250);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message.details).toMatchObject({
			outcomes: [
				{ kind: "shell", status: "completed" },
				{ kind: "shell", status: "completed" },
			],
		});
		expect(messages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	} finally {
		await active.shutdown();
	}
});

test("does not enqueue a second Agent turn for work the user explicitly stopped", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	try {
		await active.executeBash({ command: "sleep 30", runInBackground: true }, context(root));
		const shellId = active.snapshot()[0]?.id;
		expect(shellId).toBeString();
		const shellOutcome = await active.stop(shellId ?? "");
		expect(shellOutcome.status).toBe("stopped");
		expect(await active.stop(shellId ?? "")).toEqual(shellOutcome);
		expect(active.readOutput(shellId ?? "")).toContain("stopped");

		const monitor = await startMonitor(
			active,
			{
				intervalSeconds: 0.1,
				source: "file",
				successText: "READY",
				target: join(root, "never-ready"),
				timeoutSeconds: 30,
			},
			context(root),
		);
		const monitorOutcome = await active.stop(monitor.id);
		expect(monitorOutcome.status).toBe("stopped");
		expect(await active.stop(monitor.id)).toEqual(monitorOutcome);
		expect(active.readOutput(monitor.id)).toContain("stopped");
		await Bun.sleep(250);
		expect(messages).toEqual([]);
	} finally {
		await active.shutdown();
	}
});

test("retains a failed Background Shell receipt with bounded in-memory fallback", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	try {
		const launched = await active.executeBash(
			{
				command: "sleep 0.1; printf 'BACKGROUND-FAILED\\n' >&2; exit 7",
				runInBackground: true,
			},
			context(root),
		);
		const launchText = launched.content.find((item) => item.type === "text");
		const taskId = (launchText?.type === "text" ? launchText.text : "").match(/background task ([a-z0-9]+)/u)?.[1];
		expect(taskId).toBeString();
		await waitUntil(() => active.snapshot().length === 0);
		await waitUntil(() => messages.length === 1);
		expect(messages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: false });
		expect((await active.stop(taskId ?? "")).status).toBe("failed");
		expect(active.readOutput(taskId ?? "")).toContain("BACKGROUND-FAILED");

		const unreadablePath = join(root, "unreadable-output");
		mkdirSync(unreadablePath);
		const fallbackOutcome = Promise.resolve({
			endedAt: 2,
			id: "m-unreadable-terminal-output",
			kind: "monitor" as const,
			outputPath: unreadablePath,
			recentOutput: `${"旧".repeat(100)}终TAIL`,
			startedAt: 1,
			status: "failed" as const,
			summary: "Monitor failed",
			title: "unreadable monitor",
		});
		active.registerMonitor({
			cancel: async () => fallbackOutcome,
			id: "m-unreadable-terminal-output",
			outcome: fallbackOutcome,
			readOutput: () => "live",
			snapshot: () => ({
				id: "m-unreadable-terminal-output",
				kind: "monitor",
				startedAt: 1,
				status: "running",
				title: "unreadable monitor",
			}),
		});
		await fallbackOutcome;
		await Bun.sleep(0);
		const fallback = active.readOutput("m-unreadable-terminal-output", 16);
		expect(fallback).toContain("终TAIL");
		expect(fallback).not.toContain("旧旧旧旧旧旧");
	} finally {
		await active.shutdown();
	}
});

test("keeps only the newest 64 terminal receipts", async () => {
	const root = temporaryRoot();
	const active = runtime(root);
	for (let index = 0; index < 65; index += 1) {
		const id = `m-terminal-${String(index)}`;
		const outcome = Promise.resolve({
			endedAt: index + 1,
			id,
			kind: "monitor" as const,
			recentOutput: `evidence-${String(index)}`,
			startedAt: index,
			status: "completed" as const,
			summary: `Monitor ${String(index)} completed`,
			title: `monitor-${String(index)}`,
		});
		const monitor: BackgroundMonitorActivity = {
			cancel: async () => outcome,
			id,
			outcome,
			readOutput: () => `evidence-${String(index)}`,
			snapshot: () => ({
				id,
				kind: "monitor",
				startedAt: index,
				status: "running",
				title: `monitor-${String(index)}`,
			}),
		};
		active.registerMonitor(monitor);
		await outcome;
		await Bun.sleep(0);
	}

	expect(() => active.readOutput("m-terminal-0")).toThrow("No current or recently finished");
	expect(active.readOutput("m-terminal-64")).toContain("evidence-64");
	await active.shutdown();
});

test("bounds and fairly tails a full batch of missing-file notifications", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	try {
		await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				active.executeBash(
					{
						command: `sleep 0.3; dd if=/dev/zero bs=50000 count=1 2>/dev/null | tr '\\0' x; printf '<unsafe&界-TAIL-${String(index)}\\n'`,
						runInBackground: true,
					},
					context(root),
				),
			),
		);
		renameSync(join(root, ".pi"), join(root, ".pi-away"));
		await waitUntil(() => active.snapshot().length === 0, 8_000);
		await waitUntil(() => messages.length > 0);
		await Bun.sleep(250);
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const deliveries = messages as Array<{
			message: { content: string; details: { outcomes: Array<{ recentOutput?: string; outputPath?: string }> } };
		}>;
		const outcomes = deliveries.flatMap((delivery) => delivery.message.details.outcomes);
		expect(outcomes).toHaveLength(16);
		for (const delivery of deliveries) {
			expect(Buffer.byteLength(delivery.message.content, "utf-8")).toBeLessThanOrEqual(64 * 1024);
			expect(Buffer.byteLength(JSON.stringify(delivery.message.details), "utf-8")).toBeLessThanOrEqual(64 * 1024);
			expect(delivery.message.content).toContain("&lt;unsafe&amp;界-TAIL-");
		}
		for (let index = 0; index < 16; index += 1) {
			expect(outcomes.some((outcome) => outcome.recentOutput?.endsWith(`界-TAIL-${String(index)}`))).toBe(true);
		}
		for (const outcome of outcomes) {
			expect(outcome.outputPath).toBeUndefined();
			expect(outcome.recentOutput).toContain("[earlier output omitted]");
			expect(outcome.recentOutput).not.toContain("�");
		}
	} finally {
		await active.shutdown();
	}
}, 12_000);

test("keeps live output paths without duplicating recent output in notification details", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	try {
		await active.executeBash(
			{
				command: "sleep 0.1; printf 'LIVE-PATH\\n'",
				runInBackground: true,
			},
			context(root),
		);
		await waitUntil(() => messages.length === 1);
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const delivery = messages[0] as {
			message: { details: { outcomes: Array<{ recentOutput?: string; outputPath?: string }> } };
		};
		const outcome = delivery.message.details.outcomes[0];
		expect(outcome?.outputPath).toBeString();
		expect(outcome?.recentOutput).toBeUndefined();
	} finally {
		await active.shutdown();
	}
});

test("enforces a Background Shell runtime timeout after returning control", async () => {
	const root = temporaryRoot();
	const messages: DeliveredMessage[] = [];
	const active = runtime(root, messages);
	await active.executeBash({ command: "sleep 30", runInBackground: true, timeoutSeconds: 0.2 }, context(root));
	const taskId = active.snapshot()[0]?.id;
	expect(taskId).toBeString();
	await waitUntil(() => active.snapshot().length === 0);
	await waitUntil(() => messages.length === 1);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const delivered = messages[0] as {
		message: { details: { outcomes: Array<{ status: string }> } };
		options: { deliverAs: string; triggerTurn: boolean };
	};
	expect(delivered.message.details.outcomes[0]?.status).toBe("timed_out");
	expect(delivered.options).toEqual({ deliverAs: "followUp", triggerTurn: false });
	expect(active.readOutput(taskId ?? "")).toContain("timed out");
	expect((await active.stop(taskId ?? "")).status).toBe("timed_out");
	await active.shutdown();
});
