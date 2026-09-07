/** Validate and load durable Agent recovery descriptors. */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeObject } from "../../../../shared/runtime-type.ts";
import { readBoundedOwnedFile } from "../../shared/private-directory.ts";
import type { ArtifactConfig, ResolvedControlConfig } from "../../shared/types.ts";
import { getErrorMessage } from "../../shared/utils.ts";
import {
	parseSubagentCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
} from "../shared/capability-ceiling.ts";
import { MAX_MODEL_CANDIDATES_PER_CHILD } from "../shared/model-fallback.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import type { BackgroundRecoveryDescriptor } from "./resolved-task.ts";

export type LegacyRecoveryDescriptor = Omit<BackgroundRecoveryDescriptor, "version" | "childIndex" | "context"> & {
	version: 1;
};
export type AsyncRecoveryDescriptor = LegacyRecoveryDescriptor | BackgroundRecoveryDescriptor;

const MAX_RECOVERY_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const NONEMPTY_STRING = Type.String({ pattern: "\\S" });
const STRING_LIST = Type.Array(NONEMPTY_STRING);
const ARTIFACT_CONFIG_PROPERTIES = {
	cleanupDays: Type.Integer({ minimum: 0 }),
	enabled: Type.Boolean(),
	includeInput: Type.Boolean(),
	includeJsonl: Type.Boolean(),
	includeMetadata: Type.Boolean(),
	includeOutput: Type.Boolean(),
	includeTranscript: Type.Optional(Type.Boolean()),
};
const V2_ARTIFACT_CONFIG_SCHEMA = Type.Object(
	{
		...ARTIFACT_CONFIG_PROPERTIES,
		dir: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("session"), Type.Literal("temp")])),
	},
	{ additionalProperties: false },
);
const LEGACY_ARTIFACT_CONFIG_SCHEMA = Type.Object(
	{ ...ARTIFACT_CONFIG_PROPERTIES, dir: Type.Optional(Type.Unknown()) },
	{ additionalProperties: true },
);
const CONTROL_CONFIG_PROPERTIES = {
	activeNoticeAfterMs: Type.Integer({ minimum: 1 }),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	enabled: Type.Boolean(),
	failedToolAttemptsBeforeAttention: Type.Integer({ minimum: 1 }),
	needsAttentionAfterMs: Type.Integer({ minimum: 1 }),
	notifyChannels: Type.Array(Type.Union([Type.Literal("event"), Type.Literal("async"), Type.Literal("intercom")])),
	notifyOn: Type.Array(Type.Union([Type.Literal("active_long_running"), Type.Literal("needs_attention")])),
};
const V2_CONTROL_CONFIG_SCHEMA = Type.Object(CONTROL_CONFIG_PROPERTIES, { additionalProperties: false });
const LEGACY_CONTROL_CONFIG_SCHEMA = Type.Object(CONTROL_CONFIG_PROPERTIES, { additionalProperties: true });
const V2_RECOVERY_DESCRIPTOR_SCHEMA = Type.Object(
	{
		version: Type.Literal(2),
		sourceRunId: NONEMPTY_STRING,
		childIndex: Type.Integer({ minimum: 0 }),
		launchContractDigest: Type.Optional(NONEMPTY_STRING),
		agent: NONEMPTY_STRING,
		context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
		sessionFile: Type.Optional(NONEMPTY_STRING),
		cwd: NONEMPTY_STRING,
		model: Type.Optional(NONEMPTY_STRING),
		modelOrigin: Type.Optional(
			Type.Union([Type.Literal("explicit"), Type.Literal("inherited"), Type.Literal("configured")]),
		),
		fallbackModels: Type.Optional(Type.Array(NONEMPTY_STRING, { maxItems: MAX_MODEL_CANDIDATES_PER_CHILD - 1 })),
		thinking: Type.Optional(NONEMPTY_STRING),
		tools: Type.Optional(STRING_LIST),
		excludeTools: Type.Optional(STRING_LIST),
		extensions: Type.Optional(STRING_LIST),
		subagentOnlyExtensions: Type.Optional(STRING_LIST),
		mcpDirectTools: Type.Optional(STRING_LIST),
		systemPrompt: Type.Optional(Type.String()),
		systemPromptMode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		inheritProjectContext: Type.Boolean(),
		inheritSkills: Type.Boolean(),
		skills: Type.Optional(STRING_LIST),
		skillPath: Type.Optional(STRING_LIST),
		agentFilePath: Type.Optional(NONEMPTY_STRING),
		controlConfig: Type.Optional(Type.Unknown()),
		absoluteDeadlineAt: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		initialTurnBudget: Type.Optional(Type.Unknown()),
		initialToolBudget: Type.Optional(Type.Unknown()),
		toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
		maxSubagentDepth: Type.Integer({ minimum: 0 }),
		capabilityCeiling: Type.Optional(Type.Unknown()),
		sessionDir: Type.Optional(NONEMPTY_STRING),
		artifactsDir: Type.Optional(NONEMPTY_STRING),
		artifactConfig: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
const LEGACY_RECOVERY_DESCRIPTOR_FIELDS = new Set([
	...Object.keys(V2_RECOVERY_DESCRIPTOR_SCHEMA.properties).filter(
		(field) => field !== "childIndex" && field !== "context",
	),
	..."agentContract completionGuard outputPath outputMode structuredOutputSchema acceptance maxOutput".split(" "),
]);

function parseRecoveryJson(descriptorPath: string): JsonValue {
	try {
		return parseJsonValue(readBoundedOwnedFile(descriptorPath, MAX_RECOVERY_DESCRIPTOR_BYTES));
	} catch (error) {
		throw new Error(`Failed to parse async recovery descriptor '${descriptorPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function assertRecoverySchema<Schema extends TSchema, Input>(
	schema: Schema,
	value: Input,
	descriptorPath: string,
	field = "",
): asserts value is Input & Static<Schema> {
	const error = Value.Errors(schema, value)[0];
	if (!error) return;
	if (error.keyword === "additionalProperties") {
		const unknown = error.params.additionalProperties[0];
		throw new Error(
			`Invalid async recovery descriptor '${descriptorPath}': unknown ${field ? `${field} ` : ""}field '${unknown}'.`,
		);
	}
	const nested = error.instancePath.slice(1).replaceAll("/", ".");
	const location = [field, nested].filter(Boolean).join(".") || "descriptor";
	throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${location} ${error.message}.`);
}

function validateArtifactConfig<Value>(value: Value, descriptorPath: string, version: 1 | 2): ArtifactConfig {
	const schema = version === 2 ? V2_ARTIFACT_CONFIG_SCHEMA : LEGACY_ARTIFACT_CONFIG_SCHEMA;
	assertRecoverySchema(schema, value, descriptorPath, "artifactConfig");
	const config: ArtifactConfig = {
		cleanupDays: value.cleanupDays,
		enabled: value.enabled,
		includeInput: value.includeInput,
		includeJsonl: value.includeJsonl,
		includeMetadata: value.includeMetadata,
		includeOutput: value.includeOutput,
	};
	if (value.includeTranscript !== undefined) config.includeTranscript = value.includeTranscript;
	if (value.dir === "project" || value.dir === "session" || value.dir === "temp") config.dir = value.dir;
	return config;
}

function validateControlConfig<Value>(value: Value, descriptorPath: string, version: 1 | 2): ResolvedControlConfig {
	const schema = version === 2 ? V2_CONTROL_CONFIG_SCHEMA : LEGACY_CONTROL_CONFIG_SCHEMA;
	assertRecoverySchema(schema, value, descriptorPath, "controlConfig");
	const config: ResolvedControlConfig = {
		activeNoticeAfterMs: value.activeNoticeAfterMs,
		enabled: value.enabled,
		failedToolAttemptsBeforeAttention: value.failedToolAttemptsBeforeAttention,
		needsAttentionAfterMs: value.needsAttentionAfterMs,
		notifyChannels: [...value.notifyChannels],
		notifyOn: [...value.notifyOn],
	};
	if (value.activeNoticeAfterTokens !== undefined) config.activeNoticeAfterTokens = value.activeNoticeAfterTokens;
	if (value.activeNoticeAfterTurns !== undefined) config.activeNoticeAfterTurns = value.activeNoticeAfterTurns;
	return config;
}

function parseV2RecoveryDescriptor(
	parsed: JsonObject,
	descriptorPath: string,
	configVersion: 1 | 2 = 2,
): BackgroundRecoveryDescriptor {
	let candidate = parsed;
	if (configVersion === 1) {
		candidate = {};
		for (const [field, value] of Object.entries(parsed)) {
			if (field in V2_RECOVERY_DESCRIPTOR_SCHEMA.properties) candidate[field] = value;
		}
		candidate["version"] = 2;
		candidate["childIndex"] = 0;
	}
	assertRecoverySchema(V2_RECOVERY_DESCRIPTOR_SCHEMA, candidate, descriptorPath);
	const {
		artifactConfig: rawArtifactConfig,
		capabilityCeiling: rawCapabilityCeiling,
		controlConfig: rawControlConfig,
		initialToolBudget: rawInitialToolBudget,
		initialTurnBudget: rawInitialTurnBudget,
		...descriptor
	} = candidate;
	let initialTurnBudget: BackgroundRecoveryDescriptor["initialTurnBudget"];
	if (rawInitialTurnBudget !== undefined) {
		const result = resolveTurnBudgetConfig(rawInitialTurnBudget, "recoveryDescriptor.initialTurnBudget");
		if (result.error) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${result.error}`);
		initialTurnBudget = result.turnBudget;
	}
	let initialToolBudget: BackgroundRecoveryDescriptor["initialToolBudget"];
	if (rawInitialToolBudget !== undefined) {
		const result = validateToolBudgetConfig(rawInitialToolBudget, "recoveryDescriptor.initialToolBudget");
		if (result.error) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${result.error}`);
		initialToolBudget = result.budget;
	}
	let capabilityCeiling: ResolvedSubagentCapabilityCeiling | undefined;
	if (rawCapabilityCeiling !== undefined) {
		capabilityCeiling = parseSubagentCapabilityCeiling(
			rawCapabilityCeiling,
			`async recovery descriptor '${descriptorPath}' capabilityCeiling`,
		);
	}
	const result: BackgroundRecoveryDescriptor = { ...descriptor };
	if (rawArtifactConfig !== undefined)
		result.artifactConfig = validateArtifactConfig(rawArtifactConfig, descriptorPath, configVersion);
	if (capabilityCeiling) result.capabilityCeiling = capabilityCeiling;
	if (rawControlConfig !== undefined)
		result.controlConfig = validateControlConfig(rawControlConfig, descriptorPath, configVersion);
	if (initialToolBudget) result.initialToolBudget = initialToolBudget;
	if (initialTurnBudget) result.initialTurnBudget = initialTurnBudget;
	return result;
}

function parseLegacyRecoveryDescriptor(parsed: JsonObject, descriptorPath: string): LegacyRecoveryDescriptor {
	for (const field of Object.keys(parsed)) {
		if (!LEGACY_RECOVERY_DESCRIPTOR_FIELDS.has(field))
			throw new Error(`Invalid async recovery descriptor '${descriptorPath}': unknown field '${field}'.`);
	}
	if (parsed["version"] !== 1)
		throw new Error(`Invalid async recovery descriptor '${descriptorPath}': version must be 1.`);
	const {
		sourceRunId,
		agent,
		cwd,
		systemPromptMode,
		inheritProjectContext,
		inheritSkills,
		maxSubagentDepth,
		capabilityCeiling,
	} = parseV2RecoveryDescriptor({ ...parsed, version: 2, childIndex: 0 }, descriptorPath, 1);
	const descriptor = Object.assign({}, parsed, {
		version: 1 as const,
		sourceRunId,
		agent,
		cwd,
		systemPromptMode,
		inheritProjectContext,
		inheritSkills,
		maxSubagentDepth,
	});
	return capabilityCeiling ? Object.assign(descriptor, { capabilityCeiling }) : descriptor;
}

export function readAsyncRecoveryDescriptor(
	asyncDir: string | undefined,
	childIndex?: number,
): AsyncRecoveryDescriptor | undefined {
	if (!asyncDir) return undefined;
	const collectionPath = path.join(asyncDir, "recovery-descriptors.json");
	let descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
	let value: JsonValue | undefined;
	if (fs.existsSync(collectionPath)) {
		const collection = parseRecoveryJson(collectionPath);
		if (!collection || !isRuntimeObject(collection) || Array.isArray(collection)) {
			throw new Error(`Invalid async recovery descriptor '${collectionPath}': expected an object.`);
		}
		const wrapper = collection;
		if (wrapper["version"] !== 2 || !Array.isArray(wrapper["children"])) {
			throw new Error(
				`Invalid async recovery descriptor '${collectionPath}': expected version 2 with a children array.`,
			);
		}
		for (const field of Object.keys(wrapper)) {
			if (field !== "version" && field !== "children") {
				throw new Error(`Invalid async recovery descriptor '${collectionPath}': unknown field '${field}'.`);
			}
		}
		if (childIndex === undefined) {
			if (wrapper["children"].length !== 1) return undefined;
			value = wrapper["children"][0];
		} else {
			value = wrapper["children"].find((child) => {
				if (!child || !isRuntimeObject(child) || Array.isArray(child)) return false;
				return child["childIndex"] === childIndex;
			});
			if (value === undefined) {
				throw new Error(`Invalid async recovery descriptor '${collectionPath}': child ${childIndex} is missing.`);
			}
		}
		descriptorPath = `${collectionPath} children[${childIndex ?? 0}]`;
	} else {
		if (!fs.existsSync(descriptorPath)) return undefined;
		value = parseRecoveryJson(descriptorPath);
	}
	if (!value || !isRuntimeObject(value) || Array.isArray(value))
		throw new Error(`Invalid async recovery descriptor '${descriptorPath}': expected an object.`);
	const parsed = value;
	if (parsed["version"] === 2) {
		const descriptor = parseV2RecoveryDescriptor(parsed, descriptorPath);
		if (childIndex !== undefined && descriptor.childIndex !== childIndex) {
			throw new Error(`Invalid async recovery descriptor '${descriptorPath}': expected childIndex ${childIndex}.`);
		}
		return descriptor;
	}
	return parseLegacyRecoveryDescriptor(parsed, descriptorPath);
}
