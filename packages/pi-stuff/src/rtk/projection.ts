import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import {
	aggregateLinterOutput,
	aggregateTestOutput,
	compactGitOutput,
	filterBuildOutput,
	groupSearchResults,
	stripAnsiFast,
	truncate,
} from "./upstream/techniques/index.ts";

const DEFAULT_MAX_CHARS = 12_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_RECORDED_RESULTS = 10_000;
const PROJECTION_MARK = Symbol.for("@jczhang02/pi-stuff-rtk/projected/v1");

export interface ContextProjectionAdapter {
	readonly id: string;
	project(messages: AgentMessage[], signal?: AbortSignal): AgentMessage[];
}

export interface RtkProjectionOptions {
	readonly enabled?: () => boolean;
	readonly maxChars?: number;
}

export interface RtkProjectionStatsSnapshot {
	readonly originalChars: number;
	readonly projectedChars: number;
	readonly resultCount: number;
	readonly savedChars: number;
	readonly techniques: Readonly<Record<string, number>>;
}

interface CachedProjection {
	readonly cacheBytes: number;
	readonly content: ToolResultMessage["content"];
	readonly originalChars: number;
	readonly projectedChars: number;
	readonly techniques: readonly string[];
}

interface TextProjection {
	readonly techniques: readonly string[];
	readonly text: string;
}

function isProjected(message: AgentMessage): boolean {
	return Object.getOwnPropertyDescriptor(message, PROJECTION_MARK)?.value === true;
}

function markProjected<Message extends AgentMessage>(message: Message): Message {
	Object.defineProperty(message, PROJECTION_MARK, { configurable: false, enumerable: false, value: true });
	return message;
}

function commandByToolCall(messages: readonly AgentMessage[]): Map<string, string> {
	const commands = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "bash") continue;
			const command = part.arguments["command"];
			if (Guard.IsString(command)) commands.set(part.id, command);
		}
	}
	return commands;
}

function commandForDetection(command: string | undefined): string | undefined {
	if (!command) return undefined;
	const withoutAssignments = command
		.trimStart()
		.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/u, "");
	return withoutAssignments.startsWith("rtk ") ? withoutAssignments.slice(4).trimStart() : withoutAssignments;
}

function applyTechnique(
	current: string,
	techniques: string[],
	name: string,
	transform: (text: string) => string | null,
): string {
	const next = transform(current);
	if (next === null || next === current) return current;
	techniques.push(name);
	return next;
}

function projectBashText(text: string, command: string | undefined, maxChars: number): TextProjection {
	const techniques: string[] = [];
	let current = stripAnsiFast(text);
	if (current !== text) techniques.push("ansi");
	const detectionCommand = commandForDetection(command);
	current = applyTechnique(current, techniques, "build", (value) => filterBuildOutput(value, detectionCommand));
	current = applyTechnique(current, techniques, "test", (value) => aggregateTestOutput(value, detectionCommand));
	current = applyTechnique(current, techniques, "git", (value) => compactGitOutput(value, detectionCommand));
	current = applyTechnique(current, techniques, "linter", (value) => aggregateLinterOutput(value, detectionCommand));
	if (current.length > maxChars) {
		current = truncate(current, maxChars);
		techniques.push("truncate");
	}
	return { techniques, text: current };
}

function projectGrepText(text: string, maxChars: number): TextProjection {
	const techniques: string[] = [];
	let current = stripAnsiFast(text);
	if (current !== text) techniques.push("ansi");
	current = applyTechnique(current, techniques, "search", groupSearchResults);
	if (current.length > maxChars) {
		current = truncate(current, maxChars);
		techniques.push("truncate");
	}
	return { techniques, text: current };
}

function cloneContent(content: ToolResultMessage["content"]): ToolResultMessage["content"] {
	return content.map((part) => ({ ...part }));
}

function projectionBytes(content: ToolResultMessage["content"]): number {
	return content.reduce(
		(total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text, "utf8") : part.data.length),
		0,
	);
}

export class RtkProjectionAdapter implements ContextProjectionAdapter {
	readonly id = "./index.js";
	private readonly cache = new Map<string, CachedProjection>();
	private cacheBytes = 0;
	private readonly enabled: () => boolean;
	private readonly maxChars: number;
	private originalChars = 0;
	private projectedChars = 0;
	private readonly recordedResults = new Set<string>();
	private resultCount = 0;
	private readonly techniqueCounts = new Map<string, number>();

	constructor(options: RtkProjectionOptions = {}) {
		this.enabled = options.enabled ?? (() => true);
		this.maxChars = Math.max(1_000, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
	}

	project(messages: AgentMessage[], _signal?: AbortSignal): AgentMessage[] {
		if (!this.enabled()) return messages;
		try {
			const commands = commandByToolCall(messages);
			let changed = false;
			const projected = messages.map((message) => {
				if (message.role !== "toolResult" || message.isError || isProjected(message)) return message;
				if (message.toolName !== "bash" && message.toolName !== "grep") return message;
				const command = commands.get(message.toolCallId);
				const result = this.projectResult(message, command);
				if (!result) return message;
				changed = true;
				return markProjected({ ...message, content: cloneContent(result.content) });
			});
			return changed ? projected : messages;
		} catch {
			return messages;
		}
	}

	reset(): void {
		this.cache.clear();
		this.cacheBytes = 0;
		this.originalChars = 0;
		this.projectedChars = 0;
		this.recordedResults.clear();
		this.resultCount = 0;
		this.techniqueCounts.clear();
	}

	stats(): RtkProjectionStatsSnapshot {
		return {
			originalChars: this.originalChars,
			projectedChars: this.projectedChars,
			resultCount: this.resultCount,
			savedChars: Math.max(0, this.originalChars - this.projectedChars),
			techniques: Object.fromEntries(this.techniqueCounts),
		};
	}

	private projectResult(message: ToolResultMessage, command: string | undefined): CachedProjection | undefined {
		const cached = this.cache.get(message.toolCallId);
		if (cached) {
			this.cache.delete(message.toolCallId);
			this.cache.set(message.toolCallId, cached);
			return cached.projectedChars === cached.originalChars ? undefined : cached;
		}

		let changed = false;
		let originalChars = 0;
		let projectedChars = 0;
		const techniques = new Set<string>();
		const content = message.content.map((part) => {
			if (part.type !== "text") return part;
			const projection =
				message.toolName === "bash"
					? projectBashText(part.text, command, this.maxChars)
					: projectGrepText(part.text, this.maxChars);
			originalChars += part.text.length;
			projectedChars += projection.text.length;
			for (const technique of projection.techniques) techniques.add(technique);
			if (projection.text === part.text) return part;
			changed = true;
			return { ...part, text: projection.text };
		});
		const result = {
			cacheBytes: changed ? projectionBytes(content) : 0,
			content: changed ? content : [],
			originalChars,
			projectedChars,
			techniques: [...techniques],
		};
		this.cacheResult(message.toolCallId, result);
		this.record(message.toolCallId, result);
		return changed ? result : undefined;
	}

	private cacheResult(toolCallId: string, result: CachedProjection): void {
		const previous = this.cache.get(toolCallId);
		if (previous) this.cacheBytes -= previous.cacheBytes;
		this.cache.delete(toolCallId);
		if (result.cacheBytes > MAX_CACHE_BYTES) return;
		this.cache.set(toolCallId, result);
		this.cacheBytes += result.cacheBytes;
		while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cacheBytes -= this.cache.get(oldest)?.cacheBytes ?? 0;
			this.cache.delete(oldest);
		}
	}

	private record(toolCallId: string, result: CachedProjection): void {
		if (this.recordedResults.has(toolCallId) || this.recordedResults.size >= MAX_RECORDED_RESULTS) return;
		this.recordedResults.add(toolCallId);
		this.originalChars += result.originalChars;
		this.projectedChars += result.projectedChars;
		this.resultCount += 1;
		for (const technique of result.techniques) {
			this.techniqueCounts.set(technique, (this.techniqueCounts.get(technique) ?? 0) + 1);
		}
	}
}

export function createRtkProjectionAdapter(options: RtkProjectionOptions = {}): RtkProjectionAdapter {
	return new RtkProjectionAdapter(options);
}
