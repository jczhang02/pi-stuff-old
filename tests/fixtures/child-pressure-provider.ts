import { appendFileSync } from "node:fs";
import { type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-child-pressure";
const MODEL = "fixture-model";
const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

function allText(context: Context): string {
	return context.messages
		.map((entry) =>
			isRuntimeString(entry.content)
				? entry.content
				: entry.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
		)
		.join("\n");
}

function markers(text: string): string[] {
	return [...new Set(text.match(/REPAIR_[A-Z0-9_]+/g) ?? [])].sort();
}

function record(kind: string, evidence: string[]): void {
	const log = process.env["PI_STUFF_CHILD_PRESSURE_LOG"];
	if (log) appendFileSync(log, `${JSON.stringify({ kind, evidence })}\n`);
}

function historian(context: Context) {
	const text = allText(context);
	const range = /Messages\s+(\d+)-(\d+):/.exec(text);
	const start = Number(range?.[1] ?? "1");
	const end = Number(range?.[2] ?? String(start));
	const evidence = markers(text);
	record("historian", evidence);
	return textStream(
		`<output><compartments><compartment start="${start}" end="${end}" title="Repair findings and checks" importance="100" episode_type="feature"><p1>${evidence.join(" ")}</p1><p2>${evidence.join(" ")}</p2><p3>${evidence.join(" ")}</p3><p4/></compartment></compartments><facts><PROJECT_RULES>${evidence.join(" ")}</PROJECT_RULES></facts><events></events><unprocessed_from>${end + 1}</unprocessed_from></output>`,
	);
}

function overflow() {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: { ...message([], "error"), errorMessage: "Your input exceeds the context window of this model" },
	});
	stream.end();
	return stream;
}

function toolRound(round: number) {
	const stream = createAssistantMessageEventStream();
	const toolCall = {
		type: "toolCall" as const,
		id: `check_${round}|signed_${round}`,
		name: "evidence_chunk",
		arguments: { round },
	};
	const pending = message([toolCall], "pending");
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function assertProtocol(context: Context): void {
	const calls = new Set(
		context.messages.flatMap((entry) =>
			entry.role === "assistant" ? entry.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])) : [],
		),
	);
	for (const entry of context.messages) {
		if (entry.role === "toolResult" && !calls.has(entry.toolCallId))
			throw new Error(`Orphaned result: ${entry.toolCallId}`);
		if (entry.role !== "assistant") continue;
		for (const part of entry.content) {
			if (part.type === "thinking" && part.thinkingSignature !== "SIGNED_CHILD_EVIDENCE")
				throw new Error("Changed thinking signature");
			if (part.type === "toolCall" && part.name === "evidence_chunk" && !/^check_\d+\|signed_\d+$/.test(part.id))
				throw new Error(`Changed composite Tool ID: ${part.id}`);
		}
	}
}

export default function childPressureProvider(pi: ExtensionAPI): void {
	let firstOverflow = false;
	let secondOverflow = false;
	let round = 0;
	pi.registerTool({
		name: "evidence_chunk",
		label: "Evidence",
		description: "Produce checked evidence in the pressure fixture.",
		parameters: Type.Object({ round: Type.Number() }),
		execute: async (_id, params) => ({
			content: [
				{
					type: "text" as const,
					text: `REPAIR_SECOND_FINDING REPAIR_CHECK_SECOND_PASS round=${params.round}\n${"intermediate observed evidence ".repeat(2_000)}`,
				},
			],
			details: undefined,
		}),
	});
	registerFixtureProvider(pi, PROVIDER, MODEL, "Child pressure fixture", (_model, context) => {
		if (process.env["MAGIC_CONTEXT_PI_SUBAGENT"] === "1") return historian(context);
		if (process.env["PI_SUBAGENT_CHILD"] !== "1")
			throw new Error("Expected the actual delegated child launch environment");
		assertProtocol(context);
		const evidence = markers(allText(context));
		record("child-request", evidence);
		if (!firstOverflow) {
			firstOverflow = true;
			record("overflow-first", evidence);
			return overflow();
		}
		if (!evidence.includes("REPAIR_STEER_RECHECK_BINDINGS")) {
			if (!evidence.includes("REPAIR_INITIAL_FINDING") || !evidence.includes("REPAIR_CHECK_INITIAL_PASS"))
				throw new Error("First recovery lost established evidence");
			return textStream("READY_FOR_STEERING");
		}
		if (round < 8) return toolRound(++round);
		if (!secondOverflow) {
			secondOverflow = true;
			record("overflow-second", evidence);
			return overflow();
		}
		const required = [
			"REPAIR_INITIAL_FINDING",
			"REPAIR_CHECK_INITIAL_PASS",
			"REPAIR_SECOND_FINDING",
			"REPAIR_CHECK_SECOND_PASS",
			"REPAIR_STEER_RECHECK_BINDINGS",
		];
		if (required.some((item) => !evidence.includes(item)))
			throw new Error(`Repeated recovery lost evidence: ${evidence.join(" ")}`);
		return textStream(`FINAL_REPAIR_REPORT ${evidence.join(" ")}`);
	});
}
