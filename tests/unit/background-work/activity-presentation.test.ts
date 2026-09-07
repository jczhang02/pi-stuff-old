import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { registerWorkTools } from "../../../packages/pi-stuff/src/background-work/src/tools.js";
import { getToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { createSuiteToolRegistrationTracker } from "../../../packages/pi-stuff/src/tool-display/registration.js";
import { toolRegistrationHarness } from "../../fixtures/tool-registration-host.js";

function registeredBash() {
	const { host: api, tools } = toolRegistrationHarness(["bash"]);
	registerWorkTools(api, { current: () => undefined });
	const bash = tools.get("bash");
	if (!bash) throw new Error("Background Work did not register Bash");
	return { api, bash };
}

test("explicit Bash and Monitor deadlines are not capped at one day", () => {
	const { host, tools } = toolRegistrationHarness(["bash"]);
	registerWorkTools(host, { current: () => undefined });
	const bash = tools.get("bash");
	const monitor = tools.get("monitor");
	if (!bash || !monitor) throw new Error("Background Work tools were not registered");

	expect(Check(bash.parameters, { command: ":", timeout: 3_000_000 })).toBeTrue();
	expect(Check(monitor.parameters, { source: "file", target: "/tmp/ready", timeout_seconds: 3_000_000 })).toBeTrue();
});

test("the live Background Work Bash keeps its Code Mode contract", () => {
	const { host } = toolRegistrationHarness(["bash"]);
	const registrations = createSuiteToolRegistrationTracker({ ...host, getAllTools: () => [] });
	registerWorkTools(registrations.api, { current: () => undefined });
	const catalog = registrations.registry.catalog();

	expect(catalog.find((entry) => entry.definition.name === "bash")).toMatchObject({
		codeMode: { replay: "never" },
	});
});

test("/tools formats a background Bash handoff from structured result details", () => {
	const { api } = registeredBash();
	const runtime = getToolUiRuntime(api);
	const args = {
		command: "bun run check",
		description: "Run the complete checks",
		run_in_background: true,
	};
	runtime.indexMessages(
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "bash-background", name: "bash", arguments: args }],
			},
			{
				role: "toolResult",
				toolCallId: "bash-background",
				content: [{ type: "text", text: "legacy display text that formatted detail must not expose" }],
				details: {
					backgroundTaskId: "bf8t2miir",
					fullOutputPath: "/tmp/bf8t2miir.output",
				},
			},
		],
		true,
	);

	expect(runtime.toolActivityDetail("bash-background", "formatted")?.lines).toEqual([
		"bun run check",
		"Started in background · bf8t2miir",
		"",
		"Output file",
		"/tmp/bf8t2miir.output",
		"",
		"Result will be delivered automatically.",
	]);
});

test("standalone Bash preserves an automatic foreground-to-background handoff in its child output", () => {
	const { api, bash } = registeredBash();
	const args = { command: "sleep 300", description: "Wait for service" };
	const result = {
		content: [
			{
				text: "Command still running after 120s; moved to background task abc123. Continue useful work.",
				type: "text" as const,
			},
		],
		details: {},
	};
	getToolUiRuntime(api).indexMessages(
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "bash-auto-background", name: "bash", arguments: args }],
			},
			{ role: "toolResult", toolCallId: "bash-auto-background", content: result.content, details: result.details },
		],
		true,
	);
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const theme = {
		bold: (value: string) => value,
		fg: (_color: string, value: string) => value,
	} as Theme;
	const state = {};
	const context = {
		args,
		argsComplete: true,
		cwd: "/project",
		executionStarted: true,
		expanded: false,
		invalidate: () => {},
		isError: false,
		isPartial: false,
		lastComponent: undefined,
		showImages: true,
		state,
		toolCallId: "bash-auto-background",
	};
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const row = bash.renderCall?.(args, theme, context as never);
	expect(row).toBeDefined();
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	bash.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
		...context,
		lastComponent: row,
	} as never);

	const rendered = row?.render(100).join("\n") ?? "";
	expect(rendered).toContain("• Bash(sleep 300)");
	expect(rendered).toContain("⎿  Command still running after 120s; moved to background task abc123.");
	expect(rendered).not.toContain("Launched 1 background task");
});
