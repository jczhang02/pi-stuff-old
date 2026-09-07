import { basename, dirname, resolve } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { boundTerminalLine, compactTerminalPath } from "./terminal.ts";
import { oneLine } from "./tool-text.ts";

const ACTIVITY_TARGET_MAX_WIDTH = 160;

export type ToolActivityCategory =
	| "block-goal"
	| "change-file"
	| "check-task"
	| "commit"
	| "complete-goal"
	| "connect-mcp"
	| "create-pr"
	| "fetch-page"
	| "generate-image"
	| "inspect-background"
	| "invoke-mcp"
	| "launch-agent"
	| "launch-background"
	| "list-directory"
	| "check-agent"
	| "message-agent"
	| "merge"
	| "read-background"
	| "read-file"
	| "read-memory"
	| "read-note"
	| "push"
	| "rebase"
	| "record-result"
	| "retrieve-passage"
	| "review-history-range"
	| "resume-agent"
	| "run-agent"
	| "run-command"
	| "save-memory"
	| "save-note"
	| "search-history"
	| "search-mcp"
	| "search-pattern"
	| "search-tool"
	| "search-web"
	| "start-monitor"
	| "steer-agent"
	| "stop-background"
	| "stop-agent"
	| "update-memory"
	| "update-note"
	| "update-task"
	| "view-image";

export type ToolArguments = Readonly<ToolCall["arguments"]>;

export interface ToolActivityItem {
	readonly category: ToolActivityCategory;
	/** Stable identities are deduplicated within one Retrieval Group. */
	readonly countKeys?: readonly string[];
	/** Invocation-like work adds this quantity instead of deduplicating. */
	readonly count?: number;
	/** Conservative structured outcome, such as a commit SHA or pushed branch. */
	readonly detail?: string;
	/** Short active target. Never pass an unbounded command or result body. */
	readonly target?: string;
}

export interface ToolActivityClassifierInput<TArgs extends object, TDetails> {
	readonly args: Readonly<TArgs>;
	/** Host working directory for canonicalizing relative Activity identities. */
	readonly cwd?: string;
	readonly result?: AgentToolResult<TDetails>;
	readonly state: ToolActivityState;
}

export interface ToolActivityMetadata<TArgs extends object, TDetails> {
	/** Every semantic category this Tool may contribute. Empty is valid only for declared infrastructure. */
	readonly categories: readonly ToolActivityCategory[];
	readonly classify: (input: ToolActivityClassifierInput<TArgs, TDetails>) => readonly ToolActivityItem[];
	/** Calls stay out of the compact transcript while running and after success; issues remain visible. */
	readonly silentSuccess?: boolean;
	/** Optional semantic description for an exceptional result. */
	readonly summarizeIssue?: (
		args: Readonly<TArgs>,
		result: AgentToolResult<TDetails>,
		state: Exclude<ToolActivityState, "running" | "success">,
	) => string;
}

export function activityKey(...parts: readonly unknown[]): string {
	return parts
		.map((part) => oneLine(isRuntimeString(part) ? part : (JSON.stringify(part) ?? "")))
		.filter(Boolean)
		.join("\u0000");
}

export function skillReadName(cwd: string, args: ToolArguments): string | undefined {
	const path = args["path"];
	if (!isRuntimeString(path) || !path.trim()) return undefined;
	const resolved = resolve(cwd, path);
	if (basename(resolved) !== "SKILL.md") return undefined;
	const parent = dirname(resolved);
	return basename(parent) || parent;
}

/** Keep live targets glanceable without exposing a complete deep path. */
export function activityTarget(value: string): string {
	const safe = boundTerminalLine(value, ACTIVITY_TARGET_MAX_WIDTH);
	const pathLike =
		/^(?:~?[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/u.test(safe) ||
		(!/^[a-z][a-z\d+.-]*:\/\//iu.test(safe) && /[\\/]/u.test(safe));
	if (!pathLike) return safe;
	return compactTerminalPath(safe, ACTIVITY_TARGET_MAX_WIDTH, true);
}

export function singleActivity(
	category: ToolActivityCategory,
	options: {
		readonly key?: string;
		readonly target?: string;
		readonly count?: number;
	} = {},
): readonly ToolActivityItem[] {
	let item: ToolActivityItem = options.key
		? { category, countKeys: [options.key] }
		: { category, count: options.count ?? 1 };
	if (options.target) item = { ...item, target: activityTarget(options.target) };
	return [item];
}
