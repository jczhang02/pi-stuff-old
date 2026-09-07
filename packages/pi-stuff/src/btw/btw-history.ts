import { randomUUID } from "node:crypto";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonInputObject, type JsonInputObject, type JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeString } from "../shared/runtime-type.ts";

/** A session would have to accumulate roughly three BTW exchanges a day for a year to reach this guard. */
export const BTW_HISTORY_LIMIT = 1_000;
export const BTW_HISTORY_BYTES_LIMIT = 8 * 1024 * 1024;
export const BTW_VISIBLE_HISTORY_LIMIT = 5;
export const BTW_HISTORY_ENTRY_TYPE = "@jczhang02/pi-stuff-btw/history/v1";

interface BtwResponseMetadata {
	readonly api: AssistantMessage["api"];
	readonly provider: string;
	readonly model: string;
	readonly usage: Usage;
	readonly stopReason: StopReason;
	readonly timestamp: number;
	readonly errorMessage?: string;
}

export interface BtwExchange {
	readonly id: string;
	readonly question: string;
	readonly answer: string;
	readonly timestamp: number;
	readonly contextTrimmed: boolean;
	/** Enough provider metadata to promote this text as a real assistant turn without another model request. */
	readonly response?: BtwResponseMetadata;
}

export type BtwHistoryEvent =
	| {
			readonly version: 1;
			readonly ownerSessionId: string;
			readonly operation: "record";
			readonly exchange: BtwExchange;
	  }
	| {
			readonly version: 1;
			readonly ownerSessionId: string;
			readonly operation: "retain";
			readonly exchangeId: string;
	  }
	| {
			readonly version: 1;
			readonly ownerSessionId: string;
			readonly operation: "clear";
	  };

export type AppendHistoryEntry = (customType: string, event: BtwHistoryEvent) => void;

interface BtwHistoryState {
	readonly sessions: Map<string, BtwExchange[]>;
	readonly hydratedSessions: Set<string>;
}

const BTW_HISTORY_STATE = Symbol.for("@jczhang02/pi-stuff-btw/history/v2");

function state(): BtwHistoryState {
	// SAFETY: this module is the sole writer for its versioned global symbol and always stores BtwHistoryState.
	const root = globalThis as { [key: symbol]: BtwHistoryState | undefined };
	root[BTW_HISTORY_STATE] ??= { sessions: new Map(), hydratedSessions: new Set() };
	return root[BTW_HISTORY_STATE];
}

function isStopReason(value: JsonInputValue): value is StopReason {
	switch (value) {
		case "aborted":
		case "deferred":
		case "error":
		case "length":
		case "pending":
		case "stop":
		case "toolUse":
			return true;
		default:
			return false;
	}
}

function readUsage(value: JsonInputValue): Usage | undefined {
	if (!isJsonInputObject(value)) return undefined;
	const { cacheRead, cacheWrite, cacheWrite1h, cost, input, output, reasoning, totalTokens } = value;
	if (!isJsonInputObject(cost)) return undefined;
	const { cacheRead: costCacheRead, cacheWrite: costCacheWrite, input: costInput, output: costOutput, total } = cost;
	if (
		!isRuntimeNumber(cacheRead) ||
		!isRuntimeNumber(cacheWrite) ||
		!isRuntimeNumber(input) ||
		!isRuntimeNumber(output) ||
		!isRuntimeNumber(totalTokens) ||
		!isRuntimeNumber(costCacheRead) ||
		!isRuntimeNumber(costCacheWrite) ||
		!isRuntimeNumber(costInput) ||
		!isRuntimeNumber(costOutput) ||
		!isRuntimeNumber(total)
	) {
		return undefined;
	}
	const usage: Usage = {
		cacheRead,
		cacheWrite,
		input,
		output,
		totalTokens,
		cost: {
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			input: costInput,
			output: costOutput,
			total,
		},
	};
	if (isRuntimeNumber(cacheWrite1h)) usage.cacheWrite1h = cacheWrite1h;
	if (isRuntimeNumber(reasoning)) usage.reasoning = reasoning;
	return usage;
}

function readResponseMetadata(value: JsonInputValue): BtwResponseMetadata | undefined {
	if (!isJsonInputObject(value)) return undefined;
	const { api, errorMessage, model, provider, stopReason, timestamp } = value;
	const usage = readUsage(value["usage"]);
	if (
		!isRuntimeString(api) ||
		!isRuntimeString(provider) ||
		!isRuntimeString(model) ||
		!isStopReason(stopReason) ||
		!isRuntimeNumber(timestamp) ||
		!usage
	) {
		return undefined;
	}
	const response: BtwResponseMetadata = {
		api,
		provider,
		model,
		usage,
		stopReason,
		timestamp,
	};
	return isRuntimeString(errorMessage) ? { ...response, errorMessage } : response;
}

function readExchange(value: JsonInputValue): BtwExchange | undefined {
	if (!isJsonInputObject(value)) return undefined;
	const { answer, contextTrimmed, id, question, response: responseValue, timestamp } = value;
	if (
		!isRuntimeString(id) ||
		!isRuntimeString(question) ||
		!isRuntimeString(answer) ||
		!isRuntimeNumber(timestamp) ||
		!isRuntimeBoolean(contextTrimmed)
	) {
		return undefined;
	}
	const exchange: BtwExchange = {
		id,
		question,
		answer,
		timestamp,
		contextTrimmed,
	};
	if (responseValue === undefined) return exchange;
	const response = readResponseMetadata(responseValue);
	return response ? { ...exchange, response } : undefined;
}

function readEvent(entry: SessionEntry): BtwHistoryEvent | undefined {
	if (entry.type !== "custom" || entry.customType !== BTW_HISTORY_ENTRY_TYPE || !isJsonInputObject(entry.data)) {
		return undefined;
	}
	const data: JsonInputObject = entry.data;
	const { exchange: exchangeValue, exchangeId, operation, ownerSessionId, version } = data;
	if (version !== 1 || !isRuntimeString(ownerSessionId)) return undefined;
	if (operation === "clear") {
		return { version: 1, ownerSessionId, operation: "clear" };
	}
	if (operation === "retain" && isRuntimeString(exchangeId)) {
		return {
			version: 1,
			ownerSessionId,
			operation: "retain",
			exchangeId,
		};
	}
	if (operation === "record") {
		const exchange = readExchange(exchangeValue);
		if (!exchange) return undefined;
		return {
			version: 1,
			ownerSessionId,
			operation: "record",
			exchange,
		};
	}
	return undefined;
}

function serializedBytes(exchange: BtwExchange): number {
	return Buffer.byteLength(JSON.stringify(exchange), "utf8");
}

function boundHistory(history: readonly BtwExchange[]): BtwExchange[] {
	const newest: BtwExchange[] = [];
	let bytes = 0;
	for (let index = history.length - 1; index >= 0 && newest.length < BTW_HISTORY_LIMIT; index--) {
		const exchange = history[index];
		if (!exchange) continue;
		const exchangeBytes = serializedBytes(exchange);
		if (exchangeBytes > BTW_HISTORY_BYTES_LIMIT) continue;
		if (bytes + exchangeBytes > BTW_HISTORY_BYTES_LIMIT) break;
		newest.push(exchange);
		bytes += exchangeBytes;
	}
	return newest.reverse();
}

function appendSafely(appendEntry: AppendHistoryEntry | undefined, event: BtwHistoryEvent): void {
	try {
		appendEntry?.(BTW_HISTORY_ENTRY_TYPE, event);
	} catch {
		// The in-process copy remains usable. A later successful record will still
		// be persisted, and a Host/session persistence failure must not break BTW.
	}
}

export function btwSessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager.getSessionId();
}

/** Rebuild invisible BTW state once per loaded session. Forked/new sessions have a different owner id. */
export function hydrateBtwHistory(sessionKey: string, entries: readonly SessionEntry[]): readonly BtwExchange[] {
	const historyState = state();
	if (historyState.hydratedSessions.has(sessionKey)) return historyState.sessions.get(sessionKey) ?? [];

	let history: BtwExchange[] = [];
	for (const entry of entries) {
		const event = readEvent(entry);
		if (!event || event.ownerSessionId !== sessionKey) continue;
		if (event.operation === "record") {
			history = boundHistory([...history.filter((exchange) => exchange.id !== event.exchange.id), event.exchange]);
		} else if (event.operation === "retain") {
			const retained = history.find((exchange) => exchange.id === event.exchangeId);
			history = retained ? [retained] : [];
		} else {
			history = [];
		}
	}

	historyState.sessions.set(sessionKey, history);
	historyState.hydratedSessions.add(sessionKey);
	return history;
}

export function readBtwHistory(sessionKey: string): readonly BtwExchange[] {
	return state().sessions.get(sessionKey) ?? [];
}

/** Release process-local state after Pi closes or switches away from a session. */
export function evictBtwHistory(sessionKey: string): void {
	const historyState = state();
	historyState.sessions.delete(sessionKey);
	historyState.hydratedSessions.delete(sessionKey);
}

export function recordBtwExchange(
	sessionKey: string,
	exchange: Omit<BtwExchange, "id">,
	appendEntry?: AppendHistoryEntry,
): BtwExchange {
	const historyState = state();
	const recorded = { ...exchange, id: randomUUID() };
	const prior = historyState.sessions.get(sessionKey) ?? [];
	const next = boundHistory([...prior, recorded]);
	historyState.sessions.set(sessionKey, next);
	historyState.hydratedSessions.add(sessionKey);
	if (next.some((candidate) => candidate.id === recorded.id)) {
		appendSafely(appendEntry, {
			version: 1,
			ownerSessionId: sessionKey,
			operation: "record",
			exchange: recorded,
		});
	}
	return recorded;
}

/** Claude-style clear: retain the exchange currently being viewed, discard its siblings. */
export function clearEarlierBtwHistory(
	sessionKey: string,
	currentId: string,
	appendEntry?: AppendHistoryEntry,
): readonly BtwExchange[] {
	const current = (state().sessions.get(sessionKey) ?? []).find((exchange) => exchange.id === currentId);
	const next = current ? [current] : [];
	state().sessions.set(sessionKey, next);
	appendSafely(appendEntry, {
		version: 1,
		ownerSessionId: sessionKey,
		operation: "retain",
		exchangeId: currentId,
	});
	return next;
}

export function clearBtwHistory(sessionKey: string, appendEntry?: AppendHistoryEntry): void {
	state().sessions.set(sessionKey, []);
	appendSafely(appendEntry, { version: 1, ownerSessionId: sessionKey, operation: "clear" });
}

/** Test-only reset of process-local display state. Not used by the extension runtime. */
export function resetBtwHistoryForTests(): void {
	const historyState = state();
	historyState.sessions.clear();
	historyState.hydratedSessions.clear();
}
