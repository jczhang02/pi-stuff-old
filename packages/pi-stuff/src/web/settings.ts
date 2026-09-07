import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { isJsonInputValue, type JsonInputValue, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeObject } from "../shared/runtime-type.ts";
import {
	EffectNamespacedSettingsStore,
	mergedSettingsPath,
	mergeNamespaceRecordEffect,
	readTextFileEffect,
	type SettingsRecord,
} from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";

const WEB_NAMESPACE = "web";
const LEGACY_FILE = "web-search.json";
const LEGACY_MIGRATION_FILE = `${LEGACY_FILE}.migrating`;

function isRecord(value: JsonInputValue): value is SettingsRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isFileError(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function settingsRecord<Value extends object>(value: Value): SettingsRecord {
	const parsed = parseJsonValue(JSON.stringify(value));
	if (!isRecord(parsed)) throw new WebConfigError("Unable to update Web configuration: expected a JSON object");
	return parsed;
}

function normalizeSettings<Value>(value: Value): SettingsRecord {
	if (!isJsonInputValue(value) || !isRecord(value)) {
		throw new WebConfigError("Web configuration must be a JSON object");
	}
	return value;
}

export class WebConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebConfigError";
	}
}

export function getWebConfigPath(agentDirectory = getAgentDir()): string {
	return mergedSettingsPath(agentDirectory);
}

export function getLegacyWebConfigPath(agentDirectory = getAgentDir()): string {
	return join(agentDirectory, LEGACY_FILE);
}

function getLegacyWebMigrationPath(agentDirectory = getAgentDir()): string {
	return join(agentDirectory, LEGACY_MIGRATION_FILE);
}

function readLegacyFile(path: string): Effect.Effect<SettingsRecord, Error> {
	return readTextFileEffect(path).pipe(
		Effect.flatMap((content) =>
			Effect.try({
				try: () => {
					let parsed: JsonInputValue;
					try {
						parsed = parseJsonValue(content);
					} catch {
						throw new WebConfigError(`Unable to read legacy Web configuration at ${path}: invalid JSON`);
					}
					if (!isRecord(parsed)) {
						throw new WebConfigError(
							`Unable to read legacy Web configuration at ${path}: expected a JSON object`,
						);
					}
					return parsed;
				},
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			}),
		),
	);
}

function readLegacy(agentDirectory: string): Effect.Effect<SettingsRecord | undefined, Error> {
	return readLegacyFile(getLegacyWebConfigPath(agentDirectory)).pipe(
		Effect.catch((error) =>
			isFileError(error, "ENOENT") ? readLegacyFile(getLegacyWebMigrationPath(agentDirectory)) : Effect.fail(error),
		),
	);
}

function removeLegacyFiles(agentDirectory: string): Effect.Effect<void, Error> {
	return Effect.tryPromise({
		try: async () => {
			await rm(getLegacyWebConfigPath(agentDirectory), { force: true });
			await rm(getLegacyWebMigrationPath(agentDirectory), { force: true });
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

export class WebSettingsStore {
	private readonly path: string;
	private readonly store: EffectNamespacedSettingsStore<SettingsRecord>;

	private constructor(store: EffectNamespacedSettingsStore<SettingsRecord>, path: string) {
		this.path = path;
		this.store = store;
	}

	static load(agentDirectory = getAgentDir()): Effect.Effect<WebSettingsStore, Error> {
		const path = getWebConfigPath(agentDirectory);
		return Effect.map(
			EffectNamespacedSettingsStore.load(WEB_NAMESPACE, {}, normalizeSettings, {
				path,
				legacyPath: getLegacyWebConfigPath(agentDirectory),
				legacyReader: () => readLegacy(agentDirectory),
				acquireLock: acquireSettingsLockEffect,
				writer: (settingsPath, namespace, record) =>
					Effect.andThen(
						Effect.asVoid(mergeNamespaceRecordEffect(settingsPath, namespace, record)),
						removeLegacyFiles(agentDirectory),
					),
				reportDiagnostic: (diagnostic) => reportDiagnostic({ ...diagnostic, capability: "Web" }),
			}),
			(store) => new WebSettingsStore(store, path),
		);
	}

	static memory(settings: SettingsRecord = {}): WebSettingsStore {
		return new WebSettingsStore(EffectNamespacedSettingsStore.memory(settings), "");
	}

	get(): SettingsRecord {
		return this.store.get();
	}

	update<Updates extends object>(updates: Updates): Effect.Effect<void, WebConfigError> {
		return Effect.try({
			try: () => settingsRecord(updates),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		}).pipe(
			Effect.flatMap((patch) => Effect.asVoid(this.store.update(patch))),
			Effect.mapError((error) =>
				error instanceof WebConfigError
					? error
					: new WebConfigError(`Unable to update Web configuration at ${this.path}: ${error.message}`),
			),
		);
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}
