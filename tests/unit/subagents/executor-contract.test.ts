import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { type JsonValue, parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import {
	normalizePublicAgentParams,
	toEngineParams,
} from "../../../packages/pi-stuff/src/subagents/src/extension/product-executor.js";
import {
	FanoutChildSubagentParams,
	SubagentParams,
} from "../../../packages/pi-stuff/src/subagents/src/extension/schemas.js";
import { deriveLaunchRunId } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.js";

test("describes the public Agent Target as the status run id and child index pair", () => {
	expect(JSON.stringify(SubagentParams.properties.id)).toContain("run id shown by status");
	expect(JSON.stringify(SubagentParams.properties.index)).toContain("child index shown by status");
});

test("accepts only single, parallel, and four current-session controls", () => {
	const accepted = [
		{ agent: "general-purpose", task: "Investigate" },
		{
			tasks: [
				{ agent: "general-purpose", description: "Implement parser", task: "Implement" },
				{ agent: "general-purpose", task: "Review" },
			],
			foreground: true,
			context: "fork",
			isolation: "worktree",
		},
		{ action: "status", id: "run-a" },
		{ action: "steer", id: "run-a", index: 1, message: "Check the parser" },
		{ action: "stop", id: "run-a" },
		{ action: "resume", id: "run-a", message: "Continue" },
	];
	for (const input of accepted) expect(Check(SubagentParams, input)).toBe(true);

	const excluded = [
		{ chain: [{ agent: "general-purpose", task: "Legacy chain" }] },
		{ chainName: "legacy" },
		{ workflow: "legacy" },
		{ memory: { scope: "project" } },
		{ clarify: true },
		{ share: true },
		{ acceptance: { gates: [] } },
		{ review: true },
		{ profile: "fast" },
		{ schedule: "+1h" },
		{ agent: "general-purpose", task: "Stop early", turnBudget: { maxTurns: 2 } },
		{ wait: true },
		{ action: "doctor" },
		{ action: "create", agent: "legacy" },
	];
	for (const input of excluded) expect(Check(SubagentParams, input)).toBe(false);
});

test("keeps the provider schema branch-free and enforces exclusive shapes at runtime", () => {
	const nodes: JsonValue[] = [parseJsonValue(JSON.stringify(SubagentParams))];
	while (nodes.length > 0) {
		const node = nodes.pop();
		if (Array.isArray(node)) {
			nodes.push(...node);
			continue;
		}
		if (!node || Array.isArray(node) || !isRuntimeObject(node)) continue;
		const schema = node;
		expect(Object.hasOwn(schema, "oneOf")).toBeFalse();
		if (schema["properties"] && isRuntimeObject(schema["properties"])) {
			for (const property of Object.values(schema["properties"])) expect(property).not.toBe(false);
		}
		nodes.push(...Object.values(schema));
	}
	expect(() =>
		normalizePublicAgentParams({
			agent: "general-purpose",
			task: "Inspect",
			tasks: [{ agent: "general-purpose", task: "Review" }],
		}),
	).toThrow("either agent plus task or tasks");
});

test("promotes consistent task-level shared launch hints and rejects conflicts", () => {
	expect(
		toEngineParams({
			tasks: [
				{
					agent: "general-purpose",
					context: "fork",
					foreground: true,
					isolation: "worktree",
					task: "Implement",
				},
				{
					agent: "general-purpose",
					context: "fork",
					foreground: true,
					isolation: "worktree",
					task: "Review",
				},
			],
		}),
	).toMatchObject({ async: false, context: "fork", worktree: true });
	expect(() =>
		toEngineParams({
			tasks: [
				{ agent: "general-purpose", context: "fork", task: "Implement" },
				{ agent: "general-purpose", context: "fresh", task: "Review" },
			],
		}),
	).toThrow("one shared context value");
});

test("keeps task-level foreground out of the owner-blocking fanout schema", () => {
	const input = {
		tasks: [{ agent: "general-purpose", foreground: false, task: "Implement" }],
	};
	expect(Check(SubagentParams, input)).toBeTrue();
	expect(Check(FanoutChildSubagentParams, input)).toBeFalse();
});

test("maps the complete allowed parallel launch without legacy fields", () => {
	expect(
		toEngineParams({
			context: "fork",
			foreground: true,
			isolation: "worktree",
			tasks: [
				{
					agent: "general-purpose",
					cwd: "packages/core",
					description: "Implement core change",
					model: "provider/model",
					skill: ["research", "review"],
					task: "Implement and verify",
					toolBudget: { hard: 8, soft: 5, block: ["browser"] },
					toolTimeoutMs: 900,
				},
			],
		}),
	).toEqual({
		async: false,
		context: "fork",
		tasks: [
			{
				agent: "general-purpose",
				cwd: "packages/core",
				description: "Implement core change",
				model: "provider/model",
				skill: ["research", "review"],
				task: "Implement and verify",
				toolBudget: { hard: 8, soft: 5, block: ["browser"] },
				toolTimeoutMs: 900,
			},
		],
		worktree: true,
	});
});

test("derives a stable filesystem-safe run id from the tool-call id", () => {
	const first = deriveLaunchRunId("tool-call-123");
	expect(first).toBe(deriveLaunchRunId("tool-call-123"));
	expect(first).not.toBe(deriveLaunchRunId("tool-call-456"));
	expect(first).toMatch(/^[a-f0-9]{12}$/);
});
