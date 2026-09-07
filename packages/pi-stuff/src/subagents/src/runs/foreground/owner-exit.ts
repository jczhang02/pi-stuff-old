import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { readBoundedOwnedFile, readBoundedOwnedFileSnapshotAsync } from "../../shared/private-directory.ts";

const FOREGROUND_OWNER_EXIT_FILE = ".foreground-owner-ended.json";
const MAX_FOREGROUND_OWNER_EXIT_BYTES = 16 * 1024;
const MAX_FOREGROUND_OWNER_ERROR_CHARS = 8 * 1024;

export interface ForegroundOwnerExit {
	readonly version: 1;
	readonly runId: string;
	readonly endedAt: number;
	readonly error: string;
}

export function foregroundOwnerExitPath(asyncDir: string): string {
	return path.join(asyncDir, FOREGROUND_OWNER_EXIT_FILE);
}

/**
 * Persist the semantic owner boundary separately from status.json. A foreground
 * adapter runs inside the long-lived Pi Host, so PID liveness cannot prove that
 * its individual execution frame still exists after an exception.
 */
export function recordForegroundOwnerExit(asyncDir: string, runId: string, error: string): ForegroundOwnerExit {
	const value: ForegroundOwnerExit = {
		version: 1,
		runId,
		endedAt: Date.now(),
		error: error.slice(0, MAX_FOREGROUND_OWNER_ERROR_CHARS),
	};
	writePrivateAtomicJson(foregroundOwnerExitPath(asyncDir), value);
	return value;
}

function decodeForegroundOwnerExit<Value>(value: Value, runId: string): ForegroundOwnerExit | undefined {
	if (
		!isRuntimeObject(value) ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("runId" in value) ||
		value.runId !== runId ||
		!("endedAt" in value) ||
		!isRuntimeNumber(value.endedAt) ||
		!Number.isFinite(value.endedAt) ||
		value.endedAt < 0 ||
		!("error" in value) ||
		!isRuntimeString(value.error) ||
		value.error.length === 0 ||
		value.error.length > MAX_FOREGROUND_OWNER_ERROR_CHARS
	) {
		return undefined;
	}
	return { endedAt: value.endedAt, error: value.error, runId: value.runId, version: 1 };
}

export function readForegroundOwnerExit(asyncDir: string, runId: string): ForegroundOwnerExit | undefined {
	try {
		return decodeForegroundOwnerExit(
			parseJsonValue(readBoundedOwnedFile(foregroundOwnerExitPath(asyncDir), MAX_FOREGROUND_OWNER_EXIT_BYTES)),
			runId,
		);
	} catch {
		return undefined;
	}
}

export async function readForegroundOwnerExitAsync(
	asyncDir: string,
	runId: string,
): Promise<ForegroundOwnerExit | undefined> {
	try {
		return decodeForegroundOwnerExit(
			parseJsonValue(
				(
					await readBoundedOwnedFileSnapshotAsync(
						foregroundOwnerExitPath(asyncDir),
						MAX_FOREGROUND_OWNER_EXIT_BYTES,
					)
				).text,
			),
			runId,
		);
	} catch {
		return undefined;
	}
}
