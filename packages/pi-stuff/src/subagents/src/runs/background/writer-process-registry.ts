import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	runtimeErrorCode as errorCode,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {
	assertPrivateDirectory,
	readBoundedOwnedFile,
	readBoundedOwnedFileSnapshotAsync,
} from "../../shared/private-directory.ts";
import {
	identityBoundProcessLiveness,
	type ProcessIdentityGroupSnapshot,
	type ProcessKillFn,
	probeProcessLiveness,
	readProcessIdentityGroupSnapshot,
	readProcessStartIdentity,
	readProcessStartIdentityAsync,
} from "../../shared/process-identity.ts";

export { readProcessStartIdentity } from "../../shared/process-identity.ts";

const WRITER_PROCESS_REGISTRY_FILE = "writer-processes-live.json";
const MAX_WRITER_PROCESS_REGISTRY_BYTES = 1024 * 1024;

export type WriterRuntimeState =
	| { state: "none" | "spawning" }
	| {
			state: "running";
			pid: number;
			processStartIdentity?: string;
			groupMemberProofFile?: string;
	  };

interface PersistedWriterState {
	state: "none" | "spawning" | "running";
	pid?: number;
	processStartIdentity?: string;
	groupMemberProofFile?: string;
	terminationRequestedAt?: number;
	killRequestedAt?: number;
}

interface WriterProcessRegistry {
	version: 1;
	runId: string;
	runnerPid: number;
	runnerProcessStartIdentity?: string;
	writerStartupGate?: "parent-pipe-v1";
	writerProcessGroup?: "writer-pid-v1";
	updatedAt: number;
	writers: Record<string, PersistedWriterState>;
}

export function writerProcessRegistryPath(asyncDir: string): string {
	return path.join(asyncDir, WRITER_PROCESS_REGISTRY_FILE);
}

export function initializeWriterProcessRegistry(
	asyncDir: string,
	runId: string,
	runnerPid: number,
	childCount: number,
	runnerProcessStartIdentity = readProcessStartIdentity(runnerPid),
): void {
	const writers = Object.fromEntries(
		Array.from({ length: childCount }, (_, index) => [String(index), { state: "none" as const }]),
	);
	const registry: WriterProcessRegistry = {
		version: 1,
		runId,
		runnerPid,
		updatedAt: Date.now(),
		writers,
	};
	if (runnerProcessStartIdentity) registry.runnerProcessStartIdentity = runnerProcessStartIdentity;
	if (process.platform !== "win32") {
		registry.writerStartupGate = "parent-pipe-v1";
		registry.writerProcessGroup = "writer-pid-v1";
	}
	writePrivateAtomicJson(writerProcessRegistryPath(asyncDir), registry);
}

export function updateWriterProcessRegistry(asyncDir: string, index: number, state: WriterRuntimeState): void {
	if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("writer process index must be non-negative");
	const registry = readWriterProcessRegistry(asyncDir);
	if (!registry) throw new Error(`Writer process registry is unavailable for '${asyncDir}'.`);
	const startIdentity =
		state.state === "running" ? (state.processStartIdentity ?? readProcessStartIdentity(state.pid)) : undefined;
	if (state.state === "running" && supportsProcessStartIdentity() && !startIdentity) {
		throw new Error(`Cannot bind writer PID ${state.pid} without a stable process-start identity.`);
	}
	if (state.state === "running") {
		const writer: PersistedWriterState = { state: "running", pid: state.pid };
		if (startIdentity) writer.processStartIdentity = startIdentity;
		if (state.groupMemberProofFile) {
			const proofFile = safeProofFileName(state.groupMemberProofFile);
			if (proofFile) writer.groupMemberProofFile = proofFile;
		}
		registry.writers[String(index)] = writer;
	} else registry.writers[String(index)] = { state: state.state };
	registry.updatedAt = Date.now();
	writePrivateAtomicJson(writerProcessRegistryPath(asyncDir), registry);
}

/** `true`/`undefined` retain the governor lease; only explicit `false` permits reclamation. */
export function inspectWriterProcessLiveness(
	asyncDir: string,
	kill: ProcessKillFn = process.kill,
): boolean | undefined {
	const registryPath = writerProcessRegistryPath(asyncDir);
	if (!fs.existsSync(registryPath)) return undefined;
	const registry = readWriterProcessRegistry(asyncDir);
	if (!registry) return undefined;
	let unknown = false;
	for (const writer of Object.values(registry.writers)) {
		if (writer.state === "spawning") {
			// New writers wait on an inherited parent pipe before exec. Once the
			// runner is dead, EOF proves that a PID-less spawning record cannot turn
			// into a Pi writer. Legacy registries retain conservatively.
			if (registry.writerStartupGate !== "parent-pipe-v1") return true;
			continue;
		}
		if (writer.state !== "running" || writer.pid === undefined) continue;
		if (registry.writerProcessGroup === "writer-pid-v1") {
			const groupState = ownedWriterGroupLiveness(asyncDir, writer, kill);
			if (groupState === true) return true;
			if (groupState === undefined) unknown = true;
			continue;
		}
		const state = probeProcessLiveness(writer.pid, kill);
		if (state === false) continue;
		if (state === undefined) unknown = true;
		else {
			const identity = readProcessStartIdentity(writer.pid);
			if (writer.processStartIdentity && identity && identity !== writer.processStartIdentity) continue;
			if (!writer.processStartIdentity || !identity) unknown = true;
			else return true;
		}
	}
	return unknown ? undefined : false;
}

/** Host-side liveness inspection without synchronous runtime-file or process-identity reads. */
export function inspectWriterProcessLivenessEffect(
	asyncDir: string,
	kill: ProcessKillFn = process.kill,
): Effect.Effect<boolean | undefined> {
	return Effect.gen(function* () {
		const registry = yield* readWriterProcessRegistryEffect(asyncDir);
		if (!registry) return undefined;
		let unknown = false;
		for (const writer of Object.values(registry.writers)) {
			if (writer.state === "spawning") {
				if (registry.writerStartupGate !== "parent-pipe-v1") return true;
				continue;
			}
			if (writer.state !== "running" || writer.pid === undefined) continue;
			const pid = writer.pid;
			const alive =
				registry.writerProcessGroup === "writer-pid-v1"
					? probeProcessLiveness(-pid, kill)
					: probeProcessLiveness(pid, kill);
			if (alive === false) continue;
			if (alive === undefined || !writer.processStartIdentity) {
				unknown = true;
				continue;
			}
			const identity = yield* Effect.tryPromise({
				try: () => readProcessStartIdentityAsync(pid),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.succeed(undefined)));
			if (identity && identity !== writer.processStartIdentity) continue;
			if (!identity) unknown = true;
			else return true;
		}
		return unknown ? undefined : false;
	});
}

/** Liveness proof for one parallel child, used to release terminal siblings independently. */
export function inspectWriterChildProcessLiveness(
	asyncDir: string,
	index: number,
	kill: ProcessKillFn = process.kill,
): boolean | undefined {
	const registry = readWriterProcessRegistry(asyncDir);
	if (!registry) return undefined;
	const writer = registry.writers[String(index)];
	if (!writer || writer.state === "none") return false;
	if (writer.state === "spawning") return registry.writerStartupGate !== "parent-pipe-v1";
	if (writer.pid === undefined) return undefined;
	if (registry.writerProcessGroup === "writer-pid-v1") return ownedWriterGroupLiveness(asyncDir, writer, kill);
	const alive = probeProcessLiveness(writer.pid, kill);
	if (alive !== true) return alive;
	const identity = readProcessStartIdentity(writer.pid);
	if (writer.processStartIdentity && identity) return writer.processStartIdentity === identity;
	return undefined;
}

/** Kill writers orphaned by a dead runner. Unknown/unconfirmable writers remain recorded and counted. */
export function terminateOrphanWriterProcesses(asyncDir: string, kill: ProcessKillFn = process.kill, now = Date.now()) {
	const registryPath = writerProcessRegistryPath(asyncDir);
	if (!fs.existsSync(registryPath)) return { remaining: 1, terminated: 0 };
	const registry = readWriterProcessRegistry(asyncDir);
	if (!registry) return { remaining: 1, terminated: 0 };
	let changed = false;
	let remaining = 0;
	let terminated = 0;

	for (const [index, writer] of Object.entries(registry.writers)) {
		if (writer.state === "none") continue;
		if (writer.state === "spawning") {
			if (registry.writerStartupGate === "parent-pipe-v1") {
				registry.writers[index] = { state: "none" };
				changed = true;
			} else {
				// A legacy registry has no exec-gate proof, so an unbound writer PID
				// may already be running and must remain conservative.
				remaining += 1;
			}
			continue;
		}

		if (writer.pid === undefined) {
			remaining += 1;
			continue;
		}
		const groupOwned = registry.writerProcessGroup === "writer-pid-v1";
		const liveness = groupOwned
			? ownedWriterGroupLiveness(asyncDir, writer, kill)
			: ownedLegacyWriterLiveness(writer, kill);
		if (liveness === false) {
			registry.writers[index] = { state: "none" };
			changed = true;
			continue;
		}
		if (liveness === undefined) {
			remaining += 1;
			continue;
		}
		try {
			if (groupOwned) {
				const leaderLiveness = probeProcessLiveness(writer.pid, kill);
				const leaderIdentity = readProcessStartIdentity(writer.pid);
				if (leaderLiveness === true) {
					if (!writer.processStartIdentity || leaderIdentity !== writer.processStartIdentity) {
						// A transiently unreadable or mismatched leader identity cannot
						// authorize either a positive or group-wide signal.
						remaining += 1;
						continue;
					}
					const shouldNudge =
						writer.terminationRequestedAt === undefined || now - writer.terminationRequestedAt >= 1_000;
					if (shouldNudge) {
						// Keep the authenticated supervisor/PGID leader alive. It owns the
						// bounded escalation and will not exit until all members are gone.
						kill(writer.pid, "SIGTERM");
						terminated += 1;
						registry.writers[index] = { ...writer, terminationRequestedAt: now };
						changed = true;
					}
					remaining += 1;
					continue;
				}
				if (leaderLiveness === undefined) {
					remaining += 1;
					continue;
				}
			}
			const signalTarget = groupOwned ? -writer.pid : writer.pid;
			const shouldRequestTermination = writer.terminationRequestedAt === undefined;
			const shouldKill =
				writer.terminationRequestedAt !== undefined &&
				writer.killRequestedAt === undefined &&
				now - writer.terminationRequestedAt >= 250;
			if (shouldRequestTermination || shouldKill) {
				kill(signalTarget, shouldKill ? "SIGKILL" : "SIGTERM");
				terminated += 1;
			}
			const finalLiveness = groupOwned
				? ownedWriterGroupLiveness(asyncDir, writer, kill)
				: ownedLegacyWriterLiveness(writer, kill);
			if (finalLiveness === false) {
				registry.writers[index] = { state: "none" };
				changed = true;
			} else {
				const updated: PersistedWriterState = { ...writer };
				if (shouldRequestTermination) updated.terminationRequestedAt = now;
				if (shouldKill) updated.killRequestedAt = now;
				registry.writers[index] = updated;
				changed ||= shouldRequestTermination || shouldKill;
				// Signal delivery alone is not proof of exit. A later poll revalidates
				// ownership and escalates globally without blocking the Host event loop.
				remaining += 1;
			}
		} catch (error) {
			if (errorCode(error) === "ESRCH") {
				registry.writers[index] = { state: "none" };
				changed = true;
			} else {
				remaining += 1;
			}
		}
	}

	if (changed) {
		registry.updatedAt = Date.now();
		writePrivateAtomicJson(registryPath, registry);
	}
	return { remaining, terminated };
}

/**
 * Event-loop-friendly bounded reaping for runner shutdown. The synchronous
 * primitive above performs one ownership-checked step; this helper provides the
 * later TERM -> KILL -> absence probes that a terminating runner cannot defer to
 * a future Host/session poll.
 */
export function reapOrphanWriterProcesses(
	asyncDir: string,
	options: {
		readonly kill?: ProcessKillFn;
		readonly timeoutMs?: number;
		readonly pollIntervalMs?: number;
	} = {},
): Effect.Effect<{ remaining: number; terminated: number }> {
	const kill = options.kill ?? process.kill;
	const timeoutMs = Math.max(250, options.timeoutMs ?? 2_000);
	const pollIntervalMs = Math.max(10, Math.min(options.pollIntervalMs ?? 25, timeoutMs));
	return Effect.gen(function* () {
		const startedAt = Date.now();
		let terminated = 0;
		let result = terminateOrphanWriterProcesses(asyncDir, kill, startedAt);
		terminated += result.terminated;
		while (result.remaining > 0 && Date.now() - startedAt < timeoutMs) {
			yield* Effect.sleep(pollIntervalMs);
			result = terminateOrphanWriterProcesses(asyncDir, kill);
			terminated += result.terminated;
		}
		return { remaining: result.remaining, terminated };
	});
}

function readWriterProcessRegistry(asyncDir: string): WriterProcessRegistry | undefined {
	try {
		const resolvedDir = path.resolve(asyncDir);
		assertPrivateDirectory(resolvedDir);
		if (fs.realpathSync(resolvedDir) !== resolvedDir) return undefined;
		const registryPath = writerProcessRegistryPath(resolvedDir);
		return parseWriterProcessRegistry(
			parseJsonValue(readBoundedOwnedFile(registryPath, MAX_WRITER_PROCESS_REGISTRY_BYTES)),
		);
	} catch {
		return undefined;
	}
}

function readWriterProcessRegistryEffect(asyncDir: string): Effect.Effect<WriterProcessRegistry | undefined> {
	return Effect.tryPromise({
		try: async () => {
			const resolvedDir = path.resolve(asyncDir);
			const stat = await fs.promises.lstat(resolvedDir);
			const currentUid = process.getuid?.();
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				(currentUid !== undefined && stat.uid !== currentUid) ||
				(await fs.promises.realpath(resolvedDir)) !== resolvedDir
			) {
				return undefined;
			}
			const snapshot = await readBoundedOwnedFileSnapshotAsync(
				writerProcessRegistryPath(resolvedDir),
				MAX_WRITER_PROCESS_REGISTRY_BYTES,
			);
			return parseWriterProcessRegistry(parseJsonValue(snapshot.text));
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function parseWriterProcessRegistry(value: JsonValue): WriterProcessRegistry | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	if (
		value["version"] !== 1 ||
		!isRuntimeString(value["runId"]) ||
		!positiveInteger(value["runnerPid"]) ||
		(value["runnerProcessStartIdentity"] !== undefined && !isRuntimeString(value["runnerProcessStartIdentity"])) ||
		(value["writerStartupGate"] !== undefined && value["writerStartupGate"] !== "parent-pipe-v1") ||
		(value["writerProcessGroup"] !== undefined && value["writerProcessGroup"] !== "writer-pid-v1") ||
		!isRuntimeNumber(value["updatedAt"]) ||
		!value["writers"] ||
		!isRuntimeObject(value["writers"]) ||
		Array.isArray(value["writers"])
	)
		return undefined;
	const writers: Record<string, PersistedWriterState> = {};
	for (const [index, rawWriter] of Object.entries(value["writers"])) {
		const writer = parseWriterState(rawWriter);
		if (!/^\d+$/.test(index) || !writer) return undefined;
		writers[index] = writer;
	}
	const registry: WriterProcessRegistry = {
		version: 1,
		runId: value["runId"],
		runnerPid: value["runnerPid"],
		updatedAt: value["updatedAt"],
		writers,
	};
	if (isRuntimeString(value["runnerProcessStartIdentity"])) {
		registry.runnerProcessStartIdentity = value["runnerProcessStartIdentity"];
	}
	if (value["writerStartupGate"] === "parent-pipe-v1") registry.writerStartupGate = value["writerStartupGate"];
	if (value["writerProcessGroup"] === "writer-pid-v1") registry.writerProcessGroup = value["writerProcessGroup"];
	return registry;
}

function parseWriterState(value: JsonValue): PersistedWriterState | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	if (value["state"] !== "none" && value["state"] !== "spawning" && value["state"] !== "running") return undefined;
	if (value["state"] === "running") {
		if (
			!positiveInteger(value["pid"]) ||
			(value["processStartIdentity"] !== undefined && !isRuntimeString(value["processStartIdentity"])) ||
			(value["groupMemberProofFile"] !== undefined &&
				(!isRuntimeString(value["groupMemberProofFile"]) || !safeProofFileName(value["groupMemberProofFile"]))) ||
			(value["terminationRequestedAt"] !== undefined &&
				(!isRuntimeNumber(value["terminationRequestedAt"]) || !Number.isFinite(value["terminationRequestedAt"]))) ||
			(value["killRequestedAt"] !== undefined &&
				(!isRuntimeNumber(value["killRequestedAt"]) || !Number.isFinite(value["killRequestedAt"])))
		) {
			return undefined;
		}
		const writer: PersistedWriterState = { state: "running", pid: value["pid"] };
		if (isRuntimeString(value["processStartIdentity"])) writer.processStartIdentity = value["processStartIdentity"];
		if (isRuntimeString(value["groupMemberProofFile"])) writer.groupMemberProofFile = value["groupMemberProofFile"];
		if (isRuntimeNumber(value["terminationRequestedAt"])) {
			writer.terminationRequestedAt = value["terminationRequestedAt"];
		}
		if (isRuntimeNumber(value["killRequestedAt"])) writer.killRequestedAt = value["killRequestedAt"];
		return writer;
	}
	if (
		value["pid"] !== undefined ||
		value["processStartIdentity"] !== undefined ||
		value["groupMemberProofFile"] !== undefined ||
		value["terminationRequestedAt"] !== undefined ||
		value["killRequestedAt"] !== undefined
	) {
		return undefined;
	}
	return { state: value["state"] };
}

function positiveInteger(value: JsonValue | undefined): value is number {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value > 0;
}

/**
 * Prove that a live process group still belongs to the recorded writer before
 * it can influence lease retention or receive a signal.
 */
function ownedWriterGroupLiveness(
	asyncDir: string,
	writer: PersistedWriterState,
	kill: ProcessKillFn,
): boolean | undefined {
	if (writer.state !== "running" || !writer.pid) return false;
	const groupState = probeProcessLiveness(-writer.pid, kill);
	if (groupState !== true) return groupState;
	if (!writer.processStartIdentity) return undefined;
	const currentIdentity = readProcessStartIdentity(writer.pid);
	if (currentIdentity) return currentIdentity === writer.processStartIdentity;
	if (readAuthenticatedGroupMember(asyncDir, writer)) return true;
	// Once the leader is absent, a numeric PGID alone cannot prove continuity:
	// the original group may have disappeared and the number may have been
	// reused before this recovery pass. Retain the lease rather than risk
	// signalling an unrelated group.
	return undefined;
}

function ownedLegacyWriterLiveness(writer: PersistedWriterState, kill: ProcessKillFn): boolean | undefined {
	if (writer.state !== "running" || !writer.pid) return false;
	return identityBoundProcessLiveness(writer.pid, writer.processStartIdentity, probeProcessLiveness(writer.pid, kill));
}

function supportsProcessStartIdentity(): boolean {
	return process.platform === "linux" || process.platform === "darwin" || process.platform === "freebsd";
}

type ProcessIdentityGroupReader = (pid: number) => ProcessIdentityGroupSnapshot | undefined;

export function readAuthenticatedGroupMember(
	asyncDir: string,
	writer: PersistedWriterState,
	readSnapshot: ProcessIdentityGroupReader = readProcessIdentityGroupSnapshot,
): { readonly pid: number; readonly identity: string } | undefined {
	if (writer.state !== "running" || !writer.pid || !writer.processStartIdentity || !writer.groupMemberProofFile) {
		return undefined;
	}
	try {
		const fileName = safeProofFileName(writer.groupMemberProofFile);
		if (!fileName) return undefined;
		const parsed = parseJsonValue(readBoundedOwnedFile(path.join(path.resolve(asyncDir), fileName), 16 * 1024));
		if (
			!parsed ||
			!isRuntimeObject(parsed) ||
			Array.isArray(parsed) ||
			parsed["version"] !== 1 ||
			parsed["groupLeaderPid"] !== writer.pid ||
			parsed["groupLeaderProcessStartIdentity"] !== writer.processStartIdentity ||
			!positiveInteger(parsed["memberPid"]) ||
			!isRuntimeString(parsed["memberProcessStartIdentity"])
		) {
			return undefined;
		}
		const snapshot = readSnapshot(parsed["memberPid"]);
		if (
			!snapshot ||
			snapshot.processStartIdentity !== parsed["memberProcessStartIdentity"] ||
			snapshot.processGroupId !== writer.pid
		) {
			return undefined;
		}
		return { pid: parsed["memberPid"], identity: parsed["memberProcessStartIdentity"] };
	} catch {
		return undefined;
	}
}

function safeProofFileName(value: string): string | undefined {
	return /^[A-Za-z0-9._-]{1,256}$/u.test(value) && value !== "." && value !== ".." ? value : undefined;
}
