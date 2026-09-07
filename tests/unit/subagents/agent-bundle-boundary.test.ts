import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../../../packages/pi-stuff/src/subagents/src/agents/agents.js";
import {
	buildFanoutChildSubagentToolDescription,
	buildSubagentToolDescription,
} from "../../../packages/pi-stuff/src/subagents/src/extension/tool-description.js";

describe("Pi Stuff Agent bundle boundary", () => {
	test("ships no built-in Agent definitions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-stuff-agent-discovery-"));
		try {
			expect((await discoverAgents(cwd, "project")).agents).toEqual([]);
		} finally {
			rmSync(cwd, { force: true, recursive: true });
		}
	});

	test("directs callers to externally supplied Agent definitions", () => {
		for (const description of [buildSubagentToolDescription(), buildFanoutChildSubagentToolDescription()]) {
			expect(description).toContain("Pi Stuff does not provide built-in Agent definitions");
			expect(description).toContain("Package, user, or project Agent");
			expect(description).not.toContain("built-in general-purpose");
		}
	});
});
