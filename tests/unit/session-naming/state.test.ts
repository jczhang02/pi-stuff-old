import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { NamingMessage } from "../../../packages/pi-stuff/src/session-naming/prompt.js";
import {
	getLastRenameMarker,
	getSessionNameTimestamp,
	LEGACY_AUTONAME_STATE_ENTRY_TYPE,
	namingMessages,
	SESSION_NAMING_STATE_ENTRY_TYPE,
} from "../../../packages/pi-stuff/src/session-naming/state.js";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let entrySequence = 0;

function entryBase() {
	entrySequence += 1;
	return { id: `entry-${String(entrySequence)}`, parentId: null, timestamp: "2026-08-24T00:00:00.000Z" };
}

function message(role: "assistant" | "user", content: string): SessionEntry {
	const base = entryBase();
	if (role === "user") {
		return { ...base, type: "message", message: { role, content, timestamp: entrySequence } };
	}
	const assistant: AssistantMessage = {
		role,
		content: [{ type: "text", text: content }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: entrySequence,
	};
	return { ...base, type: "message", message: assistant };
}

function custom(customType: string, data: JsonInputObject): CustomEntry<JsonInputObject> {
	return { ...entryBase(), type: "custom", customType, data };
}

function text(message: NamingMessage): string {
	if (isRuntimeString(message.content)) return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("Session Naming state projection", () => {
	test("restores the newest branch-local marker and accepts the upstream marker", () => {
		expect(
			getLastRenameMarker([
				custom(SESSION_NAMING_STATE_ENTRY_TYPE, {
					mode: "initial",
					source: "ai",
					timestamp: 10,
					name: "Initial name",
				}),
				custom(LEGACY_AUTONAME_STATE_ENTRY_TYPE, {
					event: "user_rename",
					timestamp: 20,
					name: "Upstream manual name",
				}),
			]),
		).toEqual({ source: "user", timestamp: 20, name: "Upstream manual name" });
	});

	test("accepts an upstream AI marker with its legacy timestamp fallback", () => {
		expect(
			getLastRenameMarker([custom(LEGACY_AUTONAME_STATE_ENTRY_TYPE, { source: "ai", name: "Upstream AI name" })]),
		).toEqual({ source: "ai", timestamp: 0, name: "Upstream AI name" });
	});

	test("reads the latest matching native Session name timestamp", () => {
		const older = { ...entryBase(), type: "session_info" as const, name: "Manual name" };
		const newer = {
			...entryBase(),
			type: "session_info" as const,
			name: "Manual name",
			timestamp: "2026-08-24T12:34:56.000Z",
		};
		expect(getSessionNameTimestamp([older, newer], "Manual name")).toBe(1_787_574_896_000);
		expect(getSessionNameTimestamp([older, newer], "Other name")).toBeUndefined();
	});

	test("initial naming uses the first user-to-Assistant exchange", () => {
		expect(
			namingMessages(
				[custom("ignored", {}), message("user", "first request"), message("assistant", "first answer")],
				true,
			),
		).toEqual([
			{ role: "user", content: "first request" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
		]);
	});

	test("initial naming waits for an Assistant result", () => {
		expect(namingMessages([message("user", "cancelled request")], true)).toEqual([]);
	});

	test("initial naming of an older unmarked Session uses recent dialogue", () => {
		const entries = Array.from({ length: 8 }, (_, index) =>
			message(index % 2 === 0 ? "user" : "assistant", `message-${String(index)}`),
		);
		expect(namingMessages(entries, true).map(text)).toEqual([
			"message-2",
			"message-3",
			"message-4",
			"message-5",
			"message-6",
			"message-7",
		]);
	});

	test("periodic naming keeps only the six newest user and Assistant messages", () => {
		const entries = Array.from({ length: 8 }, (_, index) =>
			message(index % 2 === 0 ? "user" : "assistant", `message-${String(index)}`),
		);
		expect(namingMessages(entries, false).map(text)).toEqual([
			"message-2",
			"message-3",
			"message-4",
			"message-5",
			"message-6",
			"message-7",
		]);
	});
});
