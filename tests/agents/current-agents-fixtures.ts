import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAsyncJobTracker as createOwnedAsyncJobTracker } from "../../packages/pi-stuff/src/subagents/src/runs/background/async-job-tracker.js";
import {
	type AgentControlAcknowledgement,
	type AgentRow,
	CurrentAgents,
	type CurrentAgentsOptions,
} from "../../packages/pi-stuff/src/subagents/src/session/current-agents.js";
import type {
	AsyncJobState,
	ForegroundResumeRun,
	ForegroundRunControl,
	ProcessTerminalV1,
	SubagentState,
} from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
} from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { createTestAgentEffectOwner } from "./agent-effect-owner-fixture.js";

type StateInput = Pick<
	SubagentState,
	"currentSessionId" | "asyncJobs" | "recentAgentJobs" | "foregroundControls" | "foregroundRuns"
>;
type EventPayload = Parameters<ExtensionAPI["events"]["emit"]>[1];
type EventObserver = (event: string, payload: EventPayload) => void;

interface SignalChannel {
	emit(): void;
	readonly size: number;
	subscribe(listener: () => void): () => void;
}

function signalChannel(): SignalChannel {
	const listeners = new Set<() => void>();
	return {
		emit() {
			for (const listener of Array.from(listeners)) listener();
		},
		get size() {
			return listeners.size;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function eventHost(emit: EventObserver = () => {}): Pick<ExtensionAPI, "events"> {
	const events = createEventBus();
	return {
		events: {
			emit(event, payload) {
				emit(event, payload);
				events.emit(event, payload);
			},
			on: events.on,
		},
	};
}

function createState(sessionId = "root-session"): StateInput {
	return {
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
	};
}

function createFullState(sessionId: string): SubagentState {
	return {
		baseCwd: "",
		completionSeen: new Map(),
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		lastForegroundControlId: null,
		lastUiContext: null,
		recentAgentJobs: new Map(),
	};
}

function createAsyncJobTracker(
	pi: Parameters<typeof createOwnedAsyncJobTracker>[0],
	state: Parameters<typeof createOwnedAsyncJobTracker>[1],
	asyncDirRoot: string,
	options: Omit<Parameters<typeof createOwnedAsyncJobTracker>[3], "effects"> = {},
) {
	return createOwnedAsyncJobTracker(pi, state, asyncDirRoot, {
		...options,
		effects: createTestAgentEffectOwner(),
	});
}

function asyncJob(id: string, status: AsyncJobState["status"], overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: id,
		asyncDir: `/tmp/${id}`,
		status,
		sessionId: "root-session",
		agents: [id],
		startedAt: 1_000,
		updatedAt: 2_000,
		...overrides,
	};
}

function signalledProcessTerminal(
	runId: string,
	signal: string | null,
	terminationOrigin?: "external" | "manager-final-drain" | "manager-request",
	exitCode: number | null = null,
): ProcessTerminalV1 {
	const instance: Extract<ProcessTerminalV1, { state: "observed" }>["instances"][number] = {
		kind: "pi-writer",
		processInstanceId: `${runId}-writer`,
		attempt: 0,
		closeObservedAt: 2_000,
		exitCode,
		signal,
	};
	if (terminationOrigin) Object.assign(instance, { terminationOrigin });
	return {
		version: 1,
		state: "observed",
		runId,
		childIndex: 0,
		runnerProcessInstanceId: `${runId}-runner`,
		observedAt: 2_000,
		instances: [instance],
	};
}

function foregroundControl(overrides: Partial<ForegroundRunControl> = {}): ForegroundRunControl {
	return {
		runId: "foreground",
		sessionId: "root-session",
		mode: "parallel",
		startedAt: 1_000,
		updatedAt: 2_000,
		currentAgent: "worker",
		currentIndex: 0,
		activeChildren: new Map(),
		...overrides,
	};
}

function foregroundRun(overrides: Partial<ForegroundResumeRun> = {}): ForegroundResumeRun {
	return {
		runId: "foreground",
		sessionId: "root-session",
		mode: "single",
		cwd: "/repo",
		updatedAt: 3_000,
		children: [],
		...overrides,
	};
}

function acknowledgedOptions(overrides: Partial<CurrentAgentsOptions> = {}): CurrentAgentsOptions {
	const acknowledged = (): AgentControlAcknowledgement => true;
	return {
		inspect: acknowledged,
		steer: acknowledged,
		stop: acknowledged,
		resume: acknowledged,
		now: () => 5_000,
		...overrides,
	};
}

function row(snapshot: ReturnType<CurrentAgents["snapshot"]>, key: string): AgentRow {
	const result = snapshot.rows.find((candidate) => candidate.key === key);
	if (!result) throw new Error(`Expected row ${key}`);
	return result;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for Agent lifecycle condition");
}

export type { AsyncJobState, ProcessTerminalV1 };
export {
	acknowledgedOptions,
	asyncJob,
	CurrentAgents,
	createAsyncJobTracker,
	createFullState,
	createState,
	eventHost,
	foregroundControl,
	foregroundRun,
	fs,
	os,
	path,
	row,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
	signalChannel,
	signalledProcessTerminal,
	waitUntil,
};
