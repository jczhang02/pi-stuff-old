import type { AgentToolResult, ContextEvent } from "@earendil-works/pi-coding-agent";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { TOOL_DISPLAY_ITEM_LIMIT, TOOL_DISPLAY_MEDIA_LIMIT } from "../tool-display/limits.ts";
import { sanitizeCodeModeContent } from "./image-content.ts";

type ToolContent = AgentToolResult<unknown>["content"];
type ToolContentItem = ToolContent[number];
type AgentMessage = ContextEvent["messages"][number];

const RAW_MODEL_CONTENT = Symbol("pi-stuff-code-mode-raw-model-content");

export interface CodeModeModelContentOwner {
	readonly kind: "pi-stuff-code-mode";
}

interface CodeModeMediaProjectionDetails {
	readonly mediaContentIndexes: readonly (readonly number[])[];
	readonly modelContent: ToolContent;
}

export function isCodeModeModelContentOwner<Value>(value: Value): value is Value & CodeModeModelContentOwner {
	return isRuntimeObject(value) && value !== null && "kind" in value && value.kind === "pi-stuff-code-mode";
}

function isToolContentItem<Value>(value: Value): value is Value & ToolContentItem {
	if (!isRuntimeObject(value) || value === null || !("type" in value)) return false;
	if (value.type === "text") return "text" in value && isRuntimeString(value.text);
	return (
		value.type === "image" &&
		"data" in value &&
		isRuntimeString(value.data) &&
		"mimeType" in value &&
		isRuntimeString(value.mimeType)
	);
}

export function isCodeModeToolContent<Value>(value: Value): value is Value & ToolContent {
	return Array.isArray(value) && Array.from(value).every(isToolContentItem);
}

/**
 * Retain the exact pre-normalization content by identity until Pi's
 * tool_execution_end event. The symbol is deliberately non-enumerable, so it
 * can never leak into session JSON.
 */
export function captureCodeModeModelContent(details: CodeModeModelContentOwner, content: ToolContent): void {
	Object.defineProperty(details, RAW_MODEL_CONTENT, {
		configurable: true,
		enumerable: false,
		value: content,
	});
}

function normalizedMediaContentIndexes(
	raw: ToolContent,
	normalized: ToolContent,
): readonly (readonly number[])[] | undefined {
	const segments: number[][] = [];
	let normalizedIndex = 0;
	for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
		const rawItem = raw[rawIndex];
		if (!rawItem) continue;
		if (rawItem.type === "text") {
			// Pi retains original text block objects while normalizing image blocks.
			if (normalized[normalizedIndex] !== rawItem) return undefined;
			normalizedIndex += 1;
			continue;
		}

		if (normalized[normalizedIndex]?.type !== "image") return undefined;
		const segment = [normalizedIndex];
		normalizedIndex += 1;
		const nextRaw = raw[rawIndex + 1];
		if (!nextRaw) {
			while (normalizedIndex < normalized.length) {
				if (normalized[normalizedIndex]?.type !== "text") return undefined;
				segment.push(normalizedIndex);
				normalizedIndex += 1;
			}
		} else if (nextRaw.type === "image") {
			while (normalized[normalizedIndex]?.type !== "image") {
				if (normalized[normalizedIndex]?.type !== "text") return undefined;
				segment.push(normalizedIndex);
				normalizedIndex += 1;
			}
		} else {
			while (normalized[normalizedIndex] !== nextRaw) {
				if (normalized[normalizedIndex]?.type !== "text") return undefined;
				segment.push(normalizedIndex);
				normalizedIndex += 1;
			}
		}
		segments.push(segment);
	}
	return normalizedIndex === normalized.length ? segments : undefined;
}

/**
 * Move normalized nested media out of the outer Host result used by the TUI.
 * The full provider-facing content remains in details and is restored by the
 * context hook. This lets each original renderer own its image position and
 * prevents Pi from appending every nested image below the Code Mode envelope.
 */
export function separateCodeModeMediaForUi<Details>(
	result: AgentToolResult<Details>,
): AgentToolResult<Details & CodeModeMediaProjectionDetails> | undefined {
	const details = result.details;
	if (!isCodeModeModelContentOwner(details) || !("operations" in details) || !Array.isArray(details.operations)) {
		return undefined;
	}
	const raw = Object.getOwnPropertyDescriptor(details, RAW_MODEL_CONTENT)?.value;
	if (!Array.isArray(raw)) return undefined;
	if (
		details.operations.length > TOOL_DISPLAY_ITEM_LIMIT ||
		raw.length > TOOL_DISPLAY_ITEM_LIMIT ||
		result.content.length > TOOL_DISPLAY_ITEM_LIMIT
	) {
		return {
			...result,
			content: [{ type: "text", text: "… Code Mode media preview omitted" }],
			details: {
				...details,
				mediaContentIndexes: [],
				modelContent: result.content,
			},
		};
	}
	const referencedMedia = new Set<number>();
	const operationStart = Math.max(0, details.operations.length - TOOL_DISPLAY_ITEM_LIMIT);
	for (let operationIndex = operationStart; operationIndex < details.operations.length; operationIndex += 1) {
		const operation = details.operations[operationIndex];
		if (
			!isRuntimeObject(operation) ||
			operation === null ||
			!("mediaPlacements" in operation) ||
			!Array.isArray(operation.mediaPlacements)
		) {
			continue;
		}
		for (
			let placementIndex = 0;
			placementIndex < Math.min(operation.mediaPlacements.length, TOOL_DISPLAY_ITEM_LIMIT);
			placementIndex += 1
		) {
			const placement = operation.mediaPlacements[placementIndex];
			if (
				isRuntimeObject(placement) &&
				placement !== null &&
				"mediaIndex" in placement &&
				isRuntimeNumber(placement.mediaIndex) &&
				Number.isSafeInteger(placement.mediaIndex) &&
				placement.mediaIndex >= 0
			) {
				referencedMedia.add(placement.mediaIndex);
				if (referencedMedia.size >= TOOL_DISPLAY_MEDIA_LIMIT) break;
			}
		}
		if (referencedMedia.size >= TOOL_DISPLAY_MEDIA_LIMIT) break;
	}
	if (referencedMedia.size === 0) return undefined;
	if (!isCodeModeToolContent(raw)) return undefined;
	const mediaContentIndexes = normalizedMediaContentIndexes(raw, result.content);
	if (!mediaContentIndexes) return undefined;
	if ([...referencedMedia].some((index) => !mediaContentIndexes[index])) return undefined;

	const nestedContentIndexes = new Set<number>();
	for (const mediaIndex of referencedMedia) {
		for (const contentIndex of (mediaContentIndexes[mediaIndex] ?? []).slice(0, TOOL_DISPLAY_ITEM_LIMIT)) {
			nestedContentIndexes.add(contentIndex);
		}
	}
	return {
		...result,
		content: result.content.filter((_item, index) => !nestedContentIndexes.has(index)),
		details: {
			...details,
			mediaContentIndexes,
			modelContent: result.content,
		},
	};
}

/** Resolve normalized media plus Pi-generated image hints for nested renderers. */
export function decodeCodeModeMediaSegments<Value>(detailsValue: Value): readonly (readonly ToolContentItem[])[] {
	if (
		!isRuntimeObject(detailsValue) ||
		detailsValue === null ||
		!("modelContent" in detailsValue) ||
		!("mediaContentIndexes" in detailsValue)
	) {
		return [];
	}
	const modelContent = detailsValue.modelContent;
	const mediaContentIndexes = detailsValue.mediaContentIndexes;
	if (!Array.isArray(modelContent) || !Array.isArray(mediaContentIndexes)) return [];
	const segments: ToolContentItem[][] = [];
	for (
		let segmentIndex = 0;
		segmentIndex < Math.min(mediaContentIndexes.length, TOOL_DISPLAY_MEDIA_LIMIT);
		segmentIndex += 1
	) {
		const indexes = mediaContentIndexes[segmentIndex];
		if (!Array.isArray(indexes)) return [];
		const segment: ToolContentItem[] = [];
		for (let index = 0; index < Math.min(indexes.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
			const contentIndex = indexes[index];
			if (!isRuntimeNumber(contentIndex) || !Number.isSafeInteger(contentIndex) || contentIndex < 0) return [];
			const item = modelContent[contentIndex];
			if (!isToolContentItem(item)) return [];
			segment.push(item);
		}
		segments.push(segment);
	}
	return segments;
}

/** Restore normalized Tool results and quarantine invalid historical images only in provider context. */
export function rehydrateCodeModeMessages(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const hydrated = messages.map((message) => {
		if (message.role !== "toolResult" || message.toolName !== "codemode") return message;
		const details = message.details;
		if (!isCodeModeModelContentOwner(details)) return message;
		if ("modelContent" in details && isCodeModeToolContent(details.modelContent)) {
			const modelContent = details.modelContent;
			const sanitized = sanitizeCodeModeContent(modelContent);
			changed = true;
			return { ...message, content: sanitized.rejected > 0 ? sanitized.content : modelContent };
		}
		const sanitized = sanitizeCodeModeContent(message.content);
		if (sanitized.rejected === 0) return message;
		changed = true;
		return { ...message, content: sanitized.content };
	});
	return changed ? hydrated : undefined;
}
