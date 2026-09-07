import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type BeforeAgentStartEvent, loadSkills } from "@earendil-works/pi-coding-agent";
import { getPonytailInstructions } from "../../../packages/pi-stuff/src/ponytail/instructions.js";
import { PonytailPromptRenderer } from "../../../packages/pi-stuff/src/ponytail/prompt.js";
import { countPonytailPromptTokens } from "../../../packages/pi-stuff/src/ponytail/prompt-budget.js";

const PONYTAIL_ROOT = resolve(import.meta.dir, "../../../packages/pi-stuff/src/ponytail");
function prompt(mode: "off" | "lite" | "full" | "ultra"): string {
	const skills = loadSkills({
		agentDir: resolve(import.meta.dir, ".missing-agent-dir"),
		cwd: PONYTAIL_ROOT,
		includeDefaults: false,
		skillPaths: [resolve(PONYTAIL_ROOT, "skills")],
	}).skills;
	// SAFETY: this fixture supplies every BeforeAgentStartEvent field read by the renderer.
	const event = {
		type: "before_agent_start",
		prompt: "task",
		systemPrompt: "Host",
		systemPromptOptions: { cwd: PONYTAIL_ROOT, skills },
	} as BeforeAgentStartEvent;
	return new PonytailPromptRenderer().renderAgent(event, mode) ?? "";
}

describe("Ponytail prompt budget", () => {
	test("makes off free and bounds each active contribution", () => {
		const off = prompt("off");
		const full = prompt("full");
		const instructions = getPonytailInstructions("full") ?? "";
		const fullTokens = countPonytailPromptTokens(full);
		const instructionTokens = countPonytailPromptTokens(instructions);

		expect(off).toBe("");
		expect(full).toContain("<available_skills>");
		expect(full).toContain("PONYTAIL MODE ACTIVE — level: full");
		expect(instructions.length).toBeLessThanOrEqual(2_000);
		expect(instructionTokens).toBeLessThanOrEqual(400);
		expect(full.length).toBeLessThanOrEqual(4_000);
		expect(fullTokens - instructionTokens).toBeLessThanOrEqual(600);
		expect(fullTokens).toBeLessThanOrEqual(900);
	});

	test("keeps lite and ultra within the same bounded policy shape", () => {
		for (const mode of ["lite", "ultra"] as const) {
			const rendered = prompt(mode);
			expect(rendered).toContain(`PONYTAIL MODE ACTIVE — level: ${mode}`);
			expect(countPonytailPromptTokens(rendered)).toBeLessThanOrEqual(900);
		}
	});
});
