// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript enforces bracket access for untrusted index-signature data.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { type JsonInputObject, type JsonInputValue, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { type CodexAccountContext, resolveCodexAccount } from "./account.ts";

const USAGE_TIMEOUT_MS = 10_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

interface CodexUsageWindow {
	readonly resetsAt?: number;
	readonly usedPercent?: number;
	readonly windowMinutes?: number;
}

export interface CodexUsageSnapshot {
	readonly fiveHour?: CodexUsageWindow;
	readonly plan?: string;
	readonly weekly?: CodexUsageWindow;
}

type CodexUsageWindowBuilder = { -readonly [Key in keyof CodexUsageWindow]: CodexUsageWindow[Key] };
type CodexUsageSnapshotBuilder = { -readonly [Key in keyof CodexUsageSnapshot]: CodexUsageSnapshot[Key] };

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: JsonInputValue): JsonInputObject | undefined {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return undefined;
	// SAFETY: JsonInputValue leaves only JsonInputObject after excluding null, scalars, and arrays.
	return value as JsonInputObject;
}

function finiteNumber(value: JsonInputValue): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function text(value: JsonInputValue): string | undefined {
	return isRuntimeString(value) && value.trim() ? value.trim() : undefined;
}

function parseWindow(value: JsonInputValue): CodexUsageWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const seconds = finiteNumber(source["limit_window_seconds"]);
	const usedPercent = finiteNumber(source["used_percent"]);
	const windowMinutes = finiteNumber(source["window_minutes"]) ?? (seconds === undefined ? undefined : seconds / 60);
	const resetsAt = finiteNumber(source["resets_at"]) ?? finiteNumber(source["reset_at"]);
	if (usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined) return undefined;
	const parsed: CodexUsageWindowBuilder = {};
	if (resetsAt !== undefined) parsed.resetsAt = resetsAt;
	if (usedPercent !== undefined) parsed.usedPercent = usedPercent;
	if (windowMinutes !== undefined) parsed.windowMinutes = windowMinutes;
	return parsed;
}

export function parseCodexUsage(value: JsonInputValue): CodexUsageSnapshot {
	const root = record(value) ?? {};
	const rateLimit = record(root["rate_limit"]) ?? {};
	let fiveHour = parseWindow(rateLimit["primary_window"] ?? rateLimit["primary"]);
	let weekly = parseWindow(rateLimit["secondary_window"] ?? rateLimit["secondary"]);
	if (fiveHour?.windowMinutes === WEEKLY_WINDOW_MINUTES && weekly === undefined) {
		weekly = fiveHour;
		fiveHour = undefined;
	}
	const plan = text(root["plan_type"]);
	const snapshot: CodexUsageSnapshotBuilder = {};
	if (fiveHour) snapshot.fiveHour = fiveHour;
	if (plan) snapshot.plan = plan;
	if (weekly) snapshot.weekly = weekly;
	return snapshot;
}

export function weeklyRemainingPercent(snapshot: CodexUsageSnapshot | undefined): number | undefined {
	const used = snapshot?.weekly?.usedPercent;
	return used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used));
}

export function buildCodexUsageUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/u, "");
	try {
		const url = new URL(normalized);
		if (url.hostname === "chatgpt.com") return `${url.origin}/backend-api/wham/usage`;
	} catch {
		// Retain the bounded string fallback for a configured compatible endpoint.
	}
	const apiBase = normalized.endsWith("/codex/responses")
		? normalized.slice(0, -"/codex/responses".length)
		: normalized.endsWith("/codex")
			? normalized.slice(0, -"/codex".length)
			: normalized.endsWith("/backend-api")
				? normalized
				: `${normalized}/backend-api`;
	return `${apiBase}/wham/usage`;
}

export function fetchCodexUsage(
	ctx: CodexAccountContext,
	fetcher: Fetcher = fetch,
	timeoutMs = USAGE_TIMEOUT_MS,
): Effect.Effect<CodexUsageSnapshot, Error> {
	return Effect.gen(function* () {
		if (process.env["PI_OFFLINE"] === "1") {
			return yield* Effect.fail(new Error("Codex usage is unavailable in offline mode."));
		}
		const account = yield* Effect.tryPromise({
			try: () => resolveCodexAccount(ctx),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		const headers = new Headers(account.headers);
		headers.set("authorization", `Bearer ${account.token}`);
		headers.set("chatgpt-account-id", account.accountId);
		headers.set("accept", "application/json");
		headers.set("oai-language", "en");
		headers.set("originator", "pi");
		const { body, response } = yield* Effect.tryPromise({
			try: async (signal) => {
				const response = await fetcher(buildCodexUsageUrl(account.baseUrl), { headers, signal });
				return { body: await response.text(), response };
			},
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		}).pipe(
			Effect.timeout(Math.max(0, timeoutMs)),
			Effect.mapError((error) =>
				Cause.isTimeoutError(error) ? new Error("Codex usage request timed out.") : error,
			),
		);
		if (!response.ok)
			return yield* Effect.fail(new Error(`Codex usage request failed (${String(response.status)}).`));
		return yield* Effect.try({
			try: () => parseCodexUsage(parseJsonValue(body)),
			catch: () => new Error("Codex usage returned invalid JSON."),
		});
	});
}

function remaining(window: CodexUsageWindow | undefined): string {
	if (window?.usedPercent === undefined) return "unknown";
	return `${String(Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))))}% left`;
}

function resetText(window: CodexUsageWindow | undefined): string | undefined {
	if (!window?.resetsAt) return undefined;
	const minutes = Math.max(0, Math.round((window.resetsAt * 1000 - Date.now()) / 60_000));
	return minutes < 90
		? `resets in ~${String(minutes)}m`
		: `resets ${new Date(window.resetsAt * 1000).toLocaleString()}`;
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot): string {
	const lines: string[] = [];
	if (snapshot.weekly) {
		const weeklyReset = resetText(snapshot.weekly);
		lines.push(`Weekly ${remaining(snapshot.weekly)}${weeklyReset ? ` · ${weeklyReset}` : ""}`);
	}
	if (snapshot.fiveHour) {
		const fiveHourReset = resetText(snapshot.fiveHour);
		lines.push(`5h ${remaining(snapshot.fiveHour)}${fiveHourReset ? ` · ${fiveHourReset}` : ""}`);
	}
	return lines.join("\n") || "Usage unavailable";
}
