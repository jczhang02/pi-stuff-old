import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { isRuntimeNumber } from "../../shared/runtime-type.ts";
import { getWebConfigPath } from "../settings.ts";

export function errorMessage<ErrorValue>(error: ErrorValue): string {
	return error instanceof Error ? error.message : String(error);
}

export function getWebSearchConfigPath(): string {
	return getWebConfigPath();
}

export function isAbortError<ErrorValue>(error: ErrorValue): boolean {
	return errorMessage(error).toLowerCase().includes("abort");
}

export function normalizeCount(value: number | undefined, fallback = 5, maximum = 20): number {
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(Math.floor(value), maximum));
}

export function normalizeHeaders(headers: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

export function nativePromise<Value>(
	request: (signal: AbortSignal) => PromiseLike<Value>,
	signal?: AbortSignal,
): Effect.Effect<Value, Error> {
	return Effect.tryPromise({
		try: (effectSignal) => request(signal ? AbortSignal.any([signal, effectSignal]) : effectSignal),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

export function nativeRequest<Value>(
	request: (signal: AbortSignal) => PromiseLike<Value>,
	timeoutMs: number,
	signal?: AbortSignal,
	onTimeout: () => Error = () => new DOMException("The operation timed out.", "TimeoutError"),
): Effect.Effect<Value, Error> {
	return nativePromise(request, signal).pipe(
		Effect.timeout(Math.max(0, timeoutMs)),
		Effect.mapError((error) => (Cause.isTimeoutError(error) ? onTimeout() : error)),
	);
}

export function formatSearchSources(
	results: readonly { readonly snippet?: string; readonly title: string; readonly url: string }[],
): string {
	return results
		.map((result) =>
			result.snippet
				? `${result.snippet}\nSource: ${result.title} (${result.url})`
				: `Source: ${result.title} (${result.url})`,
		)
		.join("\n\n");
}
