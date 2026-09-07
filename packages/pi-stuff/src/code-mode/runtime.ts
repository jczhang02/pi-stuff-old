import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { SuiteToolEnvelopeOperation } from "../tool-display/contract.ts";
import { type CodemodeValue, isCodemodeObject, requireCodemodeValue } from "./cloudflare/codec.ts";
import type { Snippet } from "./cloudflare/snippet.ts";
import {
	buildSuiteSandboxSource,
	INTERNAL_STEP_DECIDE_TOOL,
	INTERNAL_STEP_RECORD_TOOL,
	type SuiteCodeModeConnector,
} from "./connector.ts";
import { CodeModeHostLostError } from "./host/host-client.ts";
import {
	assertDecodableSupportedCodeModeImages,
	codeModeImageFromDataUrl,
	InvalidCodeModeImageError,
} from "./image-content.ts";
import type { CodeModeExecutionController, CodeModePendingAction, CodeModeSessionLedger } from "./ledger.ts";
import { captureCodeModeModelContent } from "./presentation.ts";
import type {
	CodeModeExecuteOptions,
	CodeModeWaitOptions,
	ExecutorContext,
	RuntimeContentItem,
	RuntimeResponse,
	RuntimeToolCallPlan,
	RuntimeToolTrace,
	SuiteSandboxTool,
} from "./protocol.ts";
import { MAX_RETAINED_CODE_MODE_TRACES } from "./protocol.ts";

const AUTO_WAIT_MS = 60_000;
const MAX_OUTPUT_CHARS = 400_000;
const NESTED_CANCELLATION_TEXT = "Operation aborted";
const HOST_RECOVERY_LIMIT = 1;
export const CODE_MODE_NO_OUTPUT_MESSAGE = "Code completed with no output; use text(...) to return a value";

function isRuntimeToolCallPlan<Value>(value: Value): value is Value & RuntimeToolCallPlan {
	return (
		isRuntimeObject(value) &&
		value !== null &&
		"attempt" in value &&
		isRuntimeNumber(value.attempt) &&
		Number.isSafeInteger(value.attempt) &&
		"executionId" in value &&
		isRuntimeString(value.executionId) &&
		"id" in value &&
		isRuntimeString(value.id) &&
		"sequence" in value &&
		isRuntimeNumber(value.sequence) &&
		Number.isSafeInteger(value.sequence)
	);
}

export interface CodeModeExecutor {
	execute(options: CodeModeExecuteOptions): Promise<RuntimeResponse>;
	shutdown(): Promise<void>;
	wait(cellId: string, options: CodeModeWaitOptions & { readonly yieldTimeMs: number }): Promise<RuntimeResponse>;
}

export interface PiStuffCodeModeDetails {
	readonly attempt?: number;
	readonly cellId?: string;
	readonly droppedOperationCount?: number;
	readonly error?: string;
	readonly executionId?: string;
	readonly kind: "pi-stuff-code-mode";
	/** Normalized provider-facing content retained outside the Host-rendered result. */
	readonly modelContent?: AgentToolResult<unknown>["content"];
	/** Content indexes for each normalized media segment in modelContent. */
	readonly mediaContentIndexes?: readonly (readonly number[])[];
	readonly operations: readonly SuiteToolEnvelopeOperation[];
	readonly pending?: readonly CodeModePendingAction[];
	readonly status: "cancelled" | "error" | "incomplete" | "paused" | "running" | "success";
}

type ControllerSettlement = Pick<PiStuffCodeModeDetails, "error" | "status">;

function approvalMessage(executionId: string, pending: readonly CodeModePendingAction[]): string {
	const action = pending[0];
	return action
		? `Code Mode execution ${executionId} paused before tools.${action.method} at step ${String(action.seq)}. Await explicit user approval; do not repeat the action.`
		: `Code Mode execution ${executionId} paused for user approval.`;
}

function operation(trace: RuntimeToolTrace): SuiteToolEnvelopeOperation {
	let args: Readonly<Record<string, CodemodeValue>> = {};
	if (isCodemodeObject(trace.input)) args = trace.input;
	const value: SuiteToolEnvelopeOperation = {
		args,
		id: trace.id,
		name: trace.name,
		state:
			trace.status === "done"
				? "success"
				: trace.status === "pending"
					? "rejected"
					: trace.status === "error"
						? "error"
						: trace.status === "cancelled"
							? "cancelled"
							: "running",
	};
	if (trace.attempt !== undefined) Object.assign(value, { attempt: trace.attempt });
	if (trace.executionId) Object.assign(value, { executionId: trace.executionId });
	if (trace.replayed) Object.assign(value, { replayed: true });
	if (trace.result) Object.assign(value, { result: trace.result });
	if (trace.sequence !== undefined) Object.assign(value, { sequence: trace.sequence });
	return value;
}

function imageKey(item: AgentToolResult<unknown>["content"][number]): string | undefined {
	return item.type === "image" ? `${item.mimeType}\u0000${item.data}` : undefined;
}

function projectFinalMedia(
	traces: ReadonlyMap<string, RuntimeToolTrace>,
	content: AgentToolResult<unknown>["content"],
	includeMedia = true,
) {
	const output = [...content];
	const available = new Map<string, number[]>();
	let imageIndex = 0;
	for (const item of output) {
		const key = imageKey(item);
		if (!key) continue;
		const indexes = available.get(key) ?? [];
		indexes.push(imageIndex);
		available.set(key, indexes);
		imageIndex += 1;
	}
	const operations = [...traces.values()].map((trace) => {
		const projected = operation(trace);
		if (!trace.result) return projected;
		if (!includeMedia) {
			const nonMedia = trace.result.content.filter((item) => item.type !== "image");
			return nonMedia.length === trace.result.content.length
				? projected
				: { ...projected, result: { ...trace.result, content: nonMedia } };
		}
		const mediaPlacements: Array<{ readonly afterContentIndex: number; readonly mediaIndex: number }> = [];
		const nonMedia: AgentToolResult<unknown>["content"] = [];
		for (const item of trace.result.content) {
			const key = imageKey(item);
			if (!key) {
				nonMedia.push(item);
				continue;
			}
			const reusable = available.get(key)?.shift();
			if (reusable !== undefined) {
				mediaPlacements.push({ afterContentIndex: nonMedia.length, mediaIndex: reusable });
				continue;
			}
			mediaPlacements.push({ afterContentIndex: nonMedia.length, mediaIndex: imageIndex });
			imageIndex += 1;
			output.push(item);
		}
		return mediaPlacements.length === 0
			? projected
			: {
					...projected,
					mediaPlacements,
					result: { ...trace.result, content: nonMedia },
				};
	});
	return { content: output, operations };
}

function dropOldestTrace(
	target: Map<string, RuntimeToolTrace>,
	operationIndexes: Map<string, number>,
	operations: SuiteToolEnvelopeOperation[],
	retainedControls: NestedResultControlState,
): void {
	const oldestId = target.keys().next().value;
	if (oldestId === undefined) return;
	const oldestTrace = target.get(oldestId);
	if (oldestTrace?.status === "running") retainedControls.omittedRunningTraceIds.add(oldestId);
	else if (oldestTrace?.result) retainNestedResultControls(retainedControls, oldestTrace.result);
	const index = operationIndexes.get(oldestId);
	target.delete(oldestId);
	operationIndexes.delete(oldestId);
	if (index === undefined) return;
	operations.splice(index, 1);
	for (const [id, current] of operationIndexes) {
		if (current > index) operationIndexes.set(id, current - 1);
	}
}

function mergeTrace(
	target: Map<string, RuntimeToolTrace>,
	operationIndexes: Map<string, number>,
	operations: SuiteToolEnvelopeOperation[],
	trace: RuntimeToolTrace,
	retainedControls: NestedResultControlState,
): number {
	let index = operationIndexes.get(trace.id);
	let dropped = 0;
	if (index === undefined && retainedControls.omittedRunningTraceIds.has(trace.id)) {
		if (trace.status !== "running") {
			retainedControls.omittedRunningTraceIds.delete(trace.id);
			if (trace.result) retainNestedResultControls(retainedControls, trace.result);
		}
		return 0;
	}
	if (index === undefined) {
		if (target.size >= MAX_RETAINED_CODE_MODE_TRACES) {
			dropOldestTrace(target, operationIndexes, operations, retainedControls);
			dropped = 1;
		}
		index = operations.length;
		operationIndexes.set(trace.id, index);
	}
	target.set(trace.id, trace);
	operations[index] = operation(trace);
	return dropped;
}

function mergeTraces(
	target: Map<string, RuntimeToolTrace>,
	operationIndexes: Map<string, number>,
	operations: SuiteToolEnvelopeOperation[],
	traces: readonly RuntimeToolTrace[] | undefined,
	retainedControls: NestedResultControlState,
): number {
	let dropped = 0;
	for (const trace of traces ?? [])
		dropped += mergeTrace(target, operationIndexes, operations, trace, retainedControls);
	return dropped;
}

function settleRunningTraces(
	traces: ReadonlyMap<string, RuntimeToolTrace>,
	status: "cancelled" | "error",
	message: string,
): void {
	for (const trace of traces.values()) {
		if (trace.status !== "running") continue;
		trace.status = status;
		trace.error = message;
		trace.result ??= { content: [{ type: "text", text: message }], details: {} };
	}
}

function wasCancelled(cause: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");
}

function contentItem(item: RuntimeContentItem): AgentToolResult<unknown>["content"][number] | undefined {
	if (item.type === "input_text" && isRuntimeString(item.text)) return { type: "text", text: item.text };
	if (item.type !== "input_image" || !isRuntimeString(item.image_url)) return undefined;
	return codeModeImageFromDataUrl(item.image_url);
}

function boundedContent(items: readonly RuntimeContentItem[], fallback: string): AgentToolResult<unknown>["content"] {
	let remaining = MAX_OUTPUT_CHARS;
	const output: AgentToolResult<unknown>["content"] = [];
	for (const item of items) {
		const converted = contentItem(item);
		if (!converted) continue;
		if (converted.type !== "text") {
			output.push(converted);
			continue;
		}
		if (remaining <= 0) continue;
		const text = converted.text.slice(0, remaining);
		remaining -= text.length;
		output.push({ type: "text", text: text.length === converted.text.length ? text : `${text}\n[Output truncated]` });
	}
	return output.length > 0 ? output : [{ type: "text", text: fallback }];
}

function runOutcome(
	response: RuntimeResponse | undefined,
	cause: unknown,
	signal: AbortSignal | undefined,
	controller: CodeModeExecutionController | undefined,
	pending: readonly CodeModePendingAction[],
	traces: ReadonlyMap<string, RuntimeToolTrace>,
) {
	const responseError = response?.kind === "result" ? response.errorText : undefined;
	const thrownError = response ? undefined : cause instanceof Error ? cause.message : String(cause);
	const error = controller?.incompleteError?.message ?? responseError ?? thrownError;
	const invalidImage = cause instanceof InvalidCodeModeImageError;
	const status: PiStuffCodeModeDetails["status"] = controller?.incompleteError
		? "incomplete"
		: invalidImage
			? "error"
			: controller?.isPaused
				? "paused"
				: response?.kind === "terminated" || (!response && wasCancelled(cause, signal))
					? "cancelled"
					: !response || responseError
						? "error"
						: "success";
	if (status !== "success" && status !== "paused") {
		settleRunningTraces(
			traces,
			status === "cancelled" ? "cancelled" : "error",
			status === "cancelled"
				? NESTED_CANCELLATION_TEXT
				: ((response ? responseError : error) ?? "Code Mode execution failed"),
		);
	}
	const settled = response ? undefined : settleController(controller, status, error);
	const finalStatus = settled?.status ?? status;
	const finalError = settled?.error ?? (status === "paused" && response ? undefined : error);
	const content: AgentToolResult<unknown>["content"] =
		finalStatus === "paused" && controller
			? [{ type: "text", text: approvalMessage(controller.executionId, pending) }]
			: response
				? boundedContent(
						response.contentItems,
						finalError ??
							(finalStatus === "cancelled" ? "Code Mode execution was cancelled" : CODE_MODE_NO_OUTPUT_MESSAGE),
					)
				: [{ type: "text", text: finalError ?? "Code Mode execution failed" }];
	return { content, error: finalError, includeMedia: !invalidImage, settled, status: finalStatus };
}

type ToolUsage = NonNullable<AgentToolResult<unknown>["usage"]>;

type NestedResultControlState = {
	readonly addedToolNames: Set<string>;
	readonly omittedRunningTraceIds: Set<string>;
	terminate: boolean;
	usage: ToolUsage | undefined;
};

function newNestedResultControlState(): NestedResultControlState {
	return { addedToolNames: new Set(), omittedRunningTraceIds: new Set(), terminate: false, usage: undefined };
}

function aggregateUsage(values: readonly ToolUsage[]): ToolUsage | undefined {
	if (values.length === 0) return undefined;
	const optional = (key: "cacheWrite1h" | "reasoning"): number | undefined => {
		const present = values.filter((usage) => usage[key] !== undefined);
		return present.length > 0 ? present.reduce((total, usage) => total + (usage[key] ?? 0), 0) : undefined;
	};
	const cacheWrite1h = optional("cacheWrite1h");
	const reasoning = optional("reasoning");
	const usage: ToolUsage = {
		cacheRead: values.reduce((total, usage) => total + usage.cacheRead, 0),
		cacheWrite: values.reduce((total, usage) => total + usage.cacheWrite, 0),
		cost: {
			cacheRead: values.reduce((total, usage) => total + usage.cost.cacheRead, 0),
			cacheWrite: values.reduce((total, usage) => total + usage.cost.cacheWrite, 0),
			input: values.reduce((total, usage) => total + usage.cost.input, 0),
			output: values.reduce((total, usage) => total + usage.cost.output, 0),
			total: values.reduce((total, usage) => total + usage.cost.total, 0),
		},
		input: values.reduce((total, usage) => total + usage.input, 0),
		output: values.reduce((total, usage) => total + usage.output, 0),
		totalTokens: values.reduce((total, usage) => total + usage.totalTokens, 0),
	};
	if (cacheWrite1h !== undefined) Object.assign(usage, { cacheWrite1h });
	if (reasoning !== undefined) Object.assign(usage, { reasoning });
	return usage;
}

function retainNestedResultControls(target: NestedResultControlState, result: AgentToolResult<unknown>): void {
	for (const name of result.addedToolNames ?? []) target.addedToolNames.add(name);
	target.terminate ||= result.terminate === true;
	target.usage = aggregateUsage([...(target.usage ? [target.usage] : []), ...(result.usage ? [result.usage] : [])]);
}

function resetTraceProjection(
	traces: Map<string, RuntimeToolTrace>,
	operationIndexes: Map<string, number>,
	operations: SuiteToolEnvelopeOperation[],
	controls: NestedResultControlState,
): void {
	traces.clear();
	operationIndexes.clear();
	operations.length = 0;
	controls.addedToolNames.clear();
	controls.omittedRunningTraceIds.clear();
	controls.terminate = false;
	controls.usage = undefined;
}

function nestedResultControls(
	traces: ReadonlyMap<string, RuntimeToolTrace>,
	retained: NestedResultControlState,
): Pick<AgentToolResult<unknown>, "addedToolNames" | "terminate" | "usage"> {
	const results = [...traces.values()].flatMap((trace) => (trace.result ? [trace.result] : []));
	const addedToolNames = new Set(retained.addedToolNames);
	for (const result of results) {
		for (const name of result.addedToolNames ?? []) addedToolNames.add(name);
	}
	const usage = aggregateUsage([
		...(retained.usage ? [retained.usage] : []),
		...results.flatMap((result) => (result.usage ? [result.usage] : [])),
	]);
	const controls: Pick<AgentToolResult<unknown>, "addedToolNames" | "terminate" | "usage"> = {};
	if (addedToolNames.size > 0) Object.assign(controls, { addedToolNames: [...addedToolNames] });
	if (retained.terminate || results.some((result) => result.terminate === true))
		Object.assign(controls, { terminate: true });
	if (usage) Object.assign(controls, { usage });
	return controls;
}

function settleController(
	controller: CodeModeExecutionController | undefined,
	status: PiStuffCodeModeDetails["status"],
	error?: string,
): ControllerSettlement {
	try {
		controller?.finish(status, error);
		return error ? { error, status } : { status };
	} catch (ledgerError) {
		const message = `${error ? `${error}; ` : ""}Code Mode ledger update failed: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`;
		return { error: message, status: status === "cancelled" ? "cancelled" : "incomplete" };
	}
}

async function settleConnectorLifecycle(
	connector: SuiteCodeModeConnector,
	controller: CodeModeExecutionController | undefined,
	status: PiStuffCodeModeDetails["status"],
): Promise<void> {
	if (!controller) return;
	const passStatus = status === "success" ? "completed" : status === "paused" ? "paused" : "error";
	await connector.onPassEnd(controller.executionId, passStatus);
	if (status === "success") await connector.disposeExecution(controller.executionId, "completed");
	else if (status !== "paused" && status !== "incomplete") {
		await connector.disposeExecution(controller.executionId, "error");
	}
}

function stepTools(controller: CodeModeExecutionController): SuiteSandboxTool[] {
	return [
		{
			description: "Decide whether a durable Code Mode step should execute or replay",
			inputSchema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
			invoke: async (input) =>
				requireCodemodeValue(
					controller.beginStep(
						isRuntimeObject(input) && input !== null && "name" in input ? String(input["name"]) : "",
					),
					"Code Mode step decision",
				),
			ledger: "bypass",
			name: INTERNAL_STEP_DECIDE_TOOL,
			presentation: "hidden",
			usage: `${INTERNAL_STEP_DECIDE_TOOL}({ name })`,
		},
		{
			description: "Record one durable Code Mode step result",
			inputSchema: {
				properties: { plan: { type: "object" }, value: {} },
				required: ["plan"],
				type: "object",
			},
			invoke: async (input) => {
				if (!isRuntimeObject(input) || input === null || !("plan" in input)) {
					throw new Error("Code Mode step record is missing its decision");
				}
				const plan = input["plan"];
				if (!isRuntimeToolCallPlan(plan)) throw new Error("Code Mode step record has an invalid decision");
				const value = "value" in input ? requireCodemodeValue(input["value"], "Code Mode step value") : undefined;
				controller.completeStep(plan, value);
				return true;
			},
			ledger: "bypass",
			name: INTERNAL_STEP_RECORD_TOOL,
			presentation: "hidden",
			usage: `${INTERNAL_STEP_RECORD_TOOL}({ plan, value })`,
		},
	];
}

export class CodeModeRuntime {
	readonly connector: SuiteCodeModeConnector;
	readonly executor: CodeModeExecutor;
	readonly ledger: CodeModeSessionLedger | undefined;

	constructor(connector: SuiteCodeModeConnector, executor: CodeModeExecutor, ledger?: CodeModeSessionLedger) {
		this.connector = connector;
		this.executor = executor;
		this.ledger = ledger;
	}

	async execute(
		outerToolCallId: string,
		code: string,
		context: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PiStuffCodeModeDetails>,
	): Promise<AgentToolResult<PiStuffCodeModeDetails>> {
		let controller: CodeModeExecutionController | undefined;
		const snippets = this.ledger?.snippets(context) ?? [];
		const catalogTools = this.connector.runtimeTools(snippets);
		try {
			controller = this.ledger?.begin(
				context,
				outerToolCallId,
				code,
				new Map(catalogTools.map((tool) => [tool.name, tool.replay ?? "never"])),
				new Set(catalogTools.filter((tool) => tool.requiresApproval).map((tool) => tool.name)),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				details: { error: message, kind: "pi-stuff-code-mode", operations: [], status: "error" },
			};
		}
		return this.run(outerToolCallId, code, context, snippets, catalogTools, controller, signal, onUpdate);
	}

	async approve(
		executionId: string,
		context: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PiStuffCodeModeDetails>,
	): Promise<AgentToolResult<PiStuffCodeModeDetails>> {
		if (!this.ledger) {
			const message = "Code Mode durable approval is unavailable";
			return {
				content: [{ type: "text", text: message }],
				details: { error: message, executionId, kind: "pi-stuff-code-mode", operations: [], status: "error" },
			};
		}
		const snippets = this.ledger.snippets(context);
		const catalogTools = this.connector.runtimeTools(snippets);
		const controller = this.ledger.resume(
			context,
			executionId,
			new Map(catalogTools.map((tool) => [tool.name, tool.replay ?? "never"])),
			new Set(catalogTools.filter((tool) => tool.requiresApproval).map((tool) => tool.name)),
		);
		if (!controller) {
			const message = `Code Mode execution ${executionId} is not paused; refresh pending approvals`;
			return {
				content: [{ type: "text", text: message }],
				details: { error: message, executionId, kind: "pi-stuff-code-mode", operations: [], status: "error" },
			};
		}
		return this.run(
			controller.outerToolCallId,
			controller.code,
			context,
			snippets,
			catalogTools,
			controller,
			signal,
			onUpdate,
		);
	}

	pending(context: ExtensionContext, executionId?: string): readonly CodeModePendingAction[] {
		return this.ledger?.pending(context, executionId) ?? [];
	}

	async reject(executionId: string, sequence: number, context: ExtensionContext): Promise<boolean> {
		if (!this.ledger?.reject(context, executionId, sequence)) return false;
		await this.connector.disposeExecution(executionId, "rejected");
		return true;
	}

	private async run(
		outerToolCallId: string,
		code: string,
		context: ExtensionContext,
		snippets: readonly Snippet[],
		catalogTools: readonly SuiteSandboxTool[],
		controller: CodeModeExecutionController | undefined,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PiStuffCodeModeDetails>,
	): Promise<AgentToolResult<PiStuffCodeModeDetails>> {
		const traces = new Map<string, RuntimeToolTrace>();
		const operationIndexes = new Map<string, number>();
		const operations: SuiteToolEnvelopeOperation[] = [];
		const retainedControls = newNestedResultControlState();
		let droppedOperationCount = 0;
		let cellId: string | undefined;
		let attempt = controller?.attempt ?? 0;
		const tools = controller ? [...catalogTools, ...stepTools(controller)] : catalogTools;
		const details = (
			status: PiStuffCodeModeDetails["status"],
			error?: string,
			projectedOperations: readonly SuiteToolEnvelopeOperation[] = [...operations],
		): PiStuffCodeModeDetails => {
			const pending = controller && this.ledger ? this.ledger.pending(context, controller.executionId) : [];
			const value: PiStuffCodeModeDetails = {
				kind: "pi-stuff-code-mode",
				operations: projectedOperations,
				status,
			};
			if (attempt > 0) Object.assign(value, { attempt });
			if (cellId) Object.assign(value, { cellId });
			if (droppedOperationCount > 0) Object.assign(value, { droppedOperationCount });
			if (error) Object.assign(value, { error });
			if (controller) Object.assign(value, { executionId: controller.executionId });
			if (pending.length > 0) Object.assign(value, { pending });
			return value;
		};
		const publish = (): void => onUpdate?.({ content: [], details: details("running") });
		const recordResponse = (response: RuntimeResponse): void => {
			cellId = response.cellId;
			const dropped = mergeTraces(traces, operationIndexes, operations, response.traces, retainedControls);
			droppedOperationCount = Math.max(droppedOperationCount + dropped, response.droppedTraceCount ?? 0);
			publish();
		};
		const executorContext: ExecutorContext = {
			cwd: context.cwd,
			extensionContext: context,
			onTraceUpdate: (update: { cellId: string; droppedTraceCount?: number; trace: RuntimeToolTrace }) => {
				cellId = update.cellId;
				const dropped = mergeTrace(traces, operationIndexes, operations, update.trace, retainedControls);
				droppedOperationCount = Math.max(droppedOperationCount + dropped, update.droppedTraceCount ?? 0);
				publish();
			},
			toolCallId: outerToolCallId,
		};
		if (controller) {
			Object.assign(executorContext, {
				beginToolCall: controller.beginToolCall,
				completeToolCall: controller.completeToolCall,
			});
		}
		let outcome: ReturnType<typeof runOutcome>;
		let media: ReturnType<typeof projectFinalMedia>;
		try {
			const executeOptions: CodeModeExecuteOptions = {
				context: executorContext,
				source: buildSuiteSandboxSource(code, this.connector.catalog(), snippets),
				tools,
			};
			if (signal) Object.assign(executeOptions, { signal });
			let response: RuntimeResponse;
			for (;;) {
				controller?.beginPass(attempt);
				try {
					response = await this.runPass(executeOptions, recordResponse);
					break;
				} catch (cause) {
					if (
						cause instanceof CodeModeHostLostError &&
						attempt < HOST_RECOVERY_LIMIT &&
						!signal?.aborted &&
						!controller?.incompleteError
					) {
						if (controller) await this.connector.onPassEnd(controller.executionId, "error");
						resetTraceProjection(traces, operationIndexes, operations, retainedControls);
						[droppedOperationCount, cellId, attempt] = [0, undefined, attempt + 1];
						continue;
					}
					throw cause;
				}
			}
			const pending = controller && this.ledger ? this.ledger.pending(context, controller.executionId) : [];
			outcome = runOutcome(response, undefined, signal, controller, pending, traces);
			media = projectFinalMedia(traces, outcome.content, outcome.includeMedia);
			await assertDecodableSupportedCodeModeImages(media.content);
		} catch (cause) {
			const pending = controller && this.ledger ? this.ledger.pending(context, controller.executionId) : [];
			outcome = runOutcome(undefined, cause, signal, controller, pending, traces);
			media = projectFinalMedia(traces, outcome.content, outcome.includeMedia);
		}
		const settled = outcome.settled ?? settleController(controller, outcome.status, outcome.error);
		const finalError = settled.error ?? outcome.error;
		const finalDetails = details(settled.status, finalError, media.operations);
		captureCodeModeModelContent(finalDetails, media.content);
		await settleConnectorLifecycle(this.connector, controller, settled.status);
		return {
			content: media.content,
			details: finalDetails,
			...nestedResultControls(traces, retainedControls),
		};
	}

	private async runPass(
		options: CodeModeExecuteOptions,
		recordResponse: (response: RuntimeResponse) => void,
	): Promise<RuntimeResponse> {
		const waitOptions: CodeModeWaitOptions & { readonly yieldTimeMs: number } = {
			context: options.context,
			yieldTimeMs: AUTO_WAIT_MS,
		};
		if (options.signal) Object.assign(waitOptions, { signal: options.signal });
		let response = await this.executor.execute(options);
		recordResponse(response);
		while (response.kind === "yielded") {
			response = await this.executor.wait(response.cellId, waitOptions);
			recordResponse(response);
		}
		return response;
	}

	shutdown(): Promise<void> {
		return this.executor.shutdown();
	}
}
