/** Input, control, and result contract for one owned Agent writer process. */

import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import type { AgentContextUsage, ProtocolOutputLimit, Usage } from "../../shared/types.ts";
import type { ChildProtocolMessage } from "../shared/child-protocol.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";
import type {
	BackgroundRunnerStatus as RunnerStatus,
	BackgroundRunnerStatusStep as RunnerStatusStep,
} from "./initial-status.ts";
import type { WriterRuntimeState } from "./writer-process-registry.ts";

export interface ChildProcessResult {
	exitCode: number | null;
	signal: string | null;
	stderr: string;
	messages: ChildProtocolMessage[];
	output: string;
	error?: string | undefined;
	protocolError?: ProtocolOutputLimit | undefined;
	usage: Usage;
	costReported?: boolean;
	toolCount: number;
	toolBudgetBlockedTool?: string | undefined;
	durationMs: number;
	model?: string | undefined;
	contextUsage?: AgentContextUsage | undefined;
	interrupted?: boolean | undefined;
	timedOut?: boolean | undefined;
	stopped?: boolean | undefined;
	contextNudgeObserved?: boolean | undefined;
	process?: WriterProcess | undefined;
}

export type WriterProcess = NonNullable<BackgroundTaskResult["writerProcesses"]>[number];

export interface ChildRuntimeControl {
	state: "running" | "paused" | "timed-out" | "stopped" | "failed";
	interrupt(kind: "pause" | "timeout" | "stop"): void;
	revokeFinalization(): void;
}

export interface ChildProcessEngineInput {
	config: BackgroundRunnerConfig;
	task: RunnerAgentTask;
	index: number;
	model?: string | undefined;
	taskCwd: string;
	sessionDir?: string | undefined;
	outputFile: string;
	transcript: ChildTranscriptWriter;
	artifactJsonlPath?: string | undefined;
	statusStep: RunnerStatusStep;
	statusPath: string;
	status: RunnerStatus;
	activeControls: Map<number, ChildRuntimeControl>;
	consumeScheduledStop: () => boolean;
	preStartTerminalCause?: () => "pause" | "timeout" | "stop" | undefined;
	onWriterProcess?: ((writer: WriterRuntimeState) => void) | undefined;
}
