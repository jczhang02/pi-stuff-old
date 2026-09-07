import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
	runFileSystemOperationWithRetry,
	runFileSystemOperationWithRetryAsync,
	waitForFileSystemRetry,
} from "./file-system-retry.ts";

type AtomicFileFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;

type AtomicFileWriterOptions = {
	fs?: AtomicFileFs;
	now?: () => number;
	pid?: number;
	random?: () => number;
	mode?: number;
	retryRenameErrors?: boolean;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

function renameWithRetry(
	fsImpl: AtomicFileFs,
	sourcePath: string,
	targetPath: string,
	retryDelaysMs: readonly number[],
	wait: (delayMs: number) => void,
): void {
	runFileSystemOperationWithRetry(
		() => {
			fsImpl.renameSync(sourcePath, targetPath);
		},
		{ retryDelaysMs, wait },
	);
}

export function createAtomicTextWriter(
	options: AtomicFileWriterOptions = {},
): (filePath: string, content: string | Uint8Array) => void {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const random = options.random ?? Math.random;
	const mode = options.mode;
	const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
	const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
	const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
	const wait = options.wait ?? waitForFileSystemRetry;
	return (filePath: string, content: string | Uint8Array): void => {
		runFileSystemOperationWithRetry(
			() => {
				fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
			},
			{ retryDelaysMs: directoryRetryDelaysMs, wait },
		);
		const tempPath = path.join(
			path.dirname(filePath),
			`.${path.basename(filePath)}.${pid}.${now()}.${random().toString(36).slice(2)}.tmp`,
		);
		try {
			fsImpl.writeFileSync(tempPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
		} catch (error) {
			try {
				fsImpl.rmSync(tempPath, { force: true });
			} catch {
				// Preserve the original write or rename failure.
			}
			throw error;
		}
	};
}

export function createAtomicJsonWriter(
	options: AtomicFileWriterOptions = {},
): <Payload extends object>(filePath: string, payload: Payload) => void {
	const write = createAtomicTextWriter(options);
	return <Payload extends object>(filePath: string, payload: Payload): void => {
		write(filePath, JSON.stringify(payload, null, 2));
	};
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
export const writePrivateAtomicText = createAtomicTextWriter({ mode: 0o600 });

/** Host-side atomic writer; unlike the runner writer, retries never sleep the TUI thread. */
export async function writePrivateAtomicTextAsync(filePath: string, content: string): Promise<void> {
	const retryDelaysMs = process.platform === "win32" ? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [];
	await runFileSystemOperationWithRetryAsync(
		() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined),
		{ retryDelaysMs },
	);
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		await fs.promises.writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		await runFileSystemOperationWithRetryAsync(() => fs.promises.rename(tempPath, filePath), { retryDelaysMs });
	} catch (error) {
		try {
			await fs.promises.rm(tempPath, { force: true });
		} catch {
			// Preserve the original write or rename failure.
		}
		throw error;
	}
}

export async function writePrivateAtomicJsonAsync<Payload extends object>(
	filePath: string,
	payload: Payload,
): Promise<void> {
	await writePrivateAtomicTextAsync(filePath, JSON.stringify(payload, null, 2));
}
