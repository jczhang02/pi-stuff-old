import { existsSync } from "node:fs";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { isRuntimeNumber } from "../../shared/runtime-type.ts";
import { boundTerminalLine } from "../../tool-display/index.ts";
import { reportWorkDiagnostic } from "./diagnostics.ts";
import { type BoundedOutputFile, foregroundOutputSnapshot } from "./output.ts";
import type {
	BackgroundWorkBashDetails,
	BackgroundWorkKind,
	BackgroundWorkOutcome,
	BackgroundWorkSnapshot,
	BackgroundWorkTerminalStatus,
	BashExecutionInput,
} from "./runtime.ts";
import type { ShellLaunchInput } from "./shell-activity-launch.ts";

const QUICK_COMPLETION_MS = 2_000;

export type ShellStopReason = "abort" | "shutdown" | "timeout" | "user";

export function shellActivityTitle(input: ShellLaunchInput): string {
	const first =
		input.command
			.trim()
			.split(/\r?\n|&&|\|\||;/u)[0]
			?.trim() ?? "";
	return input.description?.trim() || boundTerminalLine(first, 80) || "background command";
}

export function emitShellToolUpdate(
	onUpdate: AgentToolUpdateCallback<BackgroundWorkBashDetails | undefined> | undefined,
	result: AgentToolResult<BackgroundWorkBashDetails | undefined>,
): void {
	try {
		onUpdate?.(result);
	} catch (error) {
		reportWorkDiagnostic("Bash progress observer failed", error, { key: "bash-progress-observer" });
	}
}

interface ShellExecutionProjection {
	readonly completion: Effect.Effect<BackgroundWorkOutcome>;
	readonly detach: (reason: "timeout") => void;
	readonly detached: Effect.Effect<"manual" | "timeout">;
	readonly id: string;
	readonly onAbort: () => void;
	readonly output: BoundedOutputFile;
	readonly outputPath: () => string | undefined;
}

type ShellExecutionResult =
	| { readonly kind: "completed"; readonly outcome: BackgroundWorkOutcome }
	| { readonly kind: "detached"; readonly reason: "manual" | "timeout" };

function waitForShellResult(source: ShellExecutionProjection, detachAt: number): Effect.Effect<ShellExecutionResult> {
	const terminal = Effect.raceFirst(
		source.completion.pipe(Effect.map((outcome) => ({ kind: "completed" as const, outcome }))),
		source.detached.pipe(Effect.map((reason) => ({ kind: "detached" as const, reason }))),
	);
	const automaticDetach = Effect.sleep(Math.max(0, detachAt - Date.now())).pipe(
		Effect.andThen(
			Effect.sync(() => {
				source.detach("timeout");
				return { kind: "detached" as const, reason: "timeout" as const };
			}),
		),
	);
	return Effect.raceFirst(terminal, automaticDetach);
}

function abortShellExecution(signal: AbortSignal, onAbort: () => void): Effect.Effect<never> {
	return Effect.callback((resume) => {
		const abort = () => {
			onAbort();
			resume(Effect.interrupt);
		};
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", abort));
	});
}

export function executeShellTool(
	input: BashExecutionInput,
	backgroundAfterMs: number,
	source: ShellExecutionProjection,
): Effect.Effect<AgentToolResult<BackgroundWorkBashDetails | undefined>, never, Scope.Scope> {
	if (input.runInBackground) return Effect.succeed(backgroundShellLaunchResult(source.id, source.outputPath()));
	const execution = Effect.gen(function* () {
		const detachAt = Date.now() + backgroundAfterMs;
		let lastUpdate = "";
		const sendUpdate = () => {
			const output = source.output.recentText(12_000);
			if (!output || output === lastUpdate) return;
			lastUpdate = output;
			emitShellToolUpdate(input.onUpdate, { content: [{ type: "text", text: output }], details: undefined });
		};
		emitShellToolUpdate(input.onUpdate, { content: [], details: undefined });
		const quick = yield* Effect.raceFirst(
			waitForShellResult(source, detachAt),
			Effect.sleep(QUICK_COMPLETION_MS).pipe(Effect.as({ kind: "still-running" as const })),
		);
		if (quick.kind === "completed") return foregroundShellResult(quick.outcome);
		if (quick.kind === "detached") {
			return backgroundShellLaunchResult(source.id, source.outputPath(), quick.reason);
		}
		yield* Effect.forkScoped(Effect.forever(Effect.sleep(250).pipe(Effect.andThen(Effect.sync(sendUpdate)))));
		const result = yield* waitForShellResult(source, detachAt);
		sendUpdate();
		return result.kind === "detached"
			? backgroundShellLaunchResult(source.id, source.outputPath(), result.reason)
			: foregroundShellResult(result.outcome);
	}).pipe(Effect.onInterrupt(() => Effect.sync(source.onAbort)));
	return input.signal ? Effect.raceFirst(execution, abortShellExecution(input.signal, source.onAbort)) : execution;
}

export function durableShellOutputPath(output: BoundedOutputFile): string | undefined {
	return output.durable && existsSync(output.path) ? output.path : undefined;
}

interface ShellSnapshotProjection {
	readonly id: string;
	readonly input: ShellLaunchInput;
	readonly kind: BackgroundWorkKind;
	readonly outputPath: string | undefined;
	readonly recentOutput: string;
	readonly startedAt: number;
	readonly stopReason: ShellStopReason | undefined;
	readonly title: string;
}

export function projectShellSnapshot(source: ShellSnapshotProjection): BackgroundWorkSnapshot {
	const { input } = source;
	const snapshot: BackgroundWorkSnapshot = {
		command: input.command,
		id: source.id,
		kind: source.kind,
		startedAt: source.startedAt,
		status: source.stopReason ? "stopping" : "running",
		title: source.title,
	};
	if (input.description) Object.assign(snapshot, { description: input.description });
	if (input.monitorFailureText) Object.assign(snapshot, { monitorFailureText: input.monitorFailureText });
	if (input.monitorSource) Object.assign(snapshot, { monitorSource: input.monitorSource });
	if (input.monitorSuccessText) Object.assign(snapshot, { monitorSuccessText: input.monitorSuccessText });
	if (input.monitorTarget) Object.assign(snapshot, { monitorTarget: input.monitorTarget });
	if (input.monitorTimeoutSeconds !== undefined) {
		Object.assign(snapshot, { monitorTimeoutSeconds: input.monitorTimeoutSeconds });
	}
	if (source.outputPath) Object.assign(snapshot, { outputPath: source.outputPath });
	if (source.recentOutput) Object.assign(snapshot, { recentOutput: source.recentOutput });
	return snapshot;
}

export function shellTerminalStatus(
	stopReason: ShellStopReason | undefined,
	code: number | null,
	signal: NodeJS.Signals | null,
	conditionsFailed: boolean,
): BackgroundWorkTerminalStatus {
	if (stopReason === "timeout") return "timed_out";
	if (stopReason) return "stopped";
	return code === 0 && signal === null && !conditionsFailed ? "completed" : "failed";
}

export function shellOutcomeSummary(
	kind: BackgroundWorkKind,
	title: string,
	status: BackgroundWorkTerminalStatus,
	code: number | null,
): string {
	const subject = kind === "monitor" ? "Monitor" : "Background command";
	switch (status) {
		case "completed":
			return `${subject} "${title}" completed`;
		case "failed":
			return `${subject} "${title}" failed${isRuntimeNumber(code) ? ` (exit ${String(code)})` : ""}`;
		case "stopped":
			return `${subject} "${title}" stopped`;
		case "timed_out":
			return `${subject} "${title}" timed out`;
	}
}

export function foregroundShellResult(
	outcome: BackgroundWorkOutcome,
): AgentToolResult<BackgroundWorkBashDetails | undefined> {
	const snapshot = foregroundOutputSnapshot(outcome.outputPath, outcome.recentOutput);
	if (outcome.status !== "completed") {
		let status = outcome.summary;
		if (isRuntimeNumber(outcome.exitCode) && outcome.exitCode !== 0) {
			status = `Command exited with code ${String(outcome.exitCode)}`;
		} else if (outcome.status === "timed_out") status = "Command timed out";
		else if (outcome.status === "stopped") status = "Command aborted";
		throw new Error(`${snapshot.text ? `${snapshot.text}\n\n` : ""}${status}`);
	}
	return textResult(snapshot.text || "(no output)", "details" in snapshot ? snapshot.details : undefined);
}

export function backgroundShellLaunchResult(
	id: string,
	outputPath: string | undefined,
	reason?: "manual" | "timeout",
): AgentToolResult<BackgroundWorkBashDetails | undefined> {
	const action = reason === "manual" ? "manually moved" : reason === "timeout" ? "moved" : "started";
	const details: BackgroundWorkBashDetails = { backgroundTaskId: id };
	if (outputPath) Object.assign(details, { fullOutputPath: outputPath });
	return textResult(
		`Command ${action} to background task ${id}.${outputPath ? `\nOutput: ${outputPath}` : ""}\nThe terminal result will be delivered automatically; continue useful work instead of polling.`,
		details,
	);
}

function textResult(
	text: string,
	details?: BackgroundWorkBashDetails,
): AgentToolResult<BackgroundWorkBashDetails | undefined> {
	return { content: [{ type: "text", text }], details };
}
