import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	importFreshSuiteRuntime,
	loadSuiteRuntime,
	type SuiteRuntimeModule,
} from "../../../packages/pi-stuff/src/suite-loader.ts";

const TEMPORARY_ROOTS: string[] = [];

const FIRST_RUNTIME: SuiteRuntimeModule = {
	installPiStuff: () => undefined,
};
const SECOND_RUNTIME: SuiteRuntimeModule = {
	installPiStuff: () => undefined,
};

async function createSourceRoot(contents = "first\n"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-suite-loader-"));
	TEMPORARY_ROOTS.push(root);
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "nested", "runtime.ts"), contents);
	return root;
}

afterEach(async () => {
	await Promise.all(TEMPORARY_ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadSuiteRuntime", () => {
	test("deduplicates concurrent and repeated loads for unchanged Suite source", async () => {
		const sourceRoot = await createSourceRoot();
		let loadCount = 0;
		const load = async (): Promise<SuiteRuntimeModule> => {
			loadCount += 1;
			await Bun.sleep(5);
			return FIRST_RUNTIME;
		};

		const [first, concurrent] = await Promise.all([
			loadSuiteRuntime({ sourceRoot, load }),
			loadSuiteRuntime({ sourceRoot, load }),
		]);
		const repeated = await loadSuiteRuntime({ sourceRoot, load: async () => SECOND_RUNTIME });

		expect(first).toBe(FIRST_RUNTIME);
		expect(concurrent).toBe(FIRST_RUNTIME);
		expect(repeated).toBe(FIRST_RUNTIME);
		expect(loadCount).toBe(1);
	});

	test("does not block the Host event loop while fingerprinting Suite source", async () => {
		const sourceRoot = await createSourceRoot();
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});

		await loadSuiteRuntime({
			sourceRoot,
			load: async () => {
				expect(yielded).toBeTrue();
				return FIRST_RUNTIME;
			},
		});
	});

	test("invalidates the namespace when any nested Suite source changes", async () => {
		const sourceRoot = await createSourceRoot();
		let loadCount = 0;
		const modes: string[] = [];
		const first = await loadSuiteRuntime({
			sourceRoot,
			load: async (_fingerprint, mode) => {
				loadCount += 1;
				modes.push(mode);
				return FIRST_RUNTIME;
			},
		});
		await writeFile(join(sourceRoot, "nested", "runtime.ts"), "second version\n");
		const second = await loadSuiteRuntime({
			sourceRoot,
			load: async (_fingerprint, mode) => {
				loadCount += 1;
				modes.push(mode);
				return SECOND_RUNTIME;
			},
		});

		expect(first).toBe(FIRST_RUNTIME);
		expect(second).toBe(SECOND_RUNTIME);
		expect(loadCount).toBe(2);
		expect(modes).toEqual(["initial", "refresh"]);
	});

	test("evicts a rejected module promise so the next load can recover", async () => {
		const sourceRoot = await createSourceRoot();
		const modes: string[] = [];
		await expect(
			loadSuiteRuntime({
				sourceRoot,
				load: async (_fingerprint, mode) => {
					modes.push(mode);
					throw new Error("broken module");
				},
			}),
		).rejects.toThrow("broken module");

		const recovered = await loadSuiteRuntime({
			sourceRoot,
			load: async (_fingerprint, mode) => {
				modes.push(mode);
				return SECOND_RUNTIME;
			},
		});
		expect(recovered).toBe(SECOND_RUNTIME);
		expect(modes).toEqual(["initial", "refresh"]);
	});

	test("isolates caches belonging to different Package source roots", async () => {
		const firstRoot = await createSourceRoot();
		const secondRoot = await createSourceRoot();

		const first = await loadSuiteRuntime({ sourceRoot: firstRoot, load: async () => FIRST_RUNTIME });
		const second = await loadSuiteRuntime({ sourceRoot: secondRoot, load: async () => SECOND_RUNTIME });

		expect(first).toBe(FIRST_RUNTIME);
		expect(second).toBe(SECOND_RUNTIME);
	});
});

describe("importFreshSuiteRuntime", () => {
	test("re-evaluates changed static and dynamic source while reusing cached transforms", async () => {
		const sourceRoot = await createSourceRoot('export const version = "first";\n');
		const runtimePath = join(sourceRoot, "runtime.ts");
		await writeFile(
			runtimePath,
			'import { version } from "./nested/runtime.ts";\nexport { version };\nexport async function readDynamicVersion(): Promise<string> { return (await import("./nested/runtime.ts")).version; }\nexport function installPiStuff(): void {}\n',
		);
		const previousCacheHome = process.env["XDG_CACHE_HOME"];
		process.env["XDG_CACHE_HOME"] = join(sourceRoot, "cache");

		try {
			// SAFETY: the fixture source above defines readDynamicVersion with this exact signature.
			const first = (await importFreshSuiteRuntime(runtimePath)) as SuiteRuntimeModule & {
				readDynamicVersion: () => Promise<string>;
			};
			expect(await first.readDynamicVersion()).toBe("first");
			await writeFile(join(sourceRoot, "nested", "runtime.ts"), 'export const version = "second";\n');
			// SAFETY: the refreshed fixture retains the same runtime export contract.
			const second = (await importFreshSuiteRuntime(runtimePath)) as SuiteRuntimeModule & {
				readDynamicVersion: () => Promise<string>;
			};

			expect(first).toHaveProperty("version", "first");
			expect(second).toHaveProperty("version", "second");
			expect(await second.readDynamicVersion()).toBe("second");
			expect(await readdir(join(sourceRoot, "cache", "pi-stuff", "jiti"))).not.toHaveLength(0);
		} finally {
			if (previousCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
			else process.env["XDG_CACHE_HOME"] = previousCacheHome;
		}
	});
});
