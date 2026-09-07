import { describe, expect, test } from "bun:test";
import type { BeforeAgentStartEvent, Skill } from "@earendil-works/pi-coding-agent";
import { PONYTAIL_SKILL_NAMES, PonytailPromptRenderer } from "../../../packages/pi-stuff/src/ponytail/prompt.js";

function skill(name: string): Skill {
	// SAFETY: this fixture supplies every Skill field read by the catalog renderer.
	return {
		baseDir: "/package/skills",
		description: `upstream ${name} description`,
		disableModelInvocation: true,
		filePath: `/package/skills/${name}/SKILL.md`,
		name,
		sourceInfo: { path: `/package/skills/${name}/SKILL.md`, source: "package" },
	} as Skill;
}

function event(systemPrompt = "Host", skills = PONYTAIL_SKILL_NAMES.map(skill)): BeforeAgentStartEvent {
	// SAFETY: this fixture supplies every BeforeAgentStartEvent field read by the renderer.
	return {
		type: "before_agent_start",
		prompt: "task",
		systemPrompt,
		systemPromptOptions: { cwd: "/workspace", skills },
	} as BeforeAgentStartEvent;
}

describe("Ponytail prompt renderer", () => {
	test("makes off a hard prompt and catalog boundary", () => {
		const renderer = new PonytailPromptRenderer();
		expect(renderer.renderAgent(event(), "off")).toBeUndefined();
		expect(renderer.renderProvider("off")).toBeUndefined();
	});

	test("projects all six compact Skill entries before active-mode instructions", () => {
		const rendered = new PonytailPromptRenderer().renderAgent(event(), "ultra");
		if (!rendered) throw new Error("Ponytail did not render");
		expect(rendered).toContain("<available_skills>");
		for (const name of PONYTAIL_SKILL_NAMES) expect(rendered).toContain(`<name>${name}</name>`);
		expect(rendered.indexOf("<available_skills>")).toBeLessThan(rendered.indexOf("PONYTAIL MODE ACTIVE"));
		expect(rendered.match(/<name>ponytail<\/name>/gu)).toHaveLength(1);
		expect(rendered).toContain("Load the complete Ponytail coding-discipline rules");
		expect(rendered).not.toContain("upstream ponytail description");
	});

	test("does not duplicate a catalog already present in the Host prompt", () => {
		const rendered = new PonytailPromptRenderer().renderAgent(
			event("Host <available_skills><skill><name>ponytail</name></skill></available_skills>"),
			"full",
		);
		expect(rendered).toStartWith("PONYTAIL MODE ACTIVE — level: full");
		expect(rendered).not.toContain("<available_skills>");
	});

	test("does not recreate Skills removed by Host resource filtering", () => {
		const renderer = new PonytailPromptRenderer();
		const rendered = renderer.renderAgent(event("Host", []), "full");
		expect(rendered).toStartWith("PONYTAIL MODE ACTIVE — level: full");
		expect(rendered).not.toContain("<available_skills>");
		expect(renderer.renderProvider("off")).toBeUndefined();
	});

	test("reuses the latest Host-visible catalog for Provider fallback", () => {
		const renderer = new PonytailPromptRenderer();
		renderer.renderAgent(event(), "full");
		const rendered = renderer.renderProvider("lite");
		expect(rendered).toContain("<available_skills>");
		expect(rendered).toContain("PONYTAIL MODE ACTIVE — level: lite");
	});
});
