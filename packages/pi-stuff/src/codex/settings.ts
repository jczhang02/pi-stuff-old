import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { isRuntimeObject } from "../shared/runtime-type.ts";
import { EffectNamespacedSettingsStore, mergedSettingsPath, readTextFileEffect } from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";

export interface CodexSettings {
	readonly fast: boolean;
}

type SettingsListener = (settings: CodexSettings) => void;

const DEFAULT_SETTINGS: CodexSettings = { fast: false };
const SETTINGS_FILENAME = "pi-stuff-codex.json";
const CODEX_NAMESPACE = "codex";

type CodexRecord = { fast: boolean };

interface RawCodexSettings {
	readonly fast?: unknown;
}

function rawCodexSettings<Value>(value: Value): RawCodexSettings {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return {};
	// SAFETY: the normalizer reads only the declared field and accepts only the literal true value.
	return value as Value & RawCodexSettings;
}

function normalizeSettings<Value>(value: Value): CodexSettings {
	return { fast: rawCodexSettings(value).fast === true };
}

function toRecord(settings: CodexSettings): CodexRecord {
	return { fast: settings.fast };
}

export class CodexSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<CodexRecord>;

	private constructor(store: EffectNamespacedSettingsStore<CodexRecord>) {
		this.store = store;
	}

	static load(agentDirectory = getAgentDir()): Effect.Effect<CodexSettingsStore, Error> {
		return Effect.map(
			EffectNamespacedSettingsStore.load<CodexRecord>(
				CODEX_NAMESPACE,
				toRecord(DEFAULT_SETTINGS),
				normalizeSettings,
				{
					path: mergedSettingsPath(agentDirectory),
					legacyPath: join(agentDirectory, SETTINGS_FILENAME),
					acquireLock: acquireSettingsLockEffect,
					reportDiagnostic,
					legacyReader: (legacyPath) =>
						Effect.flatMap(readTextFileEffect(legacyPath), (content) =>
							Effect.try({
								try: () => {
									const raw: unknown = JSON.parse(content);
									return toRecord(normalizeSettings(raw));
								},
								catch: (error) => (error instanceof Error ? error : new Error(String(error))),
							}),
						),
				},
			),
			(store) => new CodexSettingsStore(store),
		);
	}

	static memory(settings: CodexSettings = DEFAULT_SETTINGS): CodexSettingsStore {
		return new CodexSettingsStore(EffectNamespacedSettingsStore.memory(toRecord(settings)));
	}

	get(): CodexSettings {
		return normalizeSettings(this.store.get());
	}

	setFast(fast: boolean): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.replace({ fast }));
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}

	subscribe(listener: SettingsListener): () => void {
		return this.store.subscribe((record) => listener(normalizeSettings(record)));
	}
}
