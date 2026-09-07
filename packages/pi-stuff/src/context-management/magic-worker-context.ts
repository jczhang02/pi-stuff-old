import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MagicContextExtensionContext } from "./magic-context-types.ts";
import {
	MAGIC_WORKER_SYNC_BUFFER_BYTES,
	type MagicWorkerContextSnapshot,
	type MagicWorkerEffect,
	type MagicWorkerInvocationRequest,
	type MagicWorkerMessage,
	type MagicWorkerSessionEntryRequest,
	type MagicWorkerSessionSnapshotRequest,
	type MagicWorkerSyncEffectMessage,
} from "./magic-worker-protocol.ts";

interface MirroredSession {
	readonly entries: SessionEntry[];
	readonly entriesById: Map<string, SessionEntry>;
	readonly indexesById: Map<string, number>;
	leafId: string | undefined;
}

export class MagicWorkerContextStore {
	private readonly effectSession = new AsyncLocalStorage<string | null>();
	private readonly send: (message: MagicWorkerMessage) => void;
	private readonly sessions = new Map<string, MirroredSession>();

	constructor(send: (message: MagicWorkerMessage) => void) {
		this.send = send;
	}

	replaceSession(snapshot: MagicWorkerSessionSnapshotRequest): void {
		const entries = [...snapshot.branch];
		const entriesById = new Map<string, SessionEntry>();
		const indexesById = new Map<string, number>();
		for (const [index, entry] of entries.entries()) {
			const id = entry.id;
			entriesById.set(id, entry);
			indexesById.set(id, index);
		}
		this.sessions.set(snapshot.sessionId, { entries, entriesById, indexesById, leafId: snapshot.leafId });
	}

	updateSession(request: MagicWorkerSessionEntryRequest): void {
		const state = this.sessions.get(request.sessionId) ?? {
			entries: [],
			entriesById: new Map<string, SessionEntry>(),
			indexesById: new Map<string, number>(),
			leafId: undefined,
		};
		const id = request.entry.id;
		const index = state.indexesById.get(id);
		if (index === undefined) {
			state.indexesById.set(id, state.entries.length);
			state.entries.push(request.entry);
		} else {
			state.entries[index] = request.entry;
		}
		state.entriesById.set(id, request.entry);
		state.leafId = request.leafId;
		this.sessions.set(request.sessionId, state);
	}

	deleteSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	sendEffect(effect: MagicWorkerEffect): void {
		const sessionId = this.effectSession.getStore();
		if (sessionId === undefined) {
			throw new Error("Magic Context emitted a Host effect outside a Worker invocation.");
		}
		this.send({ ...effect, sessionId: sessionId ?? undefined, type: "effect" });
	}

	run<Result>(
		request: MagicWorkerInvocationRequest,
		controller: AbortController,
		operation: (ctx: MagicContextExtensionContext) => Promise<Result>,
	): Promise<Result> {
		controller.signal.throwIfAborted();
		return this.effectSession.run(request.context.session.id ?? null, () =>
			operation(this.contextFor(request.context, controller)),
		);
	}

	private syncHostCall(
		args: Parameters<SessionManager["appendCompaction"]>,
		snapshot: MagicWorkerContextSnapshot,
	): string {
		const buffer = new SharedArrayBuffer(MAGIC_WORKER_SYNC_BUFFER_BYTES);
		const control = new Int32Array(buffer, 0, 2);
		const message: MagicWorkerSyncEffectMessage = {
			args,
			buffer,
			name: "appendCompaction",
			sessionId: snapshot.session.id,
			type: "sync-effect",
		};
		this.send(message);
		const wait = Atomics.wait(control, 0, 0, 30_000);
		if (wait === "timed-out") {
			throw new Error("Pi Host did not complete Magic Context appendCompaction within 30 seconds.");
		}
		const capacity = buffer.byteLength - Int32Array.BYTES_PER_ELEMENT * 2;
		const length = Math.max(0, Math.min(Atomics.load(control, 1), capacity));
		const bytes = new Uint8Array(buffer, Int32Array.BYTES_PER_ELEMENT * 2, length);
		const response = new TextDecoder().decode(bytes);
		if (Atomics.load(control, 0) !== 1) {
			throw new Error(response || "Pi Host rejected Magic Context appendCompaction.");
		}
		return response;
	}

	private contextFor(snapshot: MagicWorkerContextSnapshot, controller: AbortController): MagicContextExtensionContext {
		const currentSession = () => (snapshot.session.id ? this.sessions.get(snapshot.session.id) : undefined);
		const sessionManager: MagicContextExtensionContext["sessionManager"] = {
			appendCompaction: (...args) => this.syncHostCall(args, snapshot),
			getBranch: () => currentSession()?.entries ?? [],
			getEntry: (id) => currentSession()?.entriesById.get(id),
			getLeafId: () => currentSession()?.leafId ?? snapshot.session.leafId ?? null,
			getSessionId: () => snapshot.session.id ?? "",
		};
		const ui: MagicContextExtensionContext["ui"] = {
			custom: async () => {
				throw new Error("Magic Context interactive UI is unavailable inside its isolated engine.");
			},
			notify: (...args) => this.sendEffect({ args, name: "notify" }),
			setStatus: (...args) => this.sendEffect({ args, name: "setStatus" }),
		};
		return {
			cwd: snapshot.cwd,
			getContextUsage: () => snapshot.contextUsage,
			getSystemPrompt: () => snapshot.systemPrompt,
			hasUI: snapshot.hasUI,
			mode: snapshot.mode,
			model: snapshot.model,
			sessionManager,
			signal: controller.signal,
			ui,
		};
	}
}
