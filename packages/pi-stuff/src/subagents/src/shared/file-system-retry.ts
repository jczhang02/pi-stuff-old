import { isRuntimeObject, isRuntimeString, isRuntimeUndefined } from "../../../shared/runtime-type.ts";

const WAIT_BUFFER = isRuntimeUndefined(globalThis.SharedArrayBuffer) ? undefined : new globalThis.SharedArrayBuffer(4);
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
const RETRYABLE_FILE_SYSTEM_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

export type FileSystemRetryOptions = {
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

export function waitForFileSystemRetry(delayMs: number): void {
	if (delayMs <= 0) return;
	if (WAIT_VIEW) {
		try {
			// Callers are synchronous status/result writers; Atomics.wait gives
			// Windows directory and rename locks time to clear without burning CPU.
			Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
			return;
		} catch {
			// Fall through to the portable busy wait below.
		}
	}
	const end = Date.now() + delayMs;
	while (Date.now() < end) {
		// Portable fallback for runtimes where Atomics.wait is unavailable.
	}
}

export function isRetryableFileSystemError(cause: unknown): boolean {
	const code = isRuntimeObject(cause) && cause !== null && "code" in cause ? cause.code : undefined;
	return isRuntimeString(code) && RETRYABLE_FILE_SYSTEM_ERROR_CODES.has(code);
}

export function runFileSystemOperationWithRetry<T>(operation: () => T, options: FileSystemRetryOptions = {}): T {
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const wait = options.wait ?? waitForFileSystemRetry;
	for (let attempt = 0; ; attempt++) {
		try {
			return operation();
		} catch (error) {
			const delayMs = retryDelaysMs[attempt];
			if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
			wait(delayMs);
		}
	}
}

/** Async retry lane for Host-side filesystem work that must not block input/rendering. */
export async function runFileSystemOperationWithRetryAsync<T>(
	operation: () => Promise<T>,
	options: Pick<FileSystemRetryOptions, "retryDelaysMs"> = {},
): Promise<T> {
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			const delayMs = retryDelaysMs[attempt];
			if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}
