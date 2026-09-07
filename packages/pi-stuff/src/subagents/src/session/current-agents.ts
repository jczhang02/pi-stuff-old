import { isRuntimeBoolean } from "../../../shared/runtime-type.ts";
import {
	type AgentRow,
	type AgentSessionSnapshot,
	type AgentStatus,
	type CurrentAgentsState,
	freezeCurrentAgentRows,
	isResumableAgentStatus,
	isTerminalAgentStatus,
	projectCurrentAgentRows,
	semanticSnapshotKey,
} from "./current-agents-projection.ts";

export type {
	AgentNestedDetail,
	AgentRow,
	AgentSessionSnapshot,
	AgentStatus,
	AgentTranscriptTarget,
} from "./current-agents-projection.ts";

export type AgentControlAction =
	| { readonly type: "inspect"; readonly key: string }
	| { readonly type: "stop"; readonly key: string }
	| { readonly type: "steer"; readonly key: string; readonly message: string }
	| { readonly type: "resume"; readonly key: string; readonly message?: string };

export interface AgentControlResult {
	readonly type: AgentControlAction["type"];
	readonly key: string;
	readonly acknowledged: boolean;
	readonly message: string;
	readonly status: AgentStatus | null;
}

export type AgentControlAcknowledgement =
	| boolean
	| {
			readonly acknowledged: boolean;
			readonly message?: string;
			readonly status?: AgentStatus;
	  };

export interface CurrentAgentsOptions {
	readonly inspect: (row: AgentRow) => AgentControlAcknowledgement | Promise<AgentControlAcknowledgement>;
	readonly steer: (
		row: AgentRow,
		message: string,
	) => AgentControlAcknowledgement | Promise<AgentControlAcknowledgement>;
	readonly stop: (row: AgentRow) => AgentControlAcknowledgement | Promise<AgentControlAcknowledgement>;
	readonly resume: (
		row: AgentRow,
		message?: string,
	) => AgentControlAcknowledgement | Promise<AgentControlAcknowledgement>;
	readonly subscribeState?: (listener: () => void) => () => void;
	readonly now?: () => number;
}

export type CurrentAgentsView = Pick<CurrentAgents, "control" | "snapshot" | "subscribe">;

interface StatusOverride {
	readonly sourceStatus: AgentStatus;
	readonly status: AgentStatus;
}

function normalizeAcknowledgement(value: AgentControlAcknowledgement): Exclude<AgentControlAcknowledgement, boolean> {
	return isRuntimeBoolean(value) ? { acknowledged: value } : value;
}

function controlResult(
	action: AgentControlAction,
	acknowledged: boolean,
	message: string,
	status: AgentStatus | null,
): AgentControlResult {
	return Object.freeze({ type: action.type, key: action.key, acknowledged, message, status });
}

export class CurrentAgents {
	private disposed = false;
	private readonly listeners = new Set<(snapshot: AgentSessionSnapshot) => void>();
	private readonly now: () => number;
	private readonly options: CurrentAgentsOptions;
	private readonly overrides = new Map<string, StatusOverride>();
	private revision = 0;
	private semanticKey = "";
	private sessionId: string | null = null;
	private snapshotValue: AgentSessionSnapshot = Object.freeze({
		sessionId: null,
		revision: 0,
		rows: Object.freeze([]),
	});
	private readonly state: CurrentAgentsState;
	private readonly unsubscribe: Array<() => void> = [];

	constructor(state: CurrentAgentsState, options: CurrentAgentsOptions) {
		this.state = state;
		this.options = options;
		this.now = options.now ?? Date.now;
		this.rebuild(false);
		if (options.subscribeState) this.unsubscribe.push(options.subscribeState(() => this.rebuild(true)));
	}

	snapshot(): AgentSessionSnapshot {
		return this.snapshotValue;
	}

	subscribe(listener: (snapshot: AgentSessionSnapshot) => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		this.callListener(listener, this.snapshot());
		return () => this.listeners.delete(listener);
	}

	refresh(): void {
		this.rebuild(true);
	}

	async control(action: AgentControlAction): Promise<AgentControlResult> {
		if (this.disposed) return controlResult(action, false, "Current Agents is disposed.", null);
		const row = this.snapshot().rows.find((candidate) => candidate.key === action.key);
		if (!row)
			return controlResult(action, false, `Agent '${action.key}' is not available in the current session.`, null);

		const rejection = this.validateAction(action, row);
		if (rejection) return controlResult(action, false, rejection, row.status);

		let acknowledgement: Exclude<AgentControlAcknowledgement, boolean>;
		try {
			const raw = await this.invokeControl(action, row);
			acknowledgement = normalizeAcknowledgement(raw);
		} catch (error) {
			return controlResult(
				action,
				false,
				error instanceof Error ? error.message : String(error),
				this.snapshot().rows.find((candidate) => candidate.key === action.key)?.status ?? null,
			);
		}

		if (!acknowledgement.acknowledged) {
			return controlResult(
				action,
				false,
				acknowledgement.message ?? "The Agent did not acknowledge the request.",
				row.status,
			);
		}

		this.rebuild(false);
		const current = this.snapshotValue.rows.find((candidate) => candidate.key === action.key);
		if (current && action.type === "stop" && !isTerminalAgentStatus(current.status)) {
			this.overrides.set(action.key, {
				sourceStatus: current.status,
				status: acknowledgement.status ?? "stopping",
			});
		} else if (current && action.type === "resume" && isTerminalAgentStatus(current.status)) {
			this.overrides.set(action.key, {
				sourceStatus: current.status,
				status: acknowledgement.status ?? "resuming",
			});
		}
		this.rebuild(true);
		const status = this.snapshotValue.rows.find((candidate) => candidate.key === action.key)?.status ?? null;
		return controlResult(action, true, acknowledgement.message ?? "Acknowledged.", status);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribe.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// A stale upstream observer must not keep this projection alive.
			}
		}
		this.listeners.clear();
		this.overrides.clear();
	}

	private invokeControl(
		action: AgentControlAction,
		row: AgentRow,
	): AgentControlAcknowledgement | Promise<AgentControlAcknowledgement> {
		switch (action.type) {
			case "inspect":
				return this.options.inspect(row);
			case "steer":
				return this.options.steer(row, action.message.trim());
			case "stop":
				return this.options.stop(row);
			case "resume":
				return this.options.resume(row, action.message?.trim() || undefined);
		}
	}

	private validateAction(action: AgentControlAction, row: AgentRow): string | null {
		const terminal = isTerminalAgentStatus(row.status);
		switch (action.type) {
			case "inspect":
				return null;
			case "stop":
				return terminal || row.status === "stopping" ? `Agent '${row.key}' is not running.` : null;
			case "steer":
				if (!action.message.trim()) return "Steering requires a non-empty message.";
				return terminal || row.status === "stopping"
					? `Agent '${row.key}' cannot be steered in state '${row.status}'.`
					: null;
			case "resume":
				return isResumableAgentStatus(row.status)
					? null
					: `Agent '${row.key}' cannot be resumed from state '${row.status}'.`;
		}
	}

	private rebuild(notify: boolean): void {
		if (this.disposed) return;
		const currentSessionId = this.state.currentSessionId;
		if (currentSessionId !== this.sessionId) {
			this.sessionId = currentSessionId;
			this.overrides.clear();
		}

		const drafts = currentSessionId ? projectCurrentAgentRows(this.state, currentSessionId) : [];
		const liveKeys = new Set(drafts.map(({ key }) => key));
		for (const key of this.overrides.keys()) {
			if (!liveKeys.has(key)) this.overrides.delete(key);
		}
		for (const draft of drafts) {
			const override = this.overrides.get(draft.key);
			if (override && draft.status !== override.sourceStatus) {
				this.overrides.delete(draft.key);
			} else if (override) {
				draft.status = override.status;
			}
		}

		const rows = freezeCurrentAgentRows(drafts, this.now());
		const nextSemanticKey = semanticSnapshotKey(currentSessionId, rows);
		const changed = nextSemanticKey !== this.semanticKey;
		if (changed) this.revision += 1;
		this.semanticKey = nextSemanticKey;
		this.snapshotValue = Object.freeze({ sessionId: currentSessionId, revision: this.revision, rows });
		if (changed && notify) {
			for (const listener of Array.from(this.listeners)) this.callListener(listener, this.snapshotValue);
		}
	}

	private callListener(listener: (snapshot: AgentSessionSnapshot) => void, snapshot: AgentSessionSnapshot): void {
		try {
			listener(snapshot);
		} catch {
			// One renderer cannot prevent the other projections from updating.
		}
	}
}
