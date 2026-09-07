import { expect, test } from "bun:test";
import {
	loadConfig,
	MAX_AGENT_DEPTH,
	MAX_RUNNING_AGENTS,
} from "../../../packages/pi-stuff/src/subagents/src/extension/config.ts";

test("Agent concurrency and depth limits remain fixed product invariants", () => {
	expect(loadConfig()).toEqual({
		maxRunningAgents: 20,
		maxSubagentDepth: 3,
	});
	expect([MAX_AGENT_DEPTH, MAX_RUNNING_AGENTS]).toEqual([3, 20]);
	expect(Object.isFrozen(loadConfig())).toBeTrue();
});
