import { afterEach, describe, expect, test } from "bun:test";
import {
	activateDiagnosticChannel,
	DiagnosticChannel,
	resetDiagnosticProcessState,
} from "../../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import {
	reportAgentDiagnostic,
	reportAgentWarning,
} from "../../../packages/pi-stuff/src/subagents/src/shared/diagnostics.js";

afterEach(() => resetDiagnosticProcessState());

describe("Agent diagnostics", () => {
	test("routes Host-side maintenance failures silently without duplicating Error details", () => {
		const channel = new DiagnosticChannel();
		activateDiagnosticChannel(channel);
		const error = new Error("injected watcher EIO");

		reportAgentDiagnostic("[pi-stuff-agents] Result watcher recovered", error, { attempt: 2 });

		const record = channel.list()[0];
		expect(record?.summary).toBe("Result watcher recovered");
		expect(record?.severity).toBe("error");
		expect(record?.details[0]).toBe('{"attempt":2}');
		expect(record?.details.filter((line) => line.includes("injected watcher EIO"))).toHaveLength(1);
		expect(channel.listNotices()).toEqual([]);
	});

	test("normalizes the inherited warning prefix", () => {
		const channel = new DiagnosticChannel();
		activateDiagnosticChannel(channel);

		reportAgentWarning("[pi-subagents] Requested model is outside the allowed scope");

		expect(channel.list()[0]?.summary).toBe("Requested model is outside the allowed scope");
		expect(channel.list()[0]?.severity).toBe("warning");
	});
});
