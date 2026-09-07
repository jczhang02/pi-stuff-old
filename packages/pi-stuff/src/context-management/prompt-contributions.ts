import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isJsonInputObject, type JsonInputObject, type JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";

const PROMPT_CONTRIBUTION_REGISTRY = Symbol.for("@jczhang02/pi-stuff-context/prompt-contributions/v1");
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/u;

export type ContextPromptHost = Pick<ExtensionAPI, "events">;

export interface ContextPromptContributor {
	readonly id: string;
	readonly order?: number;
	readonly renderAgent: (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => Promise<string | undefined> | string | undefined;
	readonly renderProvider?: (ctx: ExtensionContext) => Promise<string | undefined> | string | undefined;
}

interface RegisteredContributor {
	readonly contributor: ContextPromptContributor;
	readonly token: symbol;
}

interface ContextPromptContributionRegistry {
	readonly hosts: WeakMap<object, Map<string, RegisteredContributor>>;
}

export interface ProviderPromptProjection<Payload> {
	readonly active: boolean;
	readonly found: boolean;
	readonly payload: Payload | JsonInputValue;
}

interface PromptMarkers {
	readonly end: string;
	readonly start: string;
}

interface PromptArrayRewrite {
	readonly changed: boolean;
	readonly found: boolean;
	readonly value: readonly JsonInputValue[];
}

interface ProviderPayloadRewrite<Payload> {
	readonly found: boolean;
	readonly payload: Payload | JsonInputValue;
}

function registry(): ContextPromptContributionRegistry {
	// SAFETY: this global symbol owns only the Context contribution registry initialized immediately below.
	const root = globalThis as { [key: symbol]: ContextPromptContributionRegistry | undefined };
	root[PROMPT_CONTRIBUTION_REGISTRY] ??= { hosts: new WeakMap() };
	return root[PROMPT_CONTRIBUTION_REGISTRY];
}

function ownerKey(pi: ContextPromptHost): object {
	return isRuntimeObject(pi.events) && pi.events !== null ? pi.events : pi;
}

function contributors(pi: ContextPromptHost): RegisteredContributor[] {
	return [...(registry().hosts.get(ownerKey(pi))?.values() ?? [])].sort((left, right) => {
		const order = (left.contributor.order ?? 0) - (right.contributor.order ?? 0);
		return order || left.contributor.id.localeCompare(right.contributor.id);
	});
}

function markers(id: string): PromptMarkers {
	return {
		start: `<!-- pi-stuff:prompt-contribution:${id}:start -->`,
		end: `<!-- pi-stuff:prompt-contribution:${id}:end -->`,
	};
}

function stripBlock(prompt: string, id: string): string {
	const { end, start } = markers(id);
	let result = prompt;
	while (true) {
		const startIndex = result.indexOf(start);
		if (startIndex < 0) return result;
		const endIndex = result.indexOf(end, startIndex + start.length);
		if (endIndex < 0) return result;
		let removeStart = startIndex;
		let removeEnd = endIndex + end.length;
		while (removeStart > 0 && (result[removeStart - 1] === "\n" || result[removeStart - 1] === "\r"))
			removeStart -= 1;
		while (removeEnd < result.length && (result[removeEnd] === "\n" || result[removeEnd] === "\r")) removeEnd += 1;
		result = `${result.slice(0, removeStart)}${result.slice(removeEnd)}`;
	}
}

function appendBlock(prompt: string, id: string, body: string | undefined): string {
	const stripped = stripBlock(prompt, id).trimEnd();
	if (!body?.trim()) return stripped;
	const { end, start } = markers(id);
	return `${stripped}${stripped ? "\n\n" : ""}${start}\n${body.trim()}\n${end}`;
}

export function registerContextPromptContributor(
	pi: ContextPromptHost,
	contributor: ContextPromptContributor,
): () => void {
	if (!CONTRIBUTION_ID.test(contributor.id))
		throw new Error(`Invalid Context prompt contributor id: ${contributor.id}`);
	const key = ownerKey(pi);
	let host = registry().hosts.get(key);
	if (!host) {
		host = new Map();
		registry().hosts.set(key, host);
	}
	const token = Symbol(contributor.id);
	host.set(contributor.id, { contributor, token });
	return () => {
		const current = registry().hosts.get(key);
		if (current?.get(contributor.id)?.token !== token) return;
		current.delete(contributor.id);
		if (current.size === 0) registry().hosts.delete(key);
	};
}

export function stripContextPromptContributions(pi: ContextPromptHost, prompt: string): string {
	let result = prompt;
	for (const registered of contributors(pi)) result = stripBlock(result, registered.contributor.id);
	return result;
}

async function renderAgentPrompt(
	pi: ContextPromptHost,
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<string> {
	let prompt = stripContextPromptContributions(pi, event.systemPrompt);
	for (const registered of contributors(pi)) {
		const body = await registered.contributor.renderAgent({ ...event, systemPrompt: prompt }, ctx);
		prompt = appendBlock(prompt, registered.contributor.id, body);
	}
	return prompt;
}

export async function applyContextPromptContributions(
	pi: ContextPromptHost,
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
	const systemPrompt = await renderAgentPrompt(pi, event, ctx);
	return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
}

function runtimeRecord<Value>(value: Value): JsonInputObject | undefined {
	return isJsonInputObject(value) ? value : undefined;
}

function textLocation(value: JsonInputValue): value is JsonInputObject & { text: string } {
	return isRuntimeString(runtimeRecord(value)?.["text"]);
}

function contentLocation(value: JsonInputValue): value is JsonInputObject & { content: string; role?: JsonInputValue } {
	return isRuntimeString(runtimeRecord(value)?.["content"]);
}

function promptRole(value: JsonInputValue): boolean {
	return value === "system" || value === "developer";
}

function rewriteArrayPrompt(
	blocks: readonly JsonInputValue[],
	rewrite: (prompt: string) => string,
): PromptArrayRewrite {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (!textLocation(block)) continue;
		const text = rewrite(block.text);
		if (text === block.text) return { changed: false, found: true, value: blocks };
		const value = [...blocks];
		value[index] = { ...block, text };
		return { changed: true, found: true, value };
	}
	return { changed: false, found: false, value: blocks };
}

function rewriteMessagePrompt(
	messages: readonly JsonInputValue[],
	rewrite: (prompt: string) => string,
): PromptArrayRewrite {
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const record = runtimeRecord(message);
		if (!record || !promptRole(record["role"])) continue;
		if (contentLocation(message)) {
			const content = rewrite(message.content);
			if (content === message.content) return { changed: false, found: true, value: messages };
			const value = [...messages];
			value[index] = { ...record, content };
			return { changed: true, found: true, value };
		}
		const content = record["content"];
		if (Array.isArray(content)) {
			const rewritten = rewriteArrayPrompt(content, rewrite);
			if (!rewritten.found) continue;
			if (!rewritten.changed) return { changed: false, found: true, value: messages };
			const value = [...messages];
			value[index] = { ...record, content: rewritten.value };
			return { changed: true, found: true, value };
		}
	}
	return { changed: false, found: false, value: messages };
}

function rewriteProviderPayload<Payload>(
	payload: Payload,
	rewrite: (prompt: string) => string,
): ProviderPayloadRewrite<Payload> {
	const record = runtimeRecord(payload);
	if (!record) return { found: false, payload };
	for (const field of ["instructions", "systemInstruction", "system"] as const) {
		const value = record[field];
		if (isRuntimeString(value)) {
			const next = rewrite(value);
			return { found: true, payload: next === value ? payload : { ...record, [field]: next } };
		}
	}
	const system = record["system"];
	if (Array.isArray(system)) {
		const rewritten = rewriteArrayPrompt(system, rewrite);
		if (rewritten.found) {
			return { found: true, payload: rewritten.changed ? { ...record, system: rewritten.value } : payload };
		}
	}
	for (const field of ["messages", "input"] as const) {
		const value = record[field];
		if (!Array.isArray(value)) continue;
		const rewritten = rewriteMessagePrompt(value, rewrite);
		if (rewritten.found) {
			return { found: true, payload: rewritten.changed ? { ...record, [field]: rewritten.value } : payload };
		}
	}
	return { found: false, payload };
}

export async function applyContextPromptContributionsToProvider<Payload>(
	pi: ContextPromptHost,
	payload: Payload,
	ctx: ExtensionContext,
): Promise<ProviderPromptProjection<Payload>> {
	const rendered: Array<{ body: string | undefined; id: string }> = [];
	for (const registered of contributors(pi)) {
		rendered.push({
			body: await registered.contributor.renderProvider?.(ctx),
			id: registered.contributor.id,
		});
	}
	const active = rendered.some((item) => Boolean(item.body?.trim()));
	const rewritten = rewriteProviderPayload(payload, (systemPrompt) => {
		let prompt = systemPrompt;
		for (const item of rendered) prompt = appendBlock(prompt, item.id, item.body);
		return prompt;
	});
	return { active, found: rewritten.found, payload: rewritten.payload };
}

export const __test = {
	clear(): void {
		// SAFETY: this test-only reset addresses only the Context contribution registry symbol.
		const root = globalThis as { [key: symbol]: ContextPromptContributionRegistry | undefined };
		delete root[PROMPT_CONTRIBUTION_REGISTRY];
	},
	markers,
};
