import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, Text } from "@earendil-works/pi-tui";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { isIssueState } from "./activity-summary.ts";
import type {
	SuiteToolEnvelopeDecoder,
	SuiteToolEnvelopeDetails,
	SuiteToolEnvelopeFallbackVisibility,
	SuiteToolEnvelopeOperation,
	SuiteToolEnvelopePresentation,
	ToolRenderContext,
	ToolResultRenderOptions,
	ToolSummaryProjection,
} from "./contract.ts";
import { DETAIL_BYTE_LIMIT, DETAIL_LINE_LIMIT, TOOL_DISPLAY_ITEM_LIMIT, TOOL_DISPLAY_MEDIA_LIMIT } from "./limits.ts";
import { normalizeOperationIssueReason, operationResultText } from "./operation-block-evidence.ts";
import {
	EMBEDDED_HOST_IMAGE_KEYS,
	EMBEDDED_TOOL_RESULT,
	formattedResultLines,
	imageContentKey,
	imageMimeKey,
	terminalSummary,
	toolArgumentKeys,
} from "./registered-tool-renderer.ts";
import { CachedToolRow, EmptyToolComponent } from "./render.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { stripToolControlMetadata } from "./tool-invocation.ts";
import {
	boundedToolArguments,
	boundedToolResult,
	capDetailLines,
	classifyTerminalState,
	oneLine,
} from "./tool-text.ts";
import { isRecordValue, isToolArguments } from "./tool-value.ts";

interface EnvelopeChildRenderer {
	component?: Component;
	readonly state: ToolRenderContext<ToolArguments>["state"];
}

interface EnvelopeRendererState {
	readonly children: Map<string, EnvelopeChildRenderer>;
}

const ENVELOPE_RENDERER_STATES = new WeakMap<object, EnvelopeRendererState>();

class EnvelopeOperationsComponent implements Component {
	private readonly operations: readonly Component[];

	constructor(operations: readonly Component[]) {
		this.operations = operations;
	}

	invalidate(): void {
		for (const operation of this.operations) operation.invalidate();
	}

	render(width: number): string[] {
		const output: string[] = [];
		for (const operation of this.operations) {
			const lines = operation.render(width);
			if (lines.length === 0) continue;
			if (output.length > 0) output.push("");
			output.push(...lines);
		}
		return output;
	}
}

function envelopeRendererState(state: ToolRenderContext<ToolArguments>["state"]): EnvelopeRendererState {
	const existing = ENVELOPE_RENDERER_STATES.get(state);
	if (existing) return existing;
	const rendererState = { children: new Map<string, EnvelopeChildRenderer>() };
	ENVELOPE_RENDERER_STATES.set(state, rendererState);
	return rendererState;
}

export function decodeEnvelopeOperations(
	decode: SuiteToolEnvelopeDecoder,
	details: SuiteToolEnvelopeDetails,
): readonly SuiteToolEnvelopeOperation[] {
	try {
		const decoded = decode(details);
		const operations: SuiteToolEnvelopeOperation[] = [];
		for (let index = 0; index < Math.min(decoded.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
			const operation = decoded[index];
			if (
				operation &&
				isRuntimeString(operation.id) &&
				operation.id.length > 0 &&
				isRuntimeString(operation.name) &&
				operation.name.length > 0 &&
				isRecordValue(operation.args)
			) {
				operations.push(operation);
			}
		}
		return operations;
	} catch {
		return [];
	}
}

export function envelopeFallbackVisible(
	showFallback: SuiteToolEnvelopeFallbackVisibility | undefined,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: ToolActivityState,
): boolean {
	if (!showFallback) return true;
	try {
		return showFallback(args, result, state);
	} catch {
		return true;
	}
}

export function envelopeOperationResult(
	operation: SuiteToolEnvelopeOperation,
): (AgentToolResult<unknown> & { readonly isError?: true }) | undefined {
	if (operation.state === "running") return undefined;
	const result = operation.result ?? {
		content: [
			{
				type: "text" as const,
				text:
					operation.state === "rejected" ? "Tool execution was blocked" : `${operation.name} ${operation.state}`,
			},
		],
		details: undefined,
	};
	return operation.state === "success" ? result : { ...result, isError: true };
}

function resolveEnvelopeMedia(
	result: AgentToolResult<unknown>,
	presentation: SuiteToolEnvelopePresentation,
): readonly (readonly AgentToolResult<unknown>["content"][number][])[] {
	let resolved: readonly (readonly AgentToolResult<unknown>["content"][number][])[];
	if (presentation.media) {
		try {
			resolved = presentation.media(result.details);
		} catch {
			return [];
		}
	} else {
		resolved = [];
		for (let index = 0; index < Math.min(result.content.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
			const item = result.content[index];
			if (item?.type === "image") resolved = [...resolved, [item]];
			if (resolved.length >= TOOL_DISPLAY_MEDIA_LIMIT) break;
		}
	}
	const media: Array<readonly AgentToolResult<unknown>["content"][number][]> = [];
	for (let index = 0; index < Math.min(resolved.length, TOOL_DISPLAY_MEDIA_LIMIT); index += 1) {
		media.push((resolved[index] ?? []).slice(0, TOOL_DISPLAY_ITEM_LIMIT));
	}
	return media;
}

function projectEnvelopeOperationResult(
	operation: SuiteToolEnvelopeOperation,
	media: readonly (readonly AgentToolResult<unknown>["content"][number][])[],
): AgentToolResult<unknown> | undefined {
	if (!operation.result || !operation.mediaPlacements || operation.mediaPlacements.length === 0) {
		return operation.result;
	}
	const placements = new Map<number, AgentToolResult<unknown>["content"]>();
	for (const placement of operation.mediaPlacements.slice(0, TOOL_DISPLAY_ITEM_LIMIT)) {
		if (!Number.isInteger(placement.afterContentIndex) || !Number.isInteger(placement.mediaIndex)) continue;
		if (placement.afterContentIndex < 0 || placement.afterContentIndex > operation.result.content.length) continue;
		const segment = media[placement.mediaIndex];
		if (!segment) continue;
		const atBoundary = placements.get(placement.afterContentIndex) ?? [];
		atBoundary.push(...segment);
		placements.set(placement.afterContentIndex, atBoundary);
	}
	if (placements.size === 0) return operation.result;
	const content: AgentToolResult<unknown>["content"] = [];
	const contentLimit = Math.min(operation.result.content.length, TOOL_DISPLAY_ITEM_LIMIT);
	for (let index = 0; index <= contentLimit; index += 1) {
		content.push(...(placements.get(index) ?? []));
		const item = operation.result.content[index];
		if (item) content.push(item);
	}
	if (contentLimit < operation.result.content.length) {
		content.push({ type: "text", text: "… nested result content omitted" });
	}
	return { ...operation.result, content };
}

export function prepareEnvelopeRenderArguments(tool: ToolDefinition, args: ToolArguments): ToolArguments {
	const argumentKeys = toolArgumentKeys(tool.parameters);
	const displayArgs = boundedToolArguments(args, argumentKeys);
	try {
		let input: unknown = displayArgs;
		if (tool.prepareArguments) {
			input = tool.prepareArguments(structuredClone(displayArgs));
		}
		// SAFETY: the registry-selected Tool owns both its erased schema and this canonical replay Tool call.
		const prepared = validateToolArguments(
			tool as never,
			{ arguments: input, id: "tool-ui-replay", name: tool.name, type: "toolCall" } as never,
		);
		return isToolArguments(prepared) ? boundedToolArguments(prepared, argumentKeys) : displayArgs;
	} catch {
		return displayArgs;
	}
}

function fallbackToolTarget(args: ToolArguments): string {
	for (const key of ["path", "file_path", "command", "query", "action", "description"]) {
		const value = args[key];
		if (isRuntimeString(value) && value.trim()) return oneLine(value);
	}
	return "";
}

function fallbackToolComponent(
	theme: Theme,
	name: string,
	label: string,
	args: ToolArguments,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
	successFromResult = false,
): Component {
	const visibleResult = result ? stripToolControlMetadata(boundedToolResult(result)) : undefined;
	const summary: ToolSummaryProjection =
		state === "running"
			? { fromResult: false, text: "working" }
			: visibleResult
				? terminalSummary(visibleResult, state, successFromResult)
				: state === "success"
					? { fromResult: false, text: "done" }
					: { fromResult: false, text: state };
	const container = new Container();
	container.addChild(
		new CachedToolRow(theme, {
			durationMs: undefined,
			label: sanitizeTerminalText(label) || name,
			state,
			summary: summary.text,
			target: fallbackToolTarget(args),
		}),
	);
	if (expanded && visibleResult) {
		const lines = capDetailLines(formattedResultLines(visibleResult, summary), DETAIL_LINE_LIMIT, DETAIL_BYTE_LIMIT);
		if (lines.length > 0) container.addChild(new Text(theme.fg("toolOutput", lines.join("\n")), 2, 0));
	}
	return container;
}

function outerEnvelopeState(
	result: AgentToolResult<unknown>,
	options: ToolResultRenderOptions,
	context: ToolRenderContext<ToolArguments>,
): ToolActivityState {
	if (context.isError) return classifyTerminalState(result, true);
	return options.isPartial ? "running" : "success";
}

function envelopeHostImageKeys(
	result: AgentToolResult<unknown>,
	showImages: boolean | undefined,
): Map<string, Set<string>> | undefined {
	if (!getCapabilities().images || !showImages) return;
	let keys: Map<string, Set<string>> | undefined;
	let mediaCount = 0;
	for (let index = 0; index < Math.min(result.content.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
		const item = result.content[index];
		if (!item) continue;
		if (item.type !== "image" || !isRuntimeString(item.data) || !isRuntimeString(item.mimeType)) continue;
		if (mediaCount >= TOOL_DISPLAY_MEDIA_LIMIT) break;
		keys ??= new Map();
		const mimeType = imageMimeKey(item.mimeType);
		const data = keys.get(mimeType) ?? new Set<string>();
		data.add(imageContentKey(item.mimeType, item.data));
		keys.set(mimeType, data);
		mediaCount += 1;
	}
	return keys;
}

function renderEnvelopeFallback(
	theme: Theme,
	envelope: ToolDefinition,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: ToolActivityState,
	options: ToolResultRenderOptions,
	successFromResult = false,
): Component {
	if (envelope.name === "codemode" && isIssueState(state)) {
		const code = isRuntimeString(args["code"]) ? args["code"] : "";
		const reason =
			normalizeOperationIssueReason(
				oneLine(
					operationResultText(result)
						.text.split(/\r?\n/u)
						.find((line) => line.trim().length > 0) ?? state,
				),
			) || state;
		const label = state === "rejected" ? "Rejected" : state === "cancelled" ? "Cancelled" : "Error";
		return new CachedToolRow(theme, {
			active: false,
			evidence: [
				{
					kind: "outcome",
					text: `${label}: ${reason}`,
					tone: state === "error" ? "error" : "warning",
				},
			],
			expandable: code.length > 160 || code.slice(0, 161).includes("\n"),
			expanded: options.expanded,
			identity: code,
			identityCodeUnits: options.expanded ? 32 * 1024 : 160,
			identityLineLimit: 32 * 1024,
			identityMultiline: true,
			kind: "operation-block",
			label: "Code Mode",
			state,
		});
	}
	return fallbackToolComponent(
		theme,
		envelope.name,
		envelope.label,
		args,
		result,
		state,
		options.expanded,
		successFromResult,
	);
}

export function renderEnvelopeOperations(
	result: AgentToolResult<unknown>,
	options: ToolResultRenderOptions,
	theme: Theme,
	context: ToolRenderContext<ToolArguments>,
	presentation: SuiteToolEnvelopePresentation,
	envelope: ToolDefinition,
): Component {
	const operations = decodeEnvelopeOperations(presentation.decode, result.details);
	const visibleResult = stripToolControlMetadata(boundedToolResult(result));
	if (operations.length === 0) {
		const state = outerEnvelopeState(visibleResult, options, context);
		if (envelope.name === "codemode" && (state === "running" || state === "success")) {
			return new EmptyToolComponent();
		}
		if (!envelopeFallbackVisible(presentation.showFallback, context.args, visibleResult, state)) {
			return new EmptyToolComponent();
		}
		return renderEnvelopeFallback(theme, envelope, context.args, visibleResult, state, options, true);
	}
	const hostImageKeys = envelopeHostImageKeys(result, context.showImages);
	const media = resolveEnvelopeMedia(result, presentation);
	const rendererState = envelopeRendererState(context.state);
	const renderedOperations: Component[] = [];
	const retained = new Set<string>();
	for (const operation of operations) {
		if (operation.displayOnly === "overflow") {
			renderedOperations.push(new Text(theme.fg("dim", "… earlier nested operations omitted"), 2, 0));
			continue;
		}
		const tool = presentation.registry.get(operation.name);
		const operationResult = projectEnvelopeOperationResult(operation, media) ?? envelopeOperationResult(operation);
		let args = operation.args;
		if (tool?.renderCall) {
			args = prepareEnvelopeRenderArguments(tool, args);
			retained.add(operation.id);
			const child = rendererState.children.get(operation.id) ?? { state: {} };
			rendererState.children.set(operation.id, child);
			const childContext = {
				...context,
				[EMBEDDED_TOOL_RESULT]: true,
				args,
				argsComplete: true,
				executionStarted: operation.state === "running" && context.executionStarted !== false,
				isError: operation.state !== "running" && operation.state !== "success",
				isPartial: options.isPartial,
				lastComponent: child.component,
				state: child.state,
				toolCallId: operation.id,
			};
			if (hostImageKeys) Object.assign(childContext, { [EMBEDDED_HOST_IMAGE_KEYS]: hostImageKeys });
			try {
				const container = new Container();
				// SAFETY: the registry returns the Tool that owns this decoded operation and child renderer context.
				const call = tool.renderCall(args, theme, childContext as never);
				child.component = call;
				container.addChild(call);
				if (operationResult && tool.renderResult) {
					const childIsPartial = options.isPartial && operation.state === "running";
					// SAFETY: the registry-selected Tool owns both the decoded result and the child renderer context.
					const body = tool.renderResult(
						operationResult,
						{ expanded: options.expanded, isPartial: childIsPartial },
						theme,
						{
							...childContext,
							isPartial: childIsPartial,
							lastComponent: call,
						} as never,
					);
					if (body) container.addChild(body);
				}
				renderedOperations.push(container);
				continue;
			} catch {
				// Fall through to the stable fallback row.
			}
		}
		renderedOperations.push(
			fallbackToolComponent(
				theme,
				operation.name,
				tool?.label ?? operation.name,
				args,
				operationResult,
				operation.state,
				options.expanded,
			),
		);
	}
	for (const id of rendererState.children.keys()) {
		if (!retained.has(id)) rendererState.children.delete(id);
	}
	if (context.isError && !operations.some((operation) => isIssueState(operation.state))) {
		renderedOperations.push(
			renderEnvelopeFallback(
				theme,
				envelope,
				context.args,
				visibleResult,
				outerEnvelopeState(visibleResult, options, context),
				options,
			),
		);
	}
	return new EnvelopeOperationsComponent(renderedOperations);
}
