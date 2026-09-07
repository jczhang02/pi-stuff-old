import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { NamingMessage } from "./prompt.ts";

export const SESSION_NAMING_STATE_ENTRY_TYPE = "pi-stuff-session-naming-state";
export const LEGACY_AUTONAME_STATE_ENTRY_TYPE = "pi-autoname-state";

export type RenameMode = "forced" | "initial" | "periodic";
export type RenameSource = "ai" | "fallback" | "user";

export interface RenameMarker {
	readonly mode?: RenameMode;
	readonly name: string;
	readonly source: RenameSource;
	readonly timestamp: number;
}

function markerFromEntry(entry: SessionEntry): RenameMarker | undefined {
	if (entry.type !== "custom") return undefined;
	const customType = entry.customType;
	if (customType !== SESSION_NAMING_STATE_ENTRY_TYPE && customType !== LEGACY_AUTONAME_STATE_ENTRY_TYPE) {
		return undefined;
	}
	const data = entry.data;
	if (!isRuntimeObject(data) || data === null || !("name" in data)) {
		return undefined;
	}
	const event = "event" in data ? data["event"] : undefined;
	const source = "source" in data ? data["source"] : undefined;
	const timestampValue = "timestamp" in data ? data["timestamp"] : undefined;
	const timestamp = isRuntimeNumber(timestampValue) && Number.isFinite(timestampValue) ? timestampValue : 0;
	const name = data["name"];
	if (!isRuntimeString(name) || !name.trim()) {
		return undefined;
	}
	if (customType === LEGACY_AUTONAME_STATE_ENTRY_TYPE && event === "user_rename") {
		return { name: name.trim(), source: "user", timestamp };
	}
	if (source !== "ai" && source !== "fallback" && source !== "user") return undefined;
	const marker: RenameMarker = {
		name: name.trim(),
		source,
		timestamp,
	};
	const mode = "mode" in data ? data["mode"] : undefined;
	if (mode === "forced" || mode === "initial" || mode === "periodic") Object.assign(marker, { mode });
	return marker;
}

export function getLastRenameMarker(entries: readonly SessionEntry[]): RenameMarker | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		const marker = markerFromEntry(entry);
		if (marker) return marker;
	}
	return undefined;
}

export function getSessionNameTimestamp(entries: readonly SessionEntry[], name: string): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "session_info" || entry.name?.trim() !== name) continue;
		const timestamp = Date.parse(entry.timestamp);
		return Number.isFinite(timestamp) ? timestamp : undefined;
	}
	return undefined;
}

function messageFromEntry(entry: SessionEntry): NamingMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	return { content: message.content, role: message.role };
}

export function namingMessages(entries: readonly SessionEntry[], initial: boolean): NamingMessage[] {
	const messages: NamingMessage[] = [];
	for (let index = entries.length - 1; index >= 0 && messages.length < 6; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		const message = messageFromEntry(entry);
		if (message) messages.push(message);
	}
	messages.reverse();
	if (!initial || messages.length > 2) return messages;
	return messages[0]?.role === "user" && messages[1]?.role === "assistant" ? messages : [];
}
