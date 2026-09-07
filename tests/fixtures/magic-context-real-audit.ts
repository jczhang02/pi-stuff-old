import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Guard } from "typebox/guard";
import { Check } from "typebox/value";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";

const MESSAGE_CONTENT_SCHEMA = Type.Object({ content: Type.Unknown() }, { additionalProperties: true });

interface AuditRecord {
	readonly [key: string]: JsonInputValue;
	readonly type: string;
}

function auditPath(): string {
	const path = process.env["PI_STUFF_MAGIC_REAL_AUDIT"]?.trim();
	if (!path) throw new Error("PI_STUFF_MAGIC_REAL_AUDIT is required");
	return path;
}

function write(record: AuditRecord): void {
	appendFileSync(auditPath(), `${JSON.stringify({ ...record, timestamp: Date.now() })}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function contentCharacters<Content>(content: Content): number {
	if (!Array.isArray(content)) return Guard.IsString(content) ? content.length : 0;
	return content.reduce((total, block) => {
		if (!Guard.IsObject(block)) return total;
		const text = block["text"];
		const thinking = block["thinking"];
		return total + (Guard.IsString(text) ? text.length : 0) + (Guard.IsString(thinking) ? thinking.length : 0);
	}, 0);
}

/** Durable, content-free instrumentation used only by the maintainer's real-provider acceptance. */
export default function magicContextRealAudit(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		write({
			mode: ctx.mode,
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			type: "session_start",
		});
	});

	pi.on("session_before_compact", (event) => {
		write({ reason: event.reason, type: "session_before_compact", willRetry: event.willRetry });
	});

	pi.on("session_compact", (event) => {
		write({
			fromExtension: event.fromExtension,
			reason: event.reason,
			type: "session_compact",
			willRetry: event.willRetry,
		});
	});

	pi.on("context", (event) => {
		write({
			characters: event.messages.reduce(
				(total, message) =>
					total + (Check(MESSAGE_CONTENT_SCHEMA, message) ? contentCharacters(message.content) : 0),
				0,
			),
			messages: event.messages.length,
			type: "context_projection",
		});
	});

	pi.on("tool_result", (event) => {
		write({
			characters: contentCharacters(event.content),
			isError: event.isError,
			toolName: event.toolName,
			type: "tool_result",
		});
	});
}
