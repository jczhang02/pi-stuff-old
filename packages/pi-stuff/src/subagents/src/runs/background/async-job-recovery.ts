import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { errnoCode, readOwnedFileTailAsync } from "../../shared/private-directory.ts";
import { probeProcessLiveness, readProcessStartIdentity } from "../../shared/process-identity.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { terminalOutcome } from "../shared/terminal-outcome.ts";
import { inspectWriterProcessLiveness } from "./writer-process-registry.ts";

export const MAX_RECENT_AGENT_JOBS = 200;
const RESTORE_READ_CONCURRENCY = 8;
const MAX_LEGACY_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export type AsyncStatusReader = (asyncDir: string) => Effect.Effect<AsyncStatus | null, unknown>;

export interface TrackerEventRecord {
	readonly channels?: unknown;
	readonly childIntercomTarget?: unknown;
	readonly error?: unknown;
	readonly errorMessage?: unknown;
	readonly event?: unknown;
	readonly intercom?: unknown;
	readonly isError?: unknown;
	readonly message?: unknown;
	readonly noticeText?: unknown;
	readonly recordType?: unknown;
	readonly role?: unknown;
	readonly sourceEventType?: unknown;
	readonly stopReason?: unknown;
	readonly text?: unknown;
	readonly type?: unknown;
}

export function parseTrackerEventRecord(value: string): TrackerEventRecord {
	const parsed = parseJsonValue(value);
	if (!isRuntimeObject(parsed) || parsed === null || Array.isArray(parsed)) return {};
	// SAFETY: consumers read only the declared raw fields and validate them before dispatch.
	return parsed as TrackerEventRecord;
}

function ambiguousLegacyFinalDrain(step: NonNullable<AsyncStatus["steps"]>[number]): boolean {
	const terminal = step.processTerminal;
	if (step.error || step.status !== "failed" || terminal?.state !== "observed") return false;
	const writers = terminal.instances.filter(
		(instance): instance is Extract<(typeof terminal.instances)[number], { kind: "pi-writer" }> =>
			instance.kind === "pi-writer" && Number.isInteger(instance.attempt),
	);
	const finalAttempt = writers.reduce(
		(latest, instance) => Math.max(latest, instance.attempt),
		Number.NEGATIVE_INFINITY,
	);
	return writers.some(
		(instance) =>
			instance.attempt === finalAttempt &&
			instance.terminationOrigin === undefined &&
			(instance.signal === "SIGTERM" || (instance.signal === null && instance.exitCode === 143)),
	);
}

export function recoverLegacyFinalReports(status: AsyncStatus): Effect.Effect<AsyncStatus> {
	if (status.state !== "failed" || !status.steps?.some(ambiguousLegacyFinalDrain)) return Effect.succeed(status);
	return Effect.forEach(
		status.steps,
		(step) => {
			const transcriptPath = step.transcriptPath;
			if (!ambiguousLegacyFinalDrain(step) || !transcriptPath || !path.isAbsolute(transcriptPath)) {
				return Effect.succeed(step);
			}
			return Effect.tryPromise({
				try: () => readOwnedFileTailAsync(transcriptPath, MAX_LEGACY_TRANSCRIPT_TAIL_BYTES),
				catch: () => undefined,
			}).pipe(
				Effect.map((tail) => {
					const lastLine = tail.text.trimEnd().split("\n").at(-1);
					if (!lastLine) return step;
					const entry = parseTrackerEventRecord(lastLine);
					// SAFETY: the runtime guards below establish a non-array record before reading its optional field.
					const messageError =
						isRuntimeObject(entry.message) && entry.message !== null && !Array.isArray(entry.message)
							? (entry.message as { readonly errorMessage?: unknown }).errorMessage
							: undefined;
					if (
						entry.recordType !== "message" ||
						entry.sourceEventType !== "message_end" ||
						entry.role !== "assistant" ||
						entry.stopReason !== "stop" ||
						entry.isError === true ||
						!isRuntimeString(entry.text) ||
						!entry.text.trim() ||
						isRuntimeString(entry.error) ||
						isRuntimeString(entry.errorMessage) ||
						isRuntimeString(messageError)
					) {
						return step;
					}
					return { ...step, legacyFinalReportComplete: true as const };
				}),
				Effect.catch(() => Effect.succeed(step)),
			);
		},
		{ concurrency: 4 },
	).pipe(
		Effect.map((steps) =>
			steps.some((step, index) => step !== status.steps?.[index]) ? { ...status, steps } : status,
		),
	);
}

export interface RestoredAsyncJob {
	readonly asyncDir: string;
	readonly sessionId: string;
	readonly status: AsyncStatus;
}

function legacyIncompleteStatus(status: AsyncStatus, reason: string, now: number): AsyncStatus {
	const steps = (status.steps?.length ? status.steps : [{ agent: "agent", status: "running" as const }]).map(
		(step, index) => {
			if (step.status === "complete" || step.status === "completed") return step;
			const outcomeInput: Parameters<typeof terminalOutcome>[0] = {
				runId: status.runId,
				index,
				success: false,
				error: reason,
			};
			const sessionFile = step.sessionFile ?? status.sessionFile;
			if (sessionFile) outcomeInput.sessionFile = sessionFile;
			return {
				...step,
				status: "failed" as const,
				activityState: undefined,
				currentTool: undefined,
				currentToolStartedAt: undefined,
				currentPath: undefined,
				endedAt: step.endedAt ?? now,
				error: step.error ?? reason,
				terminalOutcome: step.terminalOutcome ?? terminalOutcome(outcomeInput),
			};
		},
	);
	const projected: AsyncStatus = {
		...status,
		state: "failed",
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		currentPath: undefined,
		lastUpdate: now,
		endedAt: now,
		error: reason,
		steps,
		processTerminal: status.processTerminal?.state === "observed" ? status.processTerminal : undefined,
	};
	delete projected.runnerTerminationRequestedAt;
	return projected;
}

/**
 * Presentation-only classification for pre-versioned active artifacts. The
 * returned status is never persisted, and liveness probes never send a signal.
 */
export function classifyLegacyActiveStatus(
	asyncDir: string,
	status: AsyncStatus,
	options: {
		readonly now?: () => number;
		readonly probeRunner?: (pid: number) => boolean | undefined;
		readonly readRunnerIdentity?: (pid: number) => string | undefined;
		readonly inspectWriters?: (asyncDir: string) => boolean | undefined;
	} = {},
): AsyncStatus {
	if (status.lifecycleArtifactVersion !== undefined || (status.state !== "queued" && status.state !== "running")) {
		return status;
	}
	const noSignalSuffix = "No process was signalled or reclaimed.";
	if (status.processTerminal?.state === "observed") {
		return legacyIncompleteStatus(
			status,
			`Legacy Agent process has terminal evidence while its status remains active. ${noSignalSuffix}`,
			options.now?.() ?? Date.now(),
		);
	}

	const pid = Number.isSafeInteger(status.pid) && Number(status.pid) > 0 ? Number(status.pid) : undefined;
	const runnerLiveness = pid === undefined ? false : (options.probeRunner ?? probeProcessLiveness)(pid);
	let reusedPid = false;
	if (pid !== undefined && runnerLiveness === true) {
		const readIdentity =
			options.readRunnerIdentity ?? (process.platform === "linux" ? readProcessStartIdentity : () => undefined);
		const currentIdentity = readIdentity(pid);
		if (status.processStartIdentity && currentIdentity === status.processStartIdentity) return status;
		reusedPid = Boolean(
			status.processStartIdentity && currentIdentity && currentIdentity !== status.processStartIdentity,
		);
	}
	const inspectWriters =
		options.inspectWriters ?? (process.platform === "linux" ? inspectWriterProcessLiveness : () => undefined);
	const writerLiveness = inspectWriters(asyncDir);
	if (writerLiveness === true) return status;

	const reason = reusedPid
		? `Legacy Agent runner PID was reused; its active status is quarantined as incomplete. ${noSignalSuffix}`
		: runnerLiveness === false && writerLiveness === false
			? `Legacy Agent runner and writers are no longer live; its active status is quarantined as incomplete. ${noSignalSuffix}`
			: `Legacy Agent process ownership cannot be verified; its active status is quarantined as incomplete. ${noSignalSuffix}`;
	return legacyIncompleteStatus(status, reason, options.now?.() ?? Date.now());
}

export function scanRestorableAsyncJobs(
	asyncDirRoot: string,
	asyncDirectories: readonly string[] | undefined,
	readRunStatus: AsyncStatusReader,
	normalizeSessionId: (sessionId: string | undefined, runId: string) => string | undefined,
): Effect.Effect<readonly RestoredAsyncJob[], unknown> {
	return Effect.gen(function* () {
		let directories: string[];
		if (asyncDirectories) {
			const root = path.resolve(asyncDirRoot);
			directories = [...new Set(asyncDirectories.map((directory) => path.resolve(directory)))].filter(
				(directory) => path.dirname(directory) === root,
			);
		} else {
			const entries = yield* Effect.tryPromise({
				try: () => fs.promises.readdir(asyncDirRoot, { withFileTypes: true }),
				catch: (error) => error,
			}).pipe(Effect.catch((error) => (errnoCode(error) === "ENOENT" ? Effect.succeed([]) : Effect.fail(error))));
			directories = entries
				.filter((entry) => entry.isDirectory() && entry.name !== "." && entry.name !== "..")
				.map((entry) => path.join(asyncDirRoot, entry.name));
		}
		const statuses = yield* Effect.forEach(
			directories,
			(asyncDir) =>
				readRunStatus(asyncDir).pipe(
					Effect.flatMap((observedStatus) =>
						observedStatus ? recoverLegacyFinalReports(observedStatus) : Effect.succeed(undefined),
					),
					Effect.map((status) => {
						if (!status) return undefined;
						const classified = classifyLegacyActiveStatus(asyncDir, status);
						const sessionId = normalizeSessionId(classified.sessionId, classified.runId);
						return sessionId ? { asyncDir, sessionId, status: classified } : undefined;
					}),
					Effect.catch((error) =>
						Effect.sync(() => {
							reportAgentDiagnostic(
								`Failed to inspect async run '${asyncDir}'; leaving it untouched for retry:`,
								error,
							);
							return undefined;
						}),
					),
				),
			{ concurrency: RESTORE_READ_CONCURRENCY },
		);
		const observed = statuses.filter((value) => value !== undefined);
		const active = observed.filter(({ status }) => status.state === "queued" || status.state === "running");
		const terminal = observed
			.filter(({ status }) => status.state !== "queued" && status.state !== "running")
			.sort(
				(left, right) =>
					(right.status.lastUpdate ?? right.status.endedAt ?? right.status.startedAt) -
					(left.status.lastUpdate ?? left.status.endedAt ?? left.status.startedAt),
			)
			.slice(0, MAX_RECENT_AGENT_JOBS);
		return [...active, ...terminal];
	});
}
