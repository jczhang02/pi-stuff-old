/** Project one Agent writer's bounded protocol streams into background-run state. */

import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { appendArtifactJsonl } from "../../shared/artifacts.ts";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import type { ProtocolOutputLimit, Usage } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import {
	type ChildProtocolEvent,
	type ChildProtocolMessage,
	createBoundedByteTail,
	createBoundedLineReader,
	createRollingLineReader,
	formatProtocolOutputLimit,
	MAX_CHILD_STDERR_BYTES,
	parseChildProtocolEvent,
	projectChildLifecycle,
} from "../shared/child-protocol.ts";
import type { BackgroundRunnerConfig, RunnerAgentTask } from "../shared/parallel-utils.ts";
import { effectiveToolTimeoutMs, formatToolTimeoutMessage, toolTimeoutCallKey } from "../shared/tool-timeout.ts";
import { ChildResultReducer } from "./child-result-reducer.ts";
import type {
	BackgroundRunnerStatus as RunnerStatus,
	BackgroundRunnerStatusStep as RunnerStatusStep,
} from "./initial-status.ts";
import {
	addUsage,
	appendDiagnosticEvent,
	appendRecentOutput,
	emptyUsage,
	estimatedChildMessageTokens,
	providerContextTokens,
	resolveTaskContextWindow,
	terminalAssistantStop,
	tokenUsage,
} from "./runner-output.ts";
import { writeStatus } from "./runner-state.ts";

type ChildProtocolTerminalCause = "protocol" | "tool-timeout";

export interface ChildProtocolRuntimeInput {
	config: BackgroundRunnerConfig;
	task: RunnerAgentTask;
	index: number;
	model?: string | undefined;
	transcript: ChildTranscriptWriter;
	artifactJsonlPath?: string | undefined;
	statusStep: RunnerStatusStep;
	statusPath: string;
	status: RunnerStatus;
	startFinalDrain: (evidence: boolean) => void;
	cancelFinalDrain: () => void;
	scheduleTimeout: (delayMs: number, action: () => void) => () => void;
	terminate: (cause: ChildProtocolTerminalCause, error: string, signal: "SIGINT" | "SIGTERM") => boolean;
}

export interface ChildProtocolSnapshot {
	stderr: string;
	messages: ChildProtocolMessage[];
	output: string;
	assistantError: string | undefined;
	protocolError: ProtocolOutputLimit | undefined;
	usage: Usage;
	costReported: boolean;
	toolCount: number;
	model: string | undefined;
	contextNudgeObserved: boolean;
	toolBudgetBlockedTool: string | undefined;
}

function tailEvidence(tail: ReturnType<typeof createBoundedByteTail>, stream: "stdout" | "stderr"): string {
	const marker =
		tail.droppedBytes() > 0 ? `[… ${String(tail.droppedBytes())} earlier ${stream} bytes omitted …]\n` : "";
	return `${marker}${tail.text()}`;
}

function latestAssistantMessage(messages: readonly ChildProtocolMessage[]): ChildProtocolMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

export class ChildProtocolRuntime {
	private readonly input: ChildProtocolRuntimeInput;
	private readonly usage = emptyUsage();
	private readonly resultMessages = new ChildResultReducer();
	private readonly stderrTail = createBoundedByteTail();
	private readonly rawOutputTail = createBoundedByteTail();
	private readonly stdoutReader: ReturnType<typeof createBoundedLineReader>;
	private readonly stderrReader: ReturnType<typeof createRollingLineReader>;
	private contextWindow: number | undefined;
	private contextTokens: number | undefined;
	private toolCount = 0;
	private observedModel: string | undefined;
	private assistantError: string | undefined;
	private protocolError: ProtocolOutputLimit | undefined;
	private invalidProtocolEvent = false;
	private toolTimeoutSequence = 0;
	private readonly activeToolTimeouts = new Map<string, { toolName: string; cancel: () => void }>();
	private readonly activeToolTimeoutKeysByName = new Map<string, string[]>();
	private contextNudgeObserved = false;
	private toolBudgetBlockedTool: string | undefined;
	private costReported = false;
	private streamingStatusPersistenceFailed = false;

	constructor(input: ChildProtocolRuntimeInput) {
		this.input = input;
		this.contextWindow = resolveTaskContextWindow(input.task, input.model);
		this.observedModel = input.model;
		this.stdoutReader = createBoundedLineReader({
			onLine: (line) => this.processLine(line),
			onLimit: (limit) => {
				this.protocolError = limit;
				input.terminate("protocol", formatProtocolOutputLimit(limit), "SIGTERM");
			},
		});
		this.stderrReader = createRollingLineReader({
			stream: "stderr",
			maxPendingLineBytes: MAX_CHILD_STDERR_BYTES,
			onLine: (line) => this.processStderrLine(line),
		});
	}

	private persistStreamingStatus(): void {
		try {
			writeStatus(this.input.statusPath, this.input.status);
		} catch (error) {
			if (this.streamingStatusPersistenceFailed) return;
			this.streamingStatusPersistenceFailed = true;
			reportAgentDiagnostic(
				`Failed to persist live Agent progress for child ${String(this.input.index)}; execution will continue in memory:`,
				error,
			);
		}
	}

	private appendRawEvent(line: string, event?: ChildProtocolEvent): void {
		appendDiagnosticEvent(`${this.input.config.asyncDir}/events.jsonl`, {
			...(event ?? { type: "subagent.child.stdout", line }),
			subagentSource: "child",
			subagentRunId: this.input.config.id,
			subagentStepIndex: this.input.index,
			subagentAgent: this.input.task.agent,
			observedAt: Date.now(),
		});
		if (!this.input.artifactJsonlPath) return;
		try {
			appendArtifactJsonl(this.input.artifactJsonlPath, line);
		} catch {
			// Artifact JSONL is optional.
		}
	}

	private updateContextUsage(message: ChildProtocolMessage): void {
		if (!this.contextWindow) return;
		if (message.role === "assistant") {
			const providerTokens = providerContextTokens(message);
			if (message.stopReason !== "aborted" && message.stopReason !== "error" && providerTokens) {
				this.contextTokens = providerTokens;
			} else if (this.contextTokens !== undefined) {
				this.contextTokens += estimatedChildMessageTokens(message);
			}
		} else if (this.contextTokens !== undefined) {
			this.contextTokens += estimatedChildMessageTokens(message);
		}
		this.input.statusStep.contextUsage =
			this.contextTokens === undefined
				? undefined
				: { tokens: this.contextTokens, contextWindow: this.contextWindow };
	}

	private rejectProtocolEvent(line: string, reason: string): void {
		this.invalidProtocolEvent = true;
		this.recordRawLine(line);
		this.input.terminate("protocol", `protocol_invalid_event: ${reason}.`, "SIGTERM");
	}

	private recordRawLine(line: string): void {
		this.rawOutputTail.push(`${line}\n`);
		this.input.transcript.writeStdoutLine(line);
		this.appendRawEvent(line);
	}

	private parseEvent(line: string): ChildProtocolEvent | undefined {
		let parsed: JsonValue;
		try {
			parsed = parseJsonValue(line);
		} catch {
			this.recordRawLine(line);
			appendRecentOutput(this.input.statusStep, line);
			this.persistStreamingStatus();
			return undefined;
		}
		const parsedEvent = parseChildProtocolEvent(parsed);
		if (!parsedEvent.event) {
			this.rejectProtocolEvent(line, parsedEvent.error ?? "event is malformed");
			return undefined;
		}
		return parsedEvent.event;
	}

	private processLineUnchecked(line: string): void {
		if (this.protocolError || this.invalidProtocolEvent || !line.trim()) return;
		const event = this.parseEvent(line);
		if (event) this.processEvent(line, event);
	}

	private processLine(line: string): void {
		try {
			this.processLineUnchecked(line);
		} catch (error) {
			this.rejectProtocolEvent(
				line,
				`event processing failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private processEvent(line: string, event: ChildProtocolEvent): void {
		if (
			event.type === "message_end" &&
			event.message?.role === "custom" &&
			event.message.customType === "magic-context:ceiling-nudge"
		) {
			this.contextNudgeObserved = true;
		}
		this.appendRawEvent(line, event);
		this.input.transcript.writeChildEvent(event);
		if (this.handleContextEvent(event)) return;
		const terminalStop =
			event.type === "message_end" && event.message?.role === "assistant" && terminalAssistantStop(event.message);
		const lifecycle = projectChildLifecycle(event, terminalStop);
		if (lifecycle === "start-drain") this.input.startFinalDrain(terminalStop || event.type === "agent_settled");
		else if (lifecycle === "cancel-drain") this.input.cancelFinalDrain();
		if (this.handleToolEvent(event)) return;
		if ((event.type !== "message_end" && event.type !== "tool_result_end") || !event.message) return;
		this.recordMessage(event.message, event.type === "message_end" && event.message.role === "assistant");
	}

	private handleContextEvent(event: ChildProtocolEvent): boolean {
		if (event.toolBudgetEvent) {
			this.toolCount = Math.max(this.toolCount, event.toolBudgetEvent.toolCount);
			this.input.statusStep.toolCount = this.toolCount;
			if (event.toolBudgetEvent.outcome === "hard-blocked") {
				this.toolBudgetBlockedTool = event.toolBudgetEvent.toolName;
			}
			this.persistStreamingStatus();
			return true;
		}
		if (event.modelContext) {
			this.contextWindow = event.modelContext.contextWindow;
			this.input.statusStep.contextUsage =
				this.contextTokens === undefined
					? undefined
					: { tokens: this.contextTokens, contextWindow: this.contextWindow };
			this.persistStreamingStatus();
			return true;
		}
		if (event.type !== "compaction_start") return false;
		this.contextTokens = undefined;
		this.input.statusStep.contextUsage = undefined;
		this.persistStreamingStatus();
		return true;
	}

	private handleToolEvent(event: ChildProtocolEvent): boolean {
		if (event.type === "tool_execution_start" && event.toolName) {
			this.armToolTimeout(event);
			this.toolCount += 1;
			this.input.statusStep.toolCount = this.toolCount;
			this.input.statusStep.currentTool = event.toolName;
			this.input.statusStep.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			this.input.statusStep.currentToolStartedAt = Date.now();
			this.input.statusStep.lastActivityAt = Date.now();
			this.persistStreamingStatus();
			return true;
		}
		if (event.type !== "tool_execution_end") return false;
		this.clearToolTimeout(event);
		this.input.statusStep.currentTool = undefined;
		this.input.statusStep.currentToolArgs = undefined;
		this.input.statusStep.currentToolStartedAt = undefined;
		this.input.statusStep.lastActivityAt = Date.now();
		this.persistStreamingStatus();
		return true;
	}

	private removeToolTimeout(key: string): void {
		const active = this.activeToolTimeouts.get(key);
		if (!active) return;
		active.cancel();
		this.activeToolTimeouts.delete(key);
		const keys =
			this.activeToolTimeoutKeysByName.get(active.toolName)?.filter((candidate) => candidate !== key) ?? [];
		if (keys.length > 0) this.activeToolTimeoutKeysByName.set(active.toolName, keys);
		else this.activeToolTimeoutKeysByName.delete(active.toolName);
	}

	private clearToolTimeout(event: ChildProtocolEvent): void {
		const key = event.toolCallId
			? `id:${event.toolCallId}`
			: event.toolName
				? this.activeToolTimeoutKeysByName.get(event.toolName)?.[0]
				: this.activeToolTimeouts.size === 1
					? this.activeToolTimeouts.keys().next().value
					: undefined;
		if (key) this.removeToolTimeout(key);
	}

	private armToolTimeout(event: ChildProtocolEvent): void {
		const toolName = event.toolName;
		if (!toolName) return;
		const timeoutMs = effectiveToolTimeoutMs(toolName, this.input.task.toolTimeoutMs);
		if (timeoutMs === undefined) return;
		const remainingMs =
			this.input.config.deadlineAt === undefined
				? undefined
				: Math.max(0, this.input.config.deadlineAt - Date.now());
		if (remainingMs !== undefined && timeoutMs >= remainingMs) return;
		const key = toolTimeoutCallKey(event, ++this.toolTimeoutSequence);
		const cancel = this.input.scheduleTimeout(timeoutMs, () => {
			this.removeToolTimeout(key);
			this.input.terminate("tool-timeout", formatToolTimeoutMessage(toolName, timeoutMs), "SIGTERM");
		});
		this.activeToolTimeouts.set(key, { toolName, cancel });
		const keys = this.activeToolTimeoutKeysByName.get(toolName) ?? [];
		keys.push(key);
		this.activeToolTimeoutKeysByName.set(toolName, keys);
	}

	private clearAllToolTimeouts(): void {
		for (const key of this.activeToolTimeouts.keys()) this.removeToolTimeout(key);
	}

	private recordMessage(message: ChildProtocolMessage, assistantMessageEnd: boolean): void {
		this.resultMessages.record(message);
		this.updateContextUsage(message);
		const text = extractTextFromContent(message.content);
		if (text) {
			appendRecentOutput(this.input.statusStep, text);
			this.input.statusStep.lastActivityAt = Date.now();
		}
		if (assistantMessageEnd && message.role === "assistant") {
			this.observedModel = message.model ?? this.observedModel;
			this.assistantError = message.errorMessage;
			this.costReported = addUsage(this.usage, message) || this.costReported;
			this.input.statusStep.turnCount = this.usage.turns;
			this.input.statusStep.tokens = tokenUsage(this.usage);
		}
		this.persistStreamingStatus();
	}

	private appendStderr(line: string): void {
		this.input.transcript.writeStderrLine(line);
		appendDiagnosticEvent(`${this.input.config.asyncDir}/events.jsonl`, {
			type: "subagent.child.stderr",
			line,
			subagentRunId: this.input.config.id,
			subagentStepIndex: this.input.index,
			observedAt: Date.now(),
		});
	}

	private processStderrLine(line: string): void {
		this.appendStderr(line);
	}

	pushStdout(chunk: Buffer): void {
		this.stdoutReader.push(chunk);
	}

	pushStderr(chunk: Buffer): void {
		this.stderrTail.push(chunk);
		this.stderrReader.push(chunk);
	}

	end(): void {
		this.clearAllToolTimeouts();
		this.stdoutReader.end();
		this.stderrReader.end();
	}

	snapshot(): ChildProtocolSnapshot {
		const messages = this.resultMessages.messages();
		const latestAssistantEvidence = latestAssistantMessage(messages);
		return {
			stderr: tailEvidence(this.stderrTail, "stderr"),
			messages,
			output:
				getFinalOutput(messages) ||
				(latestAssistantEvidence ? extractTextFromContent(latestAssistantEvidence.content) : "") ||
				tailEvidence(this.rawOutputTail, "stdout").trim(),
			assistantError: this.assistantError,
			protocolError: this.protocolError,
			usage: this.usage,
			costReported: this.costReported,
			toolCount: this.toolCount,
			model: this.observedModel,
			contextNudgeObserved: this.contextNudgeObserved,
			toolBudgetBlockedTool: this.toolBudgetBlockedTool,
		};
	}
}
