import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { isJsonInputValue, type JsonInputObject, type JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { EffectNamespacedSettingsStore, mergedSettingsPath } from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";

export const SESSION_NAMING_NAMESPACE = "sessionNaming";
const MAX_COOLDOWN_MINUTES = 24 * 60;

export interface SessionNamingSettings {
	readonly cooldownMinutes: number;
	readonly enabled: boolean;
	readonly fallbackModels: readonly string[];
	readonly model?: string;
	readonly respectManualName: boolean;
	readonly schemaVersion: 1;
}

export interface SessionNamingSettingsPatch {
	readonly cooldownMinutes?: number;
	readonly enabled?: boolean;
	/** A model reference fixes routing; null restores the active Session model. */
	readonly model?: string | null;
	readonly respectManualName?: boolean;
}

interface SessionNamingRecord extends JsonInputObject {
	cooldownMinutes: number;
	enabled: boolean;
	fallbackModels: string[];
	model?: string;
	respectManualName: boolean;
	schemaVersion: 1;
}

export const DEFAULT_SESSION_NAMING_SETTINGS: SessionNamingSettings = {
	cooldownMinutes: 10,
	enabled: true,
	fallbackModels: [],
	respectManualName: false,
	schemaVersion: 1,
};

function isRecord(value: JsonInputValue): value is JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isModelReference(value: string): boolean {
	const separator = value.indexOf("/");
	return separator > 0 && separator < value.length - 1;
}

export function parseSessionNamingSettings(value: JsonInputValue): SessionNamingSettings {
	if (!isRecord(value)) throw new Error("expected a settings object");
	const enabled = value["enabled"];
	const cooldownMinutes = value["cooldownMinutes"];
	const respectManualName = value["respectManualName"];
	const model = value["model"];
	const fallbackModels = value["fallbackModels"];
	if (
		value["schemaVersion"] !== 1 ||
		!isRuntimeBoolean(enabled) ||
		!isRuntimeNumber(cooldownMinutes) ||
		!Number.isFinite(cooldownMinutes) ||
		cooldownMinutes < 1 ||
		cooldownMinutes > MAX_COOLDOWN_MINUTES ||
		!isRuntimeBoolean(respectManualName) ||
		(model !== undefined && (!isRuntimeString(model) || !isModelReference(model.trim()))) ||
		!Array.isArray(fallbackModels) ||
		!fallbackModels.every((candidate) => isRuntimeString(candidate) && isModelReference(candidate.trim()))
	) {
		throw new Error("expected schemaVersion 1 and valid Session Naming settings");
	}
	const settings: SessionNamingSettings = {
		cooldownMinutes,
		enabled,
		fallbackModels: fallbackModels.map((candidate) => candidate.trim()),
		respectManualName,
		schemaVersion: 1,
	};
	if (isRuntimeString(model)) Object.assign(settings, { model: model.trim() });
	return settings;
}

function toRecord(settings: SessionNamingSettings): SessionNamingRecord {
	const record: SessionNamingRecord = {
		cooldownMinutes: settings.cooldownMinutes,
		enabled: settings.enabled,
		fallbackModels: [...settings.fallbackModels],
		respectManualName: settings.respectManualName,
		schemaVersion: 1,
	};
	if (settings.model !== undefined) record.model = settings.model;
	return record;
}

function normalizeRecord<Value>(value: Value): SessionNamingRecord {
	if (!isJsonInputValue(value)) throw new Error("expected JSON-compatible Session Naming settings");
	return toRecord(parseSessionNamingSettings(value));
}

function reportSettingsDiagnostic(diagnostic: Parameters<typeof reportDiagnostic>[0]): void {
	reportDiagnostic({
		...diagnostic,
		action: "/autoname settings",
		capability: "Session Naming",
		summary: "Session Naming settings were invalid and built-in defaults are active",
	});
}

/** Startup is read-only; only a direct update from the settings Dialog persists this namespace. */
export class SessionNamingSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<SessionNamingRecord>;

	private constructor(store: EffectNamespacedSettingsStore<SessionNamingRecord>) {
		this.store = store;
	}

	static load(path = mergedSettingsPath(getAgentDir())): Effect.Effect<SessionNamingSettingsStore, Error> {
		return Effect.map(
			EffectNamespacedSettingsStore.load(
				SESSION_NAMING_NAMESPACE,
				toRecord(DEFAULT_SESSION_NAMING_SETTINGS),
				normalizeRecord,
				{
					acquireLock: acquireSettingsLockEffect,
					path,
					reportDiagnostic: reportSettingsDiagnostic,
				},
			),
			(store) => new SessionNamingSettingsStore(store),
		);
	}

	static memory(settings: SessionNamingSettings = DEFAULT_SESSION_NAMING_SETTINGS): SessionNamingSettingsStore {
		return new SessionNamingSettingsStore(EffectNamespacedSettingsStore.memory(toRecord(settings)));
	}

	get(): SessionNamingSettings {
		return parseSessionNamingSettings(this.store.get());
	}

	subscribe(listener: (settings: SessionNamingSettings) => void): () => void {
		return this.store.subscribe((record) => listener(parseSessionNamingSettings(record)));
	}

	update(patch: SessionNamingSettingsPatch): Effect.Effect<void, Error> {
		return Effect.asVoid(
			this.store.updateWith((current) => {
				const record: SessionNamingRecord = { ...current };
				if (patch.cooldownMinutes !== undefined) record.cooldownMinutes = patch.cooldownMinutes;
				if (patch.enabled !== undefined) record.enabled = patch.enabled;
				if (patch.model === null) delete record.model;
				else if (patch.model !== undefined) record.model = patch.model;
				if (patch.respectManualName !== undefined) record.respectManualName = patch.respectManualName;
				return normalizeRecord(record);
			}),
		);
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}
