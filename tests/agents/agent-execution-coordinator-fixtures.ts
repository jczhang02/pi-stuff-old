import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeWriterProcessRegistry,
	writerProcessRegistryPath,
} from "../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.js";
import { recordForegroundOwnerExit } from "../../packages/pi-stuff/src/subagents/src/runs/foreground/owner-exit.js";
import {
	type AgentExecutionCoordinatorOptions,
	type AgentExecutionCoordinatorSession,
	type AgentExecutionGovernorPort,
	AgentExecutionCoordinator as ProductionAgentExecutionCoordinator,
	parseAgentOwnerPath,
	runtimeCompletionAddresses,
} from "../../packages/pi-stuff/src/subagents/src/runtime/agent-execution-coordinator.js";
import type {
	AgentExecutionReservation,
	AgentExecutionReservationResult,
	AgentExecutionSettlement,
	AgentRuntimeCompletionEvent,
	AgentRuntimeCompletionResult,
	ReserveAgentResumeInput,
	ReserveAgentSpawnInput,
} from "../../packages/pi-stuff/src/subagents/src/runtime/agent-execution-governor.js";
import {
	createDurableAgentExecutionCoordinator as createProductionDurableAgentExecutionCoordinator,
	type DurableAgentExecutionCoordinatorOptions,
} from "../../packages/pi-stuff/src/subagents/src/runtime/durable-agent-execution-coordinator.js";
import {
	type AgentGovernorLease,
	type RebindAgentRuntimeRequest,
	SessionAgentGovernor,
	type SessionGovernorRebindResult,
} from "../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";
import { createTestAgentEffectOwner } from "./agent-effect-owner-fixture.js";

class AgentExecutionCoordinator extends ProductionAgentExecutionCoordinator {
	constructor(options: Omit<AgentExecutionCoordinatorOptions, "effects">) {
		super({ ...options, effects: createTestAgentEffectOwner() });
	}
}

function createDurableAgentExecutionCoordinator(
	options: Omit<DurableAgentExecutionCoordinatorOptions, "effects">,
): ProductionAgentExecutionCoordinator {
	return createProductionDurableAgentExecutionCoordinator({
		...options,
		effects: createTestAgentEffectOwner(),
	});
}

interface RebindCall {
	readonly reservation: AgentExecutionReservation;
	readonly reservationIndex: number;
	readonly request: RebindAgentRuntimeRequest;
}

class RecordingGovernor implements AgentExecutionGovernorPort {
	readonly completions: AgentRuntimeCompletionEvent[] = [];
	readonly rebinds: RebindCall[] = [];
	readonly resumeReservations: ReserveAgentResumeInput[] = [];
	readonly settlements: Array<{ reservation: AgentExecutionReservation; settlement: AgentExecutionSettlement }> = [];
	readonly spawnReservations: ReserveAgentSpawnInput[] = [];
	completionResults: AgentRuntimeCompletionResult[] = [];
	rebindFailures = 0;
	rebindRejected = false;
	settlementFailures = 0;
	completionFailures = 0;
	runtimeLease: AgentGovernorLease | undefined;

	async reserveSpawn(input: ReserveAgentSpawnInput): Promise<AgentExecutionReservationResult> {
		this.spawnReservations.push(input);
		return {
			ok: true,
			reservation: reservation("spawn", input.launchRunId, input.launchRunId, input.childCount),
		};
	}

	async reserveResume(input: ReserveAgentResumeInput): Promise<AgentExecutionReservationResult> {
		this.resumeReservations.push(input);
		return {
			ok: true,
			reservation: reservation("resume", input.launchRunId, input.targetRunId, 1, input.childIndex),
		};
	}

	async rebindChild(
		reservationValue: AgentExecutionReservation,
		reservationIndex: number,
		request: RebindAgentRuntimeRequest,
	): Promise<SessionGovernorRebindResult> {
		this.rebinds.push({ reservation: reservationValue, reservationIndex, request });
		if (this.rebindFailures > 0) {
			this.rebindFailures -= 1;
			throw Object.assign(new Error("injected rebind EIO"), { code: "EIO" });
		}
		if (this.rebindRejected) return { rebound: false, reason: "ownership_changed", snapshot: snapshot() };
		const lease = reservationValue.leases[reservationIndex];
		if (!lease) throw new Error("Missing test lease");
		return {
			rebound: true,
			lease: {
				...lease,
				runtimeRunId: request.runtimeRunId ?? lease.runtimeRunId,
				childIndex: request.childIndex ?? lease.childIndex,
				pid: request.pid ?? lease.pid,
			},
			snapshot: snapshot(),
		};
	}

	async settle(
		reservationValue: AgentExecutionReservation,
		settlement: AgentExecutionSettlement,
	): Promise<{ releasedCount: number; alreadyReleasedCount: number; retainedCount: number }> {
		this.settlements.push({ reservation: reservationValue, settlement });
		if (this.settlementFailures > 0) {
			this.settlementFailures -= 1;
			throw Object.assign(new Error("injected settlement EIO"), { code: "EIO" });
		}
		const releasedCount =
			settlement.kind === "start-error"
				? reservationValue.leases.length
				: settlement.kind === "foreground"
					? new Set(settlement.terminalChildIndexes).size
					: 0;
		return {
			releasedCount,
			alreadyReleasedCount: 0,
			retainedCount: reservationValue.leases.length - releasedCount,
		};
	}

	async completeRuntime(event: AgentRuntimeCompletionEvent): Promise<AgentRuntimeCompletionResult> {
		this.completions.push(event);
		if (this.completionFailures > 0) {
			this.completionFailures -= 1;
			throw Object.assign(new Error("injected completion EIO"), { code: "EIO" });
		}
		return this.completionResults.shift() ?? { released: true, logicalAgentId: `${event.runtimeRunId}:done` };
	}

	async findRuntimeLease(): Promise<AgentGovernorLease | undefined> {
		return this.runtimeLease;
	}
}

function lease(logicalRunId: string, index: number, runtimeRunId: string, runtimeIndex = index): AgentGovernorLease {
	return {
		sessionId: "session",
		logicalAgentId: `${logicalRunId}:${index}`,
		runtimeRunId,
		childIndex: runtimeIndex,
		leaseId: `lease-${logicalRunId}-${index}`,
		ownerAgentPath: [],
		agentPath: [`${logicalRunId}:${index}`],
		pid: 1,
		mode: "spawn",
		acquiredAtMs: 1,
	};
}

function reservation(
	kind: "spawn" | "resume",
	launchRunId: string,
	logicalRunId: string,
	count: number,
	logicalStartIndex = 0,
): AgentExecutionReservation {
	return {
		kind,
		launchRunId,
		logicalRunId,
		leases: Array.from({ length: count }, (_, offset) =>
			lease(logicalRunId, logicalStartIndex + offset, launchRunId, logicalStartIndex + offset),
		),
	};
}

function snapshot() {
	return {
		sessionId: "session",
		limits: { maxDepth: 3, maxRunning: 20, maxTotal: Number.MAX_SAFE_INTEGER },
		effectiveLimits: { maxDepth: 3, maxRunning: 20, maxTotal: Number.MAX_SAFE_INTEGER },
		ownerAgentPath: [],
		total: 0,
		running: 0,
		agents: [],
		leases: [],
	};
}

function harness() {
	const governor = new RecordingGovernor();
	const identities: Array<{ sessionId: string; ownerAgentPath: readonly string[] }> = [];
	const reconciled: Array<Array<boolean | undefined>> = [];
	const coordinator = new AgentExecutionCoordinator({
		createSession: (identity): AgentExecutionCoordinatorSession => {
			identities.push(identity);
			return {
				governor,
				reconcile: async (isPidAlive) => {
					reconciled.push([
						isPidAlive(11, lease("probe", 0, "probe", 0)),
						isPidAlive(12, lease("probe", 1, "probe", 1)),
						isPidAlive(13, lease("probe", 2, "probe", 2)),
					]);
				},
			};
		},
		isPidAlive: (pid) => (pid === 11 ? false : pid === 12 ? true : undefined),
	});
	return { coordinator, governor, identities, reconciled };
}

export {
	AgentExecutionCoordinator,
	createDurableAgentExecutionCoordinator,
	existsSync,
	harness,
	initializeWriterProcessRegistry,
	join,
	lease,
	mkdir,
	mkdtemp,
	parseAgentOwnerPath,
	RecordingGovernor,
	recordForegroundOwnerExit,
	rm,
	runtimeCompletionAddresses,
	SessionAgentGovernor,
	tmpdir,
	writeFile,
	writerProcessRegistryPath,
};
