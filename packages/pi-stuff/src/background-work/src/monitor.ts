import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { isRuntimeObject } from "../../shared/runtime-type.ts";
import { boundTerminalLine } from "../../tool-display/index.ts";
import type { BackgroundWorkEffectTask } from "./effect-owner.ts";
import { readMonitorHttp, readMonitorSize, readMonitorSlice } from "./monitor-native.ts";
import { sanitizeTerminalText, utf8SafeTail } from "./output.ts";
import type {
	BackgroundMonitorActivity,
	BackgroundWorkOutcome,
	BackgroundWorkRuntime,
	BackgroundWorkSnapshot,
} from "./runtime.ts";

const DEFAULT_INTERVAL_SECONDS = 2;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_EVIDENCE_BYTES = 64 * 1024;

type MonitorSource = "command" | "file" | "http" | "log";

export interface MonitorInput {
	readonly description?: string;
	readonly failureText?: string;
	readonly intervalSeconds?: number;
	readonly source: MonitorSource;
	readonly startAtEnd?: boolean;
	readonly successText?: string;
	readonly target: string;
	readonly timeoutSeconds?: number;
}

export interface StartedMonitor {
	readonly id: string;
	readonly outputPath?: string;
	readonly title: string;
}

interface ProbeResult {
	readonly evidence: string;
	readonly state: "failed" | "pending" | "satisfied";
}

function positiveSeconds(value: number | undefined, fallback: number, name: string): number {
	const selected = value ?? fallback;
	const milliseconds = Math.round(selected * 1_000);
	if (!Number.isFinite(selected) || !Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
		throw new Error(`${name} must be a positive, representable duration`);
	}
	return selected;
}

function boundedSeconds(value: number | undefined, fallback: number, name: string, maximum: number): number {
	const selected = positiveSeconds(value, fallback, name);
	if (selected > maximum) throw new Error(`${name} must be no more than ${String(maximum)} seconds`);
	return selected;
}

function titleFor(input: MonitorInput): string {
	const explicit = boundTerminalLine(input.description, 80);
	if (explicit) return explicit;
	return boundTerminalLine(`${input.source} ${input.target}`, 80);
}

function textCondition(evidence: string, successText?: string, failureText?: string): ProbeResult {
	if (failureText && evidence.includes(failureText)) return { evidence, state: "failed" };
	if (!successText || evidence.includes(successText)) return { evidence, state: "satisfied" };
	return { evidence, state: "pending" };
}

class PollingMonitor implements BackgroundMonitorActivity {
	readonly id: string;
	private evidence = "Waiting for the condition.";
	private readonly effects: BackgroundWorkRuntime["effects"];
	private initialOffset = 0;
	private readonly input: MonitorInput;
	private readonly intervalMs: number;
	private outcomeValue: Promise<BackgroundWorkOutcome> | undefined;
	private readonly startedAt = Date.now();
	private readonly startedAtMonotonic = performance.now();
	private status: "running" | "stopping" = "running";
	private stopReason: "shutdown" | "user" | undefined;
	private task: BackgroundWorkEffectTask<BackgroundWorkOutcome, never> | undefined;
	private terminalOutcome: BackgroundWorkOutcome | undefined;
	private readonly timeoutMs: number;
	private readonly title: string;

	constructor(
		id: string,
		input: MonitorInput,
		intervalMs: number,
		timeoutMs: number,
		effects: BackgroundWorkRuntime["effects"],
	) {
		this.id = id;
		this.effects = effects;
		this.input = input;
		this.intervalMs = intervalMs;
		this.timeoutMs = timeoutMs;
		this.title = titleFor(input);
	}

	get outcome(): Promise<BackgroundWorkOutcome> {
		if (!this.outcomeValue) throw new Error("Monitor has not started.");
		return this.outcomeValue;
	}

	start(): void {
		if (this.task) return;
		const task = this.effects.open(this.run());
		this.task = task;
		this.outcomeValue = task.exit.then((exit) => {
			if (Exit.isSuccess(exit)) return exit.value;
			if (this.stopReason || Cause.hasInterrupts(exit.cause)) {
				return this.finish("stopped", `Monitor "${this.title}" stopped`);
			}
			const error = Cause.squash(exit.cause);
			this.evidence = error instanceof Error ? error.message : String(error);
			return this.finish("failed", `Monitor "${this.title}" failed`);
		});
	}

	readOutput(maxBytes = MAX_EVIDENCE_BYTES): string {
		const buffer = Buffer.from(this.evidence, "utf-8");
		return utf8SafeTail(buffer, maxBytes).toString("utf-8");
	}

	snapshot(): BackgroundWorkSnapshot {
		const snapshot: BackgroundWorkSnapshot = {
			id: this.id,
			kind: "monitor",
			monitorSource: this.input.source,
			monitorTarget: this.input.target,
			monitorTimeoutSeconds: Math.round(this.timeoutMs / 1_000),
			recentOutput: this.evidence,
			startedAt: this.startedAt,
			status: this.status,
			title: this.title,
		};
		if (this.input.description) Object.assign(snapshot, { description: this.input.description });
		if (this.input.failureText) Object.assign(snapshot, { monitorFailureText: this.input.failureText });
		if (this.input.successText) Object.assign(snapshot, { monitorSuccessText: this.input.successText });
		return snapshot;
	}

	async cancel(reason: "shutdown" | "user"): Promise<BackgroundWorkOutcome> {
		if (this.terminalOutcome) return this.terminalOutcome;
		this.stopReason = reason;
		this.status = "stopping";
		await this.task?.interrupt();
		return this.outcome;
	}

	private run(): Effect.Effect<BackgroundWorkOutcome, never> {
		return Effect.gen({ self: this }, function* () {
			if (this.input.source === "log" && this.input.startAtEnd !== false) {
				this.initialOffset = yield* Effect.tryPromise({
					try: () => readMonitorSize(this.input.target),
					catch: (error) => error,
				}).pipe(Effect.catch(() => Effect.succeed(0)));
			}
			for (;;) {
				if (performance.now() - this.startedAtMonotonic >= this.timeoutMs) {
					return this.finish("timed_out", `Monitor "${this.title}" timed out`);
				}
				const attempt = yield* this.probe().pipe(
					Effect.match({
						onFailure: (error) => ({ error }) as const,
						onSuccess: (result) => ({ result }) as const,
					}),
				);
				if ("result" in attempt) {
					const result = attempt.result;
					this.evidence = result.evidence || "Condition has not been observed yet.";
					if (result.state === "satisfied") {
						return this.finish("completed", `Monitor "${this.title}" observed its condition`);
					}
					if (result.state === "failed") {
						return this.finish("failed", `Monitor "${this.title}" observed its failure condition`);
					}
				} else {
					const { error } = attempt;
					const code = error && isRuntimeObject(error) && "code" in error ? String(error.code) : "";
					if (code === "ENOENT" && (this.input.source === "file" || this.input.source === "log")) {
						this.evidence = `Waiting for ${this.input.source} to appear.`;
					} else {
						this.evidence = error instanceof Error ? error.message : String(error);
						if (this.input.source !== "http" && code) {
							return this.finish("failed", `Monitor "${this.title}" could not read its source`);
						}
					}
				}
				yield* Effect.sleep(
					Math.min(this.intervalMs, Math.max(1, this.timeoutMs - (performance.now() - this.startedAtMonotonic))),
				);
			}
		});
	}

	private probe(): Effect.Effect<ProbeResult, unknown> {
		if (this.input.source === "http") return this.probeHttp();
		return Effect.tryPromise({
			try: () => readMonitorSlice(this.input.target, this.initialOffset, MAX_EVIDENCE_BYTES),
			catch: (error) => error,
		}).pipe(
			Effect.map((evidence) =>
				!this.input.successText && !this.input.failureText
					? { evidence: evidence || `Found ${this.input.target}`, state: "satisfied" as const }
					: textCondition(evidence, this.input.successText, this.input.failureText),
			),
		);
	}

	private probeHttp(): Effect.Effect<ProbeResult, unknown> {
		return Effect.tryPromise({
			try: async (signal) => {
				const response = await readMonitorHttp(this.input.target, signal, MAX_EVIDENCE_BYTES);
				const evidence = sanitizeTerminalText(
					`HTTP ${String(response.status)} ${response.statusText}\n${response.body}`,
				).trimEnd();
				const condition = textCondition(evidence, this.input.successText, this.input.failureText);
				if (condition.state === "failed") return condition;
				return response.ok ? condition : { evidence, state: "pending" as const };
			},
			catch: (error) => error,
		}).pipe(
			Effect.timeoutOption(10_000),
			Effect.flatMap((result) =>
				Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(new Error("HTTP probe timed out")),
			),
		);
	}

	private finish(status: BackgroundWorkOutcome["status"], summary: string): BackgroundWorkOutcome {
		if (this.terminalOutcome) return this.terminalOutcome;
		this.status = "stopping";
		this.terminalOutcome = {
			endedAt: Date.now(),
			id: this.id,
			kind: "monitor",
			recentOutput: this.evidence,
			startedAt: this.startedAt,
			status,
			summary,
			title: this.title,
		};
		return this.terminalOutcome;
	}
}

export async function startMonitor(
	runtime: BackgroundWorkRuntime,
	input: MonitorInput,
	ctx: ExtensionContext,
): Promise<StartedMonitor> {
	const timeoutSeconds = positiveSeconds(input.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, "Monitor timeout");
	const title = titleFor(input);
	if (!input.target.trim()) throw new Error("Monitor target is empty");
	if (input.source === "http") {
		const url = new URL(input.target);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("Monitor HTTP target must use http or https");
	}
	if (input.source === "command") {
		const commandInput = {
			command: input.target,
			timeoutSeconds,
		};
		if (input.description) Object.assign(commandInput, { description: input.description });
		if (input.failureText) Object.assign(commandInput, { failureText: input.failureText });
		if (input.successText) Object.assign(commandInput, { successText: input.successText });
		const started = await runtime.startCommandMonitor(commandInput, ctx);
		const result: StartedMonitor = { id: started.id, title };
		if (started.outputPath) Object.assign(result, { outputPath: started.outputPath });
		return result;
	}
	const intervalSeconds = boundedSeconds(input.intervalSeconds, DEFAULT_INTERVAL_SECONDS, "Monitor interval", 60);
	const id = runtime.newMonitorId();
	const monitor = new PollingMonitor(
		id,
		input,
		Math.round(intervalSeconds * 1_000),
		Math.round(timeoutSeconds * 1_000),
		runtime.effects,
	);
	runtime.registerMonitor(monitor);
	return { id, title };
}
