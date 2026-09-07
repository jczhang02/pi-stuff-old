import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { isJsonInputValue, type JsonInputObject, type JsonInputValue, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import {
	EffectNamespacedSettingsStore,
	type EffectNamespaceStoreOptions,
	mergedSettingsPath,
	readTextFileEffect,
} from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";
import type { TerminalDeliveryMode } from "./transport.ts";

const SETTINGS_FILE_NAME = "pi-stuff-notification.json";
const NOTIFICATION_NAMESPACE = "notification";
const DELIVERY_MODES = new Set<TerminalDeliveryMode>(["auto", "bell", "kitty", "osc9", "osc777"]);

export interface NotificationSettings {
	readonly completionAlerts: boolean;
	readonly delivery: TerminalDeliveryMode;
	readonly enabled: boolean;
	readonly failureAlerts: boolean;
	readonly gracePeriodMs: number;
	readonly minimumDurationMs: number;
	readonly responsePreview: boolean;
	readonly schemaVersion: 3;
	readonly terminalBell: boolean;
	readonly tmuxNotification: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
	completionAlerts: true,
	delivery: "auto",
	enabled: true,
	failureAlerts: true,
	gracePeriodMs: 2_000,
	minimumDurationMs: 10_000,
	responsePreview: false,
	schemaVersion: 3,
	terminalBell: false,
	tmuxNotification: true,
};

export type NotificationSettingsWriter = (path: string, settings: NotificationSettings) => Effect.Effect<void, Error>;
export type NotificationSettingsChanges = {
	-readonly [Id in Exclude<keyof NotificationSettings, "schemaVersion">]?: NotificationSettings[Id];
};

interface NotificationSettingsRecord extends JsonInputObject {
	completionAlerts: boolean;
	delivery: TerminalDeliveryMode;
	enabled: boolean;
	failureAlerts: boolean;
	gracePeriodMs: number;
	minimumDurationMs: number;
	responsePreview: boolean;
	schemaVersion: 3;
	terminalBell: boolean;
	tmuxNotification: boolean;
}

function isRecord(value: JsonInputValue): value is JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function deliveryMode(value: JsonInputValue): TerminalDeliveryMode | undefined {
	if (!isRuntimeString(value)) return undefined;
	for (const mode of DELIVERY_MODES) {
		if (value === mode) return mode;
	}
	return undefined;
}

function parseSettings(value: JsonInputValue): NotificationSettings {
	if (!isRecord(value)) throw new Error("expected a settings object");
	const delivery = deliveryMode(value["delivery"]);
	const minimumDurationMs = value["minimumDurationMs"];
	const gracePeriodMs = value["gracePeriodMs"];
	const schemaVersion = value["schemaVersion"];
	const legacy = schemaVersion === 1;
	const enabled = value["enabled"];
	const completionAlerts = value["completionAlerts"];
	const failureAlerts = value["failureAlerts"];
	const responsePreview = legacy ? false : value["responsePreview"];
	const terminalBell = legacy ? value["sound"] : value["terminalBell"];
	const tmuxNotification = schemaVersion === 3 ? value["tmuxNotification"] : true;
	if (
		(schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) ||
		!isRuntimeBoolean(enabled) ||
		!isRuntimeBoolean(completionAlerts) ||
		!isRuntimeBoolean(failureAlerts) ||
		!isRuntimeBoolean(terminalBell) ||
		!isRuntimeBoolean(tmuxNotification) ||
		!isRuntimeBoolean(responsePreview) ||
		!delivery ||
		!isRuntimeNumber(minimumDurationMs) ||
		!Number.isFinite(minimumDurationMs) ||
		minimumDurationMs < 0 ||
		!isRuntimeNumber(gracePeriodMs) ||
		!Number.isFinite(gracePeriodMs) ||
		gracePeriodMs < 0
	) {
		throw new Error("expected schemaVersion 1, 2, or 3 and valid Notification settings");
	}
	return {
		completionAlerts,
		delivery,
		enabled,
		failureAlerts,
		gracePeriodMs,
		minimumDurationMs,
		responsePreview,
		schemaVersion: 3,
		terminalBell,
		tmuxNotification,
	};
}

/** Read the legacy `pi-stuff-notification.json` without mutating user configuration. */
function readLegacySettings(path: string): Effect.Effect<NotificationSettings | undefined> {
	return Effect.catch(
		Effect.flatMap(readTextFileEffect(path), (content) =>
			Effect.try({
				try: () => parseSettings(parseJsonValue(content)),
				catch: normalizeError,
			}),
		),
		() => Effect.succeed(undefined),
	);
}

function toRecord(settings: NotificationSettings): NotificationSettingsRecord {
	return { ...settings };
}

function normalizeRecord<Value>(value: Value): NotificationSettingsRecord {
	if (!isJsonInputValue(value)) throw new Error("expected JSON-compatible Notification settings");
	return toRecord(parseSettings(value));
}

function reportSettingsDiagnostic(diagnostic: Parameters<typeof reportDiagnostic>[0]): void {
	reportDiagnostic({
		...diagnostic,
		action: "/notifications",
		capability: "Notification",
		summary: "Notification settings were invalid and built-in defaults are active",
	});
}

/** Loading is read-only; only direct user updates create the settings file. */
export class NotificationSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<NotificationSettingsRecord>;

	private constructor(store: EffectNamespacedSettingsStore<NotificationSettingsRecord>) {
		this.store = store;
	}

	static load(
		path = mergedSettingsPath(getAgentDir()),
		writer?: NotificationSettingsWriter,
	): Effect.Effect<NotificationSettingsStore, Error> {
		const options: EffectNamespaceStoreOptions = {
			acquireLock: acquireSettingsLockEffect,
			legacyPath: join(dirname(path), SETTINGS_FILE_NAME),
			legacyReader: (legacyPath) =>
				Effect.map(readLegacySettings(legacyPath), (settings) => (settings ? toRecord(settings) : undefined)),
			path,
			reportDiagnostic: reportSettingsDiagnostic,
		};
		if (writer) {
			Object.assign(options, {
				writer: (settingsPath: string, _namespace: string, record: JsonInputObject) =>
					writer(settingsPath, parseSettings(record)),
			});
		}
		return Effect.map(
			EffectNamespacedSettingsStore.load(
				NOTIFICATION_NAMESPACE,
				toRecord(DEFAULT_NOTIFICATION_SETTINGS),
				normalizeRecord,
				options,
			),
			(store) => new NotificationSettingsStore(store),
		);
	}

	static memory(value: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS): NotificationSettingsStore {
		return new NotificationSettingsStore(EffectNamespacedSettingsStore.memory(toRecord(value)));
	}

	get(): NotificationSettings {
		return parseSettings(this.store.get());
	}

	subscribe(listener: (settings: NotificationSettings) => void): () => void {
		return this.store.subscribe((record) => listener(parseSettings(record)));
	}

	update(patch: NotificationSettingsChanges): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.updateWith((current) => normalizeRecord({ ...current, ...patch })));
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
