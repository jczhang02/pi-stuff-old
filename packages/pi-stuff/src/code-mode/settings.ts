import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type JsonInputObject, type JsonInputValue, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeObject } from "../shared/runtime-type.ts";
import { mergeNamespaceRecordEffect, readNamespaceEffect } from "../shared/settings-io/file.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";
import { mergedSettingsPath, resolveSettingsLockPath } from "../shared/settings-io/paths.ts";

const PROJECT_SETTINGS_DIRECTORY = ".pi";
const PROJECT_SETTINGS_FILE = "code-mode.json";
const CODE_MODE_NAMESPACE = "codeMode";

function isRecord<Value>(value: Value): value is Value & JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isMissingFile<Cause>(cause: Cause): boolean {
	return isRecord(cause) && cause["code"] === "ENOENT";
}

export function codeModeProjectSettingsPath(cwd: string): string {
	return join(cwd, PROJECT_SETTINGS_DIRECTORY, PROJECT_SETTINGS_FILE);
}

function readRawSettings(path: string): Effect.Effect<JsonInputObject | undefined, Error> {
	return Effect.gen(function* () {
		const content = yield* Effect.catch(
			Effect.tryPromise({
				try: () => readFile(path, "utf8"),
				catch: normalizeError,
			}),
			(error) =>
				isMissingFile(error)
					? Effect.succeed(undefined)
					: Effect.fail(new Error(`Unable to read Code Mode project settings at ${path}: ${error.message}`)),
		);
		if (content === undefined) return undefined;
		const value: JsonInputValue = yield* Effect.try({
			try: () => parseJsonValue(content),
			catch: (error) =>
				new Error(`Unable to read Code Mode project settings at ${path}: ${normalizeError(error).message}`),
		});
		if (!isRecord(value)) {
			return yield* Effect.fail(new Error(`Invalid Code Mode project settings at ${path}: expected a JSON object`));
		}
		return value;
	});
}

/** Read-only: a missing file or omitted value falls back to the process default. */
export function readCodeModeProjectEnabled(cwd: string): Effect.Effect<boolean | undefined, Error> {
	const path = codeModeProjectSettingsPath(cwd);
	return Effect.flatMap(readRawSettings(path), (value) =>
		Effect.try({
			try: () => {
				if (!value || value["enabled"] === undefined) return undefined;
				if (!isRuntimeBoolean(value["enabled"])) {
					throw new Error(`Invalid Code Mode project settings at ${path}: "enabled" must be a boolean`);
				}
				return value["enabled"];
			},
			catch: normalizeError,
		}),
	);
}

/** Explicit user actions only: preserve unknown fields and replace the file atomically. */
export function writeCodeModeProjectEnabled(cwd: string, enabled: boolean | undefined): Effect.Effect<void, Error> {
	const path = codeModeProjectSettingsPath(cwd);
	const persist = Effect.gen(function* () {
		const current = (yield* readRawSettings(path)) ?? {};
		const next = yield* Effect.try({
			try: () => {
				if (current["enabled"] !== undefined && !isRuntimeBoolean(current["enabled"])) {
					throw new Error(`Invalid Code Mode project settings at ${path}: "enabled" must be a boolean`);
				}
				const updated = { ...current };
				if (enabled === undefined) delete updated["enabled"];
				else updated["enabled"] = enabled;
				return updated;
			},
			catch: normalizeError,
		});
		yield* writeRawSettings(path, next);
	});
	return Effect.mapError(
		Effect.scoped(
			Effect.gen(function* () {
				yield* acquireSettingsLockEffect(resolveSettingsLockPath(path), "Code Mode project");
				yield* Effect.uninterruptible(persist);
			}),
		),
		(error) =>
			/^(Invalid|Unable to)/u.test(error.message)
				? error
				: new Error(`Unable to save Code Mode project settings at ${path}: ${error.message}`),
	);
}

/**
 * Global Code Mode default, stored as the `codeMode.enabled` namespace in the
 * single merged settings file (`<agentDir>/pi-stuff.json`). Read-only until an
 * explicit `/codemode global on|off` writes it. A missing namespace returns
 * `undefined` so the caller can fall back to the process default.
 */
export function readCodeModeGlobalEnabled(agentDirectory = getAgentDir()): Effect.Effect<boolean | undefined, Error> {
	return Effect.flatMap(readNamespaceEffect(mergedSettingsPath(agentDirectory), CODE_MODE_NAMESPACE), (namespace) =>
		Effect.try({
			try: () => {
				if (namespace === undefined || namespace["enabled"] === undefined) return undefined;
				if (!isRuntimeBoolean(namespace["enabled"])) {
					throw new Error(`Invalid Code Mode global settings: "enabled" must be a boolean`);
				}
				return namespace["enabled"];
			},
			catch: normalizeError,
		}),
	);
}

/** Explicit user action only: writes `codeMode.enabled` into the merged file. */
export function writeCodeModeGlobalEnabled(
	enabled: boolean,
	agentDirectory = getAgentDir(),
): Effect.Effect<void, Error> {
	const path = mergedSettingsPath(agentDirectory);
	return Effect.scoped(
		Effect.gen(function* () {
			yield* acquireSettingsLockEffect(resolveSettingsLockPath(path), "Code Mode");
			yield* Effect.uninterruptible(mergeNamespaceRecordEffect(path, CODE_MODE_NAMESPACE, { enabled }));
		}),
	);
}

function writeRawSettings(path: string, next: JsonInputObject): Effect.Effect<void, Error> {
	return Effect.tryPromise({
		try: async () => {
			if (Object.keys(next).length === 0) {
				await rm(path, { force: true });
				return;
			}
			await mkdir(dirname(path), { mode: 0o700, recursive: true });
			const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, `${JSON.stringify(next, null, "\t")}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				await rename(temporaryPath, path);
			} catch (error) {
				await rm(temporaryPath, { force: true }).catch(() => undefined);
				throw error;
			}
		},
		catch: (error) =>
			new Error(`Unable to save Code Mode project settings at ${path}: ${normalizeError(error).message}`),
	});
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
