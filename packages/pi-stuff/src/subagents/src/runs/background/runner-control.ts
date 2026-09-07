/** Own live stop, timeout, interrupt, and steering control for one background run. */

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import type { SteeringTargetState, SteeringTargetStatus } from "../../shared/types.ts";
import { projectNestedEvents, resolveNestedAsyncDir } from "../shared/nested-events.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";
import type { ChildRuntimeControl } from "./child-process-engine.ts";
import {
	deliverInterruptRequest,
	deliverStopRequest,
	deliverTimeoutRequest,
	enqueueStepSteer,
	type SteerAck,
	type SteerRequest,
	watchAsyncControlInbox,
} from "./control-channel.ts";
import type { BackgroundRunnerStatus as RunnerStatus } from "./initial-status.ts";
import { appendDiagnosticEvent } from "./runner-output.ts";
import { writeStatus } from "./runner-state.ts";
import {
	findSteeringRequest,
	MAX_PENDING_STEERING_REQUESTS,
	pendingSteeringRequestCount,
	recordSteeringRequest,
	steeringStatus,
	updateSteeringTarget,
} from "./steering.ts";

export type TerminalKind = "pause" | "timeout" | "stop";
const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

function interruptDescendants(config: BackgroundRunnerConfig, kind: TerminalKind): void {
	if (!config.nestedRoute) return;
	try {
		const queue = [...projectNestedEvents(config.nestedRoute).children];
		while (queue.length > 0) {
			const child = queue.shift();
			if (!child) continue;
			queue.push(...(child.children ?? []), ...(child.steps?.flatMap((step) => step.children ?? []) ?? []));
			if (child.state !== "running" && child.state !== "queued") continue;
			const asyncDir = resolveNestedAsyncDir(config.nestedRoute.rootRunId, child);
			if (!asyncDir) continue;
			const request: Parameters<typeof deliverStopRequest>[0] = { asyncDir, source: `ancestor-${kind}` };
			if (child.pid !== undefined) request.pid = child.pid;
			if (kind === "stop") deliverStopRequest(request);
			else if (kind === "timeout") deliverTimeoutRequest(request);
			else deliverInterruptRequest(request);
		}
	} catch {
		// Descendant propagation is best effort; the direct children are still stopped.
	}
}

export class BackgroundRunControl {
	readonly activeControls = new Map<number, ChildRuntimeControl>();
	private readonly config: BackgroundRunnerConfig;
	private readonly status: RunnerStatus;
	private readonly statusPath: string;
	private readonly eventsPath: string;
	private readonly scheduledStops = new Set<number>();
	private readonly signalInterrupt = () => this.requestTerminal("pause");
	private terminalKind: TerminalKind | undefined;
	private steeringStatusPersistenceFailed = false;

	constructor(config: BackgroundRunnerConfig, status: RunnerStatus, statusPath: string, eventsPath: string) {
		this.config = config;
		this.status = status;
		this.statusPath = statusPath;
		this.eventsPath = eventsPath;
	}

	install(): Effect.Effect<void, never, Scope.Scope> {
		return Effect.gen({ self: this }, function* () {
			yield* watchAsyncControlInbox(this.config.asyncDir, {
				onInterrupt: () => this.requestTerminal("pause"),
				onTimeout: () => this.requestTerminal("timeout"),
				onStop: (request) => {
					if (request.targetIndex === undefined) this.requestTerminal("stop");
					else this.stopChild(request.targetIndex);
				},
				onSteer: (request) => this.onSteer(request),
				onSteerAck: (ack) => this.onSteerAck(ack),
			});
			yield* Effect.acquireRelease(
				Effect.sync(() => process.on(ASYNC_INTERRUPT_SIGNAL, this.signalInterrupt)),
				() => Effect.sync(() => process.off(ASYNC_INTERRUPT_SIGNAL, this.signalInterrupt)),
			);
			if (this.config.deadlineAt !== undefined) {
				yield* Effect.forkScoped(
					Effect.sleep(Math.max(0, this.config.deadlineAt - Date.now())).pipe(
						Effect.andThen(Effect.sync(() => this.requestTerminal("timeout"))),
					),
				);
			}
		});
	}

	consumeScheduledStop(index: number): boolean {
		return this.scheduledStops.delete(index);
	}

	preStartTerminalCause(): TerminalKind | undefined {
		return this.terminalKind;
	}

	private requestTerminal(kind: TerminalKind): void {
		if (this.terminalKind) return;
		this.terminalKind = kind;
		for (const control of this.activeControls.values()) control.interrupt(kind);
		interruptDescendants(this.config, kind);
	}

	private persistSteering(): void {
		try {
			writeStatus(this.statusPath, this.status);
			this.steeringStatusPersistenceFailed = false;
		} catch (error) {
			if (!this.steeringStatusPersistenceFailed) {
				this.steeringStatusPersistenceFailed = true;
				reportAgentDiagnostic(
					`Failed to persist live steering status for '${this.config.id}'; retaining the durable control record for retry:`,
					error,
				);
			}
			throw error;
		}
	}

	private routeSteering(request: SteerRequest, index: number): void {
		try {
			enqueueStepSteer(this.config.asyncDir, index, request);
			this.activeControls.get(index)?.revokeFinalization();
			updateSteeringTarget(steeringStatus(this.status), request.id, index, "routed", Date.now());
			appendDiagnosticEvent(this.eventsPath, {
				type: "subagent.steer.routed",
				ts: Date.now(),
				runId: this.config.id,
				requestId: request.id,
				index,
			});
		} catch (error) {
			updateSteeringTarget(steeringStatus(this.status), request.id, index, "failed", Date.now(), {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private stopChild(index: number): void {
		const step = this.status.steps[index];
		if (!step || (step.status !== "pending" && step.status !== "running")) return;
		const control = this.activeControls.get(index);
		if (control) control.interrupt("stop");
		else this.scheduledStops.add(index);
		appendDiagnosticEvent(this.eventsPath, {
			type: "subagent.child.stop_requested",
			ts: Date.now(),
			runId: this.config.id,
			index,
		});
	}

	private requestedIndexes(request: SteerRequest): number[] {
		if (request.targetIndex !== undefined) return [request.targetIndex];
		if (request.targetIndexes?.length) return request.targetIndexes;
		return this.status.steps.flatMap((step, index) =>
			step.status === "pending" || step.status === "running" ? [index] : [],
		);
	}

	private steeringTarget(index: number, capacityReached: boolean): SteeringTargetStatus {
		const step = this.status.steps[index];
		const control = this.activeControls.get(index);
		let state: SteeringTargetState = "routed";
		let reason: string | undefined;
		if (capacityReached) {
			state = "failed";
			reason = `Agent has ${MAX_PENDING_STEERING_REQUESTS} steering requests awaiting delivery; wait for an acknowledgement before sending another.`;
		} else if (!step) {
			state = "failed";
			reason = "Agent index is out of range.";
		} else if (control && control.state !== "running") {
			state = "failed";
			reason = `Agent is ${control.state}.`;
		} else if (!control && step.status !== "pending" && step.status !== "running") {
			state = "failed";
			reason = `Agent is ${step.status}.`;
		}
		return reason ? { index, state, reason } : { index, state };
	}

	private acceptUserOrigin(request: SteerRequest, targets: readonly SteeringTargetStatus[]): void {
		if (
			request.parentRunOrigin !== "user" ||
			!targets.some((target) => target.state !== "failed" && target.state !== "late")
		)
			return;
		this.config.parentRunOrigin = "user";
		this.status.parentRunOrigin = "user";
	}

	onSteer(request: SteerRequest): void {
		const projection = steeringStatus(this.status);
		const existing = findSteeringRequest(projection, request.id);
		if (existing) {
			this.acceptUserOrigin(request, existing.targets);
			this.persistSteering();
			return;
		}
		const capacityReached = pendingSteeringRequestCount(projection) >= MAX_PENDING_STEERING_REQUESTS;
		const targets = this.requestedIndexes(request).map((index) => this.steeringTarget(index, capacityReached));
		const steeringRequest: Parameters<typeof recordSteeringRequest>[1] = {
			id: request.id,
			requestedAt: request.ts,
			message: request.message,
			targets,
		};
		if (request.source !== undefined) steeringRequest.source = request.source;
		recordSteeringRequest(projection, steeringRequest);
		for (const target of targets) {
			if (target.state === "routed") this.routeSteering(request, target.index);
		}
		const recorded = findSteeringRequest(projection, request.id);
		if (recorded) this.acceptUserOrigin(request, recorded.targets);
		this.persistSteering();
	}

	onSteerAck(ack: SteerAck): "retain" | undefined {
		const state = ack.state === "delivered" ? "delivered" : "failed";
		const projection = steeringStatus(this.status);
		const prior = findSteeringRequest(projection, ack.requestId)?.targets.find(
			(target) => target.index === ack.index,
		);
		if (!prior) return "retain";
		const alreadyApplied = prior.state === state;
		updateSteeringTarget(projection, ack.requestId, ack.index, state, ack.ts, { reason: ack.message });
		if (!alreadyApplied) {
			appendDiagnosticEvent(this.eventsPath, {
				type: ack.state === "delivered" ? "subagent.steer.delivered" : "subagent.steer.failed",
				ts: ack.ts,
				runId: this.config.id,
				requestId: ack.requestId,
				index: ack.index,
				message: ack.message,
			});
		}
		this.persistSteering();
		return undefined;
	}
}
