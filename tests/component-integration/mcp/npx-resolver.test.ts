import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getNpxCachePath, resolveNpxBinary } from "../../../packages/pi-stuff/src/mcp/runtime/npx-resolver.js";

const roots: string[] = [];
const previousCacheHome = process.env["XDG_CACHE_HOME"];

afterEach(async () => {
	if (previousCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
	else process.env["XDG_CACHE_HOME"] = previousCacheHome;
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("NPX cache keeps valid entries when an unrelated entry is malformed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-npx-cache-"));
	roots.push(root);
	process.env["XDG_CACHE_HOME"] = root;
	const binary = join(root, "fixture-bin");
	await writeFile(binary, "fixture");
	const cachePath = getNpxCachePath();
	await mkdir(dirname(cachePath), { recursive: true });
	await writeFile(
		cachePath,
		JSON.stringify({
			entries: {
				[JSON.stringify(["npx", "fixture"])]: {
					isJs: false,
					resolvedAt: Date.now(),
					resolvedBin: binary,
				},
				broken: { resolvedBin: 7 },
			},
			version: 1,
		}),
	);

	expect(await resolveNpxBinary("npx", ["fixture"])).toEqual({
		binPath: binary,
		extraArgs: [],
		isJs: false,
	});
});
