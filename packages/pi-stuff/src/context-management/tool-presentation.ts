import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "../tool-display/activity.ts";
import {
	activityKey,
	activityTarget,
	type SuiteToolPresentation,
	singleActivity,
	type ToolActivityMetadata,
} from "../tool-display/index.ts";
import { MAGIC_TOOL_LABELS } from "./activity.ts";

const MAGIC_TOOL_CATEGORIES = new Map<string, ToolActivityMetadata<ToolArguments, unknown>["categories"]>([
	["ctx_expand", ["review-history-range"]],
	["ctx_memory", ["read-memory", "save-memory", "update-memory"]],
	["ctx_note", ["read-note", "save-note", "update-note"]],
	["ctx_search", ["search-history"]],
]);
function firstPresentationTarget(args: ToolArguments): string {
	for (const key of ["query", "message", "note_id", "memory_id", "id", "range", "content", "note", "reason"]) {
		const value = args[key];
		if (isRuntimeString(value) && value.trim()) return value.trim();
	}
	const ids = args["ids"];
	if (Array.isArray(ids) && ids.length > 0) return ids.map(String).join(", ");
	const { end, start } = args;
	return isRuntimeNumber(start) && isRuntimeNumber(end) ? `${String(start)}-${String(end)}` : "";
}

function toolResultText(result: { readonly content?: readonly unknown[] } | undefined): string {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.map((item) =>
			item && isRuntimeObject(item) && "type" in item && item.type === "text" && "text" in item
				? String(item.text)
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

function resultObjectIds(text: string, kind: "memory" | "note"): readonly string[] {
	const patterns = kind === "memory" ? [/\[ID:\s*(\d+)\]/giu, /(?:^|\s)#(\d+)\s*:/gmu] : [/(?:note\s+|\*\*)#(\d+)/giu];
	const ids = new Set<string>();
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			if (match[1]) ids.add(match[1]);
		}
	}
	return [...ids];
}

function objectActivity(
	category: "read-memory" | "read-note" | "save-memory" | "save-note" | "update-memory" | "update-note",
	ids: readonly string[],
	fallbackKey: string,
	target: string,
) {
	return [
		{
			category,
			countKeys: ids.length > 0 ? ids.map((id) => `${category}:${id}`) : [`${category}:${fallbackKey}`],
			target: activityTarget(target),
		},
	] as const;
}

export function magicToolPresentation(name: string): SuiteToolPresentation<ToolArguments, unknown> {
	const activity: ToolActivityMetadata<ToolArguments, unknown> = {
		categories: MAGIC_TOOL_CATEGORIES.get(name) ?? [],
		classify: ({ args, result }) => {
			const target = firstPresentationTarget(args);
			const text = toolResultText(result);
			if (name === "ctx_reduce") return [];
			if (name === "ctx_expand") {
				const key = activityKey(args["message"], args["start"], args["end"], args["verbose"]);
				return singleActivity("review-history-range", { key, target: target || String(args["message"] ?? "") });
			}
			if (name === "ctx_search") {
				return singleActivity("search-history", {
					key: activityKey(args["query"], args["sources"]),
					target,
				});
			}
			const kind = name === "ctx_memory" ? "memory" : "note";
			const action = String(
				args["action"] ?? (kind === "note" && isRuntimeString(args["content"]) ? "write" : "read"),
			);
			const reads = kind === "memory" ? action === "get" || action === "list" : action === "read";
			const verb = reads ? "read" : action === "write" ? "save" : "update";
			const idArgument = kind === "memory" ? args["ids"] : args["note_id"];
			const argumentIds = Array.isArray(idArgument)
				? idArgument.filter((item): item is number => isRuntimeNumber(item)).map(String)
				: isRuntimeNumber(idArgument)
					? [String(idArgument)]
					: [];
			const ids = [...new Set([...argumentIds, ...resultObjectIds(text, kind)])];
			return objectActivity(
				`${verb}-${kind}`,
				ids,
				activityKey(action, idArgument, args["content"]),
				target || action,
			);
		},
		summarizeIssue: (_args, result, state) => toolResultText(result).trim().split(/\r?\n/u)[0] || state,
	};
	return {
		activity: name === "ctx_reduce" ? { ...activity, silentSuccess: true } : activity,
		label: MAGIC_TOOL_LABELS.get(name) ?? name,
		runningSummary: name === "ctx_search" ? "searching" : "working",
		target: firstPresentationTarget,
	};
}
