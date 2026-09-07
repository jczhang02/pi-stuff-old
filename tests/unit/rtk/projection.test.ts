import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ContextProjectionAdapter,
	createRtkProjectionAdapter,
} from "../../../packages/pi-stuff/src/rtk/projection.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolExchange(
	toolName: string,
	text: string,
	options: { command?: string; isError?: boolean; toolCallId?: string } = {},
): AgentMessage[] {
	const toolCallId = options.toolCallId ?? "call-1";
	return [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: toolName,
					arguments: toolName === "bash" ? { command: options.command ?? "git status --short --branch" } : {},
				},
			],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: options.isError ?? false,
			timestamp: 2,
		},
	];
}

function resultText(messages: AgentMessage[]): string {
	const result = messages.find((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") throw new Error("missing tool result");
	const text = result.content.find((part) => part.type === "text");
	if (text?.type !== "text") throw new Error("missing text result");
	return text.text;
}

describe("RTK context projection", () => {
	test("compacts model-visible Bash output without mutating the transcript messages", () => {
		const messages = toolExchange("bash", "## main...origin/main\n M src/alpha.ts\n M src/beta.ts\n?? notes.txt\n");
		const raw = JSON.stringify(messages);
		const originalResult = messages[1];
		const adapter = createRtkProjectionAdapter();

		const projected = adapter.project(messages);

		expect(projected).not.toBe(messages);
		expect(projected[1]).not.toBe(originalResult);
		expect(resultText(projected)).toContain("Branch: main");
		expect(resultText(projected)).toContain("Modified: 2 files");
		expect(JSON.stringify(messages)).toBe(raw);
		expect(JSON.stringify(projected)).not.toContain("pi-stuff-rtk/projected");
	});

	test("reconstructs Bash command context after a fresh process resumes the session", () => {
		const messages = toolExchange("bash", "## main\n M resumed.ts\n", {
			command: "rtk git status --short --branch",
		});
		const fresh = createRtkProjectionAdapter().project(messages);
		const resumed = createRtkProjectionAdapter().project(messages);

		expect(resultText(fresh)).toBe(resultText(resumed));
		expect(resultText(resumed)).toContain("Modified: 1 files");
	});

	test("keeps reads, source text, failed results, and unknown tools exact", () => {
		const source = 'export function exact(): string {\n\treturn "x";\n}\n'.repeat(500);
		for (const messages of [
			toolExchange("read", source),
			toolExchange("bash", source, { command: "cat source.ts", isError: true }),
			toolExchange("custom", source),
		]) {
			const projected = createRtkProjectionAdapter().project(messages);
			expect(projected).toBe(messages);
			expect(resultText(projected)).toBe(source);
		}
	});

	test("groups Grep output and enforces a bounded Bash result", () => {
		const grep = toolExchange("grep", "src/a.ts:10:first\nsrc/a.ts:20:second\nsrc/b.ts:3:third\n");
		const grouped = createRtkProjectionAdapter().project(grep);
		expect(resultText(grouped)).toContain("3 matches in 2 files");
		expect(resultText(grouped)).toContain("> src/a.ts (2 matches):");

		const long = toolExchange("bash", "x".repeat(20_000), { command: "printf x" });
		const bounded = createRtkProjectionAdapter({ maxChars: 1_000 }).project(long);
		expect(resultText(bounded).length).toBe(1_000);
		expect(resultText(bounded)).toEndWith("...");
	});

	test("is idempotent when a later Context owner composes the adapter", () => {
		const messages = toolExchange("grep", "src/a.ts:1:first\nsrc/a.ts:2:second\n");
		const contextPrefix: ContextProjectionAdapter = {
			id: "context-prefix",
			project: (input) => [...input],
		};
		const adapter = createRtkProjectionAdapter();
		const once = adapter.project(contextPrefix.project(messages));
		const twice = adapter.project(once);

		expect(twice).toBe(once);
		expect(resultText(twice)).toBe(resultText(once));
	});

	test("fails open and does not double-count repeated provider projections", () => {
		let enabled = true;
		const messages = toolExchange("bash", "\u001b[31mcolored\u001b[0m", { command: "printf colored" });
		const adapter = createRtkProjectionAdapter({ enabled: () => enabled });
		const first = adapter.project(messages);
		adapter.project(messages);
		const stats = adapter.stats();

		expect(resultText(first)).toBe("colored");
		expect(stats.resultCount).toBe(1);
		expect(stats.savedChars).toBeGreaterThan(0);
		enabled = false;
		expect(adapter.project(messages)).toBe(messages);
	});

	test("does not reread retained Tool output on later long-session projections", () => {
		const messages = Array.from({ length: 600 }, (_, index) =>
			toolExchange("bash", "placeholder", {
				command: "printf colored",
				toolCallId: `call-${String(index)}`,
			}),
		).flat();
		let textReads = 0;
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const part = message.content[0];
			if (part?.type !== "text") continue;
			Object.defineProperty(part, "text", {
				configurable: true,
				enumerable: true,
				get: () => {
					textReads += 1;
					return "\u001b[31mcolored\u001b[0m";
				},
			});
		}
		const adapter = createRtkProjectionAdapter();

		adapter.project(messages);
		expect(textReads).toBeGreaterThan(0);
		textReads = 0;
		adapter.project(messages);

		expect(textReads).toBe(0);
	});
});
