/**
 * Atomic reader/writer for the single merged settings file.
 *
 * Reads and writes use plain JSON (`JSON.parse` / `JSON.stringify`). The file is
 * a plain `pi-stuff.json` — comments are not supported. Writes always emit
 * comment-free, tab-indented JSON because machine output must be deterministic.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as Effect from "effect/Effect";
import { type JsonInputObject, type JsonInputValue, type JsonValue, parseJsonValue } from "../json-value.ts";
import { isRuntimeObject } from "../runtime-type.ts";

export interface SettingsRecord extends JsonInputObject {}

export class SettingsFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsFormatError";
	}
}

export class SettingsNamespaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsNamespaceError";
	}
}

function isSettingsRecord(value: JsonInputValue): value is SettingsRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isMissingFile(cause: unknown): boolean {
	return isRuntimeObject(cause) && cause !== null && "code" in cause && cause.code === "ENOENT";
}

/** Missing file returns `{}`; a malformed file throws so callers can fall back. */
async function readSettingsFileNative(path: string): Promise<SettingsRecord> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
	return parseSettingsContent(content, path);
}

export function readSettingsFileEffect(path: string): Effect.Effect<SettingsRecord, Error> {
	return Effect.tryPromise({
		try: () => readSettingsFileNative(path),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

export function readTextFileEffect(path: string): Effect.Effect<string, Error> {
	return Effect.tryPromise({
		try: () => readFile(path, "utf8"),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

async function writeSettingsFileNative(path: string, record: SettingsRecord): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

/**
 * Merge a namespace record into the whole file without clobbering siblings.
 *
 * The file is read, the named top-level namespace is replaced with `next`, and
 * the result is written atomically. Unknown sibling namespaces are preserved
 * so a Capability never edits another Capability's section.
 */
async function mergeNamespaceRecordNative(
	path: string,
	namespace: string,
	next: SettingsRecord,
): Promise<SettingsRecord> {
	const current = await readSettingsFileNative(path);
	const merged = { ...current, [namespace]: next } satisfies SettingsRecord;
	await writeSettingsFileNative(path, merged);
	return merged;
}

export function mergeNamespaceRecordEffect(
	path: string,
	namespace: string,
	next: SettingsRecord,
): Effect.Effect<SettingsRecord, Error> {
	return Effect.tryPromise({
		try: () => mergeNamespaceRecordNative(path, namespace, next),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

/** Read one namespace; a missing file or namespace returns `undefined`. */
async function readNamespaceNative(path: string, namespace: string): Promise<SettingsRecord | undefined> {
	const file = await readSettingsFileNative(path);
	const value = file[namespace];
	if (value === undefined) return undefined;
	if (!isSettingsRecord(value)) {
		throw new SettingsNamespaceError(`Settings namespace "${namespace}" at ${path} is not a JSON object`);
	}
	return value;
}

export function readNamespaceEffect(path: string, namespace: string): Effect.Effect<SettingsRecord | undefined, Error> {
	return Effect.tryPromise({
		try: () => readNamespaceNative(path, namespace),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

/** Synchronous variants for lifecycle modules (e.g. Goal) that load on the hot path. */

function parseSettingsContent(content: string, path: string): SettingsRecord {
	const trimmed = content.trim();
	if (trimmed === "") return {};
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(trimmed);
	} catch {
		throw new SettingsFormatError(`Settings file at ${path} contains invalid JSON`);
	}
	if (!isSettingsRecord(parsed)) throw new SettingsFormatError(`Settings file at ${path} is not a JSON object`);
	return parsed;
}

export function readSettingsFileSync(path: string): SettingsRecord {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
	return parseSettingsContent(content, path);
}

export function writeSettingsFileSync(path: string, record: SettingsRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup.
		}
		throw error;
	}
}
