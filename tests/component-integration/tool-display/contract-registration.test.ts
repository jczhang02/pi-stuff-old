import { expect, test } from "bun:test";
import {
	apiHarness,
	assertSuiteToolActivityCoverage,
	createSuiteToolRegistrationTracker,
	getToolUiRuntime,
	Params,
	presentation,
	registerSuiteOwnedTool,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("Suite coverage fails fast when a Tool bypasses Activity metadata", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "covered", "read-file");
	expect(() => assertSuiteToolActivityCoverage(harness.api, ["covered"])).not.toThrow();
	expect(() => assertSuiteToolActivityCoverage(harness.api, ["covered", "missing"])).toThrow(
		"Suite Tools missing Activity metadata: missing",
	);
});

test("Suite coverage checks the Tools actually registered by modules", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	registrations.api.registerTool({
		description: "untracked fixture",
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
		label: "Untracked",
		name: "untracked",
		parameters: Params,
	});
	expect(() => assertSuiteToolActivityCoverage(harness.api, [], registrations.toolNames)).toThrow(
		"Suite registered undeclared Tools: untracked",
	);
	expect(() => assertSuiteToolActivityCoverage(harness.api, ["declared"], new Set())).toThrow(
		"Suite declared unregistered Tools: declared",
	);
});

test("Suite coverage rejects metadata-only Tools without the owned Activity renderer", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	getToolUiRuntime(harness.api).registerActivity("metadata-only", presentation("run-command").activity);
	registrations.api.registerTool({
		description: "metadata-only fixture",
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
		label: "Metadata only",
		name: "metadata-only",
		parameters: Params,
	});
	expect(() => assertSuiteToolActivityCoverage(harness.api, ["metadata-only"], registrations.toolNames)).toThrow(
		"Suite Tools missing Activity renderer: metadata-only",
	);
});

test("Suite coverage accepts an already registered Tool from an idempotent module", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "existing", "read-file");
	expect(() => assertSuiteToolActivityCoverage(harness.api, ["existing"], new Set())).not.toThrow();
});

test("Suite coverage permits optional Tools when absent and checks them when registered", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	expect(() => assertSuiteToolActivityCoverage(harness.api, [], registrations.toolNames, ["optional"])).not.toThrow();
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "dynamic fixture",
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
				details: {},
			}),
			label: "Optional",
			name: "optional",
			parameters: Params,
		},
		presentation("run-command"),
	);
	expect(() => assertSuiteToolActivityCoverage(harness.api, [], registrations.toolNames, ["optional"])).not.toThrow();
});

test("Suite coverage accepts deferred Tools before registration but still requires metadata", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	expect(() => assertSuiteToolActivityCoverage(harness.api, [], registrations.toolNames, [], ["deferred"])).toThrow(
		"Suite Tools missing Activity metadata: deferred",
	);
	getToolUiRuntime(harness.api).registerActivity("deferred", presentation("run-command").activity);
	expect(() =>
		assertSuiteToolActivityCoverage(harness.api, [], registrations.toolNames, [], ["deferred"]),
	).not.toThrow();
});
