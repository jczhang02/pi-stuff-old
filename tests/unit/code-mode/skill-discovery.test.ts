import { afterEach, expect, test } from "bun:test";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerCodeModeSkillDiscovery } from "../../../packages/pi-stuff/src/code-mode/skill-discovery.js";
import {
	__test,
	applyContextPromptContributions,
	applyContextPromptContributionsToProvider,
	registerContextPromptContributor,
} from "../../../packages/pi-stuff/src/context-management/prompt-contributions.js";
import type {
	SuiteToolDefinitionRegistry,
	SuiteToolSurfaceController,
} from "../../../packages/pi-stuff/src/tool-display/contract.js";

// SAFETY: the contributor under test does not read other ExtensionContext fields.
const ctx = {} as ExtensionContext;

function skill(name: string, disableModelInvocation = false): Skill {
	// SAFETY: this fixture supplies every Skill field read by Pi's public formatter.
	return {
		baseDir: "/agent/skills",
		description: `${name} description`,
		disableModelInvocation,
		filePath: `/agent/skills/${name}/SKILL.md`,
		name,
		sourceInfo: { path: `/agent/skills/${name}/SKILL.md`, source: "user" },
	} as Skill;
}

function event(
	systemPrompt: string,
	skills: Skill[],
	selectedTools: string[] = ["codemode", "tool_search"],
): BeforeAgentStartEvent {
	// SAFETY: this fixture supplies every event field read by the public contribution seam.
	return {
		prompt: "use the matching instructions",
		systemPrompt,
		systemPromptOptions: {
			cwd: "/workspace",
			selectedTools,
			skills,
		},
		type: "before_agent_start",
	} as BeforeAgentStartEvent;
}

type EventHandler = (event: ExtensionEvent, context: ExtensionContext) => object | undefined;

function harness(options: { readonly envelopeEnabled?: boolean; readonly readActive?: boolean } = {}) {
	const events = new Map<string, EventHandler[]>();
	const { envelopeEnabled = true, readActive = true } = options;
	const registry: SuiteToolDefinitionRegistry = {
		catalog: () => [],
		compensate: async () => false,
		get: () => undefined,
		invoke: async () => ({ isError: false, result: { content: [], details: {} } }),
		isActive: (name) => readActive && name === "read",
		list: () => [],
	};
	const surface: SuiteToolSurfaceController = {
		disableEnvelope: () => {},
		enableEnvelope: () => {},
		isEnvelopeEnabled: (name) => envelopeEnabled && name === "codemode",
	};
	// SAFETY: this fixture records Host event callbacks without changing their arguments or results.
	const on = ((name: string, handler: EventHandler) => {
		events.set(name, [...(events.get(name) ?? []), handler]);
	}) as ExtensionAPI["on"];
	const pi = { events: createEventBus(), on };
	registerCodeModeSkillDiscovery(pi, { registry, surface });
	return { events, pi };
}

afterEach(() => __test.clear());

test("Code Mode preserves the Host Skill catalog through the Context prompt seam", async () => {
	const { pi } = harness();
	const target = skill("target-skill");
	const hidden = skill("hidden-skill", true);
	const first = await applyContextPromptContributions(pi, event("Custom host prompt", [target, hidden]), ctx);
	const prompt = first?.systemPrompt ?? "";

	expect(prompt).toContain("Custom host prompt");
	expect(prompt).toContain("pi-stuff:prompt-contribution:code-mode-skill-discovery:start");
	expect(prompt).toContain("<name>target-skill</name>");
	expect(prompt).toContain("<description>target-skill description</description>");
	expect(prompt).toContain("<location>/agent/skills/target-skill/SKILL.md</location>");
	expect(prompt).toContain("call codemode directly and use tools.read");
	expect(prompt).toContain("do not call tool_search or scan first");
	expect(prompt).not.toContain("hidden-skill");
	expect(prompt.match(/<name>target-skill<\/name>/gu)).toHaveLength(1);

	expect(await applyContextPromptContributions(pi, event(prompt, [target, hidden]), ctx)).toBeUndefined();
	const provider = await applyContextPromptContributionsToProvider(pi, { instructions: "Provider host" }, ctx);
	expect(JSON.stringify(provider.payload).match(/<name>target-skill<\/name>/gu)).toHaveLength(1);
});

test("Provider fallback reuses only a Skill snapshot from the current Session", async () => {
	const { events, pi } = harness();
	const payload = { instructions: "Provider host" };
	const unprimed = await applyContextPromptContributionsToProvider(pi, payload, ctx);
	expect(unprimed).toEqual({ active: false, found: true, payload });

	await applyContextPromptContributions(pi, event("Host", [skill("session-skill")]), ctx);
	expect(JSON.stringify((await applyContextPromptContributionsToProvider(pi, payload, ctx)).payload)).toContain(
		"session-skill",
	);

	for (const handler of events.get("session_start") ?? []) {
		await handler({ reason: "new", type: "session_start" }, ctx);
	}
	const nextSession = await applyContextPromptContributionsToProvider(pi, payload, ctx);
	expect(nextSession).toEqual({ active: false, found: true, payload });
});

test("Skill Discovery stays absent outside the exact Code Mode virtual Read surface", async () => {
	const target = skill("target-skill");
	const cases = [
		{ options: { envelopeEnabled: false }, selectedTools: ["read"] },
		{ options: { readActive: false }, selectedTools: ["codemode", "tool_search"] },
		{ options: {}, selectedTools: ["read"] },
		{ options: {}, selectedTools: ["codemode", "tool_search", "read"] },
	] as const;
	for (const scenario of cases) {
		const { pi } = harness(scenario.options);
		expect(
			await applyContextPromptContributions(pi, event("Host", [target], [...scenario.selectedTools]), ctx),
		).toBeUndefined();
	}

	const { pi: emptyPi } = harness();
	expect(await applyContextPromptContributions(emptyPi, event("Host", []), ctx)).toBeUndefined();
	const { pi: disabledPi } = harness();
	expect(
		await applyContextPromptContributions(disabledPi, event("Host", [skill("disabled", true)]), ctx),
	).toBeUndefined();
});

test("Skill Discovery is ordered before later Capability instructions", async () => {
	const { pi } = harness();
	registerContextPromptContributor(pi, { id: "ponytail", order: 300, renderAgent: () => "Ponytail rules" });
	const projected = await applyContextPromptContributions(pi, event("Host", [skill("target-skill")]), ctx);
	const prompt = projected?.systemPrompt ?? "";
	expect(prompt.indexOf("<name>target-skill</name>")).toBeLessThan(prompt.indexOf("Ponytail rules"));
});
