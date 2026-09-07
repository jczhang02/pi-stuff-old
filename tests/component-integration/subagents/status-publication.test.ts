import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackgroundRunnerStatus } from "../../../packages/pi-stuff/src/subagents/src/runs/background/initial-status.ts";
import {
	installStatusPublisher,
	setStatusUpdateObserver,
	writeStatus,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/runner-state.ts";

test.each([
	["absent", false, undefined],
	["disconnected", true, false],
	["connected", true, true],
] as const)("schedules status publication only for active IPC: %s", async (_name, hasSender, connected) => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-status-publication-"));
	const statusPath = join(root, "status.json");
	const descriptors = ["send", "connected"].map(
		(key) => [key, Object.getOwnPropertyDescriptor(process, key)] as const,
	);
	const sent: string[] = [];
	const observed: string[] = [];
	const usable = hasSender && connected !== false;
	const status: BackgroundRunnerStatus = {
		runId: "publication",
		mode: "single",
		state: "running",
		pid: process.pid,
		cwd: root,
		steps: [],
		startedAt: Date.now(),
		lastUpdate: Date.now(),
	};
	const clock = Effect.runSync(Clock.Clock);
	const sleep = spyOn(clock, "sleep").mockImplementation(() => Effect.never);
	try {
		Object.defineProperty(process, "send", {
			configurable: true,
			value: hasSender
				? (message: { status: BackgroundRunnerStatus }, callback: () => void) => {
						sent.push(message.status.state ?? "");
						callback();
						return true;
					}
				: undefined,
		});
		Object.defineProperty(process, "connected", { configurable: true, value: connected });
		setStatusUpdateObserver(statusPath, (update) => observed.push(update.state ?? ""));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* installStatusPublisher();
					writeStatus(statusPath, status);
					writeStatus(statusPath, status);
					yield* Effect.yieldNow;
					expect(sleep).toHaveBeenCalledTimes(usable ? 1 : 0);
					expect(sent).toEqual([]);
					status.state = "complete";
					writeStatus(statusPath, status);
					expect(sent).toEqual(usable ? ["complete"] : []);
				}),
			),
		);
		expect(observed).toEqual(["running", "running", "complete"]);
		expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ runId: "publication", state: "complete" });
		expect(sent).toEqual(usable ? ["complete"] : []);
	} finally {
		sleep.mockRestore();
		setStatusUpdateObserver(statusPath, undefined);
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(process, key, descriptor);
			else Reflect.deleteProperty(process, key);
		}
		rmSync(root, { recursive: true, force: true });
	}
});
