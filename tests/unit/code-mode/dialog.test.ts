import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type CodeModeDialogSnapshot,
	createCodeModeDialogView,
} from "../../../packages/pi-stuff/src/code-mode/dialog.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value } as Theme;
initTheme("dark", false);

function snapshot(overrides: Partial<CodeModeDialogSnapshot> = {}): CodeModeDialogSnapshot {
	return {
		effectiveSource: "project",
		enabled: false,
		fallbackEnabled: false,
		frozen: false,
		globalEnabled: undefined,
		history: { retainedCount: 2, totalCount: 2 },
		pendingCount: 1,
		projectEnabled: false,
		projectTrusted: true,
		snippetCount: 3,
		toolCount: 22,
		...overrides,
	};
}

function context(rows = 24): CommandDialogViewContext<void> {
	// SAFETY: this test controls the value and supplies every CommandDialogViewContext member exercised by this case.
	return {
		close: () => {},
		keybindings: {},
		requestRender: () => {},
		signal: new AbortController().signal,
		theme,
		tui: { terminal: { rows } },
	} as CommandDialogViewContext<void>;
}

test("shows effective provenance and persists independent project and global settings", async () => {
	let state = snapshot();
	const projectWrites: Array<boolean | undefined> = [];
	const globalWrites: boolean[] = [];
	const component = createCodeModeDialogView({
		getSnapshot: () => state,
		setProjectEnabled: (value) => {
			projectWrites.push(value);
			state = snapshot({
				enabled: value ?? false,
				projectEnabled: value,
				effectiveSource: value === undefined ? "default" : "project",
			});
		},
		setGlobalEnabled: (value) => {
			globalWrites.push(value);
			state = { ...state, globalEnabled: value };
		},
	}).create(context());

	const initial = component.render(64).join("\n");
	expect(initial).toContain("Effective");
	expect(initial).toContain("off · project");
	expect(initial).toContain("This project");
	expect(initial).toContain("2 executions total · 2 retained");
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(projectWrites).toEqual([true]);
	component.handleInput?.("\u001b[B");
	expect(component.render(64).join("\n")).toContain("Global default");
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(globalWrites).toEqual([true]);
});

test("supports project inheritance and rolls failed writes back to the durable snapshot", async () => {
	let state = snapshot({ enabled: true, projectEnabled: true });
	const writes: Array<boolean | undefined> = [];
	const component = createCodeModeDialogView({
		getSnapshot: () => state,
		setProjectEnabled: async (value) => {
			writes.push(value);
			if (value === undefined) {
				state = snapshot({ effectiveSource: "default", projectEnabled: undefined });
			} else {
				throw new Error("disk full");
			}
		},
		setGlobalEnabled: () => {},
	}).create(context());
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(writes).toEqual([undefined]);
	component.handleInput?.("\r");
	await Promise.resolve();
	await Promise.resolve();
	expect(component.render(64).join("\n")).toContain("Unable to save Code Mode setting");
	expect(state.projectEnabled).toBeUndefined();
});

test("keeps frozen and untrusted settings non-editable and fits a short terminal", () => {
	let writes = 0;
	const component = createCodeModeDialogView({
		getSnapshot: () => snapshot({ effectiveSource: "frozen", enabled: true, frozen: true, projectTrusted: false }),
		setProjectEnabled: () => {
			writes += 1;
		},
		setGlobalEnabled: () => {
			writes += 1;
		},
	}).create(context(6));
	component.handleInput?.("\r");
	expect(writes).toBe(0);
	const lines = component.render(42);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("locked");
	expect(lines.at(-1)).toContain("Esc close");
});
