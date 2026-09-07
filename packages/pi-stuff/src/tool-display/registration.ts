import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type Static, type TSchema, Type } from "typebox";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolActivityMetadata, ToolArguments } from "./activity.ts";
import {
	getToolUiRuntime,
	type SuiteToolCodeModeContract,
	type SuiteToolEnvelopePresentation,
	type SuiteToolPresentation,
	type SuiteToolRegistrationHost,
	type SuiteToolRegistrationTracker,
	type SuiteToolReplayDefinition,
	type SuiteToolTrackerHost,
	type ToolRenderContext,
	type ToolResultRenderOptions,
	type ToolUiRuntimeHost,
} from "./contract.ts";
import { prepareEnvelopeRenderArguments, renderEnvelopeOperations } from "./envelope-renderer.ts";
import { attachRenderer, terminalSummary } from "./registered-tool-renderer.ts";
import {
	createSuiteToolRegistrationTrackerWithRuntime,
	SUITE_TOOL_CODE_MODE,
	SUITE_TOOL_ENVELOPE,
	SUITE_TOOL_ENVELOPE_COMPANION,
	SUITE_TOOL_REPLAY,
	type SuiteToolEnvelopeCompanionMarker,
	type SuiteToolEnvelopeMarker,
} from "./registration-tracker.ts";
import { EmptyToolComponent } from "./render.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { buildToolResultLines } from "./tool-text.ts";

/** Predeclare Activity metadata for a conditionally registered owned Tool. */
export function registerSuiteToolActivityMetadata<TArgs extends ToolArguments, TDetails>(
	pi: ToolUiRuntimeHost,
	name: string,
	activity: ToolActivityMetadata<TArgs, TDetails>,
	resultIsError?: (args: Readonly<TArgs>, result: AgentToolResult<TDetails>) => boolean,
): void {
	getToolUiRuntime(pi).registerActivity(name, activity, resultIsError);
}

/** Observe every Tool registered by Suite modules without changing the Host API. */
export function createSuiteToolRegistrationTracker<Host extends SuiteToolTrackerHost>(
	pi: Host,
): SuiteToolRegistrationTracker<Host> {
	return createSuiteToolRegistrationTrackerWithRuntime(
		pi,
		getToolUiRuntime(pi),
		prepareEnvelopeRenderArguments,
		(runtime, invocation) => Effect.runPromise(Effect.scoped(runtime.invoke(invocation))),
	);
}
/** Fail fast when a Suite-owned Tool bypasses or under-declares the required Activity contract. */
export function assertSuiteToolActivityCoverage(
	pi: SuiteToolTrackerHost,
	declaredToolNames: readonly string[],
	registeredToolNames?: ReadonlySet<string>,
	optionalToolNames: readonly string[] = [],
	deferredToolNames: readonly string[] = [],
): void {
	const finalTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool] as const));
	const runtime = getToolUiRuntime(pi);
	let metadataToolNames = [...declaredToolNames, ...deferredToolNames];
	let rendererToolNames = [
		...declaredToolNames,
		...deferredToolNames.filter((name) => runtime.hasActivityRenderer(name)),
	];
	if (registeredToolNames) {
		const declared = new Set([...declaredToolNames, ...deferredToolNames, ...optionalToolNames]);
		// A module may be intentionally idempotent when the Suite is loaded
		// twice in one Host. Count Tools that are already installed on the shared
		// Extension API as present, while still using this invocation's tracker to
		// reject newly registered undeclared Tools.
		const available = new Set(finalTools.keys());
		const undeclared = [...registeredToolNames].filter((name) => !declared.has(name)).sort();
		if (undeclared.length > 0) {
			throw new Error(`Suite registered undeclared Tools: ${undeclared.join(", ")}`);
		}
		const unregistered = declaredToolNames
			.filter((name) => !registeredToolNames.has(name) && !available.has(name))
			.sort();
		if (unregistered.length > 0) {
			throw new Error(`Suite declared unregistered Tools: ${unregistered.join(", ")}`);
		}
		metadataToolNames = [
			...declaredToolNames,
			...deferredToolNames,
			...optionalToolNames.filter((name) => registeredToolNames.has(name) || runtime.hasActivityRenderer(name)),
		];
		rendererToolNames = [
			...declaredToolNames,
			...deferredToolNames.filter((name) => runtime.hasActivityRenderer(name)),
			...optionalToolNames.filter((name) => registeredToolNames.has(name) || runtime.hasActivityRenderer(name)),
		];
	}
	const missing = getToolUiRuntime(pi).missingActivityMetadata(metadataToolNames);
	if (missing.length > 0) {
		throw new Error(`Suite Tools missing Activity metadata: ${missing.join(", ")}`);
	}
	const missingRenderers = [...runtime.missingActivityRenderers(rendererToolNames)].sort();
	if (missingRenderers.length > 0) {
		throw new Error(`Suite Tools missing Activity renderer: ${missingRenderers.join(", ")}`);
	}
}

function restoreReplacedReplayTool(pi: SuiteToolRegistrationHost, name: string, replaced: boolean): void {
	if (!replaced || pi.getActiveTools().includes(name)) return;
	pi.setActiveTools([...pi.getActiveTools(), name]);
}

/**
 * Register an execution envelope whose nested Suite Tools retain their original
 * Tool Activity renderers. The envelope stays silent only while nested rows own its outcome.
 */
export function registerSuiteToolEnvelope<TParams extends TSchema, TDetails = unknown>(
	pi: SuiteToolRegistrationHost,
	tool: ToolDefinition<TParams, TDetails>,
	presentation: SuiteToolEnvelopePresentation,
): void {
	const runtime = getToolUiRuntime(pi);
	const replacesReplay = runtime.markLiveTool(tool.name);
	runtime.registerDetailPresentation(tool.name, {
		argumentKeys: [],
		label: () => sanitizeTerminalText(tool.label ?? tool.name) || tool.name,
		summary: (_args, result, state) =>
			state === "running"
				? { fromResult: false, text: "working" }
				: result
					? terminalSummary(result, state, true)
					: { fromResult: false, text: state },
		target: () => "",
	});
	const decorated: ToolDefinition<TParams, TDetails> = {
		...tool,
		execute: async (toolCallId, input, signal, onUpdate, context) => {
			const observe = (result: AgentToolResult<TDetails>): void => {
				runtime.observeEnvelopeResult(tool.name, toolCallId, result.details);
			};
			const result = await tool.execute(
				toolCallId,
				input,
				signal,
				(partial) => {
					observe(partial);
					onUpdate?.(partial);
				},
				context,
			);
			observe(result);
			return result;
		},
		renderShell: "self" as const,
		renderCall: () => new EmptyToolComponent(),
		renderResult: (result, options, theme, context) =>
			// SAFETY: this adapter preserves Pi's renderer values while erasing only the envelope Tool's generic parameters.
			renderEnvelopeOperations(
				result as AgentToolResult<unknown>,
				options as ToolResultRenderOptions,
				theme,
				context as ToolRenderContext<ToolArguments>,
				presentation,
				tool as ToolDefinition,
			),
	};
	const marker: SuiteToolEnvelopeMarker = {
		decode: presentation.decode,
		registry: presentation.registry,
	};
	if (presentation.media) Object.assign(marker, { media: presentation.media });
	if (presentation.showFallback) Object.assign(marker, { showFallback: presentation.showFallback });
	Object.defineProperty(decorated, SUITE_TOOL_ENVELOPE, {
		enumerable: true,
		value: marker,
	});
	pi.registerTool<TParams, TDetails>(decorated);
	restoreReplacedReplayTool(pi, tool.name, replacesReplay);
}

/** Register a Tool that is visible only while its owning execution envelope is enabled. */
export function registerSuiteToolEnvelopeCompanion<TParams extends TSchema, TDetails = unknown>(
	pi: SuiteToolRegistrationHost,
	owner: string,
	tool: ToolDefinition<TParams, TDetails>,
	presentation: SuiteToolPresentation<Static<TParams> & ToolArguments, TDetails>,
): void {
	const runtime = getToolUiRuntime(pi);
	const replacesReplay = runtime.markLiveTool(tool.name);
	registerSuiteToolActivityMetadata(pi, tool.name, presentation.activity, presentation.resultIsError);
	const decorated = attachRenderer<TParams, TDetails>(tool, presentation, runtime);
	Object.defineProperty(decorated, SUITE_TOOL_ENVELOPE_COMPANION, {
		enumerable: true,
		value: { owner } satisfies SuiteToolEnvelopeCompanionMarker,
	});
	pi.registerTool<TParams, TDetails>(decorated);
	restoreReplacedReplayTool(pi, tool.name, replacesReplay);
	runtime.markRendererAttached(tool.name);
}

/**
 * Register a Suite-owned Tool without changing its execute protocol or result.
 * Returns the exact registered definition so an owner can refresh dynamic model-facing fields through Pi's public API.
 */
export function registerSuiteOwnedTool<TParams extends TSchema, TDetails = unknown>(
	pi: SuiteToolRegistrationHost,
	tool: ToolDefinition<TParams, TDetails>,
	presentation: SuiteToolPresentation<Static<TParams> & ToolArguments, TDetails>,
	codeMode?: SuiteToolCodeModeContract,
): ToolDefinition<TParams, TDetails> {
	const runtime = getToolUiRuntime(pi);
	const replacesReplay = runtime.markLiveTool(tool.name);
	registerSuiteToolActivityMetadata(pi, tool.name, presentation.activity, presentation.resultIsError);
	const decorated = attachRenderer<TParams, TDetails>(tool, presentation, runtime);
	if (codeMode)
		Object.defineProperty(decorated, SUITE_TOOL_CODE_MODE, {
			enumerable: true,
			value: codeMode,
		});
	Object.defineProperty(decorated, SUITE_TOOL_REPLAY, {
		enumerable: true,
		// SAFETY: replay markers remain attached to the Tool and presentation whose generic schema this registry erases.
		value: Object.assign(
			{
				presentation: presentation as SuiteToolPresentation<ToolArguments, unknown>,
				tool: tool as ToolDefinition<TSchema, unknown>,
			},
			codeMode ? { codeMode } : undefined,
		) satisfies SuiteToolReplayDefinition,
	});
	pi.registerTool<TParams, TDetails>(decorated);
	restoreReplacedReplayTool(pi, tool.name, replacesReplay);
	runtime.markRendererAttached(tool.name);
	return decorated;
}

function replayFallbackLabel(name: string): string {
	return (
		name
			.split(/[_-]+/u)
			.filter(Boolean)
			.map((part) => (part.toLowerCase() === "ctx" ? "Context" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
			.join(" ") || name
	);
}

function replayUnavailableResult(name: string): AgentToolResult<unknown> & { isError: true } {
	return {
		content: [{ type: "text", text: `${name} is unavailable during Session replay.` }],
		details: undefined,
		isError: true,
	};
}

function replayFallbackDefinition(name: string): SuiteToolReplayDefinition {
	return {
		tool: {
			name,
			label: replayFallbackLabel(name),
			description: `Historical ${name} Tool display`,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => replayUnavailableResult(name),
		},
		presentation: {
			activity: { categories: [], classify: () => [] },
			runningSummary: "working",
			summarize: (_args, result, state) =>
				buildToolResultLines(result)[0] ?? (state === "success" ? "done" : "failed"),
			target: (args) => {
				for (const key of ["action", "path", "query", "id", "to"] as const) {
					if (isRuntimeString(args[key]) && args[key]) return args[key];
				}
				return "";
			},
		},
	};
}

function registerMissingReplayToolDefinitions(
	pi: ExtensionAPI,
	registeredNames: Set<string>,
	historicalNames?: ReadonlySet<string>,
): readonly string[] {
	const runtime = getToolUiRuntime(pi);
	const registeredReplayNames: string[] = [];
	for (const definition of runtime.missingResumeToolDefinitions(registeredNames, historicalNames)) {
		registerSuiteOwnedTool(
			pi,
			{
				...definition.tool,
				execute: async () => replayUnavailableResult(definition.tool.name),
			},
			definition.presentation,
			definition.codeMode,
		);
		runtime.markReplayOnlyTool(definition.tool.name);
		registeredNames.add(definition.tool.name);
		registeredReplayNames.push(definition.tool.name);
	}
	for (const name of runtime.missingReplayFallbackToolNames(registeredNames, historicalNames)) {
		const definition = replayFallbackDefinition(name);
		registerSuiteOwnedTool(pi, definition.tool, definition.presentation);
		runtime.markReplayOnlyTool(name);
		registeredNames.add(name);
		registeredReplayNames.push(name);
	}
	return registeredReplayNames;
}

/** Stage the Suite catalog and prebind it only when the Host is replacing a Session in-process. */
export function configureSuiteToolReplay(
	pi: ExtensionAPI,
	registeredNames: ReadonlySet<string>,
	fallbackNames: readonly string[] = [],
): void {
	const runtime = getToolUiRuntime(pi);
	runtime.stageReplayFallbackToolNames(fallbackNames);
	const hasReloadHandoff = runtime.hasReloadSnapshot();
	if (!hasReloadHandoff && !runtime.hasStagedResumeToolDefinitions()) return;
	registerMissingReplayToolDefinitions(pi, new Set(registeredNames));
}

/** Bind only known Suite definitions that are missing and present in the current historical branch. */
export function registerHistoricalSuiteToolDefinitions(
	pi: ExtensionAPI,
	historicalNames: ReadonlySet<string>,
): readonly string[] {
	const runtime = getToolUiRuntime(pi);
	runtime.hasReloadSnapshot();
	return registerMissingReplayToolDefinitions(pi, new Set(pi.getAllTools().map((tool) => tool.name)), historicalNames);
}
