import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../../shared/json-value.ts";
import { readTextFileEffect } from "../../shared/settings-io/file.ts";
import { mergedSettingsPath } from "../../shared/settings-io/paths.ts";
import {
	EffectNamespacedSettingsStore,
	type EffectNamespaceStoreOptions,
	type NamespaceRecord,
} from "../../shared/settings-io/store.ts";

export const GOAL_SETTINGS_FILE = "pi-stuff.json";
const GOAL_NAMESPACE = "goal";
const LEGACY_GOAL_SETTINGS_FILE = "pi-goal.json";
const GOAL_TOOL_VISIBILITIES = ["always", "after-first-goal"] as const;
const CONTINUATION_LIMIT_SCHEMA = Type.Union([
	Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
	Type.Null(),
]);
const GOAL_SETTINGS_INPUT_SCHEMA = Type.Object(
	{
		continuationLimits: Type.Optional(
			Type.Object(
				{
					automaticTurns: Type.Optional(CONTINUATION_LIMIT_SCHEMA),
					noProgressTurns: Type.Optional(CONTINUATION_LIMIT_SCHEMA),
				},
				{ additionalProperties: true },
			),
		),
		experimental: Type.Optional(
			Type.Object({ goals: Type.Optional(Type.Boolean()) }, { additionalProperties: true }),
		),
		rpc: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: true })),
		toolVisibility: Type.Optional(Type.Union(GOAL_TOOL_VISIBILITIES.map((value) => Type.Literal(value)))),
	},
	{ additionalProperties: true },
);

type GoalToolVisibility = (typeof GOAL_TOOL_VISIBILITIES)[number];
type ContinuationLimit = number | null;

export interface GoalSettings {
	toolVisibility: GoalToolVisibility;
	experimental: {
		goals: boolean;
	};
	rpc: {
		enabled: boolean;
	};
	continuationLimits: {
		automaticTurns: ContinuationLimit;
		noProgressTurns: ContinuationLimit;
	};
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
	toolVisibility: "always",
	experimental: { goals: false },
	rpc: { enabled: false },
	continuationLimits: { automaticTurns: null, noProgressTurns: null },
};

export interface GoalSettingsLoadIssue {
	readonly kind: "invalid";
	readonly reason: string;
}

export class GoalSettingsStore {
	private readonly store: EffectNamespacedSettingsStore<NamespaceRecord>;
	readonly loadIssue: GoalSettingsLoadIssue | undefined;

	private constructor(store: EffectNamespacedSettingsStore<NamespaceRecord>, loadIssue?: GoalSettingsLoadIssue) {
		this.store = store;
		this.loadIssue = loadIssue;
	}

	static load(settingsPath = mergedSettingsPath(getAgentDir())): Effect.Effect<GoalSettingsStore, Error> {
		let loadIssue: GoalSettingsLoadIssue | undefined;
		const options: EffectNamespaceStoreOptions = {
			path: settingsPath,
			legacyPath: join(dirname(settingsPath), LEGACY_GOAL_SETTINGS_FILE),
			legacyReader: (legacyPath) =>
				Effect.flatMap(readTextFileEffect(legacyPath), (content) =>
					Effect.try({
						try: () => normalizeGoalSettingsRecord(parseJsonValue(content)),
						catch: toError,
					}),
				),
			reportDiagnostic: ({ details, error }) => {
				loadIssue = { kind: "invalid", reason: `${details}: ${formatError(error)}` };
			},
		};
		const storeOptions = Object.hasOwn(process.versions, "bun")
			? { ...options, acquireLock: acquireGoalSettingsLock }
			: options;
		return EffectNamespacedSettingsStore.load<NamespaceRecord>(
			GOAL_NAMESPACE,
			goalSettingsRecord(DEFAULT_GOAL_SETTINGS),
			normalizeGoalSettingsRecord,
			storeOptions,
		).pipe(Effect.map((store) => new GoalSettingsStore(store, loadIssue)));
	}

	get(): GoalSettings {
		return normalizeGoalSettings(this.store.get()) ?? DEFAULT_GOAL_SETTINGS;
	}

	replace(settings: GoalSettings): Effect.Effect<void, Error> {
		return Effect.asVoid(this.store.updateWith((current) => goalSettingsRecord(settings, current)));
	}
}

export function normalizeGoalSettings<Value>(value: Value): GoalSettings | undefined {
	if (!Check(GOAL_SETTINGS_INPUT_SCHEMA, value)) return undefined;
	if (Object.hasOwn(value, "toolVisibility") && value.toolVisibility === undefined) return undefined;
	return {
		toolVisibility: value.toolVisibility ?? DEFAULT_GOAL_SETTINGS.toolVisibility,
		experimental: { goals: value.experimental?.goals ?? DEFAULT_GOAL_SETTINGS.experimental.goals },
		rpc: { enabled: value.rpc?.enabled ?? DEFAULT_GOAL_SETTINGS.rpc.enabled },
		continuationLimits: {
			automaticTurns:
				value.continuationLimits?.automaticTurns ?? DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
			noProgressTurns:
				value.continuationLimits?.noProgressTurns ?? DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns,
		},
	};
}

function ownRecord(value: JsonInputValue): JsonInputObject | undefined {
	return isJsonInputObject(value) ? value : undefined;
}

function normalizeGoalSettingsRecord<Value>(value: Value): NamespaceRecord {
	const settings = normalizeGoalSettings(value);
	if (!settings) throw new Error("invalid settings shape");
	return goalSettingsRecord(settings, isJsonInputObject(value) ? value : {});
}

function goalSettingsRecord(settings: GoalSettings, current: NamespaceRecord = {}): NamespaceRecord {
	return {
		...current,
		toolVisibility: settings.toolVisibility,
		experimental: { ...ownRecord(current["experimental"]), goals: settings.experimental.goals },
		rpc: { ...ownRecord(current["rpc"]), enabled: settings.rpc.enabled },
		continuationLimits: {
			...ownRecord(current["continuationLimits"]),
			automaticTurns: settings.continuationLimits.automaticTurns,
			noProgressTurns: settings.continuationLimits.noProgressTurns,
		},
	};
}

function acquireGoalSettingsLock(lockPath: string, _owner: string): Effect.Effect<void, Error, Scope.Scope> {
	return Effect.flatMap(
		Effect.tryPromise({
			try: () => import("../../shared/settings-io/lock.ts"),
			catch: toError,
		}),
		({ acquireSettingsLockEffect }) => acquireSettingsLockEffect(lockPath, "Goal"),
	);
}

function formatError(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

function toError(cause: unknown) {
	return cause instanceof Error ? cause : new Error(String(cause));
}
