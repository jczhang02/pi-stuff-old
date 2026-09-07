import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
	createSteeringStatus,
	recordSteeringRequest,
	waitForSteeringAction,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/steering.ts";
import { OwnedFileChangedDuringReadError } from "../../../packages/pi-stuff/src/subagents/src/shared/private-directory.ts";

describe("steering acknowledgement polling", () => {
	test("retries a status snapshot that changes during one read", async () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, {
			id: "steer-1",
			requestedAt: 1,
			message: "Continue",
			targets: [{ index: 0, state: "delivered" }],
		});
		let reads = 0;
		let sleeps = 0;

		const result = await Effect.runPromise(
			waitForSteeringAction(
				{ asyncDir: "/runtime", sourceRunId: "run-1", requestId: "steer-1", timeoutMs: 100 },
				{
					readSteeringStatus: () => {
						reads += 1;
						if (reads === 1) {
							throw new Error("Failed to inspect status", {
								cause: new OwnedFileChangedDuringReadError("/runtime/status.json"),
							});
						}
						return status;
					},
					sleep: () =>
						Effect.sync(() => {
							sleeps += 1;
						}),
				},
			),
		);

		expect(result).toMatchObject({
			requestId: "steer-1",
			state: "delivered",
			sourceRunId: "run-1",
			targets: [{ index: 0, state: "delivered" }],
		});
		expect(reads).toBe(2);
		expect(sleeps).toBe(1);
	});

	test("does not hide a non-transient status error", async () => {
		await expect(
			Effect.runPromise(
				waitForSteeringAction(
					{ asyncDir: "/runtime", sourceRunId: "run-1", requestId: "steer-1", timeoutMs: 100 },
					{
						readSteeringStatus: () => {
							throw new Error("unsafe status path");
						},
					},
				),
			),
		).rejects.toThrow("unsafe status path");
	});
});
