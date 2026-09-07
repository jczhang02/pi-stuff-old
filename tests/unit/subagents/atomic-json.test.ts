import { expect, test } from "bun:test";
import { createAtomicTextWriter } from "../../../packages/pi-stuff/src/subagents/src/shared/atomic-json.js";

test("atomic cleanup cannot mask the original write failure", () => {
	const writeFailure = Object.assign(new Error("storage full"), { code: "ENOSPC" });
	const cleanupFailure = new Error("cleanup failed");
	const write = createAtomicTextWriter({
		// SAFETY: This fake implements every synchronous filesystem member used by the writer.
		fs: {
			mkdirSync() {},
			writeFileSync() {
				throw writeFailure;
			},
			renameSync() {},
			rmSync() {
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
});
