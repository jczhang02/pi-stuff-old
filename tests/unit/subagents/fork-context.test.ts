import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonInputObject, parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { createForkContextResolver } from "../../../packages/pi-stuff/src/subagents/src/shared/fork-context.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

test("fork context preserves session data while removing unsafe Anthropic thinking", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-fork-context-"));
	temporaryDirectories.push(directory);
	const parentFile = join(directory, "parent.jsonl");
	const forkFile = join(directory, "fork.jsonl");
	writeFileSync(parentFile, "parent\n");
	writeFileSync(
		forkFile,
		`${[
			{ type: "session", id: "root", extra: { preserved: true } },
			{
				type: "message",
				id: "assistant",
				parentId: "root",
				message: {
					role: "assistant",
					provider: "anthropic",
					content: [
						{ type: "text", text: "visible" },
						{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
					],
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);

	const resolver = createForkContextResolver(
		{
			getLeafId: () => "assistant",
			getSessionFile: () => parentFile,
		},
		"fork",
		{ openSession: () => ({ createBranchedSession: () => forkFile }) },
	);

	expect(resolver.sessionFileForIndex(0)).toBe(forkFile);
	expect(resolver.thinkingOverrideForIndex(0)).toBe("off");
	const entries = readFileSync(forkFile, "utf8").trim().split("\n").map(parseJsonValue);
	const header = entries[0];
	const messageEntry = entries[1];
	const thinkingEntry = entries[2];
	if (!isJsonInputObject(header) || !isJsonInputObject(messageEntry) || !isJsonInputObject(thinkingEntry)) {
		throw new Error("forked session entries were not objects");
	}
	const message = messageEntry["message"];
	if (!isJsonInputObject(message)) throw new Error("forked Assistant message was missing");
	expect(header["extra"]).toEqual({ preserved: true });
	expect(message["content"]).toEqual([{ type: "text", text: "visible" }]);
	expect(thinkingEntry["type"]).toBe("thinking_level_change");
	expect(thinkingEntry["thinkingLevel"]).toBe("off");
});
