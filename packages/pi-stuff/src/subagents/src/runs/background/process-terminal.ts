import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { assertPrivateDirectory, errnoCode, readBoundedOwnedFile } from "../../shared/private-directory.ts";
import { tryAcquireStatusMutationClaim } from "../../shared/status-mutation.ts";
import { type AsyncStatus, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../shared/types.ts";
import { getErrorMessage as errorMessage, readStatus } from "../../shared/utils.ts";
import { MAX_MODEL_CANDIDATES_PER_CHILD } from "../shared/model-fallback.ts";
import { canonicalSessionId, inspectSessionLease } from "../shared/session-lease.ts";
import { appendDiagnosticEvent } from "./runner-output.ts";
import { inspectWriterProcessLiveness } from "./writer-process-registry.ts";

const MAX_PROCESS_TERMINAL_CANDIDATE_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_TERMINAL_PROOF_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_TERMINAL_CHILDREN = 20;
const MAX_WRITER_INSTANCES_PER_CHILD = MAX_MODEL_CANDIDATES_PER_CHILD;
const MAX_PROCESS_TERMINAL_INSTANCES = 1 + MAX_PROCESS_TERMINAL_CHILDREN * MAX_WRITER_INSTANCES_PER_CHILD;

export type ProcessTerminalReason =
	| "observer-unavailable"
	| "runner-candidate-missing"
	| "runner-instance-mismatch"
	| "writer-close-unverified"
	| "canonical-session-unavailable"
	| "canonical-session-lease-active"
	| "canonical-session-release-unverified"
	| "proof-write-failed"
	| "stale-repair";

export interface RunnerProcessInstanceExitV1 {
	processInstanceId: string;
	kind: "runner";
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export interface PiWriterProcessInstanceExitV1 {
	processInstanceId: string;
	kind: "pi-writer";
	attempt: number;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
	terminationOrigin?: "external" | "manager-final-drain" | "manager-request";
}

export type ProcessInstanceExitV1 = RunnerProcessInstanceExitV1 | PiWriterProcessInstanceExitV1;

export interface CanonicalSessionTerminalV1 {
	canonicalSessionId: string;
	leaseDisposition: "released" | "not-held";
	freeAtObservation: true;
	canonicalSessionLeaseReleased?: true;
}

interface ProcessTerminalBaseV1 {
	version: 1;
	runId: string;
	childIndex?: number;
	runnerProcessInstanceId: string;
	resumeDisposition?: "resumable" | "non-resumable" | "unavailable";
}

export type ProcessTerminalV1 =
	| (ProcessTerminalBaseV1 & { state: "pending" | "not-started" })
	| (ProcessTerminalBaseV1 & {
			state: "observed";
			observedAt: number;
			instances: ProcessInstanceExitV1[];
			canonicalSession?: CanonicalSessionTerminalV1;
	  })
	| (ProcessTerminalBaseV1 & {
			state: "unknown";
			reason: ProcessTerminalReason;
			diagnostic?: string;
	  });

export interface ProcessTerminalCandidate {
	version: 1;
	runId: string;
	runnerProcessInstanceId: string;
	writers: Record<string, ProcessInstanceExitV1[]>;
	expectedWriters?: Record<string, number>;
	sessionFile?: string;
	revivalLeaseToken?: string;
	revivalLeaseReleaseAcknowledged?: boolean;
}

export interface RunnerCloseObservation {
	processInstanceId: string;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

type ProcessTerminalRecord = Readonly<
	Partial<
		Record<
			| keyof ProcessTerminalCandidate
			| keyof ProcessTerminalBaseV1
			| keyof RunnerCloseObservation
			| keyof PiWriterProcessInstanceExitV1
			| keyof Extract<ProcessTerminalV1, { state: "observed" }>
			| keyof Extract<ProcessTerminalV1, { state: "unknown" }>,
			JsonValue
		>
	>
>;

function isRecord<Value>(value: Value): value is Value & ProcessTerminalRecord {
	return Boolean(value) && isRuntimeObject(value) && !Array.isArray(value);
}

function validProcessInstance<Value>(
	value: Value,
	kind?: "runner" | "pi-writer",
): value is Value & ProcessInstanceExitV1 {
	if (!isRecord(value)) return false;
	if (
		!isRuntimeString(value.processInstanceId) ||
		value.processInstanceId.length === 0 ||
		value.processInstanceId.length > 256
	)
		return false;
	if (kind ? value.kind !== kind : value.kind !== "runner" && value.kind !== "pi-writer") return false;
	if (!isRuntimeNumber(value.closeObservedAt) || !Number.isFinite(value.closeObservedAt)) return false;
	if (!isRuntimeNumber(value.exitCode) && value.exitCode !== null) return false;
	if (
		(!isRuntimeString(value.signal) && value.signal !== null) ||
		(isRuntimeString(value.signal) && value.signal.length > 32)
	)
		return false;
	if (
		value.kind === "pi-writer" &&
		value.terminationOrigin !== undefined &&
		!["external", "manager-final-drain", "manager-request"].includes(String(value.terminationOrigin))
	)
		return false;
	return value.kind === "runner"
		? value.attempt === undefined
		: isRuntimeNumber(value.attempt) && Number.isInteger(value.attempt) && value.attempt >= 0;
}

function validInstance<Value>(value: Value): value is Value & ProcessInstanceExitV1 {
	return validProcessInstance(value, "pi-writer");
}

export function processTerminalCandidatePath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal-candidate.json");
}

export function processTerminalPath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal.json");
}

export function readProcessTerminalCandidate(asyncDir: string): ProcessTerminalCandidate | undefined {
	try {
		assertPrivateDirectory(asyncDir);
		const raw = parseJsonValue(
			readBoundedOwnedFile(processTerminalCandidatePath(asyncDir), MAX_PROCESS_TERMINAL_CANDIDATE_BYTES),
		);
		if (
			!isRecord(raw) ||
			raw.version !== 1 ||
			!isRuntimeString(raw.runId) ||
			!isRuntimeString(raw.runnerProcessInstanceId) ||
			!isRecord(raw.writers)
		) {
			throw new Error(`Invalid process-terminal candidate in '${asyncDir}'.`);
		}
		const writers: Record<string, ProcessInstanceExitV1[]> = {};
		for (const [index, entries] of Object.entries(raw.writers)) {
			if (
				!/^\d+$/u.test(index) ||
				Number(index) >= MAX_PROCESS_TERMINAL_CHILDREN ||
				!Array.isArray(entries) ||
				entries.length > MAX_WRITER_INSTANCES_PER_CHILD ||
				!entries.every(validInstance)
			)
				throw new Error(`Invalid writer process records for child '${index}'.`);
			writers[index] = entries;
		}
		if (Object.keys(writers).length > MAX_PROCESS_TERMINAL_CHILDREN)
			throw new Error("Process-terminal candidate has too many children.");
		let expectedWriters: Record<string, number> | undefined;
		if (raw.expectedWriters !== undefined) {
			if (!isRecord(raw.expectedWriters)) throw new Error("Invalid expected writer process records.");
			expectedWriters = {};
			for (const [index, count] of Object.entries(raw.expectedWriters)) {
				if (
					!/^\d+$/u.test(index) ||
					Number(index) >= MAX_PROCESS_TERMINAL_CHILDREN ||
					!isRuntimeNumber(count) ||
					!Number.isInteger(count) ||
					count < 0 ||
					count > MAX_WRITER_INSTANCES_PER_CHILD
				)
					throw new Error(`Invalid expected writer count for child '${index}'.`);
				expectedWriters[index] = count;
			}
			if (Object.keys(expectedWriters).length > MAX_PROCESS_TERMINAL_CHILDREN)
				throw new Error("Process-terminal candidate has too many expected children.");
		}
		if (raw.sessionFile !== undefined && !isRuntimeString(raw.sessionFile))
			throw new Error("Invalid process-terminal candidate sessionFile.");
		if (raw.revivalLeaseToken !== undefined && !isRuntimeString(raw.revivalLeaseToken))
			throw new Error("Invalid process-terminal candidate lease token.");
		if (raw.revivalLeaseReleaseAcknowledged !== undefined && !isRuntimeBoolean(raw.revivalLeaseReleaseAcknowledged))
			throw new Error("Invalid process-terminal lease release acknowledgement.");
		const candidate: ProcessTerminalCandidate = {
			version: 1,
			runId: raw.runId,
			runnerProcessInstanceId: raw.runnerProcessInstanceId,
			writers,
		};
		if (expectedWriters) candidate.expectedWriters = expectedWriters;
		if (raw.sessionFile) candidate.sessionFile = raw.sessionFile;
		if (raw.revivalLeaseToken) candidate.revivalLeaseToken = raw.revivalLeaseToken;
		if (raw.revivalLeaseReleaseAcknowledged !== undefined) {
			candidate.revivalLeaseReleaseAcknowledged = raw.revivalLeaseReleaseAcknowledged;
		}
		return candidate;
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return undefined;
		return undefined;
	}
}

export function writeProcessTerminalCandidate(asyncDir: string, candidate: ProcessTerminalCandidate): void {
	assertPrivateDirectory(asyncDir);
	writePrivateAtomicJson(processTerminalCandidatePath(asyncDir), candidate);
}

export function markProcessTerminalCandidateLeaseRelease(asyncDir: string, token: string, acknowledged: boolean): void {
	const candidate = readProcessTerminalCandidate(asyncDir);
	if (!candidate || candidate.revivalLeaseToken !== token) return;
	writeProcessTerminalCandidate(asyncDir, { ...candidate, revivalLeaseReleaseAcknowledged: acknowledged });
}

function unknownProof(
	runId: string,
	runnerProcessInstanceId: string,
	reason: ProcessTerminalReason,
	diagnostic?: string,
): ProcessTerminalV1 {
	const proof: ProcessTerminalV1 = {
		version: 1,
		state: "unknown",
		runId,
		runnerProcessInstanceId,
		reason,
	};
	if (diagnostic) proof.diagnostic = diagnostic;
	return proof;
}

export function processTerminalResumeDisposition(
	state: string | undefined,
	sessionFile: string | undefined,
): "resumable" | "non-resumable" | "unavailable" {
	if (state === "stopped") return "non-resumable";
	if (state !== "complete" && state !== "completed" && state !== "failed" && state !== "paused") return "unavailable";
	return sessionFile && fs.existsSync(sessionFile) ? "resumable" : "unavailable";
}

function sessionProjection(
	candidate: ProcessTerminalCandidate,
	lease: ReturnType<typeof inspectSessionLease>,
): CanonicalSessionTerminalV1 | undefined {
	if (!candidate.sessionFile || lease.state !== "free") return undefined;
	if (candidate.revivalLeaseToken && candidate.revivalLeaseReleaseAcknowledged !== true) return undefined;
	const projection: CanonicalSessionTerminalV1 = {
		canonicalSessionId: canonicalSessionId(candidate.sessionFile),
		leaseDisposition: candidate.revivalLeaseToken ? "released" : "not-held",
		freeAtObservation: true,
	};
	if (candidate.revivalLeaseToken) projection.canonicalSessionLeaseReleased = true;
	return projection;
}

function validateProof<Value>(
	raw: Value,
	asyncDir: string,
	fallback?: { runId?: string | undefined; runnerProcessInstanceId?: string | undefined },
): asserts raw is Value & ProcessTerminalV1 {
	if (
		!isRecord(raw) ||
		raw.version !== 1 ||
		!["pending", "observed", "unknown", "not-started"].includes(String(raw.state)) ||
		!isRuntimeString(raw.runId) ||
		!raw.runId ||
		!isRuntimeString(raw.runnerProcessInstanceId) ||
		!raw.runnerProcessInstanceId
	) {
		throw new Error(`Invalid process-terminal proof in '${asyncDir}'.`);
	}
	if (fallback?.runId && raw.runId !== fallback.runId)
		throw new Error(
			`Process-terminal proof in '${asyncDir}' belongs to run '${raw.runId}', expected '${fallback.runId}'.`,
		);
	if (fallback?.runnerProcessInstanceId && raw.runnerProcessInstanceId !== fallback.runnerProcessInstanceId)
		throw new Error(
			`Process-terminal proof in '${asyncDir}' belongs to runner '${raw.runnerProcessInstanceId}', expected '${fallback.runnerProcessInstanceId}'.`,
		);
	if (
		raw.instances !== undefined &&
		(!Array.isArray(raw.instances) ||
			raw.instances.length > MAX_PROCESS_TERMINAL_INSTANCES ||
			!raw.instances.every((entry) => validProcessInstance(entry)))
	) {
		throw new Error(`Invalid process-terminal instances in '${asyncDir}'.`);
	}
	const childProof = raw.childIndex !== undefined;
	if (
		childProof &&
		(!isRuntimeNumber(raw.childIndex) ||
			!Number.isInteger(raw.childIndex) ||
			raw.childIndex < 0 ||
			raw.childIndex >= MAX_PROCESS_TERMINAL_CHILDREN)
	) {
		throw new Error(`Invalid process-terminal childIndex in '${asyncDir}'.`);
	}
	if (raw.state === "observed") {
		if (!isRuntimeNumber(raw.observedAt) || !Number.isFinite(raw.observedAt))
			throw new Error(`Observed process-terminal proof in '${asyncDir}' is missing observedAt.`);
		if (!Array.isArray(raw.instances))
			throw new Error(`Observed process-terminal proof in '${asyncDir}' is missing instances.`);
		if (childProof) {
			if (raw.instances.length === 0 || raw.instances.some((entry) => !validProcessInstance(entry, "pi-writer"))) {
				throw new Error(`Observed child process-terminal proof in '${asyncDir}' has invalid writer instances.`);
			}
		} else {
			const runner = raw.instances.find((entry) => isRecord(entry) && entry.kind === "runner");
			if (!validProcessInstance(runner, "runner") || runner.processInstanceId !== raw.runnerProcessInstanceId)
				throw new Error(`Observed process-terminal proof in '${asyncDir}' has no matching runner instance.`);
		}
	}
	if (
		raw.resumeDisposition !== undefined &&
		!["resumable", "non-resumable", "unavailable"].includes(String(raw.resumeDisposition))
	)
		throw new Error(`Invalid process-terminal resume disposition in '${asyncDir}'.`);
}

export function sanitizeProcessTerminal<Value>(
	value: Value,
	fallback: { runId?: string | undefined; runnerProcessInstanceId?: string | undefined },
	label = "status",
): ProcessTerminalV1 | undefined {
	if (value === undefined) return undefined;
	try {
		validateProof(value, label, fallback);
		return value;
	} catch (error) {
		return unknownProof(
			fallback.runId ?? label,
			fallback.runnerProcessInstanceId ?? "unknown",
			"proof-write-failed",
			errorMessage(error),
		);
	}
}

export function readProcessTerminal(
	asyncDir: string,
	fallback?: { runId?: string | undefined; runnerProcessInstanceId?: string | undefined },
): ProcessTerminalV1 | undefined {
	try {
		assertPrivateDirectory(asyncDir);
		const raw = parseJsonValue(readBoundedOwnedFile(processTerminalPath(asyncDir), MAX_PROCESS_TERMINAL_PROOF_BYTES));
		validateProof(raw, asyncDir, fallback);
		return raw;
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return undefined;
		return unknownProof(
			fallback?.runId ?? path.basename(asyncDir),
			fallback?.runnerProcessInstanceId ?? "unknown",
			"proof-write-failed",
			errorMessage(error),
		);
	}
}

/**
 * Persist the stronger lifecycle fact established by stale-run recovery after
 * it has proven the exact runner identity gone and every authenticated writer
 * absent. This is an observation of process absence, not a claim about the
 * runner's semantic exit code.
 */
export function persistRecoveredProcessTerminal(
	asyncDir: string,
	status: AsyncStatus,
	observedAt = Date.now(),
): ProcessTerminalV1 {
	const runnerProcessInstanceId =
		status.processTerminal?.runnerProcessInstanceId ??
		`recovered:${status.pid ?? "unknown"}:${status.processStartIdentity ?? "unknown"}`.slice(0, 256);
	const proof: ProcessTerminalV1 = {
		version: 1,
		state: "observed",
		runId: status.runId,
		runnerProcessInstanceId,
		observedAt,
		instances: [
			{
				processInstanceId: runnerProcessInstanceId,
				kind: "runner",
				closeObservedAt: observedAt,
				exitCode: null,
				signal: null,
			},
		],
		resumeDisposition: processTerminalResumeDisposition(status.state, status.sessionFile),
	};
	assertPrivateDirectory(asyncDir);
	writeAtomicJson(processTerminalPath(asyncDir), proof);
	overlayStatus(asyncDir, proof);
	appendDiagnosticEvent(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.process_terminal_recovered",
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		ts: observedAt,
		runId: status.runId,
		processTerminal: proof,
	});
	return proof;
}

function stepProcessTerminalProof(
	proof: ProcessTerminalV1,
	childIndex: number,
	state: ProcessTerminalV1["state"],
	records: ProcessInstanceExitV1[],
	resumeDispositionValue: ProcessTerminalV1["resumeDisposition"],
): ProcessTerminalV1 {
	const base = {
		version: 1 as const,
		runId: proof.runId,
		childIndex,
		runnerProcessInstanceId: proof.runnerProcessInstanceId,
	};
	if (resumeDispositionValue) Object.assign(base, { resumeDisposition: resumeDispositionValue });
	if (state === "observed") {
		return {
			...base,
			state,
			observedAt: proof.state === "observed" ? proof.observedAt : Date.now(),
			instances: records,
		};
	}
	if (state === "unknown") {
		return { ...base, state, reason: proof.state === "unknown" ? proof.reason : "writer-close-unverified" };
	}
	return { ...base, state };
}

function overlayStatus(asyncDir: string, proof: ProcessTerminalV1, candidate?: ProcessTerminalCandidate): void {
	const statusPath = path.join(asyncDir, "status.json");
	let claim: ReturnType<typeof tryAcquireStatusMutationClaim>;
	try {
		assertPrivateDirectory(asyncDir);
		claim = tryAcquireStatusMutationClaim(asyncDir);
		if (!claim) return;
		const status = readStatus(asyncDir);
		if (!status) return;
		if (status.steps && status.steps.length > MAX_PROCESS_TERMINAL_CHILDREN) return;
		status.processTerminal = proof;
		if (status.steps) {
			for (const [index, step] of status.steps.entries()) {
				const key = String(index);
				const hasWriterEvidence = candidate ? Object.hasOwn(candidate.writers, key) : false;
				const hasExpectedEvidence = candidate?.expectedWriters
					? Object.hasOwn(candidate.expectedWriters, key)
					: false;
				const records = hasWriterEvidence ? (candidate?.writers[key] ?? []) : [];
				const expected = hasExpectedEvidence
					? candidate?.expectedWriters?.[key]
					: hasWriterEvidence
						? records.length
						: undefined;
				const stepState =
					candidate && hasExpectedEvidence && expected === 0 && records.length === 0
						? "not-started"
						: proof.state === "observed" && expected !== undefined && expected > 0 && records.length === expected
							? "observed"
							: proof.state === "pending"
								? "pending"
								: "unknown";
				step.processTerminal = stepProcessTerminalProof(
					proof,
					index,
					stepState,
					records,
					processTerminalResumeDisposition(step.status, step.sessionFile ?? candidate?.sessionFile),
				);
			}
		}
		writeAtomicJson(statusPath, status);
	} catch {
		// The proof sidecar remains authoritative when terminal status is unavailable.
	} finally {
		claim?.release();
	}
}

export function finalizeProcessTerminal(
	asyncDir: string,
	runId: string,
	runnerClose: RunnerCloseObservation,
): ProcessTerminalV1 {
	const existing = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId: runnerClose.processInstanceId });
	if (existing && fs.existsSync(processTerminalPath(asyncDir))) {
		if (
			existing.state === "observed" &&
			existing.runId === runId &&
			existing.runnerProcessInstanceId === runnerClose.processInstanceId
		)
			return existing;
		if (existing.state === "unknown") return existing;
	}
	let proof: ProcessTerminalV1;
	let candidateForOverlay: ProcessTerminalCandidate | undefined;
	try {
		const candidate = readProcessTerminalCandidate(asyncDir);
		if (!candidate) proof = unknownProof(runId, runnerClose.processInstanceId, "runner-candidate-missing");
		else if (candidate.runId !== runId || candidate.runnerProcessInstanceId !== runnerClose.processInstanceId)
			proof = unknownProof(runId, runnerClose.processInstanceId, "runner-instance-mismatch");
		else {
			candidateForOverlay = candidate;
			const allWriters = Object.values(candidate.writers).flat();
			const status = (() => {
				try {
					assertPrivateDirectory(asyncDir);
					return readStatus(asyncDir);
				} catch {
					return undefined;
				}
			})();
			const session = candidate.sessionFile ? inspectSessionLease(candidate.sessionFile) : undefined;
			const writerEntries = Object.entries(candidate.writers);
			const expectedWriters =
				candidate.expectedWriters ??
				Object.fromEntries(writerEntries.map(([index, records]) => [index, records.length]));
			const expectedEntries = Object.entries(expectedWriters);
			const expectedIndexes = new Set(expectedEntries.map(([index]) => index));
			const writerIndexes = new Set(writerEntries.map(([index]) => index));
			const writerLiveness = inspectWriterProcessLiveness(asyncDir);
			const ambiguousLegacyEmptyWriter =
				candidate.expectedWriters === undefined && writerEntries.some(([, records]) => records.length === 0);
			const inconsistentWriters =
				writerEntries.some(
					([index, records]) => !expectedIndexes.has(index) || records.length !== expectedWriters[index],
				) || expectedEntries.some(([index, expected]) => !writerIndexes.has(index) && expected !== 0);
			if (writerLiveness !== false) {
				proof = unknownProof(
					runId,
					runnerClose.processInstanceId,
					"writer-close-unverified",
					writerLiveness === true
						? "An authenticated Agent writer process group is still alive."
						: "Agent writer process-group termination could not be verified.",
				);
			} else if (session && session.state !== "free") {
				proof = unknownProof(
					runId,
					runnerClose.processInstanceId,
					session.state === "owned" ? "canonical-session-lease-active" : "canonical-session-unavailable",
				);
			} else if (candidate.revivalLeaseToken && candidate.revivalLeaseReleaseAcknowledged !== true) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "canonical-session-release-unverified");
			} else if (
				ambiguousLegacyEmptyWriter ||
				inconsistentWriters ||
				(allWriters.length === 0 && expectedEntries.length === 0)
			) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "writer-close-unverified");
			} else {
				const runner: ProcessInstanceExitV1 = { kind: "runner", ...runnerClose };
				const canonicalSession = session && sessionProjection(candidate, session);
				const observed: ProcessTerminalV1 = {
					version: 1,
					state: "observed",
					runId,
					runnerProcessInstanceId: runnerClose.processInstanceId,
					observedAt: runnerClose.closeObservedAt,
					instances: [runner, ...allWriters],
					resumeDisposition: processTerminalResumeDisposition(
						status?.state,
						candidate.sessionFile ?? status?.sessionFile,
					),
				};
				if (canonicalSession) observed.canonicalSession = canonicalSession;
				proof = observed;
			}
		}
	} catch (error) {
		proof = unknownProof(runId, runnerClose.processInstanceId, "proof-write-failed", errorMessage(error));
	}
	let durable = false;
	try {
		writeAtomicJson(processTerminalPath(asyncDir), proof);
		durable = true;
		overlayStatus(asyncDir, proof, candidateForOverlay);
		appendDiagnosticEvent(path.join(asyncDir, "events.jsonl"), {
			type: "subagent.run.process_terminal",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: Date.now(),
			runId,
			processTerminal: proof,
		});
	} catch {
		// Do not emit a process-terminal event when the proof sidecar was not durable.
	}
	return durable
		? proof
		: unknownProof(
				runId,
				runnerClose.processInstanceId,
				"proof-write-failed",
				"Failed to persist process-terminal proof.",
			);
}
