import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHostSharedResource } from "../shared/host-resource.ts";
import { isRuntimeNumber } from "../shared/runtime-type.ts";
import { globalWeakMap } from "./global-registry.ts";

export interface CodexStatusSnapshot {
	readonly fastEnabled: boolean;
	readonly weeklyRemainingPercent?: number;
}

export interface CodexStatusSource {
	getSnapshot(): CodexStatusSnapshot;
	subscribe(listener: () => void): () => void;
}

export interface CodexStatusChannel {
	readonly source: CodexStatusSource;
	clear(): void;
	publish(snapshot: CodexStatusSnapshot): void;
}

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export interface GoalStatusSnapshot {
	readonly activeStartedAt?: number;
	readonly status: GoalStatus;
	readonly timeUsedSeconds: number;
	readonly tokenBudget?: number;
	readonly tokensUsed: number;
}

export interface GoalStatusSource {
	getSnapshot(): GoalStatusSnapshot | undefined;
	subscribe(listener: () => void): () => void;
}

export interface GoalStatusChannel {
	readonly source: GoalStatusSource;
	clear(): void;
	publish(snapshot: GoalStatusSnapshot): void;
}

export type ContextStatus = "recovering" | "validated" | "unknown";

export interface ContextStatusSnapshot {
	readonly state: ContextStatus;
	readonly phase?: "compacting" | "restarting" | "projecting";
	readonly tokens?: number;
	readonly contextWindow?: number;
}

export interface ContextStatusSource {
	getSnapshot(): ContextStatusSnapshot | undefined;
	subscribe(listener: () => void): () => void;
}

export interface ContextStatusChannel {
	readonly source: ContextStatusSource;
	clear(): void;
	publish(snapshot: ContextStatusSnapshot): void;
}

const CODEX_STATUS_CHANNELS = Symbol.for("@jczhang02/pi-stuff-ui/codex-status-channels/v1");
const GOAL_STATUS_CHANNELS = Symbol.for("@jczhang02/pi-stuff-ui/goal-status-channels/v1");
const CONTEXT_STATUS_CHANNELS = Symbol.for("@jczhang02/pi-stuff-ui/context-status-channels/v1");
const CODEX_STATUS_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/codex-status-discovery/v1";
const GOAL_STATUS_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/goal-status-discovery/v1";
const CONTEXT_STATUS_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/context-status-discovery/v1";
const REJECTED_STATUS = Symbol("rejected status");

type StatusChannelHost = Pick<ExtensionAPI, "events"> & Partial<Pick<ExtensionAPI, "on">>;

class SharedStatusChannel<Input, Snapshot> {
	private readonly initialSnapshot: () => Snapshot;
	private readonly listeners = new Set<() => void>();
	private readonly normalize: (input: Input) => Snapshot | typeof REJECTED_STATUS;
	private snapshot: Snapshot;
	readonly source = this;

	constructor(initialSnapshot: () => Snapshot, normalize: (input: Input) => Snapshot | typeof REJECTED_STATUS) {
		this.initialSnapshot = initialSnapshot;
		this.normalize = normalize;
		this.snapshot = initialSnapshot();
	}

	clear(): void {
		this.setSnapshot(this.initialSnapshot());
	}

	getSnapshot(): Snapshot {
		return this.snapshot;
	}

	publish(input: Input): void {
		const next = this.normalize(input);
		if (next !== REJECTED_STATUS) this.setSnapshot(next);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setSnapshot(next: Snapshot): void {
		if (JSON.stringify(this.snapshot) === JSON.stringify(next)) return;
		this.snapshot = next;
		for (const listener of this.listeners) callObserver(listener);
	}
}

function normalizeCodexStatus(snapshot: CodexStatusSnapshot): CodexStatusSnapshot {
	const next: CodexStatusSnapshot = { fastEnabled: snapshot.fastEnabled === true };
	if (isRuntimeNumber(snapshot.weeklyRemainingPercent) && Number.isFinite(snapshot.weeklyRemainingPercent)) {
		Object.assign(next, { weeklyRemainingPercent: snapshot.weeklyRemainingPercent });
	}
	return next;
}

function normalizeGoalStatus(snapshot: GoalStatusSnapshot): GoalStatusSnapshot | typeof REJECTED_STATUS {
	if (!isGoalStatus(snapshot.status)) return REJECTED_STATUS;
	const next: GoalStatusSnapshot = {
		status: snapshot.status,
		timeUsedSeconds: finiteNonNegative(snapshot.timeUsedSeconds),
		tokensUsed: finiteNonNegative(snapshot.tokensUsed),
	};
	const activeStartedAt = snapshot.status === "active" ? finitePositive(snapshot.activeStartedAt) : undefined;
	const tokenBudget = finitePositive(snapshot.tokenBudget);
	if (activeStartedAt !== undefined) Object.assign(next, { activeStartedAt });
	if (tokenBudget !== undefined) Object.assign(next, { tokenBudget });
	return next;
}

function normalizeContextStatus(snapshot: ContextStatusSnapshot): ContextStatusSnapshot | typeof REJECTED_STATUS {
	if (!["recovering", "validated", "unknown"].includes(snapshot.state)) return REJECTED_STATUS;
	const next: ContextStatusSnapshot = { state: snapshot.state };
	if (snapshot.state === "recovering" && ["compacting", "restarting", "projecting"].includes(snapshot.phase ?? ""))
		Object.assign(next, { phase: snapshot.phase });
	if (isRuntimeNumber(snapshot.tokens) && Number.isFinite(snapshot.tokens) && snapshot.tokens >= 0) {
		Object.assign(next, { tokens: snapshot.tokens });
	}
	if (
		isRuntimeNumber(snapshot.contextWindow) &&
		Number.isFinite(snapshot.contextWindow) &&
		snapshot.contextWindow > 0
	) {
		Object.assign(next, { contextWindow: snapshot.contextWindow });
	}
	return next;
}

function finiteNonNegative(value: number): number {
	return isRuntimeNumber(value) && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finitePositive(value: number | undefined): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isGoalStatus(value: string): value is GoalStatus {
	return ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(value);
}

function callObserver(observer: () => void): void {
	try {
		observer();
	} catch {
		// Shared presentation channels isolate observer failures.
	}
}

function getStatusChannel<Channel extends object>(
	pi: StatusChannelHost,
	key: symbol,
	discoveryEvent: string,
	create: () => Channel,
): Channel {
	const channels = globalWeakMap<Channel>(key);
	return getHostSharedResource(pi.events, channels, discoveryEvent, create, {
		registerOwnerCleanup: (cleanup) => pi.on?.("session_shutdown", cleanup),
	});
}

/** Share one late-bindable Codex presentation channel across Capability copies. */
export function getCodexStatusChannel(pi: StatusChannelHost): CodexStatusChannel {
	return getStatusChannel(
		pi,
		CODEX_STATUS_CHANNELS,
		CODEX_STATUS_DISCOVERY_EVENT,
		() =>
			new SharedStatusChannel<CodexStatusSnapshot, CodexStatusSnapshot>(
				() => ({ fastEnabled: false }),
				normalizeCodexStatus,
			),
	);
}

/** Share one observation-only Goal presentation channel across Capability copies. */
export function getGoalStatusChannel(pi: StatusChannelHost): GoalStatusChannel {
	return getStatusChannel(
		pi,
		GOAL_STATUS_CHANNELS,
		GOAL_STATUS_DISCOVERY_EVENT,
		() =>
			new SharedStatusChannel<GoalStatusSnapshot, GoalStatusSnapshot | undefined>(
				() => undefined,
				normalizeGoalStatus,
			),
	);
}

export function getContextStatusChannel(pi: StatusChannelHost): ContextStatusChannel {
	return getStatusChannel(
		pi,
		CONTEXT_STATUS_CHANNELS,
		CONTEXT_STATUS_DISCOVERY_EVENT,
		() =>
			new SharedStatusChannel<ContextStatusSnapshot, ContextStatusSnapshot | undefined>(
				() => undefined,
				normalizeContextStatus,
			),
	);
}
