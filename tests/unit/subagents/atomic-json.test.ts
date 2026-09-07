import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAtomicTextWriter,
	writePrivateAtomicText,
	writePrivateAtomicTextAsync,
} from "../../../packages/pi-stuff/src/subagents/src/shared/atomic-json.ts";

test("atomic cleanup cannot mask the original write failure", () => {
	const writeFailure = Object.assign(new Error("storage full"), { code: "ENOSPC" });
	const cleanupFailure = new Error("cleanup failed");
	let cleanupCalls = 0;
	const write = createAtomicTextWriter({
		// SAFETY: This fake implements every synchronous filesystem member used by the writer.
		fs: {
			mkdirSync() {},
			writeFileSync() {
				throw writeFailure;
			},
			renameSync() {},
			rmSync() {
				cleanupCalls += 1;
				throw cleanupFailure;
			},
		} as never,
	});

	let observed: unknown;
	try {
		write("/tmp/status.json", "running");
	} catch (error) {
		observed = error;
	}
	expect(observed).toBe(writeFailure);
	expect(cleanupCalls).toBe(1);
});

test.each(["sync", "async"] as const)("%s atomic publication does not clean an already-renamed file", async (mode) => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-stuff-atomic-cleanup-"));
	const filePath = join(directory, "status.json");
	fs.writeFileSync(filePath, "previous");
	const cleanup = mode === "sync" ? spyOn(fs, "rmSync") : spyOn(fs.promises, "rm");
	try {
		if (mode === "sync") writePrivateAtomicText(filePath, "complete");
		else await writePrivateAtomicTextAsync(filePath, "complete");
		expect(cleanup).toHaveBeenCalledTimes(0);
		expect(fs.readFileSync(filePath, "utf8")).toBe("complete");
		expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(directory)).toEqual(["status.json"]);
	} finally {
		cleanup.mockRestore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("async atomic failure cleans the partial file without masking the original error", async () => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-stuff-atomic-failure-"));
	const filePath = join(directory, "status.json");
	fs.writeFileSync(filePath, "previous");
	const failure = new Error("rename failed");
	const rename = spyOn(fs.promises, "rename").mockRejectedValue(failure);
	const cleanup = spyOn(fs.promises, "rm");
	try {
		await expect(writePrivateAtomicTextAsync(filePath, "replacement")).rejects.toBe(failure);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(fs.readdirSync(directory)).toEqual(["status.json"]);
		expect(fs.readFileSync(filePath, "utf8")).toBe("previous");
		cleanup.mockRejectedValue(new Error("cleanup failed"));
		await expect(writePrivateAtomicTextAsync(filePath, "replacement")).rejects.toBe(failure);
		expect(cleanup).toHaveBeenCalledTimes(2);
	} finally {
		rename.mockRestore();
		cleanup.mockRestore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
