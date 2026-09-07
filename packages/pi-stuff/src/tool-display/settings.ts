import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { type JsonInputObject, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeObject } from "../shared/runtime-type.ts";
import {
	EffectNamespacedSettingsStore,
	type EffectNamespaceStoreOptions,
	type EffectNamespaceWriter,
	mergedSettingsPath,
	readTextFileEffect,
} from "../shared/settings-io/index.ts";

const SETTINGS_FILE_NAME = "pi-stuff-tools.json";
const TOOLS_NAMESPACE = "tools";

export interface ToolUiSettings {
	readonly liveElapsed: boolean;
	readonly schemaVersion: 1;
}

type ToolUiSettingsRecord = {
	liveElapsed: boolean;
	schemaVersion: 1;
};

const DEFAULT_SETTINGS: ToolUiSettingsRecord = {
	liveElapsed: true,
	schemaVersion: 1,
};

type SettingsListener = (settings: ToolUiSettings) => void;

function isRecord<Value>(value: Value): value is Value & JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function normalizeSettings<Value>(value: Value): ToolUiSettingsRecord {
	if (!isRecord(value) || value["schemaVersion"] !== 1 || !isRuntimeBoolean(value["liveElapsed"])) {
		throw new Error("expected schemaVersion 1 and a boolean liveElapsed value");
	}
	return { liveElapsed: value["liveElapsed"], schemaVersion: 1 };
}

/** Explicitly user-mutated settings; construction and startup never write a file. */
export class ToolUiSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<ToolUiSettingsRecord>;

	private constructor(store: EffectNamespacedSettingsStore<ToolUiSettingsRecord>) {
		this.store = store;
	}

	static load(
		path = mergedSettingsPath(getAgentDir()),
		writer?: EffectNamespaceWriter,
	): Effect.Effect<ToolUiSettingsStore, Error> {
		const options: EffectNamespaceStoreOptions = {
			path,
			legacyPath: join(dirname(path), SETTINGS_FILE_NAME),
			acquireLock: acquireToolSettingsLock,
			legacyReader: (legacyPath: string) =>
				Effect.catch(
					Effect.flatMap(readTextFileEffect(legacyPath), (content) =>
						Effect.try({
							try: () => normalizeSettings(parseJsonValue(content)),
							catch: normalizeError,
						}),
					),
					() => Effect.succeed(undefined),
				),
			reportDiagnostic: (diagnostic) =>
				reportDiagnostic({
					...diagnostic,
					action: "/ui",
					capability: "Tools",
					key: "invalid-settings",
					summary: "Tool display settings were invalid and built-in defaults are active",
				}),
		};
		if (writer) Object.assign(options, { writer });
		return Effect.map(
			EffectNamespacedSettingsStore.load(TOOLS_NAMESPACE, DEFAULT_SETTINGS, normalizeSettings, options),
			(store) => new ToolUiSettingsStore(store),
		);
	}

	static memory(value: ToolUiSettings = DEFAULT_SETTINGS): ToolUiSettingsStore {
		return new ToolUiSettingsStore(EffectNamespacedSettingsStore.memory(normalizeSettings(value)));
	}

	get(): ToolUiSettings {
		return this.store.get();
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}

	subscribe(listener: SettingsListener): () => void {
		return this.store.subscribe(listener);
	}

	setLiveElapsed(liveElapsed: boolean): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.update({ liveElapsed }));
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function acquireToolSettingsLock(lockPath: string, _owner: string): Effect.Effect<void, Error, Scope.Scope> {
	return Effect.flatMap(
		Effect.tryPromise({
			try: () => import("../shared/settings-io/lock.ts"),
			catch: normalizeError,
		}),
		({ acquireSettingsLockEffect }) => acquireSettingsLockEffect(lockPath, "Tools"),
	);
}
