import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { type JsonObject, parseJsonObject } from "../../../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeString } from "../../../../shared/runtime-type.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import type { DurableClaim, tryAcquireKernelClaim } from "../../shared/durable-claim.ts";
import {
	type FileVersion,
	type OwnedFileSnapshot,
	removeOwnedFileSnapshotAsync,
	sameFileVersion,
} from "../../shared/private-directory.ts";
import { sessionArtifactMatches } from "../../shared/session-identity.ts";
import {
	type AsyncStatus,
	type IntercomEventBus,
	type NestedRunSummary,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type SubagentResultIntercomChild,
	type SubagentState,
} from "../../shared/types.ts";
import { isNotFoundError as isNotFound, pickFields, readStatusAsync } from "../../shared/utils.ts";
import {
	nestedWorkIncludesUser,
	type projectNestedEventsAuthoritatively,
	projectNestedRegistryForRootAuthoritatively,
} from "../shared/nested-events.ts";
import {
	buildCompletionKey,
	deliveryClaimName,
	markSeenWithTtl,
	type ResultDeliveryState,
	readDeliveryState,
	removeDeliveryArtifacts,
	resultDigest,
	stableDeliveryId,
	writeDeliveryState,
} from "./completion-dedupe.ts";
import { type CompletionNotification, deliverNotification } from "./notify.ts";
import {
	COMPLETION_FIELDS,
	RESULT_CHILD_FIELDS,
	type ResultFileChild,
	type ResultFileData,
	sanitizeNestedResultChildren,
} from "./result-file.ts";
import { repairTerminalStatusFromResult } from "./stale-run-reconciler.ts";

const RETRY_DELAY_MS = 100;
const STATUS_REPAIR_RETRY_INITIAL_MS = 500;
const STATUS_REPAIR_RETRY_MAX_MS = 30_000;
const STATUS_REPAIR_LOG_INTERVAL_MS = 30_000;
const PROCESS_RETRY_INITIAL_MS = 100;
const PROCESS_RETRY_MAX_MS = 30_000;
const MAX_RESULT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_IGNORED_RESULT_FINGERPRINTS = 5_000;

export interface ResultProcessorOptions {
	pi: { events: IntercomEventBus };
	state: Pick<SubagentState, "completionSeen" | "currentSessionId" | "currentSessionScope">;
	resultsDir: string;
	asyncDirRoot: string;
	completionTtlMs: number;
	notifier: { deliver(notification: CompletionNotification, signal?: AbortSignal): Promise<boolean> };
	readResultSnapshot: (resultPath: string, maxBytes: number) => Promise<OwnedFileSnapshot> | OwnedFileSnapshot;
	acquireClaim: typeof tryAcquireKernelClaim;
	projectNestedEvents: typeof projectNestedEventsAuthoritatively;
	scheduleResult(file: string, triggerTurn: boolean, delayMs?: number): void;
}

interface LoadedResult {
	data: JsonObject & ResultFileData & { sessionId: string };
	file: string;
	nestedChildren: NestedRunSummary[] | undefined;
	persistedStatus: AsyncStatus | null;
	rawResult: string;
	resultPath: string;
	resultSnapshot: OwnedFileSnapshot;
	runId: string;
	epoch: number;
	statusChildren: NestedRunSummary[] | undefined;
	terminalStatusReady: boolean;
	triggerTurn: boolean;
}

interface CompletionProjection {
	completion: CompletionNotification;
	intercomTarget: string;
	mode: "parallel" | "single";
	normalizedChildren: SubagentResultIntercomChild[];
}

export class ResultProcessor {
	private readonly options: ResultProcessorOptions;
	private readonly processing = new Map<string, symbol>();
	private readonly deliveredPendingStatus = new Set<string>();
	private readonly statusRepairRetryDelay = new Map<string, number>();
	private readonly statusRepairLastLog = new Map<string, number>();
	private readonly processRetryDelay = new Map<string, number>();
	private readonly processRetryLastLog = new Map<string, number>();
	private readonly ignoredResultFingerprints = new Map<string, FileVersion>();
	private deliveryEpoch = 0;
	activeSessionId: string | null | undefined;

	constructor(options: ResultProcessorOptions) {
		this.options = options;
	}

	activate(): void {
		const { state } = this.options;
		if (this.activeSessionId !== undefined && this.activeSessionId === state.currentSessionId) return;
		this.ignoredResultFingerprints.clear();
		this.activeSessionId = state.currentSessionId;
		this.deliveryEpoch += 1;
	}

	forgetIgnoredResult(file: string): void {
		this.ignoredResultFingerprints.delete(file);
	}

	stop(): void {
		this.activeSessionId = undefined;
		this.deliveryEpoch += 1;
		this.processing.clear();
		this.deliveredPendingStatus.clear();
		this.statusRepairRetryDelay.clear();
		this.statusRepairLastLog.clear();
		this.processRetryDelay.clear();
		this.processRetryLastLog.clear();
		this.ignoredResultFingerprints.clear();
	}

	private rememberIgnoredResult(file: string, snapshot: FileVersion, epoch: number): void {
		if (this.activeSessionId === undefined || epoch !== this.deliveryEpoch) return;
		this.ignoredResultFingerprints.delete(file);
		this.ignoredResultFingerprints.set(file, snapshot);
		while (this.ignoredResultFingerprints.size > MAX_IGNORED_RESULT_FINGERPRINTS) {
			const oldest = this.ignoredResultFingerprints.keys().next();
			if (oldest.done) break;
			this.ignoredResultFingerprints.delete(oldest.value);
		}
	}

	private validAsyncBinding(
		data: ResultFileData,
		file: string,
	): Effect.Effect<"valid" | "pending" | "invalid", unknown> {
		const { asyncDirRoot } = this.options;
		const fileRunId = file.replace(/\.json$/iu, "");
		if ((data.runId !== undefined && data.runId !== fileRunId) || (data.id !== undefined && data.id !== fileRunId))
			return Effect.succeed("invalid");
		if (!isRuntimeString(data.asyncDir) || !data.asyncDir) return Effect.succeed("valid");
		const expectedDir = path.join(path.resolve(asyncDirRoot), fileRunId);
		if (path.resolve(data.asyncDir) !== expectedDir || path.dirname(expectedDir) !== path.resolve(asyncDirRoot))
			return Effect.succeed("invalid");
		return Effect.tryPromise({
			try: async () => {
				const entry = await fs.promises.lstat(expectedDir).catch((error) => {
					if (isNotFound(error)) return undefined;
					throw error;
				});
				if (!entry) return "pending" as const;
				if (!entry.isDirectory() || entry.isSymbolicLink()) return "invalid" as const;
				const canonicalRoot = await fs.promises.realpath(asyncDirRoot);
				const canonicalDir = await fs.promises.realpath(expectedDir);
				return path.dirname(canonicalDir) === canonicalRoot ? ("valid" as const) : ("invalid" as const);
			},
			catch: (error) => error,
		});
	}

	private ownsSession(sessionId: string, runId: string, epoch: number): boolean {
		const { state } = this.options;
		if (this.activeSessionId === undefined || epoch !== this.deliveryEpoch) return false;
		if (!this.activeSessionId && state.currentSessionId) this.activeSessionId = state.currentSessionId;
		const artifactMatches = state.currentSessionScope
			? sessionArtifactMatches(state.currentSessionScope, sessionId, runId)
			: sessionId === state.currentSessionId;
		return this.activeSessionId === state.currentSessionId && artifactMatches;
	}

	private fileExists(filePath: string): Effect.Effect<boolean, unknown> {
		return Effect.tryPromise({ try: () => fs.promises.access(filePath), catch: (error) => error }).pipe(
			Effect.as(true),
			Effect.catch((error) => (isNotFound(error) ? Effect.succeed(false) : Effect.fail(error))),
		);
	}

	private reportStatusRepair(file: string, message: string, cause?: unknown): void {
		const now = Date.now();
		const last = this.statusRepairLastLog.get(file) ?? 0;
		if (now - last < STATUS_REPAIR_LOG_INTERVAL_MS) return;
		this.statusRepairLastLog.set(file, now);
		if (cause === undefined) reportAgentDiagnostic(message);
		else reportAgentDiagnostic(message, cause);
	}

	private scheduleStatusRepair(file: string, triggerTurn: boolean): void {
		const delay = this.statusRepairRetryDelay.get(file) ?? STATUS_REPAIR_RETRY_INITIAL_MS;
		this.statusRepairRetryDelay.set(file, Math.min(STATUS_REPAIR_RETRY_MAX_MS, delay * 2));
		this.options.scheduleResult(file, triggerTurn, delay);
	}

	private removeDeliveredResult(loaded: LoadedResult, completionKey: string): Effect.Effect<void> {
		const { file, resultPath, resultSnapshot, triggerTurn } = loaded;
		return Effect.gen({ self: this }, function* () {
			const removed = yield* Effect.tryPromise({
				try: () => removeOwnedFileSnapshotAsync(resultPath, resultSnapshot),
				catch: (error) => error,
			});
			if (removed === "changed") {
				this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
				return;
			}
			yield* removeDeliveryArtifacts(this.options.resultsDir, file);
			this.deliveredPendingStatus.delete(completionKey);
			this.statusRepairRetryDelay.delete(file);
			this.statusRepairLastLog.delete(file);
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					if (isNotFound(error)) return;
					reportAgentDiagnostic(`Failed to remove delivered subagent result '${resultPath}'; will retry:`, error);
					this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
				}),
			),
		);
	}

	private ensureTerminalStatus(
		data: ResultFileData,
		resultPath: string,
		file: string,
		resultContent: string,
	): boolean {
		if (!isRuntimeString(data.asyncDir) || !data.asyncDir) return true;
		try {
			const terminal = repairTerminalStatusFromResult(data.asyncDir, resultPath, Date.now(), resultContent);
			if (
				terminal &&
				terminal.state !== "running" &&
				terminal.state !== "queued" &&
				(terminal.lifecycleArtifactVersion !== 3 || terminal.processTerminal?.state === "observed")
			) {
				this.statusRepairRetryDelay.delete(file);
				this.statusRepairLastLog.delete(file);
				return true;
			}
			this.reportStatusRepair(
				file,
				`Subagent result '${resultPath}' has no durable terminal status yet; delivering once and retaining it for bounded repair retry.`,
			);
		} catch (error) {
			this.reportStatusRepair(
				file,
				`Failed to make terminal status durable for subagent result '${resultPath}'; delivering once and retaining it for bounded repair retry:`,
				error,
			);
		}
		return false;
	}

	private loadResult(
		file: string,
		resultPath: string,
		attemptEpoch: number,
		triggerTurn: boolean,
	): Effect.Effect<LoadedResult | null, unknown> {
		return Effect.gen({ self: this }, function* () {
			const resultSnapshot = yield* Effect.tryPromise({
				try: async () => this.options.readResultSnapshot(resultPath, MAX_RESULT_FILE_BYTES),
				catch: (error) => error,
			});
			const rawResult = resultSnapshot.text;
			const data: JsonObject & ResultFileData = parseJsonObject(rawResult);
			this.processRetryDelay.delete(file);
			this.processRetryLastLog.delete(file);
			if (!isRuntimeString(data.sessionId) || !data.sessionId) {
				this.rememberIgnoredResult(file, resultSnapshot, attemptEpoch);
				return null;
			}
			// SAFETY: The persisted sessionId was checked as a non-empty string above.
			const sessionData = data as typeof data & { sessionId: string };
			const runId = sessionData.runId ?? sessionData.id ?? file.replace(/\.json$/i, "");
			const epoch = this.deliveryEpoch;
			if (!this.ownsSession(sessionData.sessionId, runId, epoch)) {
				this.rememberIgnoredResult(file, resultSnapshot, epoch);
				return null;
			}
			if ((yield* this.validAsyncBinding(sessionData, file)) === "invalid") {
				this.rememberIgnoredResult(file, resultSnapshot, attemptEpoch);
				this.reportStatusRepair(file, `Ignoring subagent result '${resultPath}' with an unsafe asyncDir binding.`);
				return null;
			}
			const terminalStatusReady = this.ensureTerminalStatus(sessionData, resultPath, file, rawResult);
			const hasExplicitNestedChildren = sessionData.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(
				sanitizeNestedResultChildren(sessionData.nestedChildren, resultPath, "nestedChildren"),
			);
			let persistedStatus: AsyncStatus | null = null;
			const asyncDir = sessionData.asyncDir;
			if (isRuntimeString(asyncDir) && asyncDir) {
				persistedStatus = yield* Effect.tryPromise({
					try: () => readStatusAsync(asyncDir),
					catch: (error) => error,
				}).pipe(
					Effect.catch((error) =>
						Effect.sync(() => {
							reportAgentDiagnostic(`Failed to inspect exact nested status for '${resultPath}':`, error);
							return null;
						}),
					),
				);
			}
			const statusChildren = compactNestedResultChildren(
				persistedStatus?.steps?.flatMap((step) => step.children ?? []),
			);
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				const nestedRoute = persistedStatus?.nestedRoute;
				if (nestedRoute) {
					const projected = yield* Effect.tryPromise({
						try: () => this.options.projectNestedEvents(nestedRoute),
						catch: (error) => error,
					}).pipe(
						Effect.map((value) => ({ ok: true as const, value })),
						Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
					);
					if (!projected.ok) {
						// A busy exact-route projector is not an empty tree. Retain the
						// result instead of permanently delivering an incomplete summary.
						reportAgentDiagnostic(
							`Failed to project exact nested route for '${resultPath}'; retaining result for retry:`,
							projected.error,
						);
						this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
						return null;
					}
					nestedChildren = compactNestedResultChildren(projected.value.children);
				} else {
					nestedChildren = statusChildren;
					if (!nestedChildren?.length) {
						const projected = yield* Effect.tryPromise({
							try: () => projectNestedRegistryForRootAuthoritatively(runId),
							catch: (error) => error,
						}).pipe(
							Effect.map((value) => ({ ok: true as const, value })),
							Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
						);
						if (!projected.ok) {
							reportAgentDiagnostic(
								`Failed to authoritatively enrich legacy subagent result '${resultPath}'; retaining it for retry:`,
								projected.error,
							);
							this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
							return null;
						}
						nestedChildren = compactNestedResultChildren(projected.value?.children);
					}
				}
			}
			return {
				data: sessionData,
				file,
				nestedChildren,
				persistedStatus,
				rawResult,
				resultPath,
				resultSnapshot,
				runId,
				epoch,
				statusChildren,
				terminalStatusReady,
				triggerTurn,
			};
		});
	}

	private buildCompletion(
		loaded: LoadedResult,
		delivery: ResultDeliveryState,
	): Effect.Effect<CompletionProjection, unknown> {
		return Effect.gen({ self: this }, function* () {
			const { data, nestedChildren, persistedStatus, runId, statusChildren, triggerTurn } = loaded;
			const persistedResults = Array.isArray(data.results) && data.results.length > 0 ? data.results : undefined;
			const fallbackChild: ResultFileChild = {};
			if (isRuntimeString(data.agent)) fallbackChild.agent = data.agent;
			if (data.summary !== undefined) fallbackChild.output = data.summary;
			if (data.success !== undefined) fallbackChild.success = data.success;
			const resultChildren: ResultFileChild[] = persistedResults ?? [fallbackChild];
			const sessionPaths = yield* Effect.forEach(
				resultChildren,
				(result) => {
					const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
					return isRuntimeString(sessionPath)
						? this.fileExists(sessionPath).pipe(Effect.map((exists) => (exists ? sessionPath : undefined)))
						: Effect.succeed(undefined);
				},
				{ concurrency: "unbounded" },
			);
			const normalizedChildren = attachNestedChildrenToResultChildren(
				runId,
				resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
					const baseOutput = result.output ?? data.summary;
					const hasRealOutput = isRuntimeString(baseOutput) && baseOutput.trim().length > 0;
					const output = hasRealOutput ? baseOutput : "(no output)";
					const summary =
						result.success === false && result.error
							? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
							: output;
					const sessionPath = sessionPaths[index];
					const childNestedChildren = sanitizeNestedResultChildren(
						result.children,
						loaded.resultPath,
						`results[${index}].children`,
					);
					const childState =
						result.state === "paused" || result.state === "stopped"
							? result.state
							: result.stopped === true
								? "stopped"
								: result.interrupted === true
									? "paused"
									: persistedResults === undefined &&
											(data.state === "paused" ||
												data.state === "stopped" ||
												!isRuntimeBoolean(result.success))
										? data.state
										: undefined;
					const statusInput: Parameters<typeof resolveSubagentResultStatus>[0] = {};
					if (childState !== undefined) statusInput.state = childState;
					if (isRuntimeBoolean(result.success)) statusInput.success = result.success;
					const child: SubagentResultIntercomChild = {
						agent: result.agent ?? data.agent ?? `step-${index + 1}`,
						status: resolveSubagentResultStatus(statusInput),
						summary,
						index,
					};
					if (result.artifactPaths?.outputPath) child.artifactPath = result.artifactPaths.outputPath;
					if (sessionPath) child.sessionPath = sessionPath;
					if (result.intercomTarget) child.intercomTarget = result.intercomTarget;
					if (result.cumulativeUsage) child.cumulativeUsage = { ...result.cumulativeUsage };
					if (result.terminalOutcome) child.terminalOutcome = structuredClone(result.terminalOutcome);
					const publicChildren = compactNestedResultChildren(childNestedChildren);
					if (publicChildren) child.children = publicChildren;
					return child;
				}),
				nestedChildren,
			);
			const mode =
				data.mode === "parallel" || (data.mode !== "single" && resultChildren.length > 1) ? "parallel" : "single";
			const projectedResults = Array.isArray(data.results)
				? persistedResults !== undefined
					? normalizedChildren.map((child, index) => ({
							...pickFields(persistedResults?.[index] ?? {}, RESULT_CHILD_FIELDS),
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							index: child.index,
							artifactPath: child.artifactPath,
							sessionPath: child.sessionPath,
							children: child.children,
						}))
					: []
				: undefined;
			const completion: CompletionNotification = {
				...pickFields(data, COMPLETION_FIELDS),
				id: data.id ?? runId,
				runId,
				deliveryId: stableDeliveryId(delivery.completionKey),
				mode,
				triggerTurn,
			};
			if (
				persistedStatus?.parentRunOrigin === "user" ||
				nestedWorkIncludesUser(statusChildren) ||
				nestedWorkIncludesUser(nestedChildren)
			)
				completion.parentRunOrigin = "user";
			if (this.activeSessionId) completion.sessionId = this.activeSessionId;
			if (nestedChildren?.length) completion.nestedChildren = nestedChildren;
			if (projectedResults) completion.results = projectedResults;
			return { completion, intercomTarget: data.intercomTarget?.trim() ?? "", mode, normalizedChildren };
		});
	}

	private deliverCompletion(
		loaded: LoadedResult,
		delivery: ResultDeliveryState,
		projection: CompletionProjection,
	): Effect.Effect<void, unknown> {
		return Effect.gen({ self: this }, function* () {
			const { data, file, resultPath, runId, epoch, terminalStatusReady, triggerTurn } = loaded;
			const { completionKey } = delivery;
			const { completion, intercomTarget, mode, normalizedChildren } = projection;
			const { notifier, pi, resultsDir, state, completionTtlMs } = this.options;
			let deliveryState = delivery;
			let intercomDelivered = deliveryState.intercomDelivered;
			// `triggerTurn` only controls the local notifier. An explicitly addressed
			// intercom result remains a durable cold-start delivery obligation.
			const shouldDeliverIntercom = Boolean(intercomTarget);
			if (!deliveryState.intercomComplete && shouldDeliverIntercom) {
				if (!this.ownsSession(data.sessionId, runId, epoch)) return;
				const payloadInput: Parameters<typeof buildSubagentResultIntercomPayload>[0] = {
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: normalizedChildren,
				};
				if (isRuntimeString(data.id)) payloadInput.asyncId = data.id;
				if (data.asyncDir !== undefined) payloadInput.asyncDir = data.asyncDir;
				const payload = buildSubagentResultIntercomPayload(payloadInput);
				intercomDelivered = yield* deliverSubagentResultIntercomEvent(pi.events, {
					...payload,
					requestId: stableDeliveryId(completionKey),
				});
				if (!intercomDelivered)
					reportAgentDiagnostic(
						`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`,
					);
			}
			if (!this.ownsSession(data.sessionId, runId, epoch)) return;
			if (!shouldDeliverIntercom || intercomDelivered) {
				deliveryState = {
					...deliveryState,
					intercomComplete: true,
					intercomDelivered,
					updatedAt: Date.now(),
				};
				yield* writeDeliveryState(resultsDir, file, deliveryState);
			}
			if (!this.ownsSession(data.sessionId, runId, epoch)) return;
			completion.intercomDelivered = intercomDelivered;
			if (!deliveryState.notificationAccepted) {
				const accepted = yield* deliverNotification(notifier, completion);
				if (!accepted) {
					if (this.ownsSession(data.sessionId, runId, epoch))
						this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
					return;
				}
				deliveryState = { ...deliveryState, notificationAccepted: true, updatedAt: Date.now() };
				yield* writeDeliveryState(resultsDir, file, deliveryState);
			}
			if (!this.ownsSession(data.sessionId, runId, epoch)) return;
			markSeenWithTtl(state.completionSeen, completionKey, Date.now(), completionTtlMs);
			if (!terminalStatusReady) this.deliveredPendingStatus.add(completionKey);
			if (!deliveryState.completionEmitted) {
				try {
					pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion);
				} catch (error) {
					reportAgentDiagnostic(`Completion observer failed for '${resultPath}':`, error);
				}
				deliveryState = { ...deliveryState, completionEmitted: true, updatedAt: Date.now() };
				yield* writeDeliveryState(resultsDir, file, deliveryState);
			}
			if (!this.ownsSession(data.sessionId, runId, epoch) || !(yield* this.fileExists(resultPath))) return;
			// Local completion may already be durable, but an explicitly addressed
			// result is not disposable until its intercom delivery is acknowledged.
			if (!deliveryState.intercomComplete) {
				this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
				return;
			}
			if (!terminalStatusReady) {
				this.scheduleStatusRepair(file, triggerTurn);
				return;
			}
			yield* this.removeDeliveredResult(loaded, completionKey);
		});
	}

	readonly handleResult = (file: string, triggerTurn: boolean): Effect.Effect<void, unknown> =>
		Effect.gen({ self: this }, function* () {
			if (path.basename(file) !== file || !file.endsWith(".json")) {
				this.reportStatusRepair(file, `Ignoring unsafe subagent result entry '${file}'.`);
				return;
			}
			const { resultsDir } = this.options;
			const resultPath = path.join(resultsDir, file);
			if (this.processing.has(file) || !(yield* this.fileExists(resultPath))) return;
			const ignoredFingerprint = this.ignoredResultFingerprints.get(file);
			if (ignoredFingerprint) {
				const fingerprint = yield* Effect.tryPromise({
					try: () => fs.promises.lstat(resultPath),
					catch: () => undefined,
				}).pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (fingerprint && sameFileVersion(ignoredFingerprint, fingerprint)) return;
				this.ignoredResultFingerprints.delete(file);
			}
			const attemptEpoch = this.deliveryEpoch;
			const token = Symbol(file);
			let durableClaim: DurableClaim | undefined;
			this.processing.set(file, token);
			yield* Effect.gen({ self: this }, function* () {
				durableClaim = this.options.acquireClaim(resultsDir, deliveryClaimName(file));
				if (!durableClaim) {
					this.options.scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
					return;
				}
				const loaded = yield* this.loadResult(file, resultPath, attemptEpoch, triggerTurn);
				if (!loaded) return;
				const { completionTtlMs, state } = this.options;
				const completionKey = buildCompletionKey(loaded.data, `result:${file}`);
				const digest = resultDigest(loaded.rawResult);
				const restoredDelivery = yield* readDeliveryState(resultsDir, file, completionKey, digest);
				const delivery =
					restoredDelivery ??
					({
						version: 1,
						completionKey,
						resultDigest: digest,
						intercomComplete: false,
						intercomDelivered: false,
						notificationAccepted: false,
						completionEmitted: false,
						updatedAt: Date.now(),
					} satisfies ResultDeliveryState);
				const lastSeenAt = state.completionSeen.get(completionKey);
				if (
					lastSeenAt !== undefined &&
					!this.deliveredPendingStatus.has(completionKey) &&
					Date.now() - lastSeenAt > completionTtlMs
				) {
					state.completionSeen.delete(completionKey);
				} else if (
					(lastSeenAt !== undefined || this.deliveredPendingStatus.has(completionKey)) &&
					(!restoredDelivery ||
						(restoredDelivery.intercomComplete &&
							restoredDelivery.notificationAccepted &&
							restoredDelivery.completionEmitted))
				) {
					if (
						!this.ownsSession(loaded.data.sessionId, loaded.runId, loaded.epoch) ||
						!(yield* this.fileExists(resultPath))
					) {
						return;
					}
					if (!loaded.terminalStatusReady) {
						this.scheduleStatusRepair(file, triggerTurn);
						return;
					}
					yield* this.removeDeliveredResult(loaded, completionKey);
					return;
				}
				const projection = yield* this.buildCompletion(loaded, delivery);
				yield* this.deliverCompletion(loaded, delivery, projection);
			}).pipe(
				Effect.catch((error) =>
					Effect.gen({ self: this }, function* () {
						if (isNotFound(error)) return;
						const now = Date.now();
						const last = this.processRetryLastLog.get(file) ?? 0;
						if (now - last >= STATUS_REPAIR_LOG_INTERVAL_MS) {
							this.processRetryLastLog.set(file, now);
							reportAgentDiagnostic(
								`Failed to process subagent result file '${resultPath}'; will retry:`,
								error,
							);
						}
						if (
							this.activeSessionId !== undefined &&
							attemptEpoch === this.deliveryEpoch &&
							(yield* this.fileExists(resultPath))
						) {
							const delay = this.processRetryDelay.get(file) ?? PROCESS_RETRY_INITIAL_MS;
							this.processRetryDelay.set(file, Math.min(PROCESS_RETRY_MAX_MS, delay * 2));
							this.options.scheduleResult(file, triggerTurn, delay);
						}
					}),
				),
				Effect.ensuring(
					Effect.sync(() => {
						try {
							durableClaim?.release();
						} catch (releaseError) {
							reportAgentDiagnostic(
								`Failed to release subagent result claim for '${resultPath}':`,
								releaseError,
							);
						}
						// A restarted attempt may already own this file; never clear its lock.
						if (this.processing.get(file) === token) this.processing.delete(file);
					}),
				),
			);
		});
}
