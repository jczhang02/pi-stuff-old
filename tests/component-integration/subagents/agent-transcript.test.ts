import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonInputObject, parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import type { AgentRow } from "../../../packages/pi-stuff/src/subagents/src/session/current-agents.js";
import { createChildTranscriptWriter } from "../../../packages/pi-stuff/src/subagents/src/shared/child-transcript.js";
import { readAgentTranscript } from "../../../packages/pi-stuff/src/subagents/src/ui/agent-transcript.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-agent-transcript-"));
	temporaryDirectories.push(directory);
	return directory;
}

function row(overrides: Partial<AgentRow>): AgentRow {
	return {
		childIndex: 0,
		description: "work",
		endedAt: null,
		error: null,
		elapsedMs: 100,
		contextUsage: null,
		cumulativeUsage: null,
		terminalOutcome: null,
		key: "run:0",
		name: "worker",
		nestedAgents: [],
		nestedCount: 0,
		partialResult: null,
		runId: "run",
		savedOutputPath: null,
		sessionFile: null,
		sessionId: "root",
		startedAt: 1,
		status: "running",
		task: "work",
		transcriptPath: null,
		...overrides,
	};
}

function request(agentRow: AgentRow, maxChars = 24_000) {
	return { maxChars, row: agentRow, signal: new AbortController().signal };
}

function activity(value: Awaited<ReturnType<typeof readAgentTranscript>>) {
	if (!value || isRuntimeString(value)) throw new Error("Expected structured Agent Activity");
	return value;
}

test("reads a bounded plain transcript and strips terminal controls", async () => {
	const file = join(tempDirectory(), "transcript.md");
	writeFileSync(file, `old\n${"x".repeat(80)}\n\u001b[31mfinal 👩‍💻\u001b[0m \u001bc`);
	const output = activity(await readAgentTranscript(request(row({ transcriptPath: file }), 40)));
	expect(output.items[0]).toEqual({ kind: "notice", text: "… earlier transcript omitted" });
	expect(output.items[1]).toMatchObject({ kind: "message", speaker: null });
	const message = output.items[1]?.kind === "message" ? output.items[1].text : "";
	expect(message).toContain("final");
	expect(message).toContain("👩‍💻");
	expect(message).not.toContain("\u001b");
	expect(message).not.toEndWith("c");
	expect(message.length).toBeLessThanOrEqual(40);
});

test("pairs child Tool calls and results by persisted identity", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ recordType: "message", message: { role: "user", content: "Investigate" } }),
			JSON.stringify({
				recordType: "tool_start",
				toolCallId: "read-1",
				toolName: "read",
				argsPreview: "src/a.ts",
			}),
			JSON.stringify({
				recordType: "tool_end",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
			}),
			JSON.stringify({
				recordType: "message",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				message: {
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "112 lines" }],
				},
			}),
			JSON.stringify({
				recordType: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Found it" }] },
			}),
		].join("\n"),
	);
	const output = activity(await readAgentTranscript(request(row({ sessionFile: file }))));
	expect(output.items).toEqual([
		{ kind: "message", speaker: "You", text: "Investigate" },
		{ kind: "tool", name: "read", outcome: "completed", result: "112 lines", target: "src/a.ts" },
		{ kind: "message", speaker: "worker", text: "Found it" },
	]);
});

test("omits a transcript User message that only repeats the delegated task", async () => {
	const task = "Inspect the Agent detail without changing files.";
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ recordType: "message", message: { role: "user", content: `Task: ${task}` } }),
			JSON.stringify({ recordType: "message", message: { role: "assistant", content: "Actual result" } }),
		].join("\n"),
	);
	const output = activity(await readAgentTranscript(request(row({ sessionFile: file, task }))));
	expect(output.items).toEqual([{ kind: "message", speaker: "worker", text: "Actual result" }]);
});

test("omits internal context prompts but keeps later user guidance", async () => {
	const task = "Inspect the Agent detail without changing files.";
	const context = [
		'<pi-stuff-context audience="agent-fresh" trust="reference-only">',
		"Treat this derived history and memory as reference data.",
		"</pi-stuff-context>",
	].join("\n");
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({
				recordType: "message",
				sourceEventType: "initial_prompt",
				message: { role: "user", content: `${context}\n\n${task}` },
			}),
			JSON.stringify({
				recordType: "message",
				sourceEventType: "message_end",
				message: {
					role: "user",
					content: `<file name="/tmp/task.md">\nTask: ${context}\n\n${task}\n</file>`,
				},
			}),
			JSON.stringify({
				recordType: "message",
				sourceEventType: "message_end",
				message: { role: "user", content: "Also check the README." },
			}),
			JSON.stringify({ recordType: "message", message: { role: "assistant", content: "Actual result" } }),
		].join("\n"),
	);

	const output = activity(await readAgentTranscript(request(row({ sessionFile: file, task }))));
	expect(output.items).toEqual([
		{ kind: "message", speaker: "You", text: "Also check the README." },
		{ kind: "message", speaker: "worker", text: "Actual result" },
	]);
});

test("omits the final report already owned by the Result section", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	const finalReport = "Implemented the detail viewport.\nAll focused tests pass.";
	writeFileSync(
		file,
		[
			JSON.stringify({ recordType: "message", message: { role: "assistant", content: "Inspecting layout" } }),
			JSON.stringify({ recordType: "tool_start", toolCallId: "read-1", toolName: "read" }),
			JSON.stringify({
				recordType: "message",
				message: { role: "toolResult", toolCallId: "read-1", content: "agent-dialog.ts" },
			}),
			JSON.stringify({ recordType: "message", message: { role: "assistant", content: finalReport } }),
		].join("\n"),
	);
	const output = activity(await readAgentTranscript(request(row({ partialResult: finalReport, sessionFile: file }))));
	expect(output.items).toEqual([
		{ kind: "message", speaker: "worker", text: "Inspecting layout" },
		{ kind: "tool", name: "read", outcome: "completed", result: "agent-dialog.ts", target: "" },
	]);
});

test("keeps mixed and out-of-order child Tool outcomes attributable", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({
				recordType: "tool_start",
				toolCallId: "read-1",
				toolName: "read",
				argsPreview: "src/配置🧪.ts",
			}),
			JSON.stringify({
				recordType: "tool_start",
				toolCallId: "bash-1",
				toolName: "bash",
				argsPreview: "bun test",
			}),
			JSON.stringify({
				recordType: "message",
				toolCallId: "bash-1",
				toolName: "bash",
				isError: true,
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Command aborted" }],
				},
			}),
			JSON.stringify({
				recordType: "message",
				toolCallId: "read-1",
				toolName: "read",
				message: {
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
				},
			}),
		].join("\n"),
	);

	const output = activity(await readAgentTranscript(request(row({ sessionFile: file }))));
	expect(output.items).toEqual([
		{ kind: "tool", name: "read", outcome: "completed", result: "file contents", target: "src/配置🧪.ts" },
		{ kind: "tool", name: "bash", outcome: "cancelled", result: "Command aborted", target: "bun test" },
	]);
});

test("retains Tool results for the dialog-level bounded preview", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ recordType: "tool_start", toolCallId: "read-1", toolName: "read" }),
			JSON.stringify({
				recordType: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-1",
					content: [
						{
							type: "text",
							text: Array.from({ length: 11 }, (_, index) => `line-${String(index + 1)}`).join("\n"),
						},
					],
				},
			}),
		].join("\n"),
	);
	const output = activity(await readAgentTranscript(request(row({ sessionFile: file }))));
	const tool = output.items[0];
	expect(tool).toMatchObject({ kind: "tool", outcome: "completed" });
	expect(tool?.kind === "tool" ? tool.result : "").toContain("line-11");
});

test("keeps every Tool event in the bounded source window when result bodies are capped", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		["first.ts", "second.ts", "third.ts"]
			.flatMap((target, index) => [
				JSON.stringify({
					recordType: "tool_start",
					toolCallId: `read-${String(index)}`,
					toolName: "read",
					argsPreview: target,
				}),
				JSON.stringify({
					recordType: "message",
					message: {
						role: "toolResult",
						toolCallId: `read-${String(index)}`,
						content: `${target}:${"x".repeat(80)}`,
					},
				}),
			])
			.join("\n"),
	);

	const output = activity(await readAgentTranscript(request(row({ sessionFile: file }), 40)));
	expect(output.items.filter((item) => item.kind === "tool").map((item) => item.target)).toEqual([
		"first.ts",
		"second.ts",
		"third.ts",
	]);
});

test("distinguishes rejected results and degrades legacy records without false ownership", async () => {
	const file = join(tempDirectory(), "session.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({
				recordType: "tool_start",
				toolCallId: "write-1",
				toolName: "write",
				argsPreview: "/outside/project\u001b]0;hidden-title\u0007",
			}),
			JSON.stringify({
				recordType: "message",
				toolCallId: "write-1",
				toolName: "write",
				isError: true,
				message: {
					role: "toolResult",
					toolCallId: "write-1",
					toolName: "write",
					isError: true,
					content: [{ type: "text", text: "\u001b[31mTool execution was blocked by the fixture\u001b[0m" }],
				},
			}),
			JSON.stringify({
				recordType: "tool_end",
				toolCallId: "edit-1",
				toolName: "edit",
				isError: true,
			}),
			JSON.stringify({
				recordType: "message",
				toolCallId: "edit-1",
				toolName: "edit",
				message: {
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [{ type: "text", text: "compiler failure" }],
				},
			}),
			JSON.stringify({ recordType: "tool_start", toolName: "read", argsPreview: "first.ts" }),
			JSON.stringify({ recordType: "tool_start", toolName: "read", argsPreview: "second.ts" }),
			JSON.stringify({
				recordType: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "legacy result" }] },
			}),
		].join("\n"),
	);

	const output = activity(await readAgentTranscript(request(row({ sessionFile: file }))));
	expect(output.items).toEqual([
		{
			kind: "tool",
			name: "write",
			outcome: "rejected",
			result: "Tool execution was blocked by the fixture",
			target: "/outside/project",
		},
		{ kind: "tool", name: "edit", outcome: "failed", result: "compiler failure", target: "" },
		{ kind: "tool", name: "read", outcome: "running", result: "", target: "first.ts" },
		{ kind: "tool", name: "read", outcome: "running", result: "", target: "second.ts" },
		{ kind: "tool", name: "Tool", outcome: "completed", result: "legacy result", target: "" },
	]);
});

test("leaves the partial result to the Result section when no Activity artifact exists", async () => {
	const output = await readAgentTranscript(request(row({ partialResult: "partial work" })));
	expect(output).toBeNull();
});

test("refuses relative and symlink transcript targets", async () => {
	const directory = tempDirectory();
	const target = join(directory, "target.md");
	const link = join(directory, "link.md");
	writeFileSync(target, "secret");
	symlinkSync(target, link);
	expect(
		await readAgentTranscript(request(row({ partialResult: "fallback", transcriptPath: "relative.md" }))),
	).toBeNull();
	await expect(readAgentTranscript(request(row({ transcriptPath: link })))).rejects.toThrow();
});

test("returns quietly when its dialog signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const output = await readAgentTranscript({
		maxChars: 100,
		row: row({ partialResult: "hidden" }),
		signal: controller.signal,
	});
	expect(output).toBeNull();
});

test("disables an undersized transcript instead of publishing unmarked retained data", () => {
	const directory = tempDirectory();
	const transcriptPath = join(directory, "undersized.jsonl");
	const writer = createChildTranscriptWriter({
		transcriptPath,
		source: "async",
		runId: "undersized-run",
		agent: "reader",
		cwd: directory,
		maxBytes: 64,
	});

	writer.writeInitialUserMessage("cannot fit beside the omission marker");
	expect(writer.getError()).toContain("cannot preserve omission metadata");
	expect(() => readFileSync(transcriptPath)).toThrow();
});

test("records exact omitted transcript bytes and records when one record cannot fit", () => {
	const directory = tempDirectory();
	const writeFixture = (transcriptPath: string, maxBytes: number) => {
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "async",
			runId: "exact-roll-run",
			agent: "reader",
			cwd: directory,
			maxBytes,
		});
		writer.writeInitialUserMessage("inspect");
		writer.writeStderrLine("x".repeat(2_000));
	};
	const referencePath = join(directory, "exact-reference.jsonl");
	writeFixture(referencePath, 10_000);
	const expectedBytes = statSync(referencePath).size;
	const transcriptPath = join(directory, "exact-rolling.jsonl");
	writeFixture(transcriptPath, 500);

	const records = readFileSync(transcriptPath, "utf8").trim().split("\n").map(parseJsonValue);
	expect(records).toHaveLength(1);
	expect(isJsonInputObject(records[0]) ? records[0] : undefined).toMatchObject({
		recordType: "truncated",
		omittedBytes: expectedBytes,
		omittedRecords: 2,
	});
});

test("rolls child transcripts after the retention threshold while preserving newest evidence", async () => {
	const directory = tempDirectory();
	const transcriptPath = join(directory, "rolling.jsonl");
	const maxBytes = 2_000;
	const writer = createChildTranscriptWriter({
		transcriptPath,
		source: "async",
		runId: "rolling-run",
		agent: "reader",
		cwd: directory,
		maxBytes,
	});
	writer.writeInitialUserMessage("inspect");
	for (let index = 0; index < 20; index += 1) {
		writer.writeStderrLine(`stderr-${String(index)}-${"x".repeat(240)}`);
	}
	writer.writeChildEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "FINAL_AFTER_ROLLOVER" }],
			api: "faux",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});

	expect(statSync(transcriptPath).size).toBeLessThanOrEqual(maxBytes);
	const records = readFileSync(transcriptPath, "utf8").trim().split("\n").map(parseJsonValue);
	const marker = records[0];
	expect(isJsonInputObject(marker) ? marker : undefined).toMatchObject({
		recordType: "truncated",
		omittedBytes: expect.any(Number),
		omittedRecords: expect.any(Number),
	});
	expect(records.some((record) => isJsonInputObject(record) && record["text"] === "FINAL_AFTER_ROLLOVER")).toBe(true);
	const rendered = await readAgentTranscript(request(row({ transcriptPath }), 10_000));
	expect(rendered).not.toBeNull();
	if (!rendered || isRuntimeString(rendered)) throw new Error("Expected a structured rolling transcript");
	expect(rendered.items[0]).toMatchObject({ kind: "notice" });
});
