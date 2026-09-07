import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import {
	createPonytailDialogView,
	type PonytailDialogAction,
	type PonytailDialogSnapshot,
} from "../../../packages/pi-stuff/src/conversation-ui/ponytail-dialog.js";
import type { PonytailSpecializedSkill } from "../../../packages/pi-stuff/src/ponytail/types.js";

initTheme("dark", false);

// SAFETY: this deterministic test theme implements every Theme method used by the Ponytail Dialog.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

const SNAPSHOT: PonytailDialogSnapshot = {
	mode: "full",
	defaultMode: "full",
	savedDefaultMode: "full",
	hideStatus: false,
	savedHideStatus: false,
	quietStartup: false,
	savedQuietStartup: false,
	defaultModeOverridden: false,
	hideStatusOverridden: false,
	quietStartupOverridden: false,
	source: "merged",
};

function harness(rows = 24) {
	let closed: PonytailSpecializedSkill | undefined;
	let closeCalls = 0;
	// SAFETY: this fixture supplies every CommandDialogViewContext member exercised by the Dialog.
	const context = {
		close: (result?: PonytailSpecializedSkill) => {
			closeCalls += 1;
			closed = result;
		},
		// SAFETY: the Dialog does not read keybindings directly; SelectList uses its own Host theme.
		keybindings: {} as KeybindingsManager,
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		// SAFETY: commandDialogRows reads only the controlled terminal row count from this TUI fixture.
		tui: { terminal: { rows } } as TUI,
		// SAFETY: this fixture supplies every CommandDialogViewContext member exercised by the Dialog.
	} as CommandDialogViewContext<PonytailSpecializedSkill>;
	return { context, getClosed: () => closed, getCloseCalls: () => closeCalls };
}

function input(component: ReturnType<ReturnType<typeof createPonytailDialogView>["create"]>, data: string): void {
	component.handleInput?.(data);
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("Ponytail Command Dialog", () => {
	test("shows one Pi Stuff-styled control plane and all specialized Skills", () => {
		const { context } = harness();
		const component = createPonytailDialogView(SNAPSHOT, { apply: async () => SNAPSHOT }).create(context);
		const lines = component.render(100);
		const text = lines.join("\n");
		expect(text).toContain("󱖿 Ponytail · full");
		expect(text).toContain("󱖿 Control");
		expect(text).toContain("Session mode");
		expect(text).toContain("Statusline");
		expect(text).toContain("Review complexity");
		expect(text).toContain("Audit repository");
		expect(text).toContain("Show debt ledger");
		expect(text).toContain("Show gain");
		expect(text).toContain("Show help");
		for (const description of [
			"Find over-engineering in this diff",
			"Find code to delete or simplify",
			"Collect ponytail: shortcut markers",
			"Show upstream benchmark savings",
			"Open modes and commands",
		]) {
			expect(text).toContain(description);
		}
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBeTrue();
	});

	test("applies mode changes in place without closing", async () => {
		const actions: PonytailDialogAction[] = [];
		const { context, getCloseCalls } = harness();
		const component = createPonytailDialogView(SNAPSHOT, {
			apply: async (action) => {
				actions.push(action);
				return { ...SNAPSHOT, mode: action.type === "set-mode" ? action.mode : SNAPSHOT.mode };
			},
		}).create(context);
		input(component, "\r");
		expect(component.render(60).join("\n")).toContain("Choose the current Session mode");
		input(component, "\u001b[B");
		input(component, "\r");
		await settle();
		expect(actions).toEqual([{ type: "set-mode", mode: "lite" }]);
		expect(getCloseCalls()).toBe(0);
		expect(component.render(60).join("\n")).toContain("󱖿 Ponytail · lite");
	});

	test("Escape returns to Overview before closing and Skills close with a result", () => {
		const first = harness();
		const component = createPonytailDialogView(SNAPSHOT, { apply: async () => SNAPSHOT }).create(first.context);
		input(component, "\r");
		input(component, "\u001b");
		expect(first.getCloseCalls()).toBe(0);
		input(component, "\u001b");
		expect(first.getCloseCalls()).toBe(1);

		const second = harness();
		const skills = createPonytailDialogView(SNAPSHOT, { apply: async () => SNAPSHOT }).create(second.context);
		for (let index = 0; index < 4; index += 1) input(skills, "\u001b[B");
		input(skills, "\r");
		expect(second.getClosed()).toBe("ponytail-review");
	});

	test("keeps environment overrides visible and remains usable at low height", () => {
		const snapshot: PonytailDialogSnapshot = {
			...SNAPSHOT,
			defaultMode: "ultra",
			defaultModeOverridden: true,
			hideStatus: true,
			hideStatusOverridden: true,
		};
		const { context } = harness(9);
		const component = createPonytailDialogView(snapshot, { apply: async () => snapshot }).create(context);
		const lines = component.render(48);
		const text = lines.join("\n");
		expect(text).toContain("environment override");
		expect(text).toContain("Enter choose");
		expect(lines.length).toBeLessThanOrEqual(9);
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBeTrue();
	});
});
