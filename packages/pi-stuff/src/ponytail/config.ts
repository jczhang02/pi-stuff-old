import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputObject, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeBoolean } from "../shared/runtime-type.ts";
import {
	EffectNamespacedSettingsStore,
	type EffectNamespaceStoreOptions,
	mergedSettingsPath,
	readTextFileEffect,
	SettingsFormatError,
} from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";
import {
	normalizePonytailMode,
	PONYTAIL_DEFAULT_MODE,
	type PonytailEffectiveSettings,
	type PonytailSavedSettings,
} from "./types.ts";

const PONYTAIL_NAMESPACE = "ponytail";
const INVALID_NAMESPACE_MESSAGE = "Invalid ponytail namespace in pi-stuff.json; Ponytail is using safe defaults.";
const DEFAULT_SAVED_SETTINGS: PonytailSavedSettings = {
	defaultMode: PONYTAIL_DEFAULT_MODE,
	hideStatus: false,
	quietStartup: false,
};

type PonytailConfigEnvironment = Readonly<Record<string, string | undefined>>;

interface PonytailSettingsRecord extends JsonInputObject {
	defaultMode: PonytailSavedSettings["defaultMode"];
	hideStatus: boolean;
	quietStartup: boolean;
}

interface PonytailSettingsMetadata {
	error: string | undefined;
	source: "defaults" | "legacy" | "merged";
	writable: boolean;
}

export interface PonytailSettingsStoreOptions {
	readonly env?: PonytailConfigEnvironment;
	readonly homeDir?: string;
	readonly legacyPath?: string;
}

export type PonytailSettingsPatch = Partial<PonytailSavedSettings>;

function isObject<Value>(value: Value): value is Value & JsonInputObject {
	return isJsonInputObject(value);
}

function parseSavedSettings<Value>(value: Value): PonytailSavedSettings {
	if (!isObject(value)) throw new Error("expected a Ponytail settings object");
	const defaultMode =
		value["defaultMode"] === undefined ? PONYTAIL_DEFAULT_MODE : normalizePonytailMode(value["defaultMode"]);
	if (!defaultMode) throw new Error("expected a valid Ponytail default mode");
	if (value["hideStatus"] !== undefined && !isRuntimeBoolean(value["hideStatus"])) {
		throw new Error("expected a boolean hideStatus value");
	}
	if (value["quietStartup"] !== undefined && !isRuntimeBoolean(value["quietStartup"])) {
		throw new Error("expected a boolean quietStartup value");
	}
	return {
		defaultMode,
		hideStatus: value["hideStatus"] === true,
		quietStartup: value["quietStartup"] === true,
	};
}

function parseLegacySettings<Value>(value: Value): PonytailSavedSettings {
	if (!isObject(value)) throw new Error("expected a JSON object");
	return {
		defaultMode: normalizePonytailMode(value["defaultMode"]) ?? PONYTAIL_DEFAULT_MODE,
		hideStatus: value["hideStatus"] === true,
		quietStartup: value["quietStartup"] === true,
	};
}

function toRecord(settings: PonytailSavedSettings): PonytailSettingsRecord {
	return { ...settings };
}

function normalizeRecord<Value>(value: Value): PonytailSettingsRecord {
	return toRecord(parseSavedSettings(value));
}

function booleanEnvironmentValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function errorMessage<ErrorValue>(prefix: string, error: ErrorValue): string {
	return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function isMissingFileError<ErrorValue>(error: ErrorValue): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function legacyPonytailConfigPath(env: PonytailConfigEnvironment = process.env, homeDir = os.homedir()): string {
	if (env["XDG_CONFIG_HOME"]) return path.join(env["XDG_CONFIG_HOME"], "ponytail", "config.json");
	if (process.platform === "win32") {
		const appData = env["APPDATA"] || path.join(homeDir, "AppData", "Roaming");
		return path.join(appData, "ponytail", "config.json");
	}
	return path.join(homeDir, ".config", "ponytail", "config.json");
}

function readLegacySettings(
	legacyPath: string,
	metadata: PonytailSettingsMetadata,
): Effect.Effect<PonytailSettingsRecord | undefined> {
	const content = Effect.catch(readTextFileEffect(legacyPath), (error) =>
		Effect.sync(() => {
			if (!isMissingFileError(error)) {
				metadata.error = errorMessage("Could not read legacy Ponytail configuration", error);
			}
			return undefined;
		}),
	);
	return Effect.flatMap(content, (text) => {
		if (text === undefined) return Effect.succeed(undefined);
		return Effect.catch(
			Effect.try({
				try: () => toRecord(parseLegacySettings(parseJsonValue(text.replace(/^\uFEFF/u, "")))),
				catch: normalizeError,
			}),
			(error) =>
				Effect.sync(() => {
					metadata.error = errorMessage("Invalid legacy Ponytail configuration", error);
					return undefined;
				}),
		);
	});
}

function resolveSettings(
	saved: PonytailSavedSettings,
	metadata: PonytailSettingsMetadata,
	env: PonytailConfigEnvironment,
): PonytailEffectiveSettings {
	const envDefault = normalizePonytailMode(env["PONYTAIL_DEFAULT_MODE"]);
	const envHide = booleanEnvironmentValue(env["PONYTAIL_HIDE_STATUS"]);
	const envQuiet = booleanEnvironmentValue(env["PONYTAIL_QUIET_STARTUP"]);
	const settings = {
		defaultMode: envDefault ?? saved.defaultMode,
		defaultModeOverridden: envDefault !== undefined,
		hideStatus: envHide ?? saved.hideStatus,
		hideStatusOverridden: envHide !== undefined,
		quietStartup: envQuiet ?? saved.quietStartup,
		quietStartupOverridden: envQuiet !== undefined,
		saved,
		source: metadata.source,
		writable: metadata.writable,
	};
	return metadata.error ? { ...settings, error: metadata.error } : settings;
}

export class PonytailSettingsStore {
	private readonly env: PonytailConfigEnvironment;
	private readonly metadata: PonytailSettingsMetadata;
	private readonly store: EffectNamespacedSettingsStore<PonytailSettingsRecord>;

	private constructor(
		store: EffectNamespacedSettingsStore<PonytailSettingsRecord>,
		env: PonytailConfigEnvironment,
		metadata: PonytailSettingsMetadata,
	) {
		this.env = env;
		this.metadata = metadata;
		this.store = store;
	}

	static load(
		agentDir: string,
		options: PonytailSettingsStoreOptions = {},
	): Effect.Effect<PonytailSettingsStore, Error> {
		const env = options.env ?? process.env;
		const metadata: PonytailSettingsMetadata = { error: undefined, source: "defaults", writable: true };
		let loading = true;
		let legacySelected = false;
		const storeOptions: EffectNamespaceStoreOptions = {
			acquireLock: acquireSettingsLockEffect,
			legacyPath: options.legacyPath ?? legacyPonytailConfigPath(env, options.homeDir ?? os.homedir()),
			legacyReader: (legacyPath) =>
				Effect.tap(readLegacySettings(legacyPath, metadata), (record) =>
					Effect.sync(() => {
						if (!record) return;
						legacySelected = true;
						metadata.source = "legacy";
					}),
				),
			path: mergedSettingsPath(agentDir),
			reportDiagnostic: (diagnostic) => {
				metadata.source = "defaults";
				metadata.writable = false;
				metadata.error =
					diagnostic.error instanceof SettingsFormatError
						? errorMessage("Invalid pi-stuff.json", diagnostic.error)
						: INVALID_NAMESPACE_MESSAGE;
			},
		};
		return Effect.map(
			EffectNamespacedSettingsStore.load(
				PONYTAIL_NAMESPACE,
				toRecord(DEFAULT_SAVED_SETTINGS),
				(value) => {
					const record = normalizeRecord(value);
					if (loading && !legacySelected) metadata.source = "merged";
					return record;
				},
				storeOptions,
			),
			(store) => {
				loading = false;
				return new PonytailSettingsStore(store, env, metadata);
			},
		);
	}

	static memory(env: PonytailConfigEnvironment = process.env): PonytailSettingsStore {
		return new PonytailSettingsStore(EffectNamespacedSettingsStore.memory(toRecord(DEFAULT_SAVED_SETTINGS)), env, {
			error: undefined,
			source: "defaults",
			writable: true,
		});
	}

	get(): PonytailEffectiveSettings {
		return resolveSettings(parseSavedSettings(this.store.get()), this.metadata, this.env);
	}

	update(patch: PonytailSettingsPatch): Effect.Effect<PonytailEffectiveSettings, Error> {
		const update = Effect.map(
			this.store.updateWith((current) => normalizeRecord({ ...current, ...patch })),
			() => {
				this.metadata.error = undefined;
				this.metadata.source = "merged";
				this.metadata.writable = true;
				return this.get();
			},
		);
		return Effect.catch(update, (error) =>
			Effect.fail(
				this.metadata.error === INVALID_NAMESPACE_MESSAGE
					? new Error("Cannot update the invalid ponytail namespace in pi-stuff.json.")
					: error,
			),
		);
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
