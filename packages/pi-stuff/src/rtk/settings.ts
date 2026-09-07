import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { EffectNamespacedSettingsStore, mergedSettingsPath, readTextFileEffect } from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";

const SETTINGS_FILE_NAME = "pi-stuff-rtk.json";
const RTK_NAMESPACE = "rtk";
const RTK_SETTINGS_SCHEMA = Type.Object(
	{
		outputProjection: Type.Boolean(),
		rewriteCommands: Type.Boolean(),
		schemaVersion: Type.Literal(1),
	},
	{ additionalProperties: true },
);

export interface RtkSettings {
	readonly outputProjection: boolean;
	readonly rewriteCommands: boolean;
	readonly schemaVersion: 1;
}

type RtkSettingsRecord = {
	outputProjection: boolean;
	rewriteCommands: boolean;
	schemaVersion: 1;
};

const DEFAULT_SETTINGS: RtkSettingsRecord = {
	outputProjection: true,
	rewriteCommands: true,
	schemaVersion: 1,
};

type SettingsListener = (settings: RtkSettings) => void;

function normalizeSettings<Value>(value: Value): RtkSettingsRecord {
	if (!Check(RTK_SETTINGS_SCHEMA, value)) {
		throw new Error("expected schemaVersion 1 and boolean RTK settings");
	}
	return {
		outputProjection: value.outputProjection,
		rewriteCommands: value.rewriteCommands,
		schemaVersion: 1,
	};
}

/** Settings remain read-only until the user changes them from `/rtk`. */
export class RtkSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<RtkSettingsRecord>;

	private constructor(store: EffectNamespacedSettingsStore<RtkSettingsRecord>) {
		this.store = store;
	}

	static load(path = mergedSettingsPath(getAgentDir())): Effect.Effect<RtkSettingsStore, Error> {
		return Effect.map(
			EffectNamespacedSettingsStore.load(RTK_NAMESPACE, DEFAULT_SETTINGS, normalizeSettings, {
				path,
				legacyPath: join(dirname(path), SETTINGS_FILE_NAME),
				acquireLock: acquireSettingsLockEffect,
				legacyReader: (legacyPath) =>
					Effect.catch(
						Effect.flatMap(readTextFileEffect(legacyPath), (content) =>
							Effect.try({
								try: () => normalizeSettings(JSON.parse(content)),
								catch: normalizeError,
							}),
						),
						() => Effect.succeed(undefined),
					),
				reportDiagnostic: (diagnostic) =>
					reportDiagnostic({
						...diagnostic,
						action: "/rtk",
						capability: "RTK",
						key: "invalid-settings",
						summary: "RTK settings were invalid and built-in defaults are active",
					}),
			}),
			(store) => new RtkSettingsStore(store),
		);
	}

	static memory(value: RtkSettings = DEFAULT_SETTINGS): RtkSettingsStore {
		return new RtkSettingsStore(EffectNamespacedSettingsStore.memory(normalizeSettings(value)));
	}

	get(): RtkSettings {
		return this.store.get();
	}

	subscribe(listener: SettingsListener): () => void {
		return this.store.subscribe(listener);
	}

	setOutputProjection(outputProjection: boolean): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.update({ outputProjection }));
	}

	setRewriteCommands(rewriteCommands: boolean): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.update({ rewriteCommands }));
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
