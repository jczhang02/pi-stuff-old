import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	type ActivityCategoryAggregate,
	type ActivitySummaryMember,
	effectiveToolActivityOutcome,
	type PlannedToolActivityMember,
	type ToolActivityAggregate,
	type ToolActivityCategory,
	type ToolActivityItem,
	type ToolArguments,
} from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { classifyTerminalState } from "./tool-text.ts";

const ERROR_RESULT_SCHEMA = Type.Object({ isError: Type.Literal(true) }, { additionalProperties: true });

interface IndexedCategory {
	numericCount: number;
	readonly details: Map<
		string,
		{
			readonly detail: string;
			readonly itemIndex: number;
			readonly order: number;
		}
	>;
	readonly keyRefs: Map<string, number>;
}

interface IndexedSummaryMember extends ActivitySummaryMember {
	readonly order: number;
	readonly signature: string;
	readonly target: string;
}

export class GroupSummaryIndex {
	private cachedAggregate: ToolActivityAggregate | undefined;
	private readonly categories = new Map<ToolActivityCategory, IndexedCategory>();
	private firstIssueId: string | undefined;
	private readonly members = new Map<string, IndexedSummaryMember>();
	private readonly stateCounts: Partial<Record<ToolActivityState, number>> = {};
	private latestTargetOrder = -1;
	private readonly targetsByOrder: string[] = [];

	get size(): number {
		return this.members.size;
	}

	upsert(id: string, order: number, member: ActivitySummaryMember): boolean {
		const target =
			member.items
				.map((item) => item.target ?? "")
				.filter(Boolean)
				.at(-1) ?? "";
		const signature = JSON.stringify([
			member.state,
			member.issueLabel ?? "",
			member.issueDetail ?? "",
			member.items,
			target,
		]);
		const previous = this.members.get(id);
		if (previous?.signature === signature && previous.order === order) return false;
		this.cachedAggregate = undefined;
		if (previous) this.remove(id, previous);
		const indexed: IndexedSummaryMember = {
			...member,
			order,
			signature,
			target,
		};
		this.members.set(id, indexed);
		this.stateCounts[indexed.state] = (this.stateCounts[indexed.state] ?? 0) + 1;
		this.updateTarget(previous, indexed);
		indexed.items.forEach((item, itemIndex) => {
			this.addItem(id, indexed.order, itemIndex, item);
		});
		if (isIssueState(indexed.state)) {
			const first = this.firstIssueId ? this.members.get(this.firstIssueId) : undefined;
			if (!first || indexed.order < first.order) this.firstIssueId = id;
		}
		return true;
	}

	issue() {
		const first = this.firstIssueId ? this.members.get(this.firstIssueId) : undefined;
		return {
			count: (this.stateCounts.error ?? 0) + (this.stateCounts.rejected ?? 0) + (this.stateCounts.cancelled ?? 0),
			detail: first?.issueDetail ?? first?.issueLabel,
			id: this.firstIssueId,
		};
	}

	aggregate(): ToolActivityAggregate {
		if (this.cachedAggregate) return this.cachedAggregate;
		const target = this.targetsByOrder[this.latestTargetOrder] ?? "";
		const categories: ActivityCategoryAggregate[] = [];
		for (const [category, indexed] of this.categories) {
			categories.push({
				category,
				count: indexed.keyRefs.size + indexed.numericCount,
				details: [...indexed.details.values()]
					.sort((left, right) => left.order - right.order || left.itemIndex - right.itemIndex)
					.map((entry) => entry.detail),
			});
		}
		const firstIssueLabel = this.firstIssueId ? this.members.get(this.firstIssueId)?.issueLabel : undefined;
		const aggregate: ToolActivityAggregate = {
			categories,
			outcome: effectiveToolActivityOutcome(
				[...this.members.values()].sort((left, right) => left.order - right.order),
			),
			stateCounts: { ...this.stateCounts },
			target,
		};
		if (firstIssueLabel) Object.assign(aggregate, { firstIssueLabel });
		this.cachedAggregate = aggregate;
		return this.cachedAggregate;
	}

	private addItem(id: string, order: number, itemIndex: number, item: ToolActivityItem): void {
		let category = this.categories.get(item.category);
		if (!category) {
			category = { numericCount: 0, details: new Map(), keyRefs: new Map() };
			this.categories.set(item.category, category);
		}
		if (item.countKeys && item.countKeys.length > 0) {
			for (const rawKey of item.countKeys) {
				const key = canonicalCountKey(item.category, rawKey);
				category.keyRefs.set(key, (category.keyRefs.get(key) ?? 0) + 1);
			}
		} else {
			const count = Number.isFinite(item.count ?? 1) ? Math.max(0, Math.floor(item.count ?? 1)) : 0;
			category.numericCount += count;
		}
		if (item.detail)
			category.details.set(`${id}\u0000${String(itemIndex)}`, {
				detail: item.detail,
				itemIndex,
				order,
			});
	}

	private remove(id: string, member: IndexedSummaryMember): void {
		this.members.delete(id);
		this.stateCounts[member.state] = Math.max(0, (this.stateCounts[member.state] ?? 0) - 1);
		member.items.forEach((item, itemIndex) => {
			const category = this.categories.get(item.category);
			if (!category) return;
			if (item.countKeys && item.countKeys.length > 0) {
				for (const rawKey of item.countKeys) {
					const key = canonicalCountKey(item.category, rawKey);
					const next = (category.keyRefs.get(key) ?? 0) - 1;
					if (next > 0) category.keyRefs.set(key, next);
					else category.keyRefs.delete(key);
				}
			} else {
				const count = Number.isFinite(item.count ?? 1) ? Math.max(0, Math.floor(item.count ?? 1)) : 0;
				category.numericCount = Math.max(0, category.numericCount - count);
			}
			category.details.delete(`${id}\u0000${String(itemIndex)}`);
			if (category.numericCount === 0 && category.keyRefs.size === 0 && category.details.size === 0) {
				this.categories.delete(item.category);
			}
		});
		if (this.firstIssueId === id) {
			this.firstIssueId = [...this.members.entries()]
				.filter(([, candidate]) => isIssueState(candidate.state))
				.sort(([, left], [, right]) => left.order - right.order)[0]?.[0];
		}
	}

	private updateTarget(previous: IndexedSummaryMember | undefined, member: IndexedSummaryMember): void {
		if (previous && previous.order !== member.order) this.targetsByOrder[previous.order] = "";
		this.targetsByOrder[member.order] = member.target;
		if (member.target && member.order >= this.latestTargetOrder) this.latestTargetOrder = member.order;
		while (this.latestTargetOrder >= 0 && !this.targetsByOrder[this.latestTargetOrder]) this.latestTargetOrder -= 1;
	}
}

export function isIssueState(state: ToolActivityState): state is "cancelled" | "error" | "rejected" {
	return state === "error" || state === "rejected" || state === "cancelled";
}

export function assistantTerminalState<StopReason>(stopReason: StopReason): "cancelled" | "error" | undefined {
	return stopReason === "aborted" ? "cancelled" : stopReason === "error" ? "error" : undefined;
}

export function canonicalCountKey(category: ToolActivityCategory, key: string, cwd = process.cwd()): string {
	if (category === "fetch-page") {
		try {
			const url = new URL(key);
			url.hash = "";
			return url.href;
		} catch {
			return key;
		}
	}
	if (
		category !== "read-file" &&
		category !== "change-file" &&
		category !== "view-image" &&
		category !== "generate-image"
	)
		return key;
	const expanded = key === "~" ? homedir() : key.startsWith("~/") ? resolve(homedir(), key.slice(2)) : key;
	return resolve(cwd, expanded);
}

const SUCCESS_ONLY_ACTIVITY_CATEGORIES = new Set<ToolActivityCategory>([
	"block-goal",
	"change-file",
	"commit",
	"complete-goal",
	"connect-mcp",
	"create-pr",
	"generate-image",
	"launch-agent",
	"launch-background",
	"message-agent",
	"merge",
	"push",
	"rebase",
	"record-result",
	"resume-agent",
	"save-memory",
	"save-note",
	"start-monitor",
	"steer-agent",
	"stop-background",
	"stop-agent",
	"update-memory",
	"update-note",
	"update-task",
]);

export function visibleActivityItems(
	items: readonly ToolActivityItem[],
	state: ToolActivityState,
): readonly ToolActivityItem[] {
	return isIssueState(state) ? items.filter((item) => !SUCCESS_ONLY_ACTIVITY_CATEGORIES.has(item.category)) : items;
}

export function terminalStateFromResult(
	member: PlannedToolActivityMember,
	resultIsError: ((args: ToolArguments, result: AgentToolResult<unknown>) => boolean) | undefined,
): ToolActivityState {
	if (member.terminalState) return member.terminalState;
	if (!member.result) return "running";
	let domainError = Check(ERROR_RESULT_SCHEMA, member.result);
	if (!domainError && resultIsError) {
		try {
			domainError = resultIsError(member.args, member.result);
		} catch {
			domainError = true;
		}
	}
	return classifyTerminalState(member.result, domainError);
}
