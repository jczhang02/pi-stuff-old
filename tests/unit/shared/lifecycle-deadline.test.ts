import { describe, expect, test } from "bun:test";
import { settleWithin } from "../../../packages/pi-stuff/src/lifecycle-deadline.js";

describe("lifecycle deadline", () => {
	test("settles failures and bounds a dependency that ignores cancellation", async () => {
		expect(await settleWithin(Promise.reject(new Error("cleanup failed")), 100)).toBeTrue();

		const startedAt = performance.now();
		expect(await settleWithin(new Promise(() => undefined), 10)).toBeFalse();
		expect(performance.now() - startedAt).toBeLessThan(100);
	});
});
