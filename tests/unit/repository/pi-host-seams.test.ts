import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSeamRecords } from "../../../scripts/verify-pi-host-seams.ts";

test("Host seam polling ignores an unfinished last record but rejects malformed completed records", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-seams-test-"));
	try {
		const log = join(directory, "seams.jsonl");
		await writeFile(log, '{"phase":"clear-origin"}\n{"phase":');
		expect(await readSeamRecords(log)).toEqual([{ phase: "clear-origin" }]);
		await writeFile(log, '{"phase":}\n');
		await expect(readSeamRecords(log)).rejects.toThrow();
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
