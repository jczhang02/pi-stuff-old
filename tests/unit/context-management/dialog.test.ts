import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ContextDialogCommand,
	createContextDialogView,
	statusSnapshotFromMagic,
} from "../../../packages/pi-stuff/src/context-management/dialog.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";

initTheme("dark", false);

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

const MAGIC_STATUS = `## Magic Status

**Session:** session-a
**Tag counter:** 7

### Tags
- Active: 12 (~6.2 KB)
- Dropped: 3
- Total: 15

### Pending Queue
- Drops: 2
- Total queued: 2

### Cache TTL
- Configured: 5m
- Last response: 14s ago
- Remaining: 286s
- Queue will auto-execute: when TTL expires or context >= 65%

### Execute Threshold
- Execute threshold: 65% (130,000 of 200,000)
- Last input tokens: 48,000 tokens

**Protected tags:** 20
**Subagent session:** false

### Context Usage
- Last percentage: 24.0%
- Last input tokens: 48,000
- Resolved context limit: 200,000

### History Compression
- Compartments: 4
- History block: ~8,400 tokens
- History budget: ~19,500 tokens (43% used)`;

const MAGIC_DETAILS = {
	activeTags: 12,
	compartmentCount: 4,
	droppedTags: 3,
	historian: {
		failureCount: 0,
		inProgress: false,
		lastError: null,
		lastFailureAt: null,
		lastFireCount: 7,
	},
	lastCompartmentRange: "80-119",
	memoryCount: 6,
	noteCount: 3,
	pendingOps: 2,
	totalBytes: 6_348,
};

function harness(rows = 24) {
	let closed: ContextDialogCommand | undefined;
	let closeCalls = 0;
	// SAFETY: this test controls the value and supplies every KeybindingsManager member exercised by this case.
	const context = {
		close: (result?: ContextDialogCommand) => {
			closeCalls++;
			closed = result;
		},
		// SAFETY: this test controls the value and supplies every KeybindingsManager member exercised by this case.
		keybindings: {} as KeybindingsManager,
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		// SAFETY: this test controls the value and supplies every TUI member exercised by this case.
		tui: { terminal: { rows } } as TUI,
	} as CommandDialogViewContext<ContextDialogCommand>;
	return { context, getCloseCalls: () => closeCalls, getClosed: () => closed };
}

function input(component: ReturnType<ReturnType<typeof createContextDialogView>["create"]>, data: string): void {
	component.handleInput?.(data);
}

test("turns official Magic status into a readable Pi Stuff snapshot", () => {
	expect(
		statusSnapshotFromMagic(
			{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
			{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
		),
	).toEqual({
		activeTags: 12,
		cache: "286s remaining",
		compartmentCount: 4,
		contextWindow: 200_000,
		droppedTags: 3,
		historian: "idle",
		historyTokens: 8_400,
		memoryCount: 6,
		noteCount: 3,
		pendingOps: 2,
		percent: 24,
		tokens: 48_000,
	});
});

test("shows the repair step when Context continuity is degraded", () => {
	const detail =
		"Pi native auto-compaction is disabled. Run /settings and enable auto-compaction so Pi can recover if Magic Context becomes unavailable.";
	const snapshot = statusSnapshotFromMagic(undefined, undefined, undefined, detail);
	expect(snapshot.continuity).toBe("degraded");
	expect(snapshot.continuityDetail).toBe(detail);

	const { context } = harness();
	const component = createContextDialogView(snapshot).create(context);
	const text = component.render(100).join("\n");
	expect(text).toContain("Continuity degraded");
	expect(text.replaceAll(/\s+/gu, " ")).toContain("Run /settings and enable auto-compaction");
	component.dispose?.();

	const { context: lowContext } = harness(8);
	const lowComponent = createContextDialogView(snapshot).create(lowContext);
	expect(lowComponent.render(100).join("\n")).toContain("Continuity degraded");
	lowComponent.dispose?.();

	const { context: nestedContext } = harness(8);
	const nestedComponent = createContextDialogView(snapshot).create(nestedContext);
	input(nestedComponent, "\r");
	const nestedText = nestedComponent.render(100).join("\n");
	expect(nestedText).toContain("Keep 20 recent messages");
	expect(nestedText).not.toContain("Continuity degraded");
	nestedComponent.dispose?.();
});

test("sanitizes and wraps multiline status errors into terminal-safe rows", () => {
	const snapshot = statusSnapshotFromMagic(
		{
			level: "error",
			text: "## Magic Status — Failed\n\nfirst\u001b[2J\nsecond",
			title: "/ctx-status",
		},
		undefined,
	);
	expect(snapshot.error).toBe("first\nsecond");
	const bounded = statusSnapshotFromMagic(undefined, undefined, `bad${"x".repeat(3_000)}`);
	expect(visibleWidth(bounded.error ?? "")).toBeLessThanOrEqual(2_000);
	const { context } = harness();
	const component = createContextDialogView(snapshot).create(context);
	const lines = component.render(42);
	expect(lines.join("\n")).toContain("first\n  second");
	expect(lines.every((line) => !line.includes("\n") && !line.includes("\u001b[2J"))).toBeTrue();
	expect(lines.every((line) => visibleWidth(line) <= 42)).toBeTrue();
	component.dispose?.();
});

test("lets a first-time user understand status and choose an action without knowing syntax", () => {
	const snapshot = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	const { context, getClosed } = harness();
	const component = createContextDialogView(snapshot).create(context);
	const lines = component.render(64);
	const text = lines.join("\n");
	const wideText = component.render(100).join("\n");

	expect(text).toContain("Context · 24.0% · 48K / 200K tokens");
	expect(text).toContain("4 compartments · 6 memories · 3 notes");
	expect(text).toContain("2 pending drops");
	expect(text).toContain("Wrap up history");
	expect(wideText).toContain("Choose recent messages to keep raw");
	expect(text).toContain("Flush pending drops");
	expect(wideText).toContain("2 queued · apply on next request");
	expect(text).toContain("Rebuild compartments");
	expect(wideText).toContain("Choose scope, then confirm");
	expect(text).toContain("Upgrade session");
	expect(wideText).toContain("Upgrade legacy history and memories");
	expect(text).not.toContain("◆");
	expect(text).toContain("↑/↓ select · Enter choose · Esc close");
	expect(lines.every((line) => visibleWidth(line) <= 64)).toBeTrue();

	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Keep 20 recent messages");
	expect(getClosed()).toBeUndefined();
	input(component, "\r");
	expect(getClosed()).toEqual({ args: "20", operation: "wrapup" });
	component.dispose?.();
});

test("shows only actions that can change the current Context state", () => {
	const base = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	for (const [pendingOps, upgradeNeeded, flushVisible, upgradeVisible] of [
		[0, 0, false, false],
		[1, 0, true, false],
		[0, 1, false, true],
		[0, undefined, false, true],
	] as const) {
		const snapshot = upgradeNeeded === undefined ? { ...base, pendingOps } : { ...base, pendingOps, upgradeNeeded };
		const { context } = harness();
		const component = createContextDialogView(snapshot).create(context);
		const text = component.render(64).join("\n");
		expect(text).toContain("Wrap up history");
		expect(text).toContain("Rebuild compartments");
		expect(text.includes("Flush pending drops")).toBe(flushVisible);
		expect(text.includes("Upgrade session")).toBe(upgradeVisible);
		if (upgradeNeeded === 1) {
			expect(component.render(100).join("\n")).toContain("Upgrade legacy history and memories");
		}
		component.dispose?.();
	}
});

test("keeps custom wrapup input inside the dialog and validates it", () => {
	const snapshot = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	const { context, getClosed } = harness();
	const component = createContextDialogView(snapshot).create(context);
	input(component, "\r");
	input(component, "\u001b[B");
	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Messages to keep");
	input(component, "nope");
	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Enter a positive whole number.");
	for (let index = 0; index < 4; index++) input(component, "\u007f");
	input(component, "40");
	input(component, "\r");
	expect(getClosed()).toEqual({ args: "40", operation: "wrapup" });
	component.dispose?.();
});

test("requires explicit rebuild confirmation and accepts a validated range", () => {
	const snapshot = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	const { context, getClosed } = harness();
	const component = createContextDialogView(snapshot).create(context);
	input(component, "\u001b[B");
	input(component, "\u001b[B");
	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Rebuild scope");
	input(component, "\u001b[B");
	input(component, "\r");
	input(component, "500-1");
	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Enter a valid range");
	for (let index = 0; index < 5; index++) input(component, "\u007f");
	input(component, "1-500");
	input(component, "\r");
	expect(component.render(64).join("\n")).toContain("Confirm rebuild");
	expect(getClosed()).toBeUndefined();
	input(component, "\u001b[B");
	input(component, "\r");
	expect(getClosed()).toEqual({ args: "1-500", confirmed: true, operation: "recomp" });
	component.dispose?.();
});

test("Escape returns through nested pages before closing the dialog", () => {
	const snapshot = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	const { context, getCloseCalls, getClosed } = harness();
	const component = createContextDialogView(snapshot).create(context);
	input(component, "\r");
	input(component, "\u001b[B");
	input(component, "\r");
	input(component, "\u001b");
	expect(component.render(64).join("\n")).toContain("Wrap up history");
	input(component, "\u001b");
	expect(component.render(64).join("\n")).toContain("Flush pending drops");
	expect(getClosed()).toBeUndefined();
	expect(getCloseCalls()).toBe(0);
	input(component, "\u001b");
	expect(getClosed()).toBeUndefined();
	expect(getCloseCalls()).toBe(1);
	component.dispose?.();
});

test("keeps status, the selected action, and Escape reachable at low terminal height", () => {
	const snapshot = statusSnapshotFromMagic(
		{ details: MAGIC_DETAILS, level: "info", text: MAGIC_STATUS, title: "/ctx-status" },
		{ contextWindow: 200_000, percent: 24, tokens: 48_000 },
	);
	const { context } = harness(6);
	const component = createContextDialogView(snapshot).create(context);
	const lines = component.render(42);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("Context");
	expect(lines.join("\n")).toContain("Wrap up history");
	expect(lines.at(-1)).toContain("Esc close");
	component.dispose?.();
});
