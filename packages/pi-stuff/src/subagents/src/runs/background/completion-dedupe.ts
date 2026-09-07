import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	isFiniteRuntimeNumber as asFiniteNumber,
	isRuntimeBoolean,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJsonAsync } from "../../shared/atomic-json.ts";
import { shardedDurableClaimName } from "../../shared/durable-claim.ts";
import { readBoundedOwnedFileSnapshotAsync } from "../../shared/private-directory.ts";
import { isNotFoundError } from "../../shared/utils.ts";

const MAX_DELIVERY_STATE_BYTES = 16 * 1024;

export interface ResultDeliveryState {
	readonly version: 1;
	readonly completionKey: string;
	readonly resultDigest: string;
	readonly intercomComplete: boolean;
	readonly intercomDelivered: boolean;
	readonly notificationAccepted: boolean;
	readonly completionEmitted: boolean;
	readonly updatedAt: number;
}

interface CompletionDataLike {
	id?: unknown;
	agent?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	taskIndex?: unknown;
	totalTasks?: unknown;
	success?: unknown;
}

function asNonEmptyString<Value>(value: Value): string | undefined {
	if (!isRuntimeString(value)) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
	const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
	const id = asNonEmptyString(data.id);
	if (id) return `session:${sessionId}:id:${id}`;
	const agent = asNonEmptyString(data.agent) ?? "unknown";
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = isRuntimeBoolean(data.success) ? (data.success ? "1" : "0") : "?";
	return [
		"meta",
		sessionId,
		agent,
		timestamp !== undefined ? String(timestamp) : "no-ts",
		taskIndex !== undefined ? String(taskIndex) : "-",
		totalTasks !== undefined ? String(totalTasks) : "-",
		success,
		fallback,
	].join(":");
}

function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
	for (const [key, ts] of seen.entries()) {
		if (now - ts > ttlMs) seen.delete(key);
	}
}

export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}

function deliveryStatePath(resultsDir: string, file: string): string {
	return path.join(resultsDir, `.${file}.delivery-state`);
}

export function deliveryClaimName(file: string): string {
	return shardedDurableClaimName("result-delivery", file);
}

export function stableDeliveryId(completionKey: string): string {
	return `pi-stuff-result-${createHash("sha256").update(completionKey).digest("hex").slice(0, 32)}`;
}

export function resultDigest(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

function isResultDeliveryState(value: JsonValue): value is JsonObject & ResultDeliveryState {
	return (
		isRuntimeObject(value) &&
		value !== null &&
		!Array.isArray(value) &&
		value["version"] === 1 &&
		isRuntimeString(value["completionKey"]) &&
		isRuntimeString(value["resultDigest"]) &&
		isRuntimeBoolean(value["intercomComplete"]) &&
		isRuntimeBoolean(value["intercomDelivered"]) &&
		isRuntimeBoolean(value["notificationAccepted"]) &&
		isRuntimeBoolean(value["completionEmitted"]) &&
		asFiniteNumber(value["updatedAt"])
	);
}

export function readDeliveryState(
	resultsDir: string,
	file: string,
	completionKey: string,
	digest: string,
): Effect.Effect<ResultDeliveryState | undefined> {
	return Effect.tryPromise({
		try: () => readBoundedOwnedFileSnapshotAsync(deliveryStatePath(resultsDir, file), MAX_DELIVERY_STATE_BYTES),
		catch: () => undefined,
	}).pipe(
		Effect.map((snapshot) => {
			const value = parseJsonValue(snapshot.text);
			if (!isResultDeliveryState(value) || value.completionKey !== completionKey || value.resultDigest !== digest) {
				return undefined;
			}
			return value;
		}),
		Effect.catch(() => Effect.succeed(undefined)),
	);
}

export function writeDeliveryState(
	resultsDir: string,
	file: string,
	state: ResultDeliveryState,
): Effect.Effect<void, unknown> {
	return Effect.tryPromise({
		try: () => writePrivateAtomicJsonAsync(deliveryStatePath(resultsDir, file), state),
		catch: (error) => error,
	});
}

export function removeDeliveryArtifacts(resultsDir: string, file: string): Effect.Effect<void, unknown> {
	return Effect.tryPromise({
		try: () => fs.promises.unlink(deliveryStatePath(resultsDir, file)),
		catch: (error) => error,
	}).pipe(Effect.catch((error) => (isNotFoundError(error) ? Effect.void : Effect.fail(error))));
}
