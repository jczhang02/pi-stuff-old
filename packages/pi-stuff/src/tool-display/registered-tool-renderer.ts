import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import { SELF_RENDERED_TRANSCRIPT_PADDING, TRANSCRIPT_CONTINUATION } from "../conversation-ui/transcript.ts";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolActivityMetadata, ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type {
	PresentedToolMetadata,
	RendererState,
	SuiteToolPresentation,
	ToolDetailPresentation,
	ToolRenderContext,
	ToolResultRenderOptions,
	ToolSummaryProjection,
	ToolUiRuntime,
} from "./contract.ts";
import {
	DETAIL_BYTE_LIMIT,
	DETAIL_LINE_LIMIT,
	TOOL_DISPLAY_ITEM_LIMIT,
	TOOL_DISPLAY_MEDIA_CODE_UNIT_LIMIT,
	TOOL_DISPLAY_MEDIA_LIMIT,
} from "./limits.ts";
import { isOperationBlockMember } from "./operation-block-presentation.ts";
import { SUITE_ACTIVITY_RENDERER, type SuiteActivityRendererMarker } from "./registration-tracker.ts";
import { CachedToolRow, EmptyToolComponent, type ToolRowModel } from "./render.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import {
	boundedToolArguments,
	boundedToolResult,
	buildToolResultLines,
	capDetailLines,
	classifyTerminalState,
	oneLine,
	TOOL_DISPLAY_ARGUMENT_KEYS,
} from "./tool-text.ts";

const TOOL_ARGUMENT_KEY_LIMIT = 64;

export function toolArgumentKeys(schema: TSchema): readonly string[] {
	const properties = "properties" in schema ? schema.properties : undefined;
	const schemaKeys =
		isRuntimeObject(properties) && properties !== null && !Array.isArray(properties) ? Object.keys(properties) : [];
	return [...new Set([...schemaKeys, ...TOOL_DISPLAY_ARGUMENT_KEYS])].slice(0, TOOL_ARGUMENT_KEY_LIMIT);
}

function presentationArguments<TArgs extends ToolArguments>(
	args: ToolArguments,
	argumentKeys: readonly string[],
): Readonly<TArgs> {
	return argsForPresentation<TArgs, ToolArguments>(boundedToolArguments(args, argumentKeys));
}

export function formattedResultLines(result: AgentToolResult<unknown>, summary: ToolSummaryProjection): string[] {
	const lines = buildToolResultLines(result);
	if (!summary.fromResult || !lines[0] || oneLine(lines[0]) !== oneLine(summary.text)) return lines;
	return lines.slice(1);
}

function capPresentationDetails(
	result: AgentToolResult<unknown>,
	extra: readonly string[] | undefined,
	summary: ToolSummaryProjection,
): string[] {
	return capDetailLines(
		extra && extra.length > 0 ? extra : formattedResultLines(result, summary),
		DETAIL_LINE_LIMIT,
		DETAIL_BYTE_LIMIT,
	);
}

function labelFor<TArgs extends ToolArguments, TDetails>(
	tool: ToolDefinition<TSchema, TDetails>,
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	args: Readonly<TArgs>,
): string {
	try {
		const label = isRuntimeFunction(presentation.label) ? presentation.label(args) : presentation.label;
		return sanitizeTerminalText(label ?? tool.label ?? tool.name) || tool.name;
	} catch {
		return sanitizeTerminalText(tool.label ?? tool.name) || tool.name;
	}
}

function presentationTarget<TArgs extends ToolArguments, TDetails>(
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	args: Readonly<TArgs>,
): string {
	try {
		return oneLine(presentation.target?.(args) ?? "");
	} catch {
		return "";
	}
}

export function terminalSummary<TDetails>(
	result: AgentToolResult<TDetails>,
	state: Exclude<ToolActivityState, "running">,
	successFromResult = false,
): ToolSummaryProjection {
	if (state === "success" && !successFromResult) return { fromResult: false, text: "done" };
	for (const line of buildToolResultLines(result)) {
		const summary = oneLine(line);
		if (summary) return { fromResult: true, text: summary };
	}
	return { fromResult: false, text: state };
}

function presentationSummary<TArgs extends ToolArguments, TDetails>(
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	args: Readonly<TArgs>,
	result: AgentToolResult<TDetails>,
	state: Exclude<ToolActivityState, "running">,
	durationMs: number | undefined,
): ToolSummaryProjection {
	const fallback = terminalSummary(result, state);
	try {
		if (!presentation.summarize) return fallback;
		const summary = oneLine(presentation.summarize(args, result, state, durationMs));
		if (!summary) return fallback;
		const resultSummary = terminalSummary(result, state, true);
		return {
			fromResult: state === "success" && resultSummary.fromResult && resultSummary.text === summary,
			text: summary,
		};
	} catch {
		return fallback;
	}
}

function presentationDetails<TArgs extends ToolArguments, TDetails>(
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	args: Readonly<TArgs>,
	result: AgentToolResult<TDetails>,
	state: Exclude<ToolActivityState, "running">,
): readonly string[] | undefined {
	try {
		return presentation.detailLines?.(args, result, state);
	} catch {
		return undefined;
	}
}

function argsForPresentation<TArgs extends ToolArguments, Args>(args: Args): Readonly<TArgs> {
	// SAFETY: callers use this only inside the renderer attached to the Tool that schema-validated these arguments.
	return args as Readonly<TArgs>;
}

function resultForPresentation<TDetails>(result: AgentToolResult<unknown>): AgentToolResult<TDetails> {
	// SAFETY: callers use this only inside the renderer attached to the Tool that declared these result details.
	return result as AgentToolResult<TDetails>;
}

function createDetailPresentation<TArgs extends ToolArguments, TDetails>(
	tool: ToolDefinition<TSchema, TDetails>,
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	argumentKeys: readonly string[],
): ToolDetailPresentation {
	const detail: ToolDetailPresentation = {
		argumentKeys,
		label: (args) => labelFor(tool, presentation, presentationArguments<TArgs>(args, argumentKeys)),
		summary: (args, result, state) => {
			const typedArgs = presentationArguments<TArgs>(args, argumentKeys);
			if (state === "running") {
				const source = presentation.runningSummary;
				return {
					fromResult: false,
					text: oneLine(isRuntimeFunction(source) ? source(typedArgs, undefined) : (source ?? "working")),
				};
			}
			return result
				? presentationSummary(
						presentation,
						typedArgs,
						resultForPresentation<TDetails>(boundedToolResult(result)),
						state,
						undefined,
					)
				: { fromResult: false, text: state };
		},
		target: (args) => oneLine(presentation.target?.(presentationArguments<TArgs>(args, argumentKeys)) ?? ""),
	};
	if (presentation.detailLines) {
		Object.assign(detail, {
			detailLines: (
				args: ToolArguments,
				result: AgentToolResult<unknown>,
				state: Exclude<ToolActivityState, "running">,
			) =>
				presentation.detailLines?.(
					presentationArguments<TArgs>(args, argumentKeys),
					resultForPresentation<TDetails>(boundedToolResult(result)),
					state,
				) ?? [],
		});
	}
	if (presentation.detailSections) {
		Object.assign(detail, {
			detailSections: (
				args: ToolArguments,
				result: AgentToolResult<unknown>,
				state: Exclude<ToolActivityState, "running">,
			) =>
				presentation.detailSections?.(
					presentationArguments<TArgs>(args, argumentKeys),
					resultForPresentation<TDetails>(boundedToolResult(result)),
					state,
				) ?? [],
		});
	}
	return detail;
}

function updateRunningRow<TArgs extends ToolArguments, TDetails>(
	tool: ToolDefinition<TSchema, TDetails>,
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	runtime: ToolUiRuntime,
	state: RendererState<TArgs, TDetails>,
	context: ToolRenderContext<TArgs>,
	theme: Theme,
	argumentKeys: readonly string[],
): CachedToolRow {
	const args = context.args;
	const presentedArgs = presentationArguments<TArgs>(args, argumentKeys);
	state.args = args;
	state.wasLiveExecution ??= context.executionStarted !== false;
	if (state.wasLiveExecution && state.startedAt === undefined) state.startedAt = Date.now();
	const durationMs = state.startedAt === undefined ? undefined : Math.max(0, Date.now() - state.startedAt);
	const summarySource = presentation.runningSummary;
	let summary = "working";
	try {
		summary = isRuntimeFunction(summarySource)
			? summarySource(
					presentedArgs,
					presentation.tracksElapsed && runtime.showLiveElapsed() ? durationMs : undefined,
				)
			: (summarySource ?? "working");
	} catch {
		// The shared Tool row remains available when optional presentation logic fails.
	}
	const model: ToolRowModel = {
		durationMs,
		label: labelFor(tool, presentation, presentedArgs),
		state: "running",
		summary: oneLine(summary),
		target: presentationTarget(presentation, presentedArgs),
	};
	if (!state.component) state.component = new CachedToolRow(theme, model);
	const startLiveEffects = state.wasLiveExecution && !state.liveEffectsStarted;
	if (startLiveEffects) {
		const activity = {
			id: context.toolCallId,
			label: model.label,
			name: tool.name,
			target: model.target,
		};
		if (state.startedAt !== undefined) Object.assign(activity, { startedAt: state.startedAt });
		runtime.activities.begin(activity);
	}
	const metadata: PresentedToolMetadata = {
		args,
		cwd: context.cwd,
		name: tool.name,
	};
	const visible = context.expanded || presentation.activity.silentSuccess !== true;
	runtime.presentRow(
		context.toolCallId,
		state.component,
		model,
		visible,
		context.invalidate,
		context.expanded,
		metadata,
	);
	if (startLiveEffects) {
		state.liveEffectsStarted = true;
		runtime.startTimer(context.toolCallId, context.invalidate, (visible) =>
			state.component?.setMarkerVisible(visible),
		);
	}
	return state.component;
}

function presentSettledRow<TArgs extends ToolArguments, TDetails>(
	runtime: ToolUiRuntime,
	state: RendererState<TArgs, TDetails>,
	component: CachedToolRow,
	context: ToolRenderContext<TArgs>,
	model: ToolRowModel,
	metadata: PresentedToolMetadata,
): void {
	const row = [context.toolCallId, component, model, true, context.invalidate, context.expanded, metadata] as const;
	if (!state.projectedReplay || !runtime.updateProjectedRow(...row)) runtime.presentRow(...row);
	state.projectedReplay = false;
}

function settleRow<TArgs extends ToolArguments, TDetails>(
	tool: ToolDefinition<TSchema, TDetails>,
	presentation: SuiteToolPresentation<TArgs, TDetails>,
	runtime: ToolUiRuntime,
	state: RendererState<TArgs, TDetails>,
	result: AgentToolResult<TDetails>,
	context: ToolRenderContext<TArgs>,
	theme: Theme,
	argumentKeys: readonly string[],
): CachedToolRow {
	const args = state.args ?? context.args;
	const presentedArgs = presentationArguments<TArgs>(args, argumentKeys);
	const presentedResult = resultForPresentation<TDetails>(boundedToolResult(result));
	state.args = args;
	state.wasLiveExecution ??= context.executionStarted !== false;
	const lightweightHistoricalReplay =
		state.wasLiveExecution === false && !context.expanded && !runtime.isStandaloneInvocation(tool.name, args);
	runtime.setRowExpanded(context.toolCallId, context.expanded);
	if (
		state.lastResult &&
		state.component &&
		state.terminalState &&
		(state.terminalModelMaterialized !== false || lightweightHistoricalReplay)
	) {
		if (!context.expanded || tool.name === "bash") {
			delete state.detailLines;
			state.detailMaterialized = false;
		} else if (!state.detailMaterialized) {
			state.detailLines = capPresentationDetails(
				state.lastResult,
				presentationDetails(
					presentation,
					presentedArgs,
					resultForPresentation<TDetails>(boundedToolResult(state.lastResult)),
					state.terminalState,
				),
				state.summary ?? terminalSummary(state.lastResult, state.terminalState),
			);
			state.detailMaterialized = true;
		}
		return state.component;
	}
	let activityState: Exclude<ToolActivityState, "running">;
	let model: ToolRowModel;
	let summary: ToolSummaryProjection;
	if (lightweightHistoricalReplay) {
		activityState = context.isError ? classifyTerminalState(result, true) : "success";
		summary = { fromResult: false, text: "" };
		model = {
			durationMs: undefined,
			label: tool.name,
			state: activityState,
			summary: summary.text,
			target: "",
		};
	} else {
		let domainError = context.isError;
		if (!domainError && presentation.resultIsError) {
			try {
				domainError = presentation.resultIsError(presentedArgs, presentedResult);
			} catch {
				domainError = true;
			}
		}
		activityState = classifyTerminalState(result, domainError);
		const finishedAt = Date.now();
		const durationMs = state.startedAt === undefined ? undefined : Math.max(0, finishedAt - state.startedAt);
		summary = presentationSummary(presentation, presentedArgs, presentedResult, activityState, durationMs);
		model = {
			durationMs,
			label: labelFor(tool, presentation, presentedArgs),
			state: activityState,
			summary: summary.text,
			target: presentationTarget(presentation, presentedArgs),
		};
	}
	if (!state.component) state.component = new CachedToolRow(theme, model);
	state.lastResult = result;
	state.summary = summary;
	state.terminalState = activityState;
	state.terminalModelMaterialized = !lightweightHistoricalReplay || tool.name === "bash";
	if (context.expanded && tool.name !== "bash") {
		state.detailLines = capPresentationDetails(
			result,
			presentationDetails(presentation, presentedArgs, presentedResult, activityState),
			summary,
		);
		state.detailMaterialized = true;
	} else {
		delete state.detailLines;
		state.detailMaterialized = false;
	}
	runtime.stopTimer(context.toolCallId);
	const metadata: PresentedToolMetadata = {
		args,
		cwd: context.cwd,
		name: tool.name,
		result,
	};
	presentSettledRow(runtime, state, state.component, context, model, metadata);
	if (state.wasLiveExecution) {
		const activity = {
			id: context.toolCallId,
			label: model.label,
			name: tool.name,
			target: model.target,
		};
		if (state.startedAt !== undefined) Object.assign(activity, { startedAt: state.startedAt });
		runtime.activities.begin(activity);
		runtime.activities.settle(context.toolCallId, {
			detailLines: state.detailLines ?? [],
			durationMs: model.durationMs,
			state: activityState,
			summary: model.summary,
			summaryFromResult: summary.fromResult,
		});
	}
	return state.component;
}

export const EMBEDDED_TOOL_RESULT = Symbol("pi-stuff-embedded-tool-result");
export const EMBEDDED_HOST_IMAGE_KEYS = Symbol("pi-stuff-embedded-host-image-keys");
const MEDIA_FALLBACK_PADDING = SELF_RENDERED_TRANSCRIPT_PADDING + visibleWidth(TRANSCRIPT_CONTINUATION);

type ImageContentIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function imageContentKey(mimeType: string, data: string): string {
	return `${imageMimeKey(mimeType)}:${String(data.length)}:${data.slice(0, 64)}:${data.slice(-64)}`;
}

export function imageMimeKey(mimeType: string): string {
	return mimeType.slice(0, 256);
}

function imagePreviewFallback(mimeType: string, data: string, showImages: boolean): string {
	const safeMimeType = imageMimeKey(mimeType);
	const subtype = safeMimeType.slice(safeMimeType.indexOf("/") + 1).split("+", 1)[0];
	const format = subtype ? subtype.toUpperCase() : "IMAGE";
	const oversized = data.length > TOOL_DISPLAY_MEDIA_CODE_UNIT_LIMIT || safeMimeType.length < mimeType.length;
	const dimensions = oversized ? undefined : getImageDimensions(data, safeMimeType);
	return [
		oversized ? "Image preview omitted" : showImages ? "Image preview unavailable" : "Image preview hidden",
		format,
		dimensions ? `${String(dimensions.widthPx)}×${String(dimensions.heightPx)}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
}

function resultBody<TArgs extends ToolArguments, TDetails>(
	state: RendererState<TArgs, TDetails>,
	result: AgentToolResult<TDetails>,
	expanded: boolean,
	showImages: boolean,
	theme: Theme,
	hideExpandedText = false,
	embedded = false,
	hostImageKeys?: ImageContentIndex,
): Component {
	const container = new Container();
	const text = expanded && !hideExpandedText ? (state.detailLines?.join("\n") ?? "") : "";
	if (text) container.addChild(new Text(theme.fg("toolOutput", text), 2, 0));
	const inlineImageProtocol = getCapabilities().images;
	const hostRendersImages = Boolean(!embedded && inlineImageProtocol && showImages);
	const images: Array<{ readonly data: string; readonly mimeType: string; readonly type: "image" }> = [];
	if (!hostRendersImages) {
		for (let index = 0; index < Math.min(result.content.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
			const item = result.content[index];
			if (
				item?.type !== "image" ||
				!isRuntimeString(item.data) ||
				!isRuntimeString(item.mimeType) ||
				hostImageKeys?.get(imageMimeKey(item.mimeType))?.has(imageContentKey(item.mimeType, item.data))
			) {
				continue;
			}
			images.push(item);
			if (images.length >= TOOL_DISPLAY_MEDIA_LIMIT) break;
		}
	}
	for (const [index, image] of images.entries()) {
		if ((embedded && Boolean(inlineImageProtocol && showImages)) || text || index > 0) {
			container.addChild(new Spacer(1));
		}
		container.addChild(
			showImages &&
				inlineImageProtocol &&
				image.data.length <= TOOL_DISPLAY_MEDIA_CODE_UNIT_LIMIT &&
				image.mimeType.length <= 256
				? new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (value) => theme.fg("toolOutput", value) },
						{ maxWidthCells: 60 },
					)
				: new Text(
						theme.fg("dim", imagePreviewFallback(image.mimeType, image.data, showImages)),
						MEDIA_FALLBACK_PADDING,
						0,
					),
		);
	}
	return text || images.length > 0 ? container : new EmptyToolComponent();
}

export function attachRenderer<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
	presentation: SuiteToolPresentation<Static<TParams> & ToolArguments, TDetails>,
	runtime: ToolUiRuntime,
): ToolDefinition<TParams, TDetails> {
	type TArgs = Static<TParams> & ToolArguments;
	const argumentKeys = toolArgumentKeys(tool.parameters);
	runtime.registerDetailPresentation(
		tool.name,
		createDetailPresentation<TArgs, TDetails>(tool, presentation, argumentKeys),
	);
	const decorated: ToolDefinition<TParams, TDetails> = {
		...tool,
		renderShell: "self" as const,
		renderCall: (args, theme, context) => {
			const typedArgs = argsForPresentation<TArgs, typeof args>(args);
			const typed: ToolRenderContext<TArgs> = {
				...context,
				args: typedArgs,
			};
			// SAFETY: Pi preserves this mutable state object across renderCall and renderResult for one Tool call.
			const state = typed.state as RendererState<TArgs, TDetails>;
			if (state.lastResult && state.component) {
				runtime.setRowExpanded(context.toolCallId, typed.expanded);
				if (!typed.expanded) {
					delete state.detailLines;
					state.detailMaterialized = false;
				}
				return state.component;
			}
			const replayResult =
				context.executionStarted === false ? runtime.projectedResult(context.toolCallId) : undefined;
			if (replayResult) {
				const replayArgs = typedArgs;
				state.args = replayArgs;
				state.wasLiveExecution = false;
				const model: ToolRowModel = {
					durationMs: undefined,
					label: tool.name,
					state: "success",
					summary: "",
					target: "",
				};
				state.component ??= new CachedToolRow(theme, model);
				runtime.presentRow(context.toolCallId, state.component, model, true, context.invalidate, false, {
					args: replayArgs,
					cwd: typed.cwd,
					name: tool.name,
					result: replayResult,
				});
				state.projectedReplay = true;
				return state.component;
			}
			return updateRunningRow(tool, presentation, runtime, state, typed, theme, argumentKeys);
		},
		renderResult: (result, options, theme, context) => {
			// SAFETY: Pi supplies this documented two-flag render options object to Tool result renderers.
			const renderOptions = options as ToolResultRenderOptions;
			// SAFETY: Pi reuses the state object initialized by this Tool's renderCall callback.
			const state = context.state as RendererState<TArgs, TDetails>;
			const args = state.args ?? argsForPresentation<TArgs, ToolArguments>({});
			const typed: ToolRenderContext<TArgs> = {
				...context,
				args,
				expanded: renderOptions.expanded,
				isPartial: renderOptions.isPartial,
			};
			if (renderOptions.isPartial) {
				updateRunningRow(tool, presentation, runtime, state, typed, theme, argumentKeys);
				return new EmptyToolComponent();
			}
			settleRow(tool, presentation, runtime, state, result, typed, theme, argumentKeys);
			const embeddedHostImageKeys = Object.getOwnPropertyDescriptor(typed, EMBEDDED_HOST_IMAGE_KEYS)?.value;
			return resultBody(
				state,
				result,
				renderOptions.expanded,
				typed.showImages,
				theme,
				tool.name === "bash" || isOperationBlockMember(tool.name, args),
				Object.getOwnPropertyDescriptor(typed, EMBEDDED_TOOL_RESULT)?.value === true,
				embeddedHostImageKeys instanceof Map ? embeddedHostImageKeys : undefined,
			);
		},
	};
	if (Object.getOwnPropertyDescriptor(tool, "description")?.get) {
		Object.defineProperty(decorated, "description", {
			enumerable: true,
			get: () => tool.description,
		});
	}
	// SAFETY: marker consumers recover this metadata only from the Tool definition that owns the same argument schema.
	const marker: SuiteActivityRendererMarker = {
		activity: presentation.activity as ToolActivityMetadata<ToolArguments, unknown>,
	};
	if (presentation.resultIsError) {
		// SAFETY: marker consumers invoke this callback only with results from the Tool definition that owns this presentation.
		Object.assign(marker, {
			resultIsError: presentation.resultIsError as NonNullable<SuiteActivityRendererMarker["resultIsError"]>,
		});
	}
	Object.defineProperty(decorated, SUITE_ACTIVITY_RENDERER, {
		enumerable: true,
		value: marker,
	});
	return decorated;
}
