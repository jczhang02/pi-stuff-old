import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isRuntimeObject } from "../../../shared/runtime-type.ts";
import type { AgentConfig } from "../agents/agents.ts";

export const AGENT_DEFINITION_PROJECTION_VERSION = 4 as const;
export const LAUNCH_BINDING_PROJECTION_VERSION = 4 as const;

function stableJson<Value>(value: Value): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && isRuntimeObject(value)) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256<Value>(value: Value): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function fileDigest(filePath: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Public-safe, deterministic evidence for the parsed launch-affecting agent definition. */
export function projectAgentDefinition(agent: AgentConfig) {
	return {
		version: AGENT_DEFINITION_PROJECTION_VERSION,
		name: agent.name,
		localName: agent.localName,
		packageName: agent.packageName,
		filePath: agent.filePath,
		fileContentDigest: fileDigest(agent.filePath),
		systemPrompt: agent.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		model: agent.model,
		fallbackModels: agent.fallbackModels,
		thinking: agent.thinking,
		tools: agent.tools,
		excludeTools: agent.excludeTools,
		mcpDirectTools: agent.mcpDirectTools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		skills: agent.skills,
		skillPath: agent.skillPath,
		maxSubagentDepth: agent.maxSubagentDepth,
		toolBudget: agent.toolBudget,
		toolTimeoutMs: agent.toolTimeoutMs,
	};
}

export function agentDefinitionDigest(agent: AgentConfig): string {
	return sha256(projectAgentDefinition(agent));
}

export interface LaunchBindingInput {
	definitionDigest: string;
	/** Caller task; runtime acceptance/output task annotations are explicitly outside the preflight-known subset. */
	task?: string;
	modelCandidates?: string[];
	thinking?: string;
	systemPrompt?: string | null;
	systemPromptMode?: AgentConfig["systemPromptMode"];
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	tools?: string[];
	excludeTools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	toolBudget?: AgentConfig["toolBudget"];
	toolTimeoutMs?: number;
	maxSubagentDepth?: number;
	capabilityCeiling?: unknown;
}

/** Canonical projection of the resolved inputs handed to the child. */
export function projectLaunchBinding(input: LaunchBindingInput) {
	return {
		version: LAUNCH_BINDING_PROJECTION_VERSION,
		definitionDigest: input.definitionDigest,
		taskDigest: input.task === undefined ? undefined : sha256(input.task),
		// The ordered candidate set already contains each attempted model; keeping only
		// this set makes retries correlate to the same preflight binding.
		modelCandidates: input.modelCandidates,
		thinking: input.thinking,
		systemPromptDigest:
			input.systemPrompt === undefined || input.systemPrompt === null ? undefined : sha256(input.systemPrompt),
		systemPromptMode: input.systemPromptMode,
		inheritProjectContext: input.inheritProjectContext,
		inheritSkills: input.inheritSkills,
		skills: input.skills,
		tools: input.tools,
		excludeTools: input.excludeTools,
		extensions: input.extensions,
		subagentOnlyExtensions: input.subagentOnlyExtensions,
		mcpDirectTools: input.mcpDirectTools,
		toolBudget: input.toolBudget,
		toolTimeoutMs: input.toolTimeoutMs,
		maxSubagentDepth: input.maxSubagentDepth,
		capabilityCeiling: input.capabilityCeiling,
	};
}

export function launchBindingDigest(input: LaunchBindingInput): string {
	return sha256(projectLaunchBinding(input));
}
