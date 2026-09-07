import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { StatuslineContextUsage } from "./statusline-render.ts";
import { sanitizeOneLine } from "./terminal-text.ts";

export interface UsageTotals {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	input: number;
}

export interface PromptPreview {
	readonly skills: readonly string[];
	readonly text: string | undefined;
}

export interface SessionStatusSnapshot {
	readonly latestPrompt: PromptPreview | undefined;
	readonly usage: UsageTotals;
}

export type StatuslineSessionManager = Pick<
	ExtensionContext["sessionManager"],
	"getCwd" | "getEntry" | "getLeafId" | "getSessionId"
>;

/**
 * Incrementally derives the session-backed fields from Pi's append-only entry
 * tree. A repaint only reads the current leaf id; new tails are folded until a
 * cached ancestor is reached, including after tree navigation or compaction.
 */
export class SessionStatusSource {
	private activeLeafId: string | null | undefined;
	private readonly byEntryId = new Map<string, SessionStatusSnapshot>();
	private contextUsage:
		| {
				readonly leafId: string | null;
				readonly model: ExtensionContext["model"];
				readonly value: StatuslineContextUsage | undefined;
		  }
		| undefined;
	private readonly sessionManager: StatuslineSessionManager;
	private sessionId: string | undefined;
	private snapshot = emptySessionStatus();
	private readonly skillAliases: ReadonlyMap<string, string>;

	constructor(sessionManager: StatuslineSessionManager, skillAliases: ReadonlyMap<string, string>) {
		this.sessionManager = sessionManager;
		this.skillAliases = skillAliases;
	}

	get(): SessionStatusSnapshot {
		let leafId: string | null;
		let sessionId: string;
		try {
			sessionId = this.sessionManager.getSessionId();
			leafId = this.sessionManager.getLeafId();
		} catch {
			return emptySessionStatus();
		}

		if (sessionId !== this.sessionId) this.reset(sessionId);
		if (leafId === this.activeLeafId) return this.snapshot;
		if (leafId === null) {
			this.activeLeafId = null;
			this.snapshot = emptySessionStatus();
			return this.snapshot;
		}

		let next: SessionStatusSnapshot | undefined;
		try {
			next = this.buildSnapshot(leafId);
		} catch {
			// A partial third-party SessionManager must not take down the TUI. Do
			// not cache the failure, so a later repaint can recover automatically.
			return emptySessionStatus();
		}
		if (!next) return emptySessionStatus();

		this.activeLeafId = leafId;
		this.snapshot = next;
		return next;
	}

	private buildSnapshot(leafId: string): SessionStatusSnapshot | undefined {
		const tail: SessionEntry[] = [];
		const visited = new Set<string>();
		let ancestor = emptySessionStatus();
		let entryId: string | null = leafId;

		while (entryId !== null) {
			const cached = this.byEntryId.get(entryId);
			if (cached) {
				ancestor = cached;
				break;
			}
			if (visited.has(entryId)) return undefined;
			visited.add(entryId);

			const entry = this.sessionManager.getEntry(entryId);
			if (!entry || entry.id !== entryId) return undefined;
			tail.push(entry);
			entryId = entry.parentId;
		}

		for (let index = tail.length - 1; index >= 0; index -= 1) {
			const entry = tail[index];
			if (!entry) continue;
			ancestor = extendSessionStatus(ancestor, entry, this.skillAliases);
			this.byEntryId.set(entry.id, ancestor);
		}
		return ancestor;
	}

	readContextUsage(
		model: ExtensionContext["model"],
		hostIdle: boolean,
		read: () => StatuslineContextUsage | undefined,
	): StatuslineContextUsage | null | undefined {
		let leafId: string | null;
		try {
			const sessionId = this.sessionManager.getSessionId();
			leafId = this.sessionManager.getLeafId();
			if (sessionId !== this.sessionId) this.reset(sessionId);
		} catch {
			const cached = this.contextUsage;
			if (hostIdle) return readContextUsageSafely(read);
			return cached && cached.model === model ? cached.value : undefined;
		}
		const cached = this.contextUsage;
		// A settled Session branch is immutable, so Session leaf plus model identifies
		// exact usage. Reuse it during idle input repaints and while the Host is working.
		if (cached && model === cached.model && (leafId === cached.leafId || !hostIdle)) return cached.value;
		if (!hostIdle) return;
		const value = readContextUsageSafely(read);
		if (value === null) return null;
		this.contextUsage = { leafId, model, value };
		return value;
	}

	private reset(sessionId: string): void {
		this.sessionId = sessionId;
		this.activeLeafId = undefined;
		this.snapshot = emptySessionStatus();
		this.byEntryId.clear();
		this.contextUsage = undefined;
	}
}

function readContextUsageSafely(
	read: () => StatuslineContextUsage | undefined,
): StatuslineContextUsage | null | undefined {
	try {
		return read();
	} catch {
		return null;
	}
}

export function readSkillAliases(pi: Pick<ExtensionAPI, "getCommands">): ReadonlyMap<string, string> {
	const aliases = new Map<string, string>();
	try {
		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			const name = sanitizeOneLine(command.name);
			const skill = normalizeSkillName(name);
			if (name && skill) aliases.set(name.toLowerCase(), skill);
		}
	} catch {
		// Registry discovery is optional presentation data.
	}
	return aliases;
}

function emptySessionStatus(): SessionStatusSnapshot {
	return { latestPrompt: undefined, usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0 } };
}

function extendSessionStatus(
	previous: SessionStatusSnapshot,
	entry: SessionEntry,
	skillAliases: ReadonlyMap<string, string>,
): SessionStatusSnapshot {
	const usage = { ...previous.usage };
	let latestPrompt = previous.latestPrompt;
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			addUsage(usage, message.usage);
		}
		if (message.role === "user") latestPrompt = userPrompt(message.content, skillAliases) ?? latestPrompt;
	}
	return { latestPrompt, usage };
}

function userPrompt(
	content: string | ReadonlyArray<{ type: string; text?: string }>,
	skillAliases: ReadonlyMap<string, string>,
): PromptPreview | undefined {
	const text = isRuntimeString(content)
		? content
		: content
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && !!part.text)
				.map((part) => part.text)
				.join(" ");
	return buildPromptPreview(text, skillAliases);
}

function buildPromptPreview(rawText: string, skillAliases: ReadonlyMap<string, string>): PromptPreview | undefined {
	const parsed = parseSkillBlock(rawText);
	if (parsed) {
		const skill = normalizeSkillName(parsed.name);
		const userText = parsed.userMessage ?? extractEmbeddedSkillUserText(parsed.content);
		const rawPreview = rawSkillPromptPreview(userText ?? "", skillAliases);
		return promptPreview(rawPreview.text, uniqueSkills([...(skill ? [skill] : []), ...rawPreview.skills]));
	}

	const source = rawText;
	const skills: string[] = [];
	for (const match of source.matchAll(/<skill\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
		const skill = normalizeSkillName(match[1] ?? "");
		if (skill && !skills.includes(skill)) skills.push(skill);
	}
	const embeddedUserText = extractEmbeddedSkillUserText(source);
	if (embeddedUserText) {
		const rawPreview = rawSkillPromptPreview(embeddedUserText, skillAliases);
		return promptPreview(rawPreview.text, uniqueSkills([...skills, ...rawPreview.skills]));
	}

	const withoutSkillPayloads = source
		.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/giu, " ")
		.replace(/<skill\b[^>]*>[\s\S]*$/giu, " ");
	const rawPreview = rawSkillPromptPreview(withoutSkillPayloads, skillAliases);
	return promptPreview(rawPreview.text, uniqueSkills([...skills, ...rawPreview.skills]));
}

function rawSkillPromptPreview(value: string, aliases: ReadonlyMap<string, string>) {
	const skills: string[] = [];
	const text = value.replace(/(^|\s)\/([^\s]+)/gu, (match, prefix: string, commandName: string) => {
		const skill = aliases.get(commandName.toLowerCase());
		if (!skill) return match;
		skills.push(skill);
		return prefix;
	});
	return { skills: uniqueSkills(skills), text: sanitizeOneLine(text) || undefined };
}

function uniqueSkills(values: readonly string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function extractEmbeddedSkillUserText(value: string): string | undefined {
	let latest: string | undefined;
	for (const match of value.matchAll(/(?:^|\r?\n)\s*User:\s*([\s\S]*?)(?=\r?\n\s*<\/skill>|<\/skill>|$)/giu)) {
		const candidate = match[1]?.trim();
		if (candidate) latest = candidate;
	}
	return latest;
}

function normalizeSkillName(value: string): string {
	return sanitizeOneLine(value).replace(/^skill:/iu, "");
}

function promptPreview(text: string | undefined, skills: readonly string[]): PromptPreview | undefined {
	const normalizedText = text || undefined;
	if (!normalizedText && skills.length === 0) return undefined;
	return { skills, text: normalizedText };
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	if (Number.isFinite(usage.input) && usage.input > 0) totals.input += usage.input;
	if (Number.isFinite(usage.cacheRead) && usage.cacheRead > 0) totals.cacheRead += usage.cacheRead;
	if (Number.isFinite(usage.cacheWrite) && usage.cacheWrite > 0) totals.cacheWrite += usage.cacheWrite;
	if (Number.isFinite(usage.cost.total) && usage.cost.total > 0) totals.cost += usage.cost.total;
}
