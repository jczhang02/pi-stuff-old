import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { getHostSharedResource } from "../shared/host-resource.ts";
import {
	classifyRetrievalGroupInvocation,
	type RetrievalGroupDisposition,
	type ToolActivityMetadata,
	type ToolActivityOutcome,
	type ToolArguments,
} from "./activity.ts";
import { ToolActivityPresentation } from "./activity-presentation.ts";
import type { ToolActivity, ToolActivityState } from "./activity-store.ts";
import { ToolEnvelopeProjection } from "./envelope-projection.ts";
import { ToolGroupProjection } from "./group-projection.ts";
import type { CachedToolRow } from "./render.ts";
import { ToolUiSettingsStore } from "./settings.ts";
import { boundedToolArguments, boundedToolResult } from "./tool-text.ts";

export {
	sendSuiteAgentMessage,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../conversation-ui/index.ts";

const TOOL_RUNTIME_REGISTRY = Symbol.for("@jczhang02/pi-stuff-tools/runtime-registry.v1");
const TOOL_RUNTIME_DISCOVERY_EVENT = "@jczhang02/pi-stuff-tools/runtime-discovery/v1";
const TOOL_RELOAD_HANDOFF = Symbol.for("@jczhang02/pi-stuff-tools/reload-handoff.v1");
export interface ToolSummaryProjection {
	readonly fromResult: boolean;
	readonly text: string;
}

export interface OperationEvidenceLine {
	readonly diffKind?: "add" | "context" | "delete";
	readonly kind: "diff" | "meta" | "outcome" | "source";
	readonly languagePath?: string;
	readonly newLine?: number;
	readonly oldLine?: number;
	readonly text: string;
	readonly tone?: "error" | "muted" | "success" | "warning";
}

export interface ToolFormattedSection {
	readonly languagePath?: string;
	readonly lines: readonly string[];
	readonly operationEvidence?: readonly OperationEvidenceLine[];
	readonly title: string;
}

export interface ToolFormattedImage {
	readonly data: string;
	readonly mimeType: string;
}

export interface ToolDetailPresentation {
	readonly argumentKeys?: readonly string[];
	readonly detailSections?: (
		args: ToolArguments,
		result: AgentToolResult<unknown>,
		state: Exclude<ToolActivityState, "running">,
	) => readonly ToolFormattedSection[];
	readonly detailLines?: (
		args: ToolArguments,
		result: AgentToolResult<unknown>,
		state: Exclude<ToolActivityState, "running">,
	) => readonly string[];
	readonly label: (args: ToolArguments) => string;
	readonly summary: (
		args: ToolArguments,
		result: AgentToolResult<unknown> | undefined,
		state: ToolActivityState,
	) => string | ToolSummaryProjection;
	readonly target: (args: ToolArguments) => string;
}
interface ToolReloadHandoff {
	readonly activeNames: readonly string[];
	readonly toolDefinitions: readonly SuiteToolReplayDefinition[];
}

function normalizeReloadHandoff(
	value: ToolReloadHandoff | readonly string[] | undefined,
): ToolReloadHandoff | undefined {
	if (!value) return undefined;
	return "activeNames" in value ? value : { activeNames: [...value], toolDefinitions: [] };
}

function reloadHandoff(value?: ToolReloadHandoff): ToolReloadHandoff | undefined {
	if (value !== undefined) {
		Object.defineProperty(globalThis, TOOL_RELOAD_HANDOFF, {
			configurable: true,
			value: {
				activeNames: [...value.activeNames],
				toolDefinitions: [...value.toolDefinitions],
			},
			writable: true,
		});
	}
	return normalizeReloadHandoff(Object.getOwnPropertyDescriptor(globalThis, TOOL_RELOAD_HANDOFF)?.value);
}

function consumeReloadHandoff(): ToolReloadHandoff | undefined {
	const value = normalizeReloadHandoff(Object.getOwnPropertyDescriptor(globalThis, TOOL_RELOAD_HANDOFF)?.value);
	Reflect.deleteProperty(globalThis, TOOL_RELOAD_HANDOFF);
	return value === undefined
		? undefined
		: {
				activeNames: [...value.activeNames],
				toolDefinitions: [...value.toolDefinitions],
			};
}

export interface SuiteToolPresentation<TArgs extends ToolArguments, TDetails> {
	/** Required semantic metadata for Retrieval Group projection and independent Tool Activity. */
	readonly activity: ToolActivityMetadata<TArgs, TDetails>;
	readonly detailLines?: (
		args: Readonly<TArgs>,
		result: AgentToolResult<TDetails>,
		state: Exclude<ToolActivityState, "running">,
	) => readonly string[];
	readonly detailSections?: (
		args: Readonly<TArgs>,
		result: AgentToolResult<TDetails>,
		state: Exclude<ToolActivityState, "running">,
	) => readonly ToolFormattedSection[];
	readonly label?: string | ((args: Readonly<TArgs>) => string);
	readonly resultIsError?: (args: Readonly<TArgs>, result: AgentToolResult<TDetails>) => boolean;
	readonly runningSummary?: string | ((args: Readonly<TArgs>, durationMs: number | undefined) => string);
	readonly summarize?: (
		args: Readonly<TArgs>,
		result: AgentToolResult<TDetails>,
		state: Exclude<ToolActivityState, "running">,
		durationMs: number | undefined,
	) => string;
	readonly target?: (args: Readonly<TArgs>) => string;
	readonly tracksElapsed?: boolean;
}

export interface SuiteToolReplayDefinition {
	readonly codeMode?: SuiteToolCodeModeContract;
	readonly presentation: SuiteToolPresentation<ToolArguments, unknown>;
	readonly tool: ToolDefinition<TSchema, unknown>;
}

export type SuiteToolEnvelopeOperationState = "cancelled" | "error" | "rejected" | "running" | "success";

export interface SuiteToolEnvelopeOperation {
	readonly args: ToolArguments;
	readonly attempt?: number;
	/** Display-only truthful marker for nested work omitted by the fixed projection budget. */
	readonly displayOnly?: "overflow";
	readonly executionId?: string;
	readonly id: string;
	/** Preserve media at the same boundary it occupied in the direct Tool result. */
	readonly mediaPlacements?: readonly SuiteToolEnvelopeMediaPlacement[];
	readonly name: string;
	readonly replayed?: boolean;
	readonly result?: AgentToolResult<unknown>;
	readonly sequence?: number;
	readonly state: SuiteToolEnvelopeOperationState;
}

export interface SuiteToolEnvelopeMediaPlacement {
	/** Number of non-media content blocks that preceded this media block. */
	readonly afterContentIndex: number;
	/** Index into the envelope presentation's normalized media segments. */
	readonly mediaIndex: number;
}

export type SuiteToolEnvelopeDetails = AgentToolResult<unknown>["details"];

export type SuiteToolEnvelopeDecoder = (details: SuiteToolEnvelopeDetails) => readonly SuiteToolEnvelopeOperation[];
export type SuiteToolEnvelopeArgumentPreparer = (operation: SuiteToolEnvelopeOperation) => ToolArguments;
export type SuiteToolEnvelopeFallbackVisibility = (
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: ToolActivityState,
) => boolean;

export type SuiteToolEnvelopeMediaResolver = (
	details: SuiteToolEnvelopeDetails,
) => readonly (readonly AgentToolResult<unknown>["content"][number][])[];

export interface SuiteToolDefinitionRegistry {
	catalog(): readonly SuiteToolCatalogEntry[];
	compensate(invocation: SuiteToolCompensationInvocation): Promise<boolean>;
	get(name: string): ToolDefinition | undefined;
	invoke(invocation: SuiteToolInvocation): Promise<SuiteToolInvocationResult>;
	isActive(name: string): boolean;
	list(): readonly ToolDefinition[];
}

export interface SuiteToolCodeModeContract {
	/** Explicit inverse operation. It runs only from a user-requested compensation pass. */
	readonly compensate?: (invocation: SuiteToolCompensationInvocation) => Promise<void> | void;
	readonly lifecycle?: SuiteToolCodeModeLifecycle;
	readonly replay: "never" | "record" | "reexecute";
	readonly requiresApproval?: boolean;
}

export type SuiteToolCodeModeExecutionEndStatus = "completed" | "error" | "rejected" | "rolled_back";
export type SuiteToolCodeModePassEndStatus = SuiteToolCodeModeExecutionEndStatus | "paused";

export interface SuiteToolCodeModeLifecycle {
	disposeExecution?(executionId: string, status: SuiteToolCodeModeExecutionEndStatus): Promise<void> | void;
	onPassEnd?(executionId: string, status: SuiteToolCodeModePassEndStatus): Promise<void> | void;
}

export interface SuiteToolCompensationInvocation {
	readonly context: ExtensionContext;
	readonly executionId: string;
	readonly input: unknown;
	readonly name: string;
	readonly result: unknown;
	readonly sequence: number;
	readonly signal?: AbortSignal;
}

export interface SuiteToolCatalogEntry {
	readonly codeMode?: SuiteToolCodeModeContract;
	readonly definition: ToolDefinition;
}

export interface SuiteToolInvocation {
	readonly context: ExtensionContext;
	readonly input: unknown;
	readonly name: string;
	readonly onUpdate?: AgentToolUpdateCallback<unknown>;
	readonly signal?: AbortSignal;
	readonly toolCallId: string;
}

export interface SuiteToolInvocationResult {
	readonly isError: boolean;
	readonly result: AgentToolResult<unknown>;
}

export interface SuiteToolSurfaceController {
	disableEnvelope(name: string): void;
	enableEnvelope(name: string): void;
	isEnvelopeEnabled(name: string): boolean;
}

export interface SuiteToolEnvelopePresentation {
	readonly decode: SuiteToolEnvelopeDecoder;
	readonly media?: SuiteToolEnvelopeMediaResolver;
	readonly registry: SuiteToolDefinitionRegistry;
	readonly showFallback?: SuiteToolEnvelopeFallbackVisibility;
}

export interface RendererState<TArgs extends ToolArguments, TDetails> {
	args?: Readonly<TArgs>;
	component?: CachedToolRow;
	detailLines?: readonly string[];
	detailMaterialized?: boolean;
	lastResult?: AgentToolResult<TDetails>;
	liveEffectsStarted?: boolean;
	projectedReplay?: boolean;
	startedAt?: number;
	summary?: ToolSummaryProjection;
	terminalModelMaterialized?: boolean;
	terminalState?: Exclude<ToolActivityState, "running">;
	wasLiveExecution?: boolean;
}

export interface ToolRenderContext<TArgs extends ToolArguments> {
	readonly args: Readonly<TArgs>;
	readonly cwd: string;
	readonly executionStarted?: boolean;
	readonly expanded: boolean;
	readonly invalidate: () => void;
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly lastComponent: Component | undefined;
	readonly showImages: boolean;
	readonly state: object;
	readonly toolCallId: string;
}

export interface ToolResultRenderOptions {
	readonly expanded: boolean;
	readonly isPartial: boolean;
}

export interface PresentedToolMetadata {
	readonly args: ToolArguments;
	readonly cwd?: string;
	readonly name: string;
	readonly result?: AgentToolResult<unknown>;
}

export interface ToolActivityView {
	readonly id: string;
	readonly label?: string;
	readonly memberIds: readonly string[];
	readonly operation?: string;
	readonly outcome?: string;
	readonly state: ToolActivityOutcome | "cancelled" | "rejected";
	readonly summary: string;
}

export type ToolActivityDetailMode = "formatted" | "raw";

export interface ToolActivityDetailView {
	readonly activity: ToolActivity;
	readonly images?: readonly ToolFormattedImage[];
	readonly lines: readonly string[];
	readonly sections?: readonly ToolFormattedSection[];
}

export class ToolUiRuntime extends ToolActivityPresentation {
	private readonly activityPolicies: Map<string, ToolActivityMetadata<ToolArguments, unknown>>;
	private readonly detailPresentations: Map<string, ToolDetailPresentation>;
	private readonly disposition: (name: string, args: ToolArguments) => RetrievalGroupDisposition;
	private readonly envelopes: ToolEnvelopeProjection;
	private readonly errorPolicies: Map<string, (args: ToolArguments, result: AgentToolResult<unknown>) => boolean>;
	private readonly groupProjection: ToolGroupProjection;
	private reloadActiveToolNames: readonly string[] | undefined;
	private readonly renderedToolNames: Set<string>;
	private readonly replayFallbackToolNames = new Set<string>();
	private readonly replayOnlyToolNames = new Set<string>();
	private readonly replayToolDefinitions = new Map<string, SuiteToolReplayDefinition>();
	private stagedReplayToolDefinitions: readonly SuiteToolReplayDefinition[] | undefined;

	constructor(settings = ToolUiSettingsStore.memory(), now: () => number = Date.now) {
		const activityPolicies = new Map<string, ToolActivityMetadata<ToolArguments, unknown>>();
		const detailPresentations = new Map<string, ToolDetailPresentation>();
		const envelopes = new ToolEnvelopeProjection();
		const errorPolicies = new Map<string, (args: ToolArguments, result: AgentToolResult<unknown>) => boolean>();
		const renderedToolNames = new Set<string>();
		const disposition = (name: string, args: ToolArguments): RetrievalGroupDisposition =>
			renderedToolNames.has(name)
				? classifyRetrievalGroupInvocation(name, args, activityPolicies.get(name))
				: "boundary";
		let groups!: ToolGroupProjection;
		super(
			() => groups,
			envelopes,
			activityPolicies,
			detailPresentations,
			errorPolicies,
			disposition,
			(name) => renderedToolNames.has(name),
			settings,
			now,
		);
		this.activityPolicies = activityPolicies;
		this.detailPresentations = detailPresentations;
		this.disposition = disposition;
		this.envelopes = envelopes;
		this.errorPolicies = errorPolicies;
		this.renderedToolNames = renderedToolNames;
		this.groupProjection = groups = new ToolGroupProjection(
			envelopes,
			disposition,
			(name) => errorPolicies.get(name),
			{
				groupChanged: (group, changedMemberId) => this.reconcileGroup(group, changedMemberId),
				groupRemoved: (leaderId) => this.dropGroup(leaderId),
				groupsRebuilt: () => this.groupsRebuilt(),
				liveResult: (toolCallId, result) => this.observeToolExecutionUpdate(toolCallId, result),
				shouldQueueResult: (toolCallId) => this.shouldQueueResult(toolCallId),
				stopTimer: (toolCallId) => this.stopTimer(toolCallId),
			},
		);
	}

	consumeReloadActiveTools(): readonly string[] | undefined {
		const handoff = consumeReloadHandoff();
		if (handoff) this.stagedReplayToolDefinitions ??= handoff.toolDefinitions;
		const names = this.reloadActiveToolNames ?? handoff?.activeNames;
		this.reloadActiveToolNames = undefined;
		return names;
	}

	hasReloadSnapshot(): boolean {
		const handoff = reloadHandoff();
		if (handoff) {
			this.reloadActiveToolNames ??= handoff.activeNames;
			this.stagedReplayToolDefinitions ??= handoff.toolDefinitions;
		}
		return this.reloadActiveToolNames !== undefined;
	}

	prepareReload(activeToolNames: readonly string[]): void {
		this.reloadActiveToolNames = [...activeToolNames];
		reloadHandoff({
			activeNames: activeToolNames,
			toolDefinitions: this.resumeToolDefinitions(),
		});
		this.suspend();
		this.discardBindings();
	}

	registerReplayToolDefinition(definition: SuiteToolReplayDefinition): void {
		this.replayToolDefinitions.set(definition.tool.name, definition);
	}

	markReplayOnlyTool(name: string): void {
		this.replayOnlyToolNames.add(name);
	}

	markLiveTool(name: string): boolean {
		return this.replayOnlyToolNames.delete(name);
	}

	isReplayOnlyTool(name: string): boolean {
		return this.replayOnlyToolNames.has(name);
	}

	replayOnlyTools(): readonly string[] {
		return [...this.replayOnlyToolNames];
	}

	resumeToolDefinitions(): readonly SuiteToolReplayDefinition[] {
		return [...this.replayToolDefinitions.values()];
	}

	stageResumeToolDefinitions(definitions: readonly SuiteToolReplayDefinition[]): void {
		this.stagedReplayToolDefinitions = [...definitions];
	}

	hasStagedResumeToolDefinitions(): boolean {
		return this.stagedReplayToolDefinitions !== undefined;
	}

	stageReplayFallbackToolNames(names: readonly string[]): void {
		for (const name of names) this.replayFallbackToolNames.add(name);
	}

	missingResumeToolDefinitions(
		registeredNames: ReadonlySet<string>,
		historicalNames?: ReadonlySet<string>,
	): readonly SuiteToolReplayDefinition[] {
		return (this.stagedReplayToolDefinitions ?? []).filter(
			(definition) =>
				(historicalNames === undefined || historicalNames.has(definition.tool.name)) &&
				!registeredNames.has(definition.tool.name),
		);
	}

	missingReplayFallbackToolNames(
		registeredNames: ReadonlySet<string>,
		historicalNames?: ReadonlySet<string>,
	): readonly string[] {
		return [...this.replayFallbackToolNames].filter(
			(name) => (historicalNames === undefined || historicalNames.has(name)) && !registeredNames.has(name),
		);
	}

	registerActivity<TArgs extends object, TDetails>(
		name: string,
		activity: ToolActivityMetadata<TArgs, TDetails>,
		resultIsError?: (args: Readonly<TArgs>, result: AgentToolResult<TDetails>) => boolean,
	): void {
		// SAFETY: metadata is retrieved only for the registered Tool whose schema produced these arguments.
		this.activityPolicies.set(name, activity as ToolActivityMetadata<ToolArguments, unknown>);
		if (resultIsError) {
			// SAFETY: this policy is stored only under the Tool name whose schema and result contract own it.
			const policy = resultIsError as (args: ToolArguments, result: AgentToolResult<unknown>) => boolean;
			this.errorPolicies.set(name, (args, result) => policy(boundedToolArguments(args), boundedToolResult(result)));
		} else {
			this.errorPolicies.delete(name);
		}
		if (this.renderedToolNames.has(name) && this.groupProjection.hasMessages()) this.groupProjection.rebuild();
	}

	registerDetailPresentation(name: string, presentation: ToolDetailPresentation): void {
		this.detailPresentations.set(name, presentation);
	}

	registerEnvelope(
		name: string,
		decode: SuiteToolEnvelopeDecoder,
		prepareArguments?: SuiteToolEnvelopeArgumentPreparer,
		showFallback?: SuiteToolEnvelopeFallbackVisibility,
	): void {
		this.envelopes.register(name, decode, prepareArguments, showFallback);
		if (this.groupProjection.hasMessages()) this.groupProjection.rebuild();
	}

	markRendererAttached(name: string): void {
		if (this.renderedToolNames.has(name)) return;
		this.renderedToolNames.add(name);
		if (this.groupProjection.hasMessages()) this.groupProjection.rebuild();
	}

	markRendererDetached(name: string): void {
		if (!this.renderedToolNames.delete(name)) return;
		if (this.groupProjection.hasMessages()) this.groupProjection.rebuild();
	}

	hasActivityRenderer(name: string): boolean {
		return this.renderedToolNames.has(name);
	}

	missingActivityRenderers(toolNames: readonly string[]): readonly string[] {
		return toolNames.filter((name) => !this.renderedToolNames.has(name));
	}

	missingActivityMetadata(toolNames: readonly string[]): readonly string[] {
		return toolNames.filter((name) => {
			const metadata = this.activityPolicies.get(name);
			const displayOnlyFallback = this.replayOnlyToolNames.has(name) && this.replayFallbackToolNames.has(name);
			return (
				!metadata || (metadata.categories.length === 0 && metadata.silentSuccess !== true && !displayOnlyFallback)
			);
		});
	}

	startTurn(messages?: readonly unknown[]): void {
		this.groupProjection.startTurn(messages);
	}

	observeUserBoundary(): void {
		this.groupProjection.observeUserBoundary();
	}

	endTurn(): void {
		this.groupProjection.endTurn();
	}

	observeAssistantEvent(event: AssistantMessageEvent): void {
		this.groupProjection.observeAssistantEvent(event);
	}

	indexMessages(messages: readonly unknown[], closeTail?: boolean): void {
		this.groupProjection.indexMessages(messages, closeTail);
	}

	indexMessage<Message>(message: Message): void {
		this.groupProjection.indexMessage(message);
	}

	observeEnvelopeResult(envelopeName: string, envelopeId: string, details: SuiteToolEnvelopeDetails): void {
		this.groupProjection.observeEnvelopeResult(envelopeName, envelopeId, details);
	}

	resetProjection(messages: readonly unknown[]): void {
		this.resetActivityProjection();
		this.envelopes.clearClaims();
		this.envelopes.clearRawArguments();
		this.groupProjection.resetProjection(messages);
		this.retainBindings(this.groupProjection.memberIds());
	}

	override clear(): void {
		super.clear();
		this.envelopes.clearClaims();
		this.envelopes.clearRawArguments();
		this.groupProjection.clear();
	}

	projectedResult(toolCallId: string): AgentToolResult<unknown> | undefined {
		return this.groupProjection.projectedResult(toolCallId);
	}

	isStandaloneInvocation(name: string, args: ToolArguments): boolean {
		return this.disposition(name, args) === "boundary";
	}

	projectMessages(messages: readonly unknown[]): readonly unknown[] {
		return this.envelopes.projectMessages(messages);
	}
}

function runtimeRegistry(): WeakMap<object, ToolUiRuntime> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, TOOL_RUNTIME_REGISTRY)?.value;
	if (existing instanceof WeakMap) {
		// SAFETY: this global symbol is written only below with ToolUiRuntime values keyed by Pi event facades.
		return existing as WeakMap<object, ToolUiRuntime>;
	}
	const registry = new WeakMap<object, ToolUiRuntime>();
	Object.defineProperty(globalThis, TOOL_RUNTIME_REGISTRY, {
		configurable: true,
		value: registry,
	});
	return registry;
}

export type ToolUiRuntimeHost = Pick<ExtensionAPI, "events" | "on">;
export type SuiteToolRegistrationHost = ToolUiRuntimeHost &
	Pick<ExtensionAPI, "getActiveTools" | "registerTool" | "setActiveTools">;
export type SuiteToolTrackerHost = SuiteToolRegistrationHost & Pick<ExtensionAPI, "getAllTools">;

export interface SuiteToolRegistrationTracker<Host extends SuiteToolTrackerHost = ExtensionAPI> {
	readonly api: Host;
	readonly registry: SuiteToolDefinitionRegistry;
	readonly surface: SuiteToolSurfaceController;
	readonly toolNames: ReadonlySet<string>;
}

export function getToolUiRuntime(pi: ToolUiRuntimeHost): ToolUiRuntime {
	const registry = runtimeRegistry();
	return getHostSharedResource(pi.events, registry, TOOL_RUNTIME_DISCOVERY_EVENT, () => new ToolUiRuntime(), {
		registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup),
	});
}

export function installToolUiRuntime(pi: ToolUiRuntimeHost, settings: ToolUiSettingsStore): ToolUiRuntime {
	const runtime = getToolUiRuntime(pi);
	runtime.configure(settings);
	return runtime;
}
