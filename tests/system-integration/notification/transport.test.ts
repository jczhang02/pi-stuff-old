import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendTerminalNotification } from "../../../packages/pi-stuff/src/notification/transport.ts";

const BASE_NOTIFICATION = {
	body: "repo 10s",
	delivery: "osc9",
	hasUI: true,
	mode: "tui",
	terminalBell: false,
	title: "Done",
	tmuxNotification: true,
} as const;

function notify(
	overrides: Partial<Parameters<typeof sendTerminalNotification>[0]> = {},
	environment: Record<string, string | undefined> = {},
) {
	const writes: string[] = [];
	const result = sendTerminalNotification(
		{ ...BASE_NOTIFICATION, ...overrides },
		{ environment, write: (bytes) => writes.push(bytes) },
	);
	return { result, writes };
}

for (const scenario of [
	{
		name: "RPC stays valid JSON even when Pi reports that UI requests are available",
		overrides: { body: "pi-stuff · 10s", mode: "rpc", title: "Pi Stuff complete" },
		environment: {},
		result: "not-interactive",
		writes: [],
	},
	{
		name: "Kitty receives one bounded Base64-encoded notification write",
		overrides: { delivery: "kitty" },
		environment: {},
		result: "sent",
		writes: ["\x1b]99;i=pi-stuff:d=0:e=1;RG9uZQ==\x1b\\\x1b]99;i=pi-stuff:p=body:e=1;cmVwbyAxMHM=\x1b\\"],
	},
	{
		name: "terminal controls and newlines cannot survive inside a Kitty payload",
		overrides: { body: "\x1b\\\x07repo\nready", delivery: "kitty", title: "\x1b]9;bad\x07\nDone" },
		environment: {},
		result: "sent",
		writes: ["\x1b]99;i=pi-stuff:d=0:e=1;RG9uZQ==\x1b\\\x1b]99;i=pi-stuff:p=body:e=1;cmVwbyByZWFkeQ==\x1b\\"],
	},
	{
		name: "OSC 9 and an optional terminal bell are emitted together exactly once",
		overrides: { terminalBell: true },
		environment: {},
		result: "sent",
		writes: ["\x1b]9;Done: repo 10s\x1b\\\x07"],
	},
	{
		name: "tmux receives a passthrough-wrapped OSC notification and one attention bell",
		overrides: {},
		environment: { TMUX: "/tmp/tmux-1000/default,1,0" },
		result: "sent",
		writes: ["\x1bPtmux;\x1b\x1b]9;Done: repo 10s\x1b\x1b\\\x1b\\\x07"],
	},
	{
		name: "tmux auto delivery preserves the system notification and adds one attention bell",
		overrides: { delivery: "auto" },
		environment: { GHOSTTY_RESOURCES_DIR: "/fixture/ghostty", TMUX: "/tmp/tmux-1000/default,1,0" },
		result: "sent",
		writes: ["\x1bPtmux;\x1b\x1b]777;notify;Done;repo 10s\x1b\x1b\\\x1b\\\x07"],
	},
	{
		name: "tmux notification off preserves visual delivery without an attention bell",
		overrides: { delivery: "osc777", terminalBell: true, tmuxNotification: false },
		environment: { TMUX: "/tmp/tmux-1000/default,1,0" },
		result: "sent",
		writes: ["\x1bPtmux;\x1b\x1b]777;notify;Done;repo 10s\x1b\x1b\\\x1b\\"],
	},
	{
		name: "tmux auto delivery falls back to an attention bell when the visual protocol is unknown",
		overrides: { delivery: "auto" },
		environment: { TERM: "tmux-256color", TMUX: "/tmp/tmux-1000/default,1,0" },
		result: "sent",
		writes: ["\x07"],
	},
	{
		name: "tmux notification off suppresses explicit bell delivery",
		overrides: { delivery: "bell", terminalBell: true, tmuxNotification: false },
		environment: { TMUX: "/tmp/tmux-1000/default,1,0" },
		result: "unsupported",
		writes: [],
	},
] as const) {
	test(scenario.name, () =>
		expect(notify(scenario.overrides, scenario.environment)).toEqual({
			result: scenario.result,
			writes: [...scenario.writes],
		}),
	);
}

test("explicit visual delivery marks an unattended tmux window", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-notification-tmux-"));
	const socket = join(directory, "tmux.sock");
	const tmux = (...args: string[]): string => {
		const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { stderr: "pipe", stdout: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "repro", "-n", "target", "sleep 5");
		tmux("set-option", "-g", "bell-action", "any");
		tmux("set-window-option", "-g", "monitor-bell", "on");
		tmux("new-window", "-t", "repro", "-n", "current", "sleep 5");
		const paneTty = tmux("display-message", "-p", "-t", "repro:target", "#{pane_tty}");

		expect(
			sendTerminalNotification(
				{
					body: "repo 10s",
					delivery: "osc777",
					hasUI: true,
					mode: "tui",
					terminalBell: false,
					title: "Done",
					tmuxNotification: true,
				},
				{
					environment: { TMUX: `${socket},1,0` },
					write: (bytes) => writeFileSync(paneTty, bytes),
				},
			),
		).toBe("sent");
		await Bun.sleep(50);
		expect(tmux("display-message", "-p", "-t", "repro:target", "#{window_bell_flag}")).toBe("1");
	} finally {
		Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
		rmSync(directory, { force: true, recursive: true });
	}
});

test("OSC 777 delimiters in labels cannot create extra protocol fields", () => {
	expect(notify({ body: "repo;body", delivery: "osc777", title: "Done;evil" })).toEqual({
		result: "sent",
		writes: ["\x1b]777;notify;Done evil;repo body\x1b\\"],
	});
});

test("bell delivery never duplicates BEL when terminal bell is also enabled", () => {
	expect(notify({ delivery: "bell", terminalBell: true })).toEqual({ result: "sent", writes: ["\x07"] });
});

test("auto selects Kitty only when the terminal environment is recognized", () => {
	const { result, writes } = notify({ delivery: "auto" }, { KITTY_WINDOW_ID: "42" });

	expect(result).toBe("sent");
	expect(writes[0]).toStartWith("\x1b]99;");
});

test("empty labels still produce a valid bounded notification", () => {
	expect(notify({ body: "\n\x07", title: "" })).toEqual({
		result: "sent",
		writes: ["\x1b]9;Pi Stuff\x1b\\"],
	});
});

test("auto selects OSC 777 for Ghostty and OSC 9 for the remaining recognized terminals", () => {
	expect(
		notify(
			{ body: "The task is ready.", delivery: "auto", title: "Pi · ps-9e7 — Ready" },
			{ GHOSTTY_RESOURCES_DIR: "/fixture/ghostty", TERM_PROGRAM: "tmux" },
		),
	).toEqual({ result: "sent", writes: ["\x1b]777;notify;Pi · ps-9e7 — Ready;The task is ready.\x1b\\"] });

	for (const program of ["iTerm.app", "WezTerm"]) {
		expect(notify({ delivery: "auto" }, { TERM_PROGRAM: program })).toEqual({
			result: "sent",
			writes: ["\x1b]9;Done: repo 10s\x1b\\"],
		});
	}
	expect(notify({ delivery: "auto" }, { TERM: "xterm-256color" })).toEqual({ result: "unsupported", writes: [] });
});

test("headless TUI, print, and JSON modes never write", () => {
	for (const [mode, hasUI] of [
		["tui", false],
		["print", false],
		["json", false],
	] as const) {
		expect(notify({ body: "repo", delivery: "bell", hasUI, mode })).toEqual({
			result: "not-interactive",
			writes: [],
		});
	}
});

test("long Unicode fields stay bounded and a write failure is non-fatal", () => {
	const { result, writes } = notify({
		body: "体".repeat(300),
		delivery: "kitty",
		title: `完${"成".repeat(100)}\u009c`,
	});
	expect(result).toBe("sent");
	const payloads = (writes[0] ?? "")
		.split("\x1b\\")
		.filter(Boolean)
		.map((frame) => Buffer.from(frame.slice(frame.lastIndexOf(";") + 1), "base64").toString("utf8"));
	expect(payloads.map((payload) => [...payload].length)).toEqual([32, 80]);

	expect(
		sendTerminalNotification(
			{
				body: "repo",
				delivery: "bell",
				hasUI: true,
				mode: "tui",
				terminalBell: false,
				title: "Done",
				tmuxNotification: true,
			},
			{
				write: () => {
					throw new Error("closed");
				},
			},
		),
	).toBe("failed");
});
