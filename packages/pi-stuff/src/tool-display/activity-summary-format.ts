import { activityTarget, type ToolActivityCategory, type ToolActivityItem } from "./activity-model.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { oneLine } from "./tool-text.ts";

export interface ActivitySummaryMember {
	/** Stable semantic subject used by an issue-only group summary. */
	readonly issueLabel?: string;
	/** Bounded root-cause detail shown on the indented issue row. */
	readonly issueDetail?: string;
	readonly items: readonly ToolActivityItem[];
	readonly state: ToolActivityState;
}

export type ToolActivityOutcome = "error" | "running" | "success" | "warning";

export function toolActivityOutcome(state: ToolActivityState): ToolActivityOutcome {
	return state === "rejected" || state === "cancelled" ? "warning" : state;
}

export interface ToolActivitySummary {
	readonly active: boolean;
	readonly issueState: "cancelled" | "error" | "rejected" | undefined;
	readonly issueText: string;
	readonly outcome: ToolActivityOutcome;
	readonly semanticSummary: string;
	readonly summary: string;
	readonly target: string;
}

interface PhraseSpec {
	readonly past: string;
	readonly plural: string;
	readonly present: string;
	readonly priority: number;
	readonly singular: string;
}

function definePhrase(past: string, present: string, singular: string, plural: string, priority: number): PhraseSpec {
	return { past, plural, present, priority, singular };
}

const PHRASES = {
	"complete-goal": definePhrase("Completed", "Completing", "goal", "goals", 10),
	"block-goal": definePhrase("Reported", "Reporting", "goal blocker", "goal blockers", 11),
	commit: definePhrase("Committed", "Committing", "change", "changes", 12),
	push: definePhrase("Pushed", "Pushing", "branch", "branches", 13),
	merge: definePhrase("Merged", "Merging", "branch", "branches", 13),
	rebase: definePhrase("Rebased", "Rebasing", "branch", "branches", 13),
	"create-pr": definePhrase("Created", "Creating", "pull request", "pull requests", 14),
	"record-result": definePhrase("Recorded", "Recording", "result", "results", 15),
	"generate-image": definePhrase("Generated", "Generating", "image", "images", 16),
	"change-file": definePhrase("Changed", "Changing", "file", "files", 20),
	"update-task": definePhrase("Updated", "Updating", "task", "tasks", 21),
	"update-memory": definePhrase("Updated", "Updating", "memory", "memories", 22),
	"save-memory": definePhrase("Saved", "Saving", "memory", "memories", 23),
	"save-note": definePhrase("Saved", "Saving", "note", "notes", 24),
	"update-note": definePhrase("Updated", "Updating", "note", "notes", 25),
	"run-agent": definePhrase("Ran", "Running", "agent", "agents", 30),
	"launch-agent": definePhrase("Launched", "Launching", "background agent", "background agents", 31),
	"check-agent": definePhrase("Checked", "Checking", "agent", "agents", 32),
	"message-agent": definePhrase("Messaged", "Messaging", "agent", "agents", 32),
	"resume-agent": definePhrase("Resumed", "Resuming", "agent", "agents", 32),
	"steer-agent": definePhrase("Steered", "Steering", "agent", "agents", 32),
	"stop-agent": definePhrase("Stopped", "Stopping", "agent", "agents", 32),
	"launch-background": definePhrase("Launched", "Launching", "background task", "background tasks", 33),
	"start-monitor": definePhrase("Started", "Starting", "monitor", "monitors", 34),
	"stop-background": definePhrase("Stopped", "Stopping", "background task", "background tasks", 35),
	"run-command": definePhrase("Ran", "Running", "command", "commands", 40),
	"invoke-mcp": definePhrase("Invoked", "Invoking", "MCP tool", "MCP tools", 41),
	"connect-mcp": definePhrase("Connected to", "Connecting to", "MCP server", "MCP servers", 42),
	"search-mcp": definePhrase("Searched", "Searching", "MCP catalog", "MCP catalogs", 43),
	"search-pattern": definePhrase("Searched", "Searching", "pattern", "patterns", 50),
	"search-tool": definePhrase("Searched", "Searching", "Tool catalog", "Tool catalogs", 50),
	"search-web": definePhrase("Searched", "Searching", "web query", "web queries", 51),
	"fetch-page": definePhrase("Fetched", "Fetching", "page", "pages", 52),
	"retrieve-passage": definePhrase("Retrieved", "Retrieving", "passage", "passages", 53),
	"read-file": definePhrase("Read", "Reading", "file", "files", 54),
	"list-directory": definePhrase("Listed", "Listing", "directory", "directories", 55),
	"view-image": definePhrase("Viewed", "Viewing", "image", "images", 56),
	"search-history": definePhrase("Searched", "Searching", "history query", "history queries", 57),
	"review-history-range": definePhrase("Reviewed", "Reviewing", "history range", "history ranges", 58),
	"check-task": definePhrase("Checked", "Checking", "task", "tasks", 59),
	"read-memory": definePhrase("Read", "Reading", "memory", "memories", 60),
	"read-note": definePhrase("Read", "Reading", "note", "notes", 61),
	"inspect-background": definePhrase("Inspected", "Inspecting", "background task", "background tasks", 62),
	"read-background": definePhrase("Read", "Reading", "background output", "background outputs", 63),
} satisfies Readonly<Record<ToolActivityCategory, PhraseSpec>>;

interface CategoryAccumulator {
	count: number;
	readonly details: Set<string>;
	readonly keys: Set<string>;
}

export interface ActivityCategoryAggregate {
	readonly category: ToolActivityCategory;
	readonly count: number;
	readonly details?: readonly string[];
}

export interface ToolActivityAggregate {
	readonly categories: readonly ActivityCategoryAggregate[];
	readonly firstIssueLabel?: string;
	readonly outcome: ToolActivityOutcome;
	readonly stateCounts: Readonly<Partial<Record<ToolActivityState, number>>>;
	readonly target?: string;
}

function normalizedCount(item: ToolActivityItem): number {
	if (item.countKeys && item.countKeys.length > 0) return 0;
	const count = item.count ?? 1;
	return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function phrase(category: ToolActivityCategory, accumulator: CategoryAccumulator, active: boolean): string {
	const spec = PHRASES[category];
	const count = accumulator.keys.size + accumulator.count;
	const details = [...accumulator.details];
	if (!active && details.length > 0) {
		if (category === "commit") return `${spec.past} ${details.join(", ")}`;
		if (category === "push") return `${spec.past} to ${details.join(", ")}`;
		if (category === "merge" || category === "rebase") return `${spec.past} ${details.join(", ")}`;
		if (category === "create-pr") return `${spec.past} ${details.join(", ")}`;
	}
	const safeCount = Math.max(0, count);
	if (safeCount === 1 && (category === "complete-goal" || category === "block-goal")) {
		return `${active ? spec.present : spec.past} ${spec.singular}`;
	}
	return `${active ? spec.present : spec.past} ${String(safeCount)} ${safeCount === 1 ? spec.singular : spec.plural}`;
}

interface ToolIssueSummary {
	readonly issueLabel: string;
	readonly issueState: "cancelled" | "error" | "rejected" | undefined;
	readonly text: string;
}

function issueSummaryFromCounts(
	counts: Readonly<Partial<Record<ToolActivityState, number>>>,
	firstIssueLabel = "",
): ToolIssueSummary {
	const failed = counts.error ?? 0;
	const rejected = counts.rejected ?? 0;
	const cancelled = counts.cancelled ?? 0;
	const parts = [
		...(failed > 0 ? [`${String(failed)} failed`] : []),
		...(rejected > 0 ? [`${String(rejected)} rejected`] : []),
		...(cancelled > 0 ? [`${String(cancelled)} cancelled`] : []),
	];
	return {
		issueLabel: oneLine(firstIssueLabel),
		issueState: failed > 0 ? "error" : rejected > 0 ? "rejected" : cancelled > 0 ? "cancelled" : undefined,
		text: parts.join(", "),
	};
}

/** Keep every settled failure historical, even when a later invocation succeeds. */
export function effectiveToolActivityOutcome(members: readonly ActivitySummaryMember[]): ToolActivityOutcome {
	if (members.some((member) => member.state === "running")) return "running";
	const hasError = members.some((member) => member.state === "error");
	if (hasError) return members.some((member) => member.state === "success") ? "warning" : "error";
	if (members.some((member) => member.state === "rejected" || member.state === "cancelled")) return "warning";
	return "success";
}

/** Format a pre-aggregated Retrieval Group without rescanning every member. */
export function summarizeToolActivityAggregate(aggregate: ToolActivityAggregate, closed: boolean): ToolActivitySummary {
	const active = !closed || (aggregate.stateCounts.running ?? 0) > 0;
	const clauses = [...aggregate.categories]
		.sort((left, right) => PHRASES[left.category].priority - PHRASES[right.category].priority)
		.map((entry, index) => {
			const accumulator: CategoryAccumulator = {
				count: Math.max(0, entry.count),
				details: new Set(entry.details ?? []),
				keys: new Set(),
			};
			const value = phrase(entry.category, accumulator, active);
			return index === 0 ? value : `${value.slice(0, 1).toLocaleLowerCase()}${value.slice(1)}`;
		});
	const issues = issueSummaryFromCounts(aggregate.stateCounts, aggregate.firstIssueLabel);
	const base = clauses.join(", ");
	const issueOnly =
		issues.text === "1 failed"
			? `${issues.issueLabel || "Internal operation"} failed`
			: `${issues.issueLabel || "Internal operation"} · ${issues.text}`;
	const summary = issues.text ? (base ? `${base} · ${issues.text}` : issueOnly) : base;
	return {
		active,
		issueState: issues.issueState,
		issueText: issues.text,
		outcome: active ? "running" : aggregate.outcome,
		semanticSummary: base,
		summary,
		target: active ? activityTarget(aggregate.target ?? "") : "",
	};
}

/** Build a deterministic Claude-style semantic clause for one Retrieval Group. */
export function summarizeRetrievalGroup(
	members: readonly ActivitySummaryMember[],
	closed: boolean,
): ToolActivitySummary {
	const categories = new Map<ToolActivityCategory, CategoryAccumulator>();
	let target = "";
	const stateCounts: Partial<Record<ToolActivityState, number>> = {};
	let firstIssueLabel = "";
	for (const member of members) {
		stateCounts[member.state] = (stateCounts[member.state] ?? 0) + 1;
		if (
			!firstIssueLabel &&
			(member.state === "error" || member.state === "rejected" || member.state === "cancelled")
		) {
			firstIssueLabel = member.issueLabel ?? "";
		}
		for (const item of member.items) {
			let accumulator = categories.get(item.category);
			if (!accumulator) {
				accumulator = { count: 0, details: new Set(), keys: new Set() };
				categories.set(item.category, accumulator);
			}
			for (const key of item.countKeys ?? []) {
				const safe = oneLine(key);
				if (safe) accumulator.keys.add(safe);
			}
			accumulator.count += normalizedCount(item);
			const detail = oneLine(item.detail ?? "");
			if (detail) accumulator.details.add(detail);
			const nextTarget = activityTarget(item.target ?? "");
			if (nextTarget) target = nextTarget;
		}
	}
	return summarizeToolActivityAggregate(
		{
			categories: [...categories.entries()].map(([category, accumulator]) => ({
				category,
				count: accumulator.keys.size + accumulator.count,
				details: [...accumulator.details],
			})),
			firstIssueLabel,
			outcome: effectiveToolActivityOutcome(members),
			stateCounts,
			target,
		},
		closed,
	);
}
