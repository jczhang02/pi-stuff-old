import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { boundTerminalLine } from "../tool-display/index.ts";

const SESSION_WIDTH = 32;
const BODY_WIDTH = 160;

export interface NotificationContent {
	readonly body: string;
	readonly title: string;
}

function withoutFencedCode(value: string): string {
	const lines: string[] = [];
	let fence: "`" | "~" | undefined;
	for (const line of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
		const match = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
		const marker = match?.startsWith("`") ? "`" : match?.startsWith("~") ? "~" : undefined;
		if (marker) {
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (!fence) lines.push(line);
	}
	return lines.join("\n");
}

function plainParagraph(value: string): string {
	const lines = value.split("\n").map((line) => line.trim());
	if (lines.every((line) => !line || /^#{1,6}\s+/u.test(line))) return "";
	return boundTerminalLine(
		lines
			.join(" ")
			.replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
			.replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
			.replaceAll(/<[^>]+>/gu, " ")
			.replaceAll(/`+([^`]+)`+/gu, "$1")
			.replaceAll(/\*\*([^*]+)\*\*/gu, "$1")
			.replaceAll(/__([^_]+)__/gu, "$1")
			.replaceAll(/~~([^~]+)~~/gu, "$1")
			.replaceAll(/(^|\s)(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gu, "$1"),
		BODY_WIDTH,
	);
}

export function extractNotificationPreview(content: readonly unknown[]): string | undefined {
	const text = content
		.filter(
			(part): part is { readonly text: string; readonly type: "text" } =>
				isRuntimeObject(part) &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				isRuntimeString(part.text),
		)
		.map((part) => part.text)
		.join("\n\n");
	for (const paragraph of withoutFencedCode(text).split(/\n\s*\n/gu)) {
		const preview = plainParagraph(paragraph);
		if (preview) return preview;
	}
	return undefined;
}

export function formatNotificationContent(input: {
	readonly includeResponsePreview: boolean;
	readonly outcome: "completion" | "failure";
	readonly preview?: string;
	readonly session: string;
}): NotificationContent {
	const session = boundTerminalLine(input.session, SESSION_WIDTH) || "Pi session";
	const failed = input.outcome === "failure";
	return {
		body:
			!failed && input.includeResponsePreview
				? boundTerminalLine(input.preview, BODY_WIDTH) || "Ready for review."
				: failed
					? "The run ended with an error."
					: "Ready for review.",
		title: `Pi · ${session} — ${failed ? "Needs attention" : "Ready"}`,
	};
}
