import { dirname, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { getHostSharedResource } from "../shared/host-resource.ts";
import { parseJsonValue } from "../shared/json-value.ts";
import {
	EffectNamespacedSettingsStore,
	type EffectNamespaceStoreOptions,
	type EffectNamespaceWriter,
	mergedSettingsPath,
	readTextFileEffect,
} from "../shared/settings-io/index.ts";
import { acquireSettingsLockEffect } from "../shared/settings-io/lock.ts";
import { reportDiagnostic } from "./diagnostics.ts";
import type { StatuslineDensity } from "./statusline.ts";

const SETTINGS_FILE_NAME = "pi-stuff-ui.json";
const UI_NAMESPACE = "ui";

const UI_SETTING_IDS = [
	"statusline",
	"statuslineDensity",
	"statuslineLatestPrompt",
	"welcomeHeader",
	"inputHighlighting",
	"inlineSlashAutocomplete",
] as const;

const BOOLEAN_SETTING_VALUES = [true, false] as const;
const STATUSLINE_DENSITY_VALUES = ["auto", "full", "compact"] as const satisfies readonly StatuslineDensity[];
const LEGACY_STATUSLINE_ICON_VALUES = ["auto", "nerd", "ascii"] as const;
const UI_SETTINGS_VERSION_ONE_SCHEMA = Type.Object(
	{
		inlineSlashAutocomplete: Type.Boolean(),
		inputHighlighting: Type.Boolean(),
		schemaVersion: Type.Literal(1),
		statusline: Type.Boolean(),
		welcomeHeader: Type.Boolean(),
	},
	{ additionalProperties: true },
);
const UI_SETTINGS_VERSION_TWO_SCHEMA = Type.Object(
	{
		inlineSlashAutocomplete: Type.Boolean(),
		inputHighlighting: Type.Boolean(),
		schemaVersion: Type.Literal(2),
		statusline: Type.Boolean(),
		statuslineDensity: Type.Union(STATUSLINE_DENSITY_VALUES.map((value) => Type.Literal(value))),
		statuslineIcons: Type.Union(LEGACY_STATUSLINE_ICON_VALUES.map((value) => Type.Literal(value))),
		statuslineLatestPrompt: Type.Boolean(),
		welcomeHeader: Type.Boolean(),
	},
	{ additionalProperties: true },
);
const UI_SETTINGS_VERSION_THREE_SCHEMA = Type.Object(
	{
		inlineSlashAutocomplete: Type.Boolean(),
		inputHighlighting: Type.Boolean(),
		schemaVersion: Type.Literal(3),
		statusline: Type.Boolean(),
		statuslineDensity: Type.Union(STATUSLINE_DENSITY_VALUES.map((value) => Type.Literal(value))),
		statuslineLatestPrompt: Type.Boolean(),
		welcomeHeader: Type.Boolean(),
	},
	{ additionalProperties: true },
);

export type UiSettingId = (typeof UI_SETTING_IDS)[number];

export interface UiSettings {
	readonly inlineSlashAutocomplete: boolean;
	readonly inputHighlighting: boolean;
	readonly schemaVersion: 3;
	readonly statusline: boolean;
	readonly statuslineDensity: StatuslineDensity;
	readonly statuslineLatestPrompt: boolean;
	readonly welcomeHeader: boolean;
}

type UiSettingsRecord = {
	inlineSlashAutocomplete: boolean;
	inputHighlighting: boolean;
	schemaVersion: 3;
	statusline: boolean;
	statuslineDensity: StatuslineDensity;
	statuslineLatestPrompt: boolean;
	welcomeHeader: boolean;
};

export interface RegisteredUiSetting {
	readonly description: string;
	readonly id: string;
	readonly label: string;
	readonly order: number;
	readonly values: readonly string[];
	get(): string;
	set(value: string): Promise<void>;
	subscribe(listener: () => void): () => void;
}

export interface UiSettingRegistry {
	list(): readonly RegisteredUiSetting[];
	register(setting: RegisteredUiSetting): () => void;
}

export type UiSettingsHost = Pick<ExtensionAPI, "events" | "on">;

const DEFAULT_SETTINGS: UiSettingsRecord = {
	inlineSlashAutocomplete: true,
	inputHighlighting: true,
	schemaVersion: 3,
	statusline: true,
	statuslineDensity: "auto",
	statuslineLatestPrompt: true,
	welcomeHeader: true,
};

type SettingsListener = (settings: UiSettings) => void;
type UiSettingMutationRunner = (program: Effect.Effect<void, Error>) => Promise<void>;

function parseVersionOneSettings(value: Static<typeof UI_SETTINGS_VERSION_ONE_SCHEMA>): UiSettingsRecord {
	return {
		inlineSlashAutocomplete: value.inlineSlashAutocomplete,
		inputHighlighting: value.inputHighlighting,
		schemaVersion: 3,
		statusline: value.statusline,
		statuslineDensity: DEFAULT_SETTINGS.statuslineDensity,
		statuslineLatestPrompt: DEFAULT_SETTINGS.statuslineLatestPrompt,
		welcomeHeader: value.welcomeHeader,
	};
}

function parseSettings<Value>(value: Value): UiSettingsRecord {
	if (Check(UI_SETTINGS_VERSION_ONE_SCHEMA, value)) return parseVersionOneSettings(value);
	if (Check(UI_SETTINGS_VERSION_TWO_SCHEMA, value) || Check(UI_SETTINGS_VERSION_THREE_SCHEMA, value)) {
		return {
			inlineSlashAutocomplete: value.inlineSlashAutocomplete,
			inputHighlighting: value.inputHighlighting,
			schemaVersion: 3,
			statusline: value.statusline,
			statuslineDensity: value.statuslineDensity,
			statuslineLatestPrompt: value.statuslineLatestPrompt,
			welcomeHeader: value.welcomeHeader,
		};
	}
	throw new Error("expected schemaVersion 1, 2, or 3");
}

/** Settings are read at startup and written only after an explicit /ui mutation. */
export class UiSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<UiSettingsRecord>;

	private constructor(store: EffectNamespacedSettingsStore<UiSettingsRecord>) {
		this.store = store;
	}

	static load(
		path = mergedSettingsPath(getAgentDir()),
		writer?: EffectNamespaceWriter,
	): Effect.Effect<UiSettingsStore, Error> {
		const options: EffectNamespaceStoreOptions = {
			path,
			legacyPath: join(dirname(path), SETTINGS_FILE_NAME),
			acquireLock: acquireSettingsLockEffect,
			legacyReader: (legacyPath) =>
				Effect.catch(
					Effect.flatMap(readTextFileEffect(legacyPath), (content) =>
						Effect.try({
							try: () => parseSettings(parseJsonValue(content)),
							catch: normalizeError,
						}),
					),
					() => Effect.succeed(undefined),
				),
			reportDiagnostic: (diagnostic) =>
				reportDiagnostic({
					...diagnostic,
					action: "/ui",
					capability: "UI",
					key: "invalid-settings",
					summary: "UI settings were invalid and built-in defaults are active",
				}),
		};
		if (writer) Object.assign(options, { writer });
		return Effect.map(
			EffectNamespacedSettingsStore.load(UI_NAMESPACE, DEFAULT_SETTINGS, parseSettings, options),
			(store) => new UiSettingsStore(store),
		);
	}

	static memory(value: UiSettings = DEFAULT_SETTINGS): UiSettingsStore {
		return new UiSettingsStore(EffectNamespacedSettingsStore.memory(parseSettings(value)));
	}

	get(): UiSettings {
		return this.store.get();
	}

	getValue<Id extends UiSettingId>(id: Id): UiSettings[Id] {
		return this.store.get()[id];
	}

	subscribe(listener: SettingsListener): () => void {
		return this.store.subscribe(listener);
	}

	set<Id extends UiSettingId>(id: Id, value: UiSettings[Id]): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.update({ [id]: value }));
	}

	whenIdle(): Effect.Effect<void> {
		return this.store.whenIdle();
	}
}

class UiSettingRegistryImplementation implements UiSettingRegistry {
	private current: UiSettingRegistryGeneration;
	private generation = 0;
	private readonly settings = new Map<string, RegisteredUiSetting>();

	constructor() {
		this.current = new UiSettingRegistryGeneration(this, this.generation);
	}

	beginGeneration(): UiSettingRegistry {
		this.generation += 1;
		this.settings.clear();
		this.current = new UiSettingRegistryGeneration(this, this.generation);
		return this.current;
	}

	currentGeneration(): UiSettingRegistry {
		return this.current;
	}

	list(generation = this.generation): readonly RegisteredUiSetting[] {
		if (generation !== this.generation) return [];
		return [...this.settings.values()].sort(
			(left, right) => left.order - right.order || left.id.localeCompare(right.id),
		);
	}

	register(setting: RegisteredUiSetting, generation = this.generation): () => void {
		if (generation !== this.generation) return () => {};
		if (!setting.id.trim()) throw new Error("UI setting id must not be empty");
		if (this.settings.has(setting.id)) throw new Error(`Duplicate UI setting id: ${setting.id}`);
		this.settings.set(setting.id, setting);
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			if (this.settings.get(setting.id) === setting) this.settings.delete(setting.id);
		};
	}
}

class UiSettingRegistryGeneration implements UiSettingRegistry {
	private readonly generation: number;
	private readonly owner: UiSettingRegistryImplementation;

	constructor(owner: UiSettingRegistryImplementation, generation: number) {
		this.owner = owner;
		this.generation = generation;
	}

	list(): readonly RegisteredUiSetting[] {
		return this.owner.list(this.generation);
	}

	register(setting: RegisteredUiSetting): () => void {
		return this.owner.register(setting, this.generation);
	}
}

const SETTINGS_REGISTRY = Symbol.for("@jczhang02/pi-stuff-ui/settings-registry/v1");
const SETTINGS_REGISTRY_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/settings-registry-discovery/v1";

function settingsRegistries(): WeakMap<object, UiSettingRegistryImplementation> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, SETTINGS_REGISTRY)?.value;
	if (existing instanceof WeakMap) return existing;
	const created = new WeakMap<object, UiSettingRegistryImplementation>();
	Object.defineProperty(globalThis, SETTINGS_REGISTRY, {
		configurable: true,
		value: created,
		writable: true,
	});
	return created;
}

export function beginUiSettingsGeneration(pi: UiSettingsHost): UiSettingRegistry {
	return getUiSettingRegistryImplementation(pi).beginGeneration();
}

export function getUiSettingRegistry(pi: UiSettingsHost): UiSettingRegistry {
	return getUiSettingRegistryImplementation(pi).currentGeneration();
}

function getUiSettingRegistryImplementation(pi: UiSettingsHost): UiSettingRegistryImplementation {
	const registries = settingsRegistries();
	return getHostSharedResource(
		pi.events,
		registries,
		SETTINGS_REGISTRY_DISCOVERY_EVENT,
		() => new UiSettingRegistryImplementation(),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
}

interface OwnedSettingDefinition<Id extends UiSettingId> {
	readonly description: string;
	readonly id: Id;
	readonly label: string;
	readonly order: number;
}

function registerStoreSetting<Id extends UiSettingId>(
	registry: UiSettingRegistry,
	store: UiSettingsStore,
	runMutation: UiSettingMutationRunner,
	definition: OwnedSettingDefinition<Id>,
	values: readonly UiSettings[Id][],
): () => void {
	const serializedValues = values.map(String);
	return registry.register({
		...definition,
		get: () => String(store.getValue(definition.id)),
		set: async (value) => {
			const index = serializedValues.indexOf(value);
			const storedValue = values[index];
			if (storedValue === undefined) throw new Error(`Invalid ${definition.id} value: ${value}`);
			await runMutation(store.set(definition.id, storedValue));
		},
		subscribe: (listener) => store.subscribe(listener),
		values: serializedValues,
	});
}

export function registerOwnedUiSettings(
	registry: UiSettingRegistry,
	store: UiSettingsStore,
	runMutation: UiSettingMutationRunner,
): () => void {
	const unregister = [
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Show session and context information below the editor",
				id: "statusline",
				label: "Statusline",
				order: 10,
			},
			BOOLEAN_SETTING_VALUES,
		),
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Choose how much Statusline detail is retained as space narrows",
				id: "statuslineDensity",
				label: "Statusline density",
				order: 11,
			},
			STATUSLINE_DENSITY_VALUES,
		),
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Show the latest prompt under the Statusline when space allows",
				id: "statuslineLatestPrompt",
				label: "Latest prompt",
				order: 12,
			},
			BOOLEAN_SETTING_VALUES,
		),
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Show startup context summary (applies next launch)",
				id: "welcomeHeader",
				label: "Welcome header",
				order: 20,
			},
			BOOLEAN_SETTING_VALUES,
		),
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Highlight recognized commands and skills while typing",
				id: "inputHighlighting",
				label: "Input highlighting",
				order: 30,
			},
			BOOLEAN_SETTING_VALUES,
		),
		registerStoreSetting(
			registry,
			store,
			runMutation,
			{
				description: "Suggest Host-ranked Skills after slash text anywhere in the input",
				id: "inlineSlashAutocomplete",
				label: "Inline slash autocomplete",
				order: 40,
			},
			BOOLEAN_SETTING_VALUES,
		),
	];
	return () => {
		for (const dispose of unregister.reverse()) dispose();
	};
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
