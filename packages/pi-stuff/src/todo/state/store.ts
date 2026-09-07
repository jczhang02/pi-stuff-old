import type { Task } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

/**
 * Per-session live state. Pre-refactor this was a single scalar `let state`
 * cell; it is now a Map partitioned by session id so a detached/child session
 * (distinct sid) can never read or clobber another session's tasks.
 *
 * The Map is the single mutation seam — only `commitState` / `replaceState` /
 * `evictSession` write it; the reducer (`state/state-reducer.ts`) stays pure.
 */
const sessions = new Map<string, TaskState>();

/**
 * Ctx-less render pointer: which slot does the above-editor widget render?
 * Set when the first UI session claims the foreground (see `index.ts`). This
 * is distinct from the task-state mutation seams and never writes task state.
 */
let activeRenderSession = "";

/**
 * Session-id extractor. Structural ctx type (no Pi-runtime import) —
 * mirrors `replay.ts`'s ctx shape so `state/` stays Pi-import-free. Returns
 * `… ?? ""` so an unknown/empty session resolves to a plain string key.
 */
export function sid(ctx: { sessionManager: { getSessionId(): string | undefined } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Fresh, non-aliasing EMPTY_STATE copy (never returns `EMPTY_STATE.tasks`). */
function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function numericIdFloor(tasks: readonly Task[]): number {
	let nextId = EMPTY_STATE.nextId;
	for (const task of tasks) {
		if (!/^[1-9]\d*$/.test(task.id)) continue;
		const id = Number(task.id);
		if (Number.isSafeInteger(id)) nextId = Math.max(nextId, id + 1);
	}
	return nextId;
}

/** Preserve the session-local id high-water mark across commits and branch replay. */
function withMonotonicNextId(sessionId: string, next: TaskState): TaskState {
	const currentNextId = sessions.get(sessionId)?.nextId ?? EMPTY_STATE.nextId;
	const candidateNextId = Number.isSafeInteger(next.nextId) ? next.nextId : EMPTY_STATE.nextId;
	const nextId = Math.max(EMPTY_STATE.nextId, currentNextId, candidateNextId, numericIdFloor(next.tasks));
	return nextId === next.nextId ? next : { tasks: next.tasks, nextId };
}

/** Get-or-read a session's slot: the committed slot by identity, or a fresh
 * EMPTY_STATE copy (not stored) when the slot is absent. */
function slotFor(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	return slotFor(sessionId);
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot, keyed to the session.
 */
export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, withMonotonicNextId(sessionId, next));
}

/**
 * Post-reducer commit seam. Tool `execute()` calls this with the reducer's
 * `state` output to publish the new canonical state to live readers, keyed to
 * the calling session.
 */
export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, withMonotonicNextId(sessionId, next));
}

/** Drop a session's slot on `session_shutdown`. No-op if the slot is absent. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/**
 * Ctx-less render reader: the slot rendered by the above-editor widget.
 * Resolves to the `activeRenderSession` slot, or a fresh EMPTY_STATE copy when
 * no foreground has been set yet.
 */
export function getRenderState(): TaskState {
	return slotFor(activeRenderSession);
}

/** Set the ctx-less render pointer when the first UI session claims foreground. */
export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

/**
 * Reads the foreground render pointer: the session ID used by the lifecycle
 * gate and the slot resolved by `getRenderState()`.
 */
export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/**
 * Foreground teardown (session_shutdown of the foreground session). Resets the
 * pointer to "" so the next `hasUI` session_start reclaims the foreground.
 */
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

/**
 * Test-only reset. Clears both the session map and foreground render pointer.
 */
export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
}
