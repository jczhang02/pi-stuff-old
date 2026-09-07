import { basename } from "node:path";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isRuntimeNumber } from "../shared/runtime-type.ts";
import type {
	CodexStatusSnapshot,
	ContextStatusSnapshot,
	GoalStatus,
	GoalStatusSnapshot,
} from "./statusline-channels.ts";
import type { GitChangeCounts } from "./statusline-git.ts";
import type { PromptPreview, UsageTotals } from "./statusline-session.ts";
import { sanitizeOneLine } from "./terminal-text.ts";

const MIN_TRUNCATED_PROMPT_WIDTH = 6;
const STATUSLINE_SEPARATOR = " · ";

export type StatuslineDensity = "auto" | "full" | "compact";

export interface StatuslineContextUsage {
	readonly contextWindow: number | null;
	readonly percent: number | null;
}

export interface StatuslineRenderInput {
	readonly branch: string;
	readonly codexStatus: CodexStatusSnapshot | undefined;
	readonly contextStatus: ContextStatusSnapshot | undefined;
	readonly contextUsage: StatuslineContextUsage | null | undefined;
	readonly cwd: string;
	readonly density: StatuslineDensity;
	readonly extensionStatuses: ReadonlyMap<string, string>;
	readonly extensionStatusKeys: readonly string[];
	readonly gitChanges: GitChangeCounts | undefined;
	readonly goalStatus: GoalStatusSnapshot | undefined;
	readonly latestPrompt: PromptPreview | undefined;
	readonly model: ExtensionContext["model"];
	readonly now: number;
	readonly showCost: boolean;
	readonly thinkingLevel: string | undefined;
	readonly usage: UsageTotals;
	readonly width: number;
}

const STATUSLINE_ICONS = {
	ahead: "\uF431",
	behind: "\uF433",
	branch: "\uF418",
	cache: "\u{F01BC}",
	conflict: "\uF421",
	context: "\u{F0328}",
	cost: "\uF155",
	fast: "\uF0E7",
	folder: "\u{F024B}",
	goalActive: "\uF111",
	goalAttention: "\uF06A",
	goalComplete: "\uF49E",
	goalPaused: "\uF28B",
	model: "\u{F167A}",
	prompt: "\uF460",
	staged: "\uF457",
	thinking: "\uF0EB",
	unstaged: "\u{F03EB}",
	untracked: "\u{F0752}",
	weekly: "\u{F029A}",
};

type StatuslineIcons = typeof STATUSLINE_ICONS;

type StatusSegmentId =
	| "model"
	| "thinking"
	| "fast"
	| "cwd"
	| "branch"
	| "diff"
	| "context"
	| "cache"
	| "cost"
	| "codex"
	| "goal"
	| "extension";

interface StatusSegment {
	readonly compact: string;
	readonly full: string;
	readonly id: StatusSegmentId;
	readonly minimum?: string;
	readonly priority: number;
}

interface SegmentText {
	readonly compact: string;
	readonly full: string;
}

interface GoalStatusAppearance {
	readonly color: ThemeColor;
	readonly icon: string;
	readonly label: string;
}

interface GitSegments {
	branch?: SegmentText;
	diff?: SegmentText;
}

export function renderStatusline(theme: Theme, input: StatuslineRenderInput): string[] {
	const icons = STATUSLINE_ICONS;
	const segments: StatusSegment[] = [];
	const modelName = displayModelIdentity(input.model);
	const model = theme.fg("accent", withIcon(icons.model, modelName));
	const compactModel = theme.fg("accent", withIcon(icons.model, displayCompactModelName(input.model)));
	const minimumModel = theme.fg("accent", icons.model);
	segments.push(statusSegment("model", 100, model, compactModel, minimumModel));
	if (input.model?.reasoning !== false) {
		const thinkingLevel = input.thinkingLevel ?? "off";
		const thinking = `${theme.fg(thinkingColor(thinkingLevel), icons.thinking)} ${theme.fg(
			"muted",
			formatThinking(thinkingLevel),
		)}`;
		segments.push(statusSegment("thinking", 65, thinking));
	}
	if (input.model?.provider === "openai-codex" && input.codexStatus?.fastEnabled === true) {
		segments.push(statusSegment("fast", 55, theme.fg("warning", withIcon(icons.fast, "fast"))));
	}
	const cwd = sanitizeOneLine(input.cwd) || ".";
	const cwdText = basename(cwd) || cwd;
	const cwdSegment = `${theme.fg("accent", icons.folder)} ${theme.fg("text", cwdText)}`;
	segments.push(statusSegment("cwd", 95, cwdSegment));

	const gitSegments = renderGitSegments(theme, icons, input.branch, input.gitChanges);
	if (gitSegments.branch) {
		segments.push(statusSegment("branch", 90, gitSegments.branch.full, gitSegments.branch.compact));
	}
	if (gitSegments.diff) segments.push(statusSegment("diff", 50, gitSegments.diff.full, gitSegments.diff.compact));

	const contextSegment = renderContextSegment(
		input.contextStatus,
		input.contextUsage,
		input.model?.contextWindow,
		theme,
		icons,
		input.extensionStatuses,
	);
	if (contextSegment) segments.push(statusSegment("context", 96, contextSegment.full, contextSegment.compact));
	const cacheHitRate = formatCacheHitRate(input.usage);
	if (cacheHitRate) {
		const cache = `${theme.fg("muted", icons.cache)} ${theme.fg("text", cacheHitRate)}`;
		segments.push(statusSegment("cache", 45, cache));
	}
	if (input.model?.provider === "openai-codex") {
		const weekly = formatCodexWeekly(input.codexStatus);
		if (weekly) {
			const value = `${theme.fg("warning", icons.weekly)} ${theme.fg("text", weekly)}`;
			segments.push(statusSegment("codex", 80, value));
		}
	} else if (input.usage.cost > 0 && input.showCost) {
		const cost = `${theme.fg("warning", icons.cost)} ${theme.fg("text", `$${input.usage.cost.toFixed(2)}`)}`;
		segments.push(statusSegment("cost", 80, cost));
	}
	const goal = renderGoalSegment(theme, icons, input.goalStatus, input.now);
	if (goal) segments.push(statusSegment("goal", 99, goal.full, goal.compact));

	const extensionStatusSegment = renderExtensionStatusSegment(
		theme,
		input.extensionStatuses,
		input.extensionStatusKeys,
	);
	if (extensionStatusSegment) segments.push(statusSegment("extension", 35, extensionStatusSegment));

	const status = renderStatusRow(segments, input.width, theme, input.density);
	const prompt = renderPromptRow(input.latestPrompt, input.width, theme, icons);
	return [status, prompt]
		.filter((line): line is string => line !== undefined && line.length > 0)
		.map((line) =>
			visibleWidth(line) <= input.width ? line : truncateToWidth(line, input.width, theme.fg("dim", "…")),
		);
}

function statusSegment(
	id: StatusSegmentId,
	priority: number,
	full: string,
	compact = full,
	minimum?: string,
): StatusSegment {
	const segment: StatusSegment = { compact, full, id, priority };
	if (minimum) Object.assign(segment, { minimum });
	return segment;
}

function renderGitSegments(theme: Theme, icons: StatuslineIcons, branch: string, counts: GitChangeCounts | undefined) {
	const ahead = counts?.ahead ?? 0;
	const behind = counts?.behind ?? 0;
	const conflicted = counts?.conflicted ?? 0;
	const dirty = !!counts && (counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0 || conflicted > 0);
	const branchColor: ThemeColor = conflicted > 0 ? "error" : dirty || behind > 0 ? "warning" : "success";
	let branchSegment: SegmentText | undefined;
	if (branch) {
		const tracking = [
			ahead > 0 ? theme.fg("success", `${icons.ahead}${String(ahead)}`) : "",
			behind > 0 ? theme.fg("warning", `${icons.behind}${String(behind)}`) : "",
		].filter(Boolean);
		const fullBranch = `${theme.fg(branchColor, icons.branch)} ${theme.fg("text", branch)}`;
		const compactBranch = `${theme.fg(branchColor, icons.branch)} ${theme.fg("text", middleTruncate(branch, 14))}`;
		branchSegment = {
			compact: [compactBranch, ...tracking].join(" "),
			full: [fullBranch, ...tracking].join(" "),
		};
	}

	const fullState: string[] = [];
	if (conflicted > 0) fullState.push(theme.fg("error", `${icons.conflict}${String(conflicted)}`));
	if (counts?.staged) fullState.push(theme.fg("success", `${icons.staged}${String(counts.staged)}`));
	if (counts?.unstaged) fullState.push(theme.fg("warning", `${icons.unstaged}${String(counts.unstaged)}`));
	if (counts?.untracked) fullState.push(theme.fg("muted", `${icons.untracked}${String(counts.untracked)}`));
	const compactState: string[] = [];
	if (conflicted > 0) compactState.push(theme.fg("error", `${icons.conflict}${compactCount(conflicted)}`));
	const changed = (counts?.staged ?? 0) + (counts?.unstaged ?? 0) + (counts?.untracked ?? 0);
	if (changed > 0) compactState.push(theme.fg("warning", `${icons.unstaged}${compactCount(changed)}`));
	const diffSegment =
		fullState.length > 0
			? {
					compact: compactState.join(" "),
					full: fullState.join(" "),
				}
			: undefined;
	const segments: GitSegments = {};
	if (branchSegment) segments.branch = branchSegment;
	if (diffSegment) segments.diff = diffSegment;
	return segments;
}

function compactCount(value: number): string {
	return value > 99 ? "99+" : String(value);
}

function renderContextSegment(
	status: ContextStatusSnapshot | undefined,
	usage: StatuslineContextUsage | null | undefined,
	modelContextWindow: number | undefined,
	theme: Theme,
	icons: StatuslineIcons,
	statuses: ReadonlyMap<string, string>,
): SegmentText | undefined {
	if (statuses.has("compact-policy")) return undefined;
	if (status) {
		if (status.state !== "validated") {
			const text = status.phase ? `${status.state}: ${status.phase}` : status.state;
			return {
				compact: `${theme.fg("dim", icons.context)} ${theme.fg("text", status.state)}`,
				full: `${theme.fg("dim", icons.context)} ${theme.fg("text", text)}`,
			};
		}
		const contextWindow = status.contextWindow;
		const tokens = status.tokens;
		if (
			isRuntimeNumber(tokens) &&
			Number.isFinite(tokens) &&
			isRuntimeNumber(contextWindow) &&
			Number.isFinite(contextWindow) &&
			contextWindow > 0
		) {
			const percent = Math.max(0, Math.min(100, (tokens / contextWindow) * 100));
			const value = `${Math.round(percent)}%`;
			return {
				compact: `${theme.fg("dim", icons.context)} ${theme.fg("text", value)}`,
				full: `${theme.fg("dim", icons.context)} ${theme.fg("text", value)}`,
			};
		}
		return {
			compact: `${theme.fg("dim", icons.context)} ${theme.fg("text", "unknown")}`,
			full: `${theme.fg("dim", icons.context)} ${theme.fg("text", "unknown")}`,
		};
	}
	if (usage === null) return undefined;
	const percent = usage?.percent;
	const knownPercent = isRuntimeNumber(percent) && Number.isFinite(percent);
	const contextWindow = usage?.contextWindow ?? modelContextWindow;
	const knownWindow = isRuntimeNumber(contextWindow) && Number.isFinite(contextWindow) && contextWindow > 0;
	if (!knownPercent && !knownWindow) return undefined;
	const boundedPercent = knownPercent ? Math.max(0, percent) : undefined;
	const fullValue = boundedPercent === undefined ? "?" : `${boundedPercent.toFixed(1).replace(/\.0$/u, "")}%`;
	const compactValue = boundedPercent === undefined ? "?" : `${String(Math.round(boundedPercent))}%`;
	const color: ThemeColor =
		boundedPercent === undefined ? "dim" : boundedPercent >= 90 ? "error" : boundedPercent >= 70 ? "warning" : "dim";
	return {
		compact: `${theme.fg(color, icons.context)} ${theme.fg("text", compactValue)}`,
		full: `${theme.fg(color, icons.context)} ${theme.fg("text", fullValue)}`,
	};
}

function renderExtensionStatusSegment(
	theme: Theme,
	statuses: ReadonlyMap<string, string>,
	keys: readonly string[],
): string | undefined {
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const key of keys) {
		const status = sanitizeOneLine(statuses.get(key) ?? "");
		if (!status || status.startsWith("[") || seen.has(status)) continue;
		seen.add(status);
		selected.push(status);
	}
	return selected.length > 0 ? theme.fg("muted", selected.join(" · ")) : undefined;
}

function renderGoalSegment(
	theme: Theme,
	icons: StatuslineIcons,
	snapshot: GoalStatusSnapshot | undefined,
	now: number,
): SegmentText | undefined {
	if (!snapshot) return undefined;
	const appearance = goalStatusAppearance(snapshot.status, icons);
	const icon = theme.fg(appearance.color, appearance.icon);
	const identity = `${icon} ${theme.fg("text", "goal")}`;
	const budget =
		snapshot.tokenBudget === undefined
			? ""
			: theme.fg("text", `${formatCompactTokens(snapshot.tokensUsed)}/${formatCompactTokens(snapshot.tokenBudget)}`);
	const elapsed = theme.fg("muted", formatGoalElapsed(snapshot, now));
	const full = [identity, appearance.label && theme.fg(appearance.color, appearance.label), budget, elapsed]
		.filter(Boolean)
		.join(" ");
	return { compact: full, full };
}

function goalStatusAppearance(status: GoalStatus, icons: StatuslineIcons): GoalStatusAppearance {
	if (status === "paused") return { color: "muted", icon: icons.goalPaused, label: "paused" };
	if (status === "blocked") return { color: "warning", icon: icons.goalAttention, label: "blocked" };
	if (status === "usage_limited") return { color: "warning", icon: icons.goalAttention, label: "usage" };
	if (status === "budget_limited") return { color: "warning", icon: icons.goalAttention, label: "budget" };
	if (status === "complete") return { color: "success", icon: icons.goalComplete, label: "complete" };
	return { color: "accent", icon: icons.goalActive, label: "" };
}

function formatCompactTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return `${Number((value / 1_000_000).toFixed(1))}m`;
}

function formatGoalElapsed(snapshot: GoalStatusSnapshot, now: number): string {
	const liveSeconds =
		snapshot.status === "active" && snapshot.activeStartedAt !== undefined
			? Math.max(0, now - snapshot.activeStartedAt) / 1_000
			: 0;
	const seconds = Math.floor(snapshot.timeUsedSeconds + liveSeconds);
	if (seconds < 60) return `${String(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	return `${String(hours)}h${String(minutes % 60)}m`;
}

function renderStatusRow(
	segments: readonly StatusSegment[],
	width: number,
	theme: Theme,
	density: StatuslineDensity,
): string {
	const compactIds = new Set<StatusSegmentId>(["model", "thinking", "cwd", "branch", "context", "goal"]);
	const eligible = density === "compact" ? segments.filter((segment) => compactIds.has(segment.id)) : segments;
	if (eligible.length === 0 || width < 1) return "";
	const join = (items: readonly { readonly id: StatusSegmentId; readonly text: string }[]): string =>
		items
			.map((item, index) => {
				if (index === 0) return item.text;
				const separator =
					items[index - 1]?.id === "branch" && item.id === "diff" ? " " : theme.fg("dim", STATUSLINE_SEPARATOR);
				return `${separator}${item.text}`;
			})
			.join("");
	const full = join(eligible.map((segment) => ({ id: segment.id, text: segment.full })));
	if (density !== "compact" && visibleWidth(full) <= width) return full;

	const selected = eligible.map((segment) => ({
		...segment,
		text: density === "full" ? segment.full : segment.compact,
	}));
	const render = (): string => join(selected);
	while (selected.length > 1 && visibleWidth(render()) > width) {
		let removalIndex = 0;
		for (let index = 1; index < selected.length; index += 1) {
			if ((selected[index]?.priority ?? Number.POSITIVE_INFINITY) < (selected[removalIndex]?.priority ?? 0)) {
				removalIndex = index;
			}
		}
		selected.splice(removalIndex, 1);
	}
	const rendered = render();
	if (visibleWidth(rendered) <= width) return rendered;
	const minimum = selected[0]?.minimum;
	return minimum && visibleWidth(minimum) <= width ? minimum : "";
}

function renderPromptRow(
	prompt: PromptPreview | undefined,
	width: number,
	theme: Theme,
	icons: StatuslineIcons,
): string | undefined {
	if (!prompt || width < 2) return undefined;
	const promptText = prompt.text ?? "";
	const fullBadge = formatSkillBadge(prompt.skills, false);
	const compactBadge = formatSkillBadge(prompt.skills, true);
	const prefix = `${theme.fg("muted", icons.prompt)} `;
	const contentWidth = width - visibleWidth(prefix);
	if (contentWidth < 1) return truncateToWidth(prefix, width, "");
	const badge =
		fullBadge !== compactBadge && visibleWidth(joinPromptAndBadge(promptText, fullBadge)) > contentWidth
			? compactBadge
			: fullBadge;
	const content = fitPromptAndBadge(promptText, badge, contentWidth);
	return `${prefix}${theme.fg("muted", content)}`;
}

function fitPromptAndBadge(prompt: string, badge: string, width: number): string {
	if (!badge) return truncateToWidth(prompt, width, "…");
	const badgeWidth = visibleWidth(badge);
	if (badgeWidth >= width) return truncateToWidth(badge, width, "…");
	const promptWidth = Math.max(0, width - badgeWidth - (prompt ? 1 : 0));
	const fittedPrompt =
		visibleWidth(prompt) <= promptWidth || promptWidth >= MIN_TRUNCATED_PROMPT_WIDTH
			? truncateToWidth(prompt, promptWidth, "…")
			: "";
	return joinPromptAndBadge(fittedPrompt, badge);
}

function joinPromptAndBadge(prompt: string, badge: string): string {
	return [prompt, badge].filter(Boolean).join(" ");
}

function formatSkillBadge(skills: readonly string[], compact: boolean): string {
	if (skills.length === 0) return "";
	if (skills.length === 1) return `[skill:${skills[0] ?? ""}]`;
	return compact ? `[skills:${String(skills.length)}]` : `[skills:${skills.join(",")}]`;
}

function formatCacheHitRate(usage: UsageTotals): string | undefined {
	const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
	const percent = (usage.cacheRead / denominator) * 100;
	return `${percent.toFixed(1).replace(/\.0$/u, "")}%`;
}

function formatCodexWeekly(snapshot: CodexStatusSnapshot | undefined): string | undefined {
	if (!snapshot) return undefined;
	const weekly = snapshot.weeklyRemainingPercent;
	return isRuntimeNumber(weekly) && Number.isFinite(weekly)
		? `${String(Math.round(Math.max(0, Math.min(100, weekly))))}%`
		: undefined;
}

function formatThinking(level: string): string {
	if (level === "medium") return "med";
	if (level === "minimal") return "min";
	return ["high", "low", "max", "off", "xhigh"].includes(level) ? level : sanitizeOneLine(level);
}

function thinkingColor(level: string): ThemeColor {
	if (level === "high") return "thinkingHigh";
	if (level === "low") return "thinkingLow";
	if (level === "max") return "thinkingMax";
	if (level === "medium") return "thinkingMedium";
	if (level === "minimal") return "thinkingMinimal";
	if (level === "off") return "thinkingOff";
	if (level === "xhigh") return "thinkingXhigh";
	return "thinkingText";
}

function displayModelIdentity(model: ExtensionContext["model"]): string {
	const provider = sanitizeOneLine(model?.provider ?? "");
	const name = sanitizeOneLine(model?.id ?? model?.name ?? "no-model").replace(/^Claude\s+/u, "");
	if (!provider || name.startsWith(`${provider}/`)) return name || "no-model";
	return `${provider}/${name || "no-model"}`;
}

function displayCompactModelName(model: ExtensionContext["model"]): string {
	const name = sanitizeOneLine(model?.id ?? model?.name ?? "no-model").replace(/^Claude\s+/u, "");
	return middleTruncate(name || "no-model", 11);
}

function middleTruncate(value: string, maximumWidth: number): string {
	if (visibleWidth(value) <= maximumWidth) return value;
	if (maximumWidth <= 1) return truncateToWidth(value, maximumWidth, "…");
	const suffixWidth = Math.floor((maximumWidth - 1) / 2);
	const prefixWidth = maximumWidth - suffixWidth - 1;
	const prefix = truncateToWidth(value, prefixWidth, "");
	return `${prefix}…${visibleSuffix(value, suffixWidth)}`;
}

function visibleSuffix(value: string, maximumWidth: number): string {
	let suffix = "";
	for (const character of [...value].reverse()) {
		const candidate = `${character}${suffix}`;
		if (visibleWidth(candidate) > maximumWidth) break;
		suffix = candidate;
	}
	return suffix;
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}
