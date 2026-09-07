import { expect, test } from "bun:test";
import { activityMonitor, throwRedactedActivityError } from "../../../packages/pi-stuff/src/web/runtime/activity.js";

test("redacts provider failures before publishing activity errors", () => {
	activityMonitor.clear();
	const activityId = activityMonitor.logStart({ type: "api" });
	const error = new TypeError("request exposed secret-token");
	expect(() => throwRedactedActivityError(activityId, error, "secret-token")).toThrow("request exposed [redacted]");
	expect(activityMonitor.getEntries().at(-1)).toMatchObject({ error: "request exposed [redacted]", status: null });

	const abortId = activityMonitor.logStart({ type: "api" });
	const abort = new Error("request aborted");
	try {
		throwRedactedActivityError(abortId, abort, undefined);
	} catch (caught) {
		expect(caught).toBe(abort);
	}
	expect(activityMonitor.getEntries().at(-1)).toMatchObject({ status: 0 });
});
