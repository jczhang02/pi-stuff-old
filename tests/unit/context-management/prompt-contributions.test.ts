import { afterEach, describe, expect, test } from "bun:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	__test,
	applyContextPromptContributions,
	applyContextPromptContributionsToProvider,
	registerContextPromptContributor,
	stripContextPromptContributions,
} from "../../../packages/pi-stuff/src/context-management/prompt-contributions.js";

function host(): ExtensionAPI {
	// SAFETY: this fixture supplies the only ExtensionAPI member used by the contribution registry.
	return { events: {} } as ExtensionAPI;
}

// SAFETY: contributor renderers in this test do not read ExtensionContext.
const ctx = {} as ExtensionContext;
const event = (systemPrompt: string): BeforeAgentStartEvent => {
	// SAFETY: this fixture supplies every BeforeAgentStartEvent field read by the projection seam.
	return {
		type: "before_agent_start",
		prompt: "task",
		systemPrompt,
		systemPromptOptions: {},
	} as BeforeAgentStartEvent;
};

afterEach(() => __test.clear());

describe("Context prompt contributions", () => {
	test("composes contributors deterministically and idempotently", async () => {
		const pi = host();
		registerContextPromptContributor(pi, { id: "late", order: 20, renderAgent: () => "Late" });
		registerContextPromptContributor(pi, { id: "early", order: 10, renderAgent: () => "Early" });
		const first = await applyContextPromptContributions(pi, event("Base"), ctx);
		expect(first?.systemPrompt).toContain("Base\n\n<!-- pi-stuff:prompt-contribution:early:start -->\nEarly");
		expect(first?.systemPrompt?.indexOf("Early")).toBeLessThan(first?.systemPrompt?.indexOf("Late") ?? 0);
		const second = await applyContextPromptContributions(pi, event(first?.systemPrompt ?? ""), ctx);
		expect(second).toBeUndefined();
		expect(first?.systemPrompt?.match(/prompt-contribution:early:start/gu)).toHaveLength(1);
	});

	test("lets Context place Magic before a previously projected contribution", async () => {
		const pi = host();
		registerContextPromptContributor(pi, { id: "ponytail", renderAgent: () => "Ponytail" });
		const first = await applyContextPromptContributions(pi, event("Host"), ctx);
		const stripped = stripContextPromptContributions(pi, first?.systemPrompt ?? "");
		const recomposed = await applyContextPromptContributions(pi, event(`${stripped}\n\nMagic Context`), ctx);
		expect(recomposed?.systemPrompt).toContain(
			"Host\n\nMagic Context\n\n<!-- pi-stuff:prompt-contribution:ponytail:start -->",
		);
	});

	test("replacement cleanup cannot unregister a newer contributor", async () => {
		const pi = host();
		const removeOld = registerContextPromptContributor(pi, { id: "ponytail", renderAgent: () => "old" });
		registerContextPromptContributor(pi, { id: "ponytail", renderAgent: () => "new" });
		removeOld();
		const result = await applyContextPromptContributions(pi, event("Host"), ctx);
		expect(result?.systemPrompt).toContain("new");
		expect(result?.systemPrompt).not.toContain("old");
	});

	test("removes a contribution when its renderer becomes inactive", async () => {
		const pi = host();
		let active = true;
		registerContextPromptContributor(pi, { id: "ponytail", renderAgent: () => (active ? "rules" : undefined) });
		const first = await applyContextPromptContributions(pi, event("Host"), ctx);
		active = false;
		const second = await applyContextPromptContributions(pi, event(first?.systemPrompt ?? ""), ctx);
		expect(second?.systemPrompt).toBe("Host");
	});
});

describe("Provider prompt projection", () => {
	const payloads: unknown[] = [
		{ instructions: "Host" },
		{ systemInstruction: "Host" },
		{ system: "Host" },
		{ system: [{ type: "text", text: "Host" }] },
		{ system: [{ text: "Host" }] },
		{ messages: [{ role: "system", content: "Host" }] },
		{ input: [{ role: "developer", content: "Host" }] },
		{ input: [{ role: "developer", content: [{ type: "input_text", text: "Host" }] }] },
	];

	for (const [index, payload] of payloads.entries()) {
		test(`projects into supported Provider payload shape ${index + 1}`, async () => {
			const pi = host();
			registerContextPromptContributor(pi, {
				id: "ponytail",
				renderAgent: () => "rules",
				renderProvider: () => "rules",
			});
			const result = await applyContextPromptContributionsToProvider(pi, payload, ctx);
			expect(result.found).toBeTrue();
			expect(result.active).toBeTrue();
			const serialized = JSON.stringify(result.payload);
			expect(serialized).toContain("Host");
			expect(serialized).toContain("pi-stuff:prompt-contribution:ponytail:start");
			expect(serialized).toContain("rules");
		});
	}

	test("reports unsupported payloads without mutating them", async () => {
		const pi = host();
		registerContextPromptContributor(pi, {
			id: "ponytail",
			renderAgent: () => "rules",
			renderProvider: () => "rules",
		});
		const payload = { prompt: "opaque" };
		const result = await applyContextPromptContributionsToProvider(pi, payload, ctx);
		expect(result).toEqual({ active: true, found: false, payload });
	});
});
