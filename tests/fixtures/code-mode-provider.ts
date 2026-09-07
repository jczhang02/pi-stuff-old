import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-code-mode-fixture";
const MODEL = "fixture";
const LOG_ENV = "PI_STUFF_CODE_MODE_FIXTURE_LOG";
const DIRECT_ENV = "PI_STUFF_CODE_MODE_FIXTURE_DIRECT";
const HIDE_RESULT_ENV = "PI_STUFF_CODE_MODE_FIXTURE_HIDE_RESULT";
const SCENARIO_ENV = "PI_STUFF_CODE_MODE_FIXTURE_SCENARIO";
const SKILL_PATH_ENV = "PI_STUFF_CODE_MODE_FIXTURE_SKILL_PATH";
const SKILL_NAME = "code-mode-real-skill";
const SKILL_DESCRIPTION = "Verify that Code Mode preserves native Skill Discovery.";
const SKILL_BODY_TOKEN = "CODE_MODE_SKILL_BODY_OK";
const assistant = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(assistant);

function codeModeStream() {
	const stream = createAssistantMessageEventStream();
	const pending = assistant([], "pending");
	const skillPath = process.env[SKILL_PATH_ENV];
	const skillRead = skillPath ? `const skill = await tools.read({ path: ${JSON.stringify(skillPath)} });\n` : "";
	const codeModeCall = {
		arguments: {
			code:
				process.env[SCENARIO_ENV] === "failure"
					? 'await tools.read({ path: "pi-stuff-code-mode-missing-file" });'
					: process.env[SCENARIO_ENV] === "cancel"
						? `const cancelled = await tools.bash({
  command: "printf 'Operation aborted\\\\n' >&2; exit 1",
  description: "Cancellation fixture"
});
text(String(cancelled));`
						: process.env[SCENARIO_ENV] === "media"
							? 'await Promise.all([tools.read({ path: "pixel.png" }), tools.read({ path: "README.md", limit: 1 }), tools.read({ path: "pixel-copy.png" })]); text("MEDIA_OK");'
							: `${skillRead}const matches = await codemode.search("read file");
const selected = matches.results.find((entry) => entry.method === "read");
if (!selected) throw new Error("read not found");
const docs = await codemode.describe(selected.path);
const pkg = await tools[selected.method]({ path: "package.json" });
await tools.bash({ command: "printf CODE_MODE_GROUP_OK", description: "Check Tool grouping" });
await tools.background({ action: "list" });
await tools.subagent({ action: "status" });
text(JSON.stringify({
  packageManager: pkg.packageManager,
  skillLoaded: ${skillPath ? `String(skill).includes(${JSON.stringify(SKILL_BODY_TOKEN)})` : "undefined"},
  typed: docs.types.includes("path")
}));`,
		},
		id: "pi-stuff-code-mode-fixture-1",
		name: "codemode",
		type: "toolCall" as const,
	};
	const toolCalls = [codeModeCall];
	stream.push({ partial: pending, type: "start" });
	for (const [contentIndex, toolCall] of toolCalls.entries()) {
		pending.content.push(toolCall);
		stream.push({ contentIndex, partial: pending, type: "toolcall_start" });
		stream.push({ contentIndex, partial: pending, toolCall, type: "toolcall_end" });
	}
	stream.push({ message: assistant(toolCalls, "toolUse"), reason: "toolUse", type: "done" });
	return stream;
}

function directToolStream() {
	const stream = createAssistantMessageEventStream();
	const pending = assistant([], "pending");
	const toolCalls =
		process.env[SCENARIO_ENV] === "failure"
			? [
					{
						arguments: { path: "pi-stuff-code-mode-missing-file" },
						id: "pi-stuff-direct-read-failure-fixture-1",
						name: "read",
						type: "toolCall" as const,
					},
				]
			: process.env[SCENARIO_ENV] === "cancel"
				? [
						{
							arguments: {
								command: "printf 'Operation aborted\\n' >&2; exit 1",
								description: "Cancellation fixture",
							},
							id: "pi-stuff-direct-bash-cancel-fixture-1",
							name: "bash",
							type: "toolCall" as const,
						},
					]
				: process.env[SCENARIO_ENV] === "media"
					? [
							{
								arguments: { path: "pixel.png" },
								id: "pi-stuff-direct-read-media-fixture-1",
								name: "read",
								type: "toolCall" as const,
							},
							{
								arguments: { limit: 1, path: "README.md" },
								id: "pi-stuff-direct-read-media-fixture-2",
								name: "read",
								type: "toolCall" as const,
							},
							{
								arguments: { path: "pixel-copy.png" },
								id: "pi-stuff-direct-read-media-fixture-3",
								name: "read",
								type: "toolCall" as const,
							},
						]
					: [
							{
								arguments: { limit: 1, path: "README.md" },
								id: "pi-stuff-direct-read-fixture-1",
								name: "read",
								type: "toolCall" as const,
							},
							{
								arguments: { command: "printf CODE_MODE_GROUP_OK", description: "Check Tool grouping" },
								id: "pi-stuff-direct-bash-fixture-1",
								name: "bash",
								type: "toolCall" as const,
							},
							{
								arguments: { action: "list" },
								id: "pi-stuff-direct-background-fixture-1",
								name: "background",
								type: "toolCall" as const,
							},
							{
								arguments: { action: "status" },
								id: "pi-stuff-direct-subagent-fixture-1",
								name: "subagent",
								type: "toolCall" as const,
							},
						];
	stream.push({ partial: pending, type: "start" });
	for (const [contentIndex, toolCall] of toolCalls.entries()) {
		pending.content.push(toolCall);
		stream.push({ contentIndex, partial: pending, type: "toolcall_start" });
		stream.push({ contentIndex, partial: pending, toolCall, type: "toolcall_end" });
	}
	stream.push({ message: assistant(toolCalls, "toolUse"), reason: "toolUse", type: "done" });
	return stream;
}

function fixtureStream(context: Context) {
	const toolNames = (context.tools ?? []).map((tool) => tool.name);
	const direct = process.env[DIRECT_ENV] === "1";
	const directCall = direct
		? [...context.messages]
				.reverse()
				.find(
					(message) =>
						message.role === "assistant" &&
						Array.isArray(message.content) &&
						message.content.some((part) => part.type === "toolCall"),
				)
		: undefined;
	const directCallIds =
		directCall?.role === "assistant" && Array.isArray(directCall.content)
			? directCall.content.filter((part) => part.type === "toolCall").map((part) => part.id)
			: [];
	const completedDirectCallIds = new Set(
		context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	const directSettled = directCallIds.length > 0 && directCallIds.every((id) => completedDirectCallIds.has(id));
	const result = [...context.messages]
		.reverse()
		.find(
			(message) =>
				message.role === "toolResult" &&
				(direct ? directSettled && directCallIds.includes(message.toolCallId) : message.toolName === "codemode"),
		);
	const logPath = process.env[LOG_ENV];
	if (logPath) {
		const schemaChars = JSON.stringify(context.tools ?? []).length;
		const systemPrompt = context.systemPrompt ?? "";
		const systemPromptChars = systemPrompt.length;
		const expectedSkillPath = process.env[SKILL_PATH_ENV];
		const skillCatalogExact =
			expectedSkillPath !== undefined &&
			systemPrompt.split(`<name>${SKILL_NAME}</name>`).length === 2 &&
			systemPrompt.split(`<description>${SKILL_DESCRIPTION}</description>`).length === 2 &&
			systemPrompt.split(`<location>${expectedSkillPath}</location>`).length === 2;
		const messageTokens = context.messages.reduce((total, message) => total + estimateTokens(message), 0);
		appendFileSync(
			logPath,
			`${JSON.stringify({
				estimatedInputTokens: Math.ceil(systemPromptChars / 4) + Math.ceil(schemaChars / 4) + messageTokens,
				hasResult: Boolean(result),
				messageTokens,
				resultImageCount:
					result?.role === "toolResult" && Array.isArray(result.content)
						? result.content.filter((part) => part.type === "image").length
						: 0,
				schemaChars,
				skillCatalogExact,
				systemPromptChars,
				toolNames,
			})}\n`,
		);
	}
	if (!result) return direct ? directToolStream() : codeModeStream();
	const resultText =
		result?.role === "toolResult" && Array.isArray(result.content)
			? result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
			: "";
	return textStream(
		process.env[HIDE_RESULT_ENV] === "1"
			? "VERIFY_COMPLETE"
			: `${direct ? "DIRECT_COMPLETE" : "CODE_MODE_COMPLETE"} ${resultText}`,
	);
}

export default function codeModeFixtureProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Code Mode fixture",
		(_model, context) => fixtureStream(context),
		{
			apiKey: "offline-fixture",
			contextWindow: 400_000,
			input: ["text", "image"],
		},
	);
}
