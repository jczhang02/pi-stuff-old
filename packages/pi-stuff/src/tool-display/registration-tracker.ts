import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Guard } from "typebox/guard";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolActivityMetadata, ToolArguments } from "./activity.ts";
import type {
	SuiteToolCatalogEntry,
	SuiteToolCodeModeContract,
	SuiteToolDefinitionRegistry,
	SuiteToolEnvelopeDecoder,
	SuiteToolEnvelopeFallbackVisibility,
	SuiteToolEnvelopeMediaResolver,
	SuiteToolInvocation,
	SuiteToolInvocationResult,
	SuiteToolRegistrationTracker,
	SuiteToolReplayDefinition,
	SuiteToolSurfaceController,
	SuiteToolTrackerHost,
	ToolUiRuntime,
} from "./contract.ts";
import { type CapturedToolHandler, SuiteToolInvocationRuntime } from "./tool-invocation.ts";
import { isRecordValue } from "./tool-value.ts";

export const SUITE_ACTIVITY_RENDERER = Symbol.for("@jczhang02/pi-stuff-tools/activity-renderer.v1");
export const SUITE_TOOL_ENVELOPE = Symbol.for("@jczhang02/pi-stuff-tools/tool-envelope.v1");
export const SUITE_TOOL_ENVELOPE_COMPANION = Symbol.for("@jczhang02/pi-stuff-tools/tool-envelope-companion.v1");
export const SUITE_TOOL_CODE_MODE = Symbol.for("@jczhang02/pi-stuff-tools/code-mode.v1");
export const SUITE_TOOL_REPLAY = Symbol.for("@jczhang02/pi-stuff-tools/replay-definition.v1");

export interface SuiteActivityRendererMarker {
	readonly activity: ToolActivityMetadata<ToolArguments, unknown>;
	readonly resultIsError?: (args: ToolArguments, result: AgentToolResult<unknown>) => boolean;
}

export interface SuiteToolEnvelopeMarker {
	readonly decode: SuiteToolEnvelopeDecoder;
	readonly media?: SuiteToolEnvelopeMediaResolver;
	readonly registry: SuiteToolDefinitionRegistry;
	readonly showFallback?: SuiteToolEnvelopeFallbackVisibility;
}

export interface SuiteToolEnvelopeCompanionMarker {
	readonly owner: string;
}

type PrepareEnvelopeArguments = (tool: ToolDefinition, args: ToolArguments) => ToolArguments;
type RunSuiteToolInvocation = (
	runtime: SuiteToolInvocationRuntime,
	invocation: SuiteToolInvocation,
) => Promise<SuiteToolInvocationResult>;

function marker<Marker, Tool = object | undefined>(
	tool: Tool,
	key: symbol,
	validate: <Value>(value: Value) => value is Value & Marker,
): Marker | undefined {
	if (!isRecordValue(tool)) return undefined;
	const marker = Object.getOwnPropertyDescriptor(tool, key)?.value;
	return validate(marker) ? marker : undefined;
}

function suiteActivityRendererMarker<Tool>(tool: Tool): SuiteActivityRendererMarker | undefined {
	if (!isRecordValue(tool)) return undefined;
	if (!isRuntimeFunction(tool["renderCall"]) || !isRuntimeFunction(tool["renderResult"])) return undefined;
	return marker<SuiteActivityRendererMarker, Tool>(tool, SUITE_ACTIVITY_RENDERER, isActivityMarker);
}

function hasSuiteActivityRenderer<Tool>(tool: Tool): boolean {
	return suiteActivityRendererMarker(tool) !== undefined;
}

function isActivityMarker<Value>(value: Value): value is Value & SuiteActivityRendererMarker {
	if (!isRecordValue(value) || !isRecordValue(value["activity"])) return false;
	const activity = value["activity"];
	return (
		Array.isArray(activity["categories"]) &&
		isRuntimeFunction(activity["classify"]) &&
		(activity["silentSuccess"] === undefined || isRuntimeBoolean(activity["silentSuccess"])) &&
		(activity["summarizeIssue"] === undefined || isRuntimeFunction(activity["summarizeIssue"])) &&
		(value["resultIsError"] === undefined || isRuntimeFunction(value["resultIsError"]))
	);
}

function isCodeModeContract<Value>(value: Value): value is Value & SuiteToolCodeModeContract {
	if (!isRecordValue(value)) return false;
	if (value["replay"] !== "never" && value["replay"] !== "record" && value["replay"] !== "reexecute") {
		return false;
	}
	if (value["compensate"] !== undefined && !isRuntimeFunction(value["compensate"])) return false;
	if (value["requiresApproval"] !== undefined && !isRuntimeBoolean(value["requiresApproval"])) return false;
	if (value["lifecycle"] !== undefined) {
		if (!isRecordValue(value["lifecycle"])) return false;
		if (
			value["lifecycle"]["disposeExecution"] !== undefined &&
			!isRuntimeFunction(value["lifecycle"]["disposeExecution"])
		) {
			return false;
		}
		if (value["lifecycle"]["onPassEnd"] !== undefined && !isRuntimeFunction(value["lifecycle"]["onPassEnd"])) {
			return false;
		}
	}
	return true;
}

function isEnvelopeMarker<Value>(value: Value): value is Value & SuiteToolEnvelopeMarker {
	if (!isRecordValue(value) || !isRuntimeFunction(value["decode"]) || !isRecordValue(value["registry"])) {
		return false;
	}
	const registry = value["registry"];
	return (
		(value["showFallback"] === undefined || isRuntimeFunction(value["showFallback"])) &&
		(value["media"] === undefined || isRuntimeFunction(value["media"])) &&
		isRuntimeFunction(registry["catalog"]) &&
		isRuntimeFunction(registry["compensate"]) &&
		isRuntimeFunction(registry["get"]) &&
		isRuntimeFunction(registry["invoke"]) &&
		isRuntimeFunction(registry["isActive"]) &&
		isRuntimeFunction(registry["list"])
	);
}

function isCompanion<Value>(value: Value): value is Value & SuiteToolEnvelopeCompanionMarker {
	return isRecordValue(value) && isRuntimeString(value["owner"]);
}

function isReplayDefinition<Value>(value: Value): value is Value & SuiteToolReplayDefinition {
	if (!isRecordValue(value) || !isRecordValue(value["tool"]) || !isRecordValue(value["presentation"])) {
		return false;
	}
	const presentation = value["presentation"];
	const tool = value["tool"];
	return (
		(value["codeMode"] === undefined || isCodeModeContract(value["codeMode"])) &&
		isActivityMarker({
			activity: presentation["activity"],
			resultIsError: presentation["resultIsError"],
		}) &&
		isRuntimeString(tool["name"]) &&
		isRecordValue(tool["parameters"]) &&
		isRuntimeFunction(tool["execute"])
	);
}

function uniqueToolNames(names: readonly string[]): string[] {
	return [...new Set(names)];
}

function projectActiveToolNames(
	names: readonly string[],
	envelope: string,
	envelopeCompanions: ReadonlyMap<string, ReadonlySet<string>>,
	envelopeTools: ReadonlySet<string>,
	tools: ReadonlyMap<string, ToolDefinition>,
): string[] {
	const projected: string[] = [];
	const envelopeNames = [envelope, ...(envelopeCompanions.get(envelope) ?? [])];
	let inserted = false;
	for (const name of uniqueToolNames(names)) {
		if (envelopeTools.has(name)) continue;
		if (tools.has(name)) {
			if (!inserted) projected.push(...envelopeNames);
			inserted = true;
		} else projected.push(name);
	}
	if (!inserted) projected.push(...envelopeNames);
	return projected;
}

function createToolRegistry(
	tools: Map<string, ToolDefinition>,
	invocations: SuiteToolInvocationRuntime,
	isActive: (name: string) => boolean,
	runInvocation: RunSuiteToolInvocation,
): SuiteToolDefinitionRegistry {
	return {
		catalog: () =>
			[...tools.values()].map((definition) => {
				const codeMode = marker<SuiteToolCodeModeContract>(definition, SUITE_TOOL_CODE_MODE, isCodeModeContract);
				const entry: SuiteToolCatalogEntry = { definition };
				if (codeMode) Object.assign(entry, { codeMode });
				return entry;
			}),
		async compensate(invocation) {
			const definition = tools.get(invocation.name);
			const contract = marker<SuiteToolCodeModeContract>(definition, SUITE_TOOL_CODE_MODE, isCodeModeContract);
			if (!contract?.compensate) return false;
			await contract.compensate(invocation);
			return true;
		},
		get: (name) => tools.get(name),
		invoke: (invocation) => runInvocation(invocations, invocation),
		isActive,
		list: () => [...tools.values()],
	};
}

function captureToolEvents(pi: SuiteToolTrackerHost, invocations: SuiteToolInvocationRuntime): ExtensionAPI["on"] {
	return new Proxy(pi.on, {
		apply(target, _thisArgument, argumentsList) {
			const [event, handler] = argumentsList;
			if (isRuntimeString(event) && isRuntimeFunction(handler)) {
				// SAFETY: the Host boundary supplies Tool handlers; capture further restricts the event name.
				invocations.capture(event, handler as CapturedToolHandler);
			}
			return Function.prototype.apply.call(target, pi, argumentsList);
		},
	});
}

/** Observe every Tool registered by Suite modules without changing the Host API. */
export function createSuiteToolRegistrationTrackerWithRuntime<Host extends SuiteToolTrackerHost>(
	pi: Host,
	runtime: ToolUiRuntime,
	prepareEnvelopeRenderArguments: PrepareEnvelopeArguments,
	runInvocation: RunSuiteToolInvocation,
): SuiteToolRegistrationTracker<Host> {
	const envelopeCompanions = new Map<string, Set<string>>();
	const envelopeTools = new Set<string>();
	const toolNames = new Set<string>();
	const tools = new Map<string, ToolDefinition>();
	let enabledEnvelope: string | undefined;
	let virtualActiveTools: string[] | undefined;

	const applyActiveProjection = (): void => {
		if (!enabledEnvelope || !virtualActiveTools) return;
		pi.setActiveTools(
			projectActiveToolNames(virtualActiveTools, enabledEnvelope, envelopeCompanions, envelopeTools, tools),
		);
	};
	const getActiveTools: ExtensionAPI["getActiveTools"] = () =>
		enabledEnvelope && virtualActiveTools ? [...virtualActiveTools] : pi.getActiveTools();
	const setActiveTools: ExtensionAPI["setActiveTools"] = (names) => {
		if (!enabledEnvelope) {
			pi.setActiveTools(names);
			return;
		}
		virtualActiveTools = uniqueToolNames(names.filter((name) => !envelopeTools.has(name)));
		applyActiveProjection();
	};
	const isActive = (name: string): boolean =>
		tools.has(name) &&
		(enabledEnvelope && virtualActiveTools ? virtualActiveTools.includes(name) : pi.getActiveTools().includes(name));
	const invocations = new SuiteToolInvocationRuntime(tools, isActive, getActiveTools);
	const on = captureToolEvents(pi, invocations);

	const registry = createToolRegistry(tools, invocations, isActive, runInvocation);
	const surface: SuiteToolSurfaceController = {
		disableEnvelope(name) {
			if (enabledEnvelope === name && virtualActiveTools) {
				const restore = virtualActiveTools;
				enabledEnvelope = undefined;
				virtualActiveTools = undefined;
				pi.setActiveTools(restore);
				return;
			}
			if (!enabledEnvelope && envelopeTools.has(name)) {
				const hidden = new Set([name, ...(envelopeCompanions.get(name) ?? [])]);
				pi.setActiveTools(pi.getActiveTools().filter((toolName) => !hidden.has(toolName)));
			}
		},
		enableEnvelope(name) {
			if (!envelopeTools.has(name)) throw new Error(`Unknown Suite Tool envelope: ${name}`);
			if (enabledEnvelope && enabledEnvelope !== name) {
				throw new Error(`Suite Tool envelope ${enabledEnvelope} is already enabled`);
			}
			if (!enabledEnvelope) {
				virtualActiveTools = uniqueToolNames(
					pi.getActiveTools().filter((toolName) => !envelopeTools.has(toolName)),
				);
				enabledEnvelope = name;
			}
			applyActiveProjection();
		},
		isEnvelopeEnabled: (name) => enabledEnvelope === name,
	};
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		const envelope = marker<SuiteToolEnvelopeMarker>(tool, SUITE_TOOL_ENVELOPE, isEnvelopeMarker);
		const companion = marker<SuiteToolEnvelopeCompanionMarker>(tool, SUITE_TOOL_ENVELOPE_COMPANION, isCompanion);
		const replay = marker<SuiteToolReplayDefinition>(tool, SUITE_TOOL_REPLAY, isReplayDefinition);
		pi.registerTool(tool);
		if (replay) runtime.registerReplayToolDefinition(replay);
		if (envelope) {
			envelopeTools.add(tool.name);
			runtime.registerEnvelope(
				tool.name,
				envelope.decode,
				(operation) => {
					const nested = envelope.registry.get(operation.name);
					return nested ? prepareEnvelopeRenderArguments(nested, operation.args) : operation.args;
				},
				envelope.showFallback,
			);
			applyActiveProjection();
			return;
		}
		if (companion) {
			envelopeTools.add(tool.name);
			const names = envelopeCompanions.get(companion.owner) ?? new Set<string>();
			names.add(tool.name);
			envelopeCompanions.set(companion.owner, names);
			applyActiveProjection();
			return;
		}
		toolNames.add(tool.name);
		// SAFETY: this registry preserves each Tool definition intact and erases generics only for name-based lookup.
		tools.set(tool.name, tool as ToolDefinition);
		if (enabledEnvelope && virtualActiveTools && pi.getActiveTools().includes(tool.name)) {
			virtualActiveTools = uniqueToolNames([...virtualActiveTools, tool.name]);
			applyActiveProjection();
		}
		if (hasSuiteActivityRenderer(tool)) runtime.markRendererAttached(tool.name);
		else runtime.markRendererDetached(tool.name);
	};
	const api = new Proxy(pi, {
		get(target, property) {
			if (property === "getActiveTools") return getActiveTools;
			if (property === "on") return on;
			if (property === "registerTool") return registerTool;
			if (property === "setActiveTools") return setActiveTools;
			const value = readHostProxyProperty(target, property);
			return Guard.IsFunction(value) ? value.bind(target) : value;
		},
	});
	return { api, registry, surface, toolNames };
}
