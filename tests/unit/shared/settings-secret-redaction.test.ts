import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { readSettingsFileEffect } from "../../../packages/pi-stuff/src/shared/settings-io/file.js";

test("malformed merged settings never quote credential bytes in parser errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-settings-secret-"));
	const path = join(root, "pi-stuff.json");
	try {
		await writeFile(path, '{"web":{"apiKey":sk-live-secret}}');
		await expect(Effect.runPromise(readSettingsFileEffect(path))).rejects.toThrow("contains invalid JSON");
		try {
			await Effect.runPromise(readSettingsFileEffect(path));
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).not.toContain("sk-live-secret");
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
