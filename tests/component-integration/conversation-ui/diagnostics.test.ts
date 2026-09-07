import { afterEach, describe, expect, test } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
	DiagnosticNoticeController,
	renderDiagnosticNotice,
} from "../../../packages/pi-stuff/src/conversation-ui/diagnostic-notice.js";
import {
	activateDiagnosticChannel,
	DiagnosticChannel,
	reportDiagnostic,
	resetDiagnosticProcessState,
} from "../../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import { createDiagnosticsView } from "../../../packages/pi-stuff/src/conversation-ui/diagnostics-dialog.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import { createExtensionUi, testTheme } from "../../fixtures/extension-context.js";
import { TestTui } from "../../fixtures/test-tui.js";

const theme = testTheme;

afterEach(() => resetDiagnosticProcessState());

function report(channel: DiagnosticChannel, index = 1, visibility: "notice" | "silent" = "notice") {
	return channel.report({
		capability: "Background Work",
		details: [`detail ${String(index)}`],
		key: `issue-${String(index)}`,
		severity: index % 2 === 0 ? "error" : "warning",
		summary: `Issue ${String(index)}`,
		timestamp: 1_000 + index,
		visibility,
	});
}

function dialogHarness(rows = 24, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
	let closes = 0;
	let renders = 0;
	const tui = new TestTui(rows);
	return {
		closed: () => closes,
		context: {
			close: () => {
				closes += 1;
			},
			keybindings,
			requestRender: () => {
				renders += 1;
			},
			signal: new AbortController().signal,
			theme,
			tui,
		} satisfies CommandDialogViewContext<void>,
		renders: () => renders,
	};
}

describe("DiagnosticChannel", () => {
	test("keeps silent housekeeping in bounded history without raising a notice", () => {
		const channel = new DiagnosticChannel();
		report(channel, 1, "silent");
		expect(channel.list()).toHaveLength(1);
		expect(channel.listNotices()).toHaveLength(0);
	});

	test("deduplicates repeated failures while retaining the latest detail", () => {
		const channel = new DiagnosticChannel();
		channel.report({
			capability: "Agents",
			details: "first",
			key: "watcher",
			severity: "error",
			summary: "Result watcher recovered",
			timestamp: 100,
			visibility: "notice",
		});
		channel.report({
			capability: "Agents",
			details: "second",
			key: "watcher",
			severity: "error",
			summary: "Result watcher recovered",
			timestamp: 200,
			visibility: "notice",
		});
		const record = channel.list()[0];
		expect(record?.count).toBe(2);
		expect(record?.firstOccurredAt).toBe(100);
		expect(record?.lastOccurredAt).toBe(200);
		expect(record?.details).toEqual(["second"]);
		expect(channel.listNotices()).toHaveLength(1);
	});

	test("removes terminal controls and redacts common credentials from details", () => {
		const channel = new DiagnosticChannel();
		channel.report({
			capability: "MCP\u001b[31m",
			error: new Error("Bearer secret-token and https://example.test/callback?code=private-code"),
			summary: "OAuth\nfailed",
		});
		const record = channel.list()[0];
		expect(record?.capability).toBe("MCP");
		expect(record?.summary).toBe("OAuth failed");
		expect(record?.details.join("\n")).not.toContain("secret-token");
		expect(record?.details.join("\n")).not.toContain("private-code");
		expect(record?.details.join("\n")).toContain("[redacted]");
	});

	test("redacts JSON and environment-shaped credentials", () => {
		const channel = new DiagnosticChannel();
		channel.report({
			capability: "MCP",
			details: ['{"apiKey":"private-json-value"}', "OPENAI_API_KEY=private-env-value"],
			summary: "Credential diagnostic",
		});
		const details = channel.list()[0]?.details.join("\n") ?? "";
		expect(details).not.toContain("private-json-value");
		expect(details).not.toContain("private-env-value");
		expect(details.match(/\[redacted\]/gu)).toHaveLength(2);
	});

	test("bridges deep Capability reports into the active Host channel", () => {
		const channel = new DiagnosticChannel();
		activateDiagnosticChannel(channel);
		reportDiagnostic({ capability: "Todo", summary: "Refresh failed" });
		expect(channel.list()[0]?.capability).toBe("Todo");
	});

	test("acknowledges the notice row without deleting diagnostic history", () => {
		const channel = new DiagnosticChannel();
		report(channel);
		channel.acknowledgeNotices();
		expect(channel.listNotices()).toHaveLength(0);
		expect(channel.list()).toHaveLength(1);
	});

	test("retains only the newest one hundred records", () => {
		const channel = new DiagnosticChannel();
		for (let index = 1; index <= 105; index += 1) report(channel, index, "silent");
		expect(channel.list()).toHaveLength(100);
		expect(channel.list()[0]?.summary).toBe("Issue 105");
		expect(channel.list().at(-1)?.summary).toBe("Issue 6");
	});
});

describe("diagnostic notice row", () => {
	test("renders one semantic row and preserves /diagnostics at every supported width", () => {
		const channel = new DiagnosticChannel();
		channel.report({
			capability: "MCP",
			severity: "warning",
			summary: "GitHub 连接已失效，相关工具暂不可用",
			visibility: "notice",
		});
		for (const width of [100, 64, 32, 24]) {
			const lines = renderDiagnosticNotice(theme, width, channel.listNotices());
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
			expect(lines[0]).toContain("/diagnostics");
		}
	});

	test("coalesces a burst instead of stacking rows", () => {
		const channel = new DiagnosticChannel();
		for (let index = 1; index <= 5; index += 1) report(channel, index);
		const lines = renderDiagnosticNotice(theme, 80, channel.listNotices());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("5 issues need attention");
	});

	test("registers only actionable notices above the editor and restores after suppression", () => {
		const channel = new DiagnosticChannel();
		const calls: unknown[][] = [];
		const ui = createExtensionUi({
			setWidget: (...args: unknown[]) => calls.push(args),
			theme,
		});
		const controller = new DiagnosticNoticeController(ui, channel);
		report(channel, 1, "silent");
		expect(calls).toHaveLength(0);

		report(channel, 2, "notice");
		expect(calls[0]?.[0]).toBe("pi-stuff-diagnostic-notice");
		expect(calls[0]?.[2]).toEqual({ placement: "aboveEditor" });
		controller.setSuppressed(true);
		expect(calls.at(-1)).toEqual(["pi-stuff-diagnostic-notice", undefined]);
		controller.setSuppressed(false);
		expect(calls.at(-1)?.[0]).toBe("pi-stuff-diagnostic-notice");
		controller.dispose();
		expect(calls.at(-1)).toEqual(["pi-stuff-diagnostic-notice", undefined]);
	});
});

describe("/diagnostics Command Dialog", () => {
	test("renders empty, list, detail, clear, and exact escape behavior", () => {
		const channel = new DiagnosticChannel();
		const ui = dialogHarness();
		const component = createDiagnosticsView(channel).create(ui.context);
		expect(component.render(80).join("\n")).toContain("No Pi Stuff diagnostics yet.");

		report(channel, 1);
		report(channel, 2);
		const list = component.render(80).join("\n");
		expect(list).toContain("Diagnostics · 2 records");
		expect(list).toContain("Enter details");
		component.handleInput?.("?");
		expect(component.render(80).join("\n")).toContain("Diagnostics / Keys");
		component.handleInput?.("\u001b");
		component.handleInput?.("\r");
		expect(component.render(80).join("\n")).toContain("Diagnostics / Background Work");
		expect(component.render(80).join("\n")).toContain("detail 1");
		component.handleInput?.("\u001b");
		component.handleInput?.("c");
		expect(channel.list()).toHaveLength(0);
		expect(component.render(80).join("\n")).toContain("No Pi Stuff diagnostics yet.");
		component.handleInput?.("\u001b");
		expect(ui.closed()).toBe(1);
		expect(ui.renders()).toBeGreaterThan(0);
		component.dispose?.();
	});

	test("distinguishes records from repeated occurrences", () => {
		const channel = new DiagnosticChannel();
		report(channel, 1);
		report(channel, 1);
		const component = createDiagnosticsView(channel).create(dialogHarness().context);
		const output = component.render(80).join("\n");
		expect(output).toContain("Diagnostics · 1 record");
		expect(output).toContain("2 occurrences");
		component.dispose?.();
	});

	test("keeps list and detail as sequential single-column views at wide widths", () => {
		const channel = new DiagnosticChannel();
		report(channel, 1);
		report(channel, 2);
		const ui = dialogHarness(32);
		const component = createDiagnosticsView(channel).create(ui.context);
		const lines = component.render(100);
		let output = lines.join("\n");
		expect(lines[0]).toBe("━".repeat(100));
		expect(output).toContain("Diagnostics · 2 records");
		expect(output).not.toContain("┃");
		expect(output).not.toContain("Diagnostics / Background Work");
		expect(output).toContain("Issue 2");

		component.handleInput?.("\u001b[B");
		component.handleInput?.("\r");
		output = component.render(100).join("\n");
		expect(output).toContain("Diagnostics / Background Work");
		expect(output).toContain("Issue 1");
		expect(output).toContain("Details");
		expect(output).not.toContain("◆");
		expect(output).not.toContain("Diagnostics · 2 records");
		component.handleInput?.("\u001b");
		expect(component.render(100).join("\n")).toContain("Diagnostics · 2 records");
		expect(ui.closed()).toBe(0);
		component.handleInput?.("\u001b");
		expect(ui.closed()).toBe(1);
		component.dispose?.();
	});

	test("uses Space as the compact-keyboard page alias", () => {
		const channel = new DiagnosticChannel();
		for (let index = 1; index <= 12; index += 1) report(channel, index);
		const component = createDiagnosticsView(channel).create(dialogHarness().context);
		const overflow = component.render(80).join("\n");
		expect(overflow).toContain("Issue 12");
		expect(overflow).toContain("b/Space page");
		expect(overflow).not.toContain("PgUp/PgDn page");
		component.handleInput?.(" ");
		expect(component.render(80).join("\n")).toContain("Issue 4");
		component.dispose?.();
	});

	test("keeps selection, details, and escape route within narrow and short terminals", () => {
		const channel = new DiagnosticChannel();
		channel.report({
			capability: "Agents",
			details: ["这是一个很长的中文诊断详情，用于验证换行和窄屏下的完整返回路径。", "second line"],
			severity: "error",
			summary: "代理结果观察器在读取非常长的工作目录时失败",
			visibility: "notice",
		});
		const ui = dialogHarness(8);
		const component = createDiagnosticsView(channel).create(ui.context);
		for (const width of [64, 32, 24]) {
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.at(-1)).toContain("Esc close");
		}
		component.handleInput?.("\r");
		const detail = component.render(32);
		expect(detail.every((line) => visibleWidth(line) <= 32)).toBe(true);
		expect(detail.at(-1)).toContain("Esc back");
		component.dispose?.();
	});
});
