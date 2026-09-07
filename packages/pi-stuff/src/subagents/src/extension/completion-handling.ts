import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type CommandDialogCoordinator,
	listenForPendingGoalResultQueries,
	readGoalCoordination,
	sendSuiteAgentMessage,
	withAgentWorkOrigin,
} from "../../../conversation-ui/index.js";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.js";
import { CachedToolRow } from "../../../tool-display/index.js";
import type { CompletionNotification } from "../runs/background/notify.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { sessionArtifactMatches } from "../shared/session-identity.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../shared/types.ts";

import {
	type CompletionOutcomeEntry,
	completionKey,
	completionMessage,
	completionOutcome,
	completionOutcomeText,
} from "./completion-projection.ts";

const COMPLETION_MESSAGE_TYPE = "pi-stuff-agent-complete";
const COMPLETION_ENTRY_TYPE = "pi-stuff-agent-outcome";
const CONTINUATION_ENTRY_TYPE = "pi-stuff-agent-continuation";

export interface CompactCompletionNotifier {
	deliver(result: CompletionNotification, signal?: AbortSignal): Promise<boolean>;
	endRun(runId: string): void;
	reset(entries: readonly SessionEntry[]): void;
	dispose(): void;
}

interface PendingCompletion {
	submitted: boolean;
	observed: boolean;
	readonly key: string;
	readonly result: CompletionNotification;
	readonly signal: AbortSignal | undefined;
	readonly promise: Promise<boolean>;
	readonly resolve: (accepted: boolean) => void;
	readonly removeAbort: () => void;
}

type CompletionState = Pick<SubagentState, "currentSessionId" | "currentSessionScope" | "lastUiContext">;

/** Retain deliveries until the owning Host is idle; its follow-up queue survives abort. */
class CompletionNotifier implements CompactCompletionNotifier {
	private readonly delivered = new Set<string>();
	private readonly pending = new Map<string, PendingCompletion>();
	private readonly runs = new Map<string, string | null>();
	private readonly unsubscribe: Array<() => void>;
	private removeParentAbort = () => {};
	private cancelledBefore = 0;
	private epoch = 0;
	private disposed = false;
	private flushingEpoch: number | undefined;
	private readonly pi: ExtensionAPI;
	private readonly state: CompletionState;
	private readonly coordinator: Pick<CommandDialogCoordinator, "whenIdle">;

	constructor(pi: ExtensionAPI, state: CompletionState, coordinator: Pick<CommandDialogCoordinator, "whenIdle">) {
		this.pi = pi;
		this.state = state;
		this.coordinator = coordinator;
		this.unsubscribe = [
			listenForPendingGoalResultQueries(pi, () => this.pending.size > 0),
			pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (event) => {
				if (!isRuntimeObject(event) || event === null || Array.isArray(event)) return;
				const runId = "id" in event && isRuntimeString(event.id) ? event.id : undefined;
				const sessionId = "sessionId" in event && isRuntimeString(event.sessionId) ? event.sessionId : undefined;
				if (runId && sessionId) this.noteStarted(runId, sessionId);
			}),
		];
		pi.on("agent_start", (_event, ctx) => this.watchCancellation(ctx));
		pi.on("message_end", (event) => {
			if (event.message.role !== "custom" || event.message.customType !== COMPLETION_MESSAGE_TYPE) return;
			const details = event.message.details;
			if (!isRuntimeObject(details) || details === null || !("keys" in details) || !Array.isArray(details.keys))
				return;
			for (const key of details.keys) {
				const pending = isRuntimeString(key) ? this.pending.get(key) : undefined;
				if (pending?.submitted) pending.observed = true;
			}
		});
		pi.on("before_provider_request", () => {
			for (const pending of this.pending.values()) if (pending.observed) this.finish(pending.key, true);
		});
		pi.on("agent_settled", () => {
			for (const pending of this.pending.values()) {
				if (pending.submitted) this.finish(pending.key, pending.observed);
			}
			this.scheduleFlush();
		});
	}

	private owns(result: CompletionNotification): boolean {
		return (
			!this.disposed &&
			sessionArtifactMatches(this.state.currentSessionScope, result.sessionId, result.runId ?? result.id)
		);
	}

	private noteStarted(runId: string, sessionId: string): void {
		if (!this.owns({ id: runId, sessionId })) return;
		const goal = readGoalCoordination(this.pi);
		if (!goal.goalId) return;
		const persisted = this.persistContinuation({ version: 1, runId, goalId: goal.goalId });
		this.runs.set(runId, persisted ? goal.goalId : null);
	}

	private persistContinuation(data: Record<string, string | number | boolean>): boolean {
		try {
			this.pi.appendEntry(CONTINUATION_ENTRY_TYPE, data);
			return true;
		} catch (error) {
			reportAgentDiagnostic("Failed to persist Agent continuation authority:", error);
			return false;
		}
	}

	private watchCancellation(ctx: ExtensionContext): void {
		this.removeParentAbort();
		const signal = ctx.signal;
		const epoch = this.epoch;
		const cancel = () => {
			if (this.disposed || epoch !== this.epoch) return;
			this.cancelledBefore = Date.now();
			this.persistContinuation({ version: 1, cancelledBefore: this.cancelledBefore });
			this.scheduleFlush();
		};
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		this.removeParentAbort = () => signal?.removeEventListener("abort", cancel);
	}

	endRun(runId: string): void {
		if (this.disposed || this.runs.get(runId) === null) return;
		this.runs.set(runId, null);
		this.persistContinuation({ version: 1, runId, ended: true });
		this.scheduleFlush();
	}

	private mayContinue(result: CompletionNotification): boolean {
		const runId = result.runId ?? result.id ?? "";
		const goalId = this.runs.get(runId);
		if (goalId === null) return false;
		if (this.cancelledBefore > 0 && (result.startedAt ?? 0) <= this.cancelledBefore) return false;
		if (!goalId) return true;
		const goal = readGoalCoordination(this.pi);
		return goal.goalId === goalId && goal.continuationPermitted;
	}

	deliver(result: CompletionNotification, signal?: AbortSignal): Promise<boolean> {
		if (result.intercomDelivered === true) return Promise.resolve(true);
		if (!this.owns(result) || signal?.aborted) return Promise.resolve(false);
		const key = completionKey(result);
		if (this.delivered.has(key)) return Promise.resolve(true);
		const existing = this.pending.get(key);
		if (existing) return existing.promise;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const abort = () => this.finish(key, false);
		signal?.addEventListener("abort", abort, { once: true });
		this.pending.set(key, {
			submitted: false,
			observed: false,
			key,
			result,
			signal,
			promise,
			resolve,
			removeAbort: () => signal?.removeEventListener("abort", abort),
		});
		this.scheduleFlush();
		return promise;
	}

	private finish(key: string, accepted: boolean): void {
		const pending = this.pending.get(key);
		if (!pending) return;
		if (accepted) {
			if (pending.observed) this.delivered.add(key);
			try {
				this.pi.appendEntry(COMPLETION_ENTRY_TYPE, completionOutcome(pending.result, key));
				this.delivered.add(key);
			} catch (error) {
				reportAgentDiagnostic("Failed to persist the Agent completion row:", error);
				accepted = pending.observed;
			}
		}
		this.pending.delete(key);
		pending.removeAbort();
		pending.resolve(accepted);
	}

	private scheduleFlush(): void {
		if (
			this.disposed ||
			this.flushingEpoch === this.epoch ||
			![...this.pending.values()].some((item) => !item.submitted)
		)
			return;
		const epoch = this.epoch;
		this.flushingEpoch = epoch;
		void this.flush(epoch).finally(() => {
			if (this.flushingEpoch === epoch) this.flushingEpoch = undefined;
			if (epoch === this.epoch && this.state.lastUiContext?.isIdle()) this.scheduleFlush();
		});
	}

	private async flush(epoch: number): Promise<void> {
		let batch: PendingCompletion[] = [];
		try {
			await this.coordinator.whenIdle();
			if (this.disposed || epoch !== this.epoch) return;
			for (const pending of this.pending.values()) {
				if (!this.owns(pending.result) || pending.signal?.aborted) this.finish(pending.key, false);
				else if (!this.mayContinue(pending.result)) this.finish(pending.key, true);
			}
			if (!this.state.lastUiContext?.isIdle()) return;
			batch = [...this.pending.values()].filter((item) => !item.submitted).slice(0, 8);
			if (batch.length === 0) return;
			const current = () =>
				!this.disposed &&
				epoch === this.epoch &&
				batch.every((pending) => this.pending.has(pending.key) && this.mayContinue(pending.result));
			for (const pending of batch) pending.submitted = true;
			const accepted = await sendSuiteAgentMessage(
				this.pi,
				withAgentWorkOrigin(
					{
						customType: COMPLETION_MESSAGE_TYPE,
						content: batch
							.map(({ result }) => completionMessage(result, Math.floor(8_000 / batch.length)))
							.join("\n\n"),
						display: false,
						details: { keys: batch.map(({ key }) => key) },
					},
					batch.some(({ result }) => result.parentRunOrigin === "user") ? "user" : "automatic",
				),
				{ deliverAs: "followUp", triggerTurn: true },
				current,
				undefined,
				() => this.state.lastUiContext?.isIdle() === true,
			);
			if (!accepted) for (const pending of batch) pending.submitted = false;
		} catch {
			if (epoch === this.epoch)
				for (const pending of batch.length ? batch : this.pending.values()) this.finish(pending.key, false);
		}
	}

	reset(entries: readonly SessionEntry[]): void {
		this.epoch++;
		this.removeParentAbort();
		for (const key of this.pending.keys()) this.finish(key, false);
		this.delivered.clear();
		this.runs.clear();
		this.cancelledBefore = 0;
		for (const entry of entries) {
			if (entry.type === "custom_message" && entry.customType === COMPLETION_MESSAGE_TYPE) {
				const details = entry.details;
				if (isRuntimeObject(details) && details !== null && "keys" in details && Array.isArray(details.keys))
					for (const key of details.keys) if (isRuntimeString(key)) this.delivered.add(key);
			}
			if (entry.type !== "custom") continue;
			const data = entry.data;
			if (
				!isRuntimeObject(data) ||
				data === null ||
				Array.isArray(data) ||
				!("version" in data) ||
				data.version !== 1
			)
				continue;
			if (entry.customType === COMPLETION_ENTRY_TYPE && "key" in data && isRuntimeString(data.key))
				this.delivered.add(data.key);
			if (entry.customType !== CONTINUATION_ENTRY_TYPE) continue;
			if ("cancelledBefore" in data && isRuntimeNumber(data.cancelledBefore))
				this.cancelledBefore = data.cancelledBefore;
			if (!("runId" in data) || !isRuntimeString(data.runId)) continue;
			if ("ended" in data && data.ended === true) this.runs.set(data.runId, null);
			else if ("goalId" in data && isRuntimeString(data.goalId)) this.runs.set(data.runId, data.goalId);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.reset([]);
		for (const unsubscribe of this.unsubscribe) unsubscribe();
	}
}

/** Install durable completion delivery and legacy/current Session renderers. */
export function installCompletionHandling(
	pi: ExtensionAPI,
	state: CompletionState,
	coordinator: Pick<CommandDialogCoordinator, "whenIdle">,
): CompactCompletionNotifier {
	pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, _options, theme) => {
		const content = isRuntimeString(message.content) ? message.content : "";
		return new Text(theme.fg("text", content), 0, 0);
	});
	pi.registerEntryRenderer<CompletionOutcomeEntry>(COMPLETION_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.version !== 1) return undefined;
		return new CachedToolRow(theme, {
			active: false,
			expandable: false,
			hint: "",
			kind: "activity",
			outcome: data.status === "completed" ? "success" : data.status === "failed" ? "error" : "stopped",
			summary: completionOutcomeText(data),
		});
	});
	return new CompletionNotifier(pi, state, coordinator);
}
