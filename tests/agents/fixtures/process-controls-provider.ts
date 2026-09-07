import { appendFileSync } from "node:fs";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, registerFixtureProvider } from "../../fixtures/faux-provider.js";

const PROVIDER = "pi-stuff-process-controls";
const MODEL = "fixture-model";
const CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const PROCESS_CONTROLS_PROVIDER_EXTENSION_PATH = import.meta.path;
interface ProviderLogRecord {
	readonly childIndex?: string;
	readonly kind: "aborted" | "finished" | "request";
	readonly text?: string;
	readonly userText?: string;
}

const assistant = createAssistantMessage(PROVIDER, MODEL);

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const entry = context.messages[index];
		if (entry?.role !== "user") continue;
		if (isRuntimeString(entry.content)) return entry.content;
		return entry.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function record(value: ProviderLogRecord): void {
	const logPath = process.env["PI_STUFF_PROCESS_CONTROLS_LOG"];
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
}

function textStream(text: string, delayMs: number, signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	const pending = assistant([], "pending");
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text }], "stop") });
		const childIndex = process.env[CHILD_INDEX_ENV];
		record(childIndex === undefined ? { kind: "finished", text } : { kind: "finished", childIndex, text });
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		stream.push({ type: "error", reason: "aborted", error: assistant([{ type: "text", text }], "aborted") });
		const childIndex = process.env[CHILD_INDEX_ENV];
		record(childIndex === undefined ? { kind: "aborted", text } : { kind: "aborted", childIndex, text });
	};

	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	if (delayMs > 0) timer = setTimeout(finish, delayMs);
	else queueMicrotask(finish);
	signal?.addEventListener("abort", abort, { once: true });
	return stream;
}

function streamFixture(context: Context, options?: SimpleStreamOptions) {
	const userText = lastUserText(context);
	const childIndex = process.env[CHILD_INDEX_ENV] ?? "seed";
	record({ kind: "request", childIndex, userText });
	if (userText.includes("PROCESS_SEED")) return textStream("PROCESS_SEEDED", 0, options?.signal);
	if (userText.includes("PROCESS_RESUME_FINISH")) {
		return textStream("PROCESS_RESUME_COMPLETED", 100, options?.signal);
	}
	if (userText.includes("PROCESS_CRASH_HOLD")) {
		return textStream(`PROCESS_CRASH_RUNNING_${childIndex}`, 60_000, options?.signal);
	}
	if (userText.includes("TARGET_ONLY_CHILD_ZERO")) {
		return textStream(`PROCESS_CONTROL_STEERED_${childIndex}`, 7_000, options?.signal);
	}
	return textStream(
		`PROCESS_CONTROL_RUNNING_${childIndex}`,
		userText.includes("PROCESS_CONTROL_HOLD_0") ? 800 : 4_000,
		options?.signal,
	);
}

export default function registerProcessControlsProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff process controls fixture", (_model, context, options) =>
		streamFixture(context, options),
	);
}
