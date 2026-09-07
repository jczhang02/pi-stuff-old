import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { CERTIFIED_RTK_VERSION, RtkRuntime } from "../../../packages/pi-stuff/src/rtk/runtime.js";

const temporaryDirectories: string[] = [];

function run<Value, ErrorType>(program: Effect.Effect<Value, ErrorType>): Promise<Value> {
	return Effect.runPromise(program);
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fakeBinary(content = "fixture-rtk"): Promise<{ path: string; sha256: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-runtime-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "rtk");
	await writeFile(path, content);
	await chmod(path, 0o755);
	const sha256 = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	return { path, sha256 };
}

function result(stdout = "", code = 0, options: { killed?: boolean; stderr?: string } = {}) {
	return {
		code,
		killed: options.killed ?? false,
		stderr: options.stderr ?? "",
		stdout,
	};
}

test("rejects an unsupported version before attempting a rewrite", async () => {
	const binary = await fakeBinary();
	let rewrites = 0;
	// SAFETY: this test supplies the only Host operation exercised by this runtime.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") return result("rtk 0.44.0\n");
			rewrites += 1;
			return result("rtk git status\n", 3);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();
	expect(await run(runtime.rewrite(pi, "git status"))).toBeUndefined();
	expect(rewrites).toBe(0);
	expect(runtime.snapshot()).toMatchObject({ state: "unavailable" });
	expect(runtime.snapshot().lastError).toContain("0.44.0");
});

test("bounds runtime errors by terminal cells", async () => {
	const runtime = new RtkRuntime();
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	await run(
		runtime.verify({
			exec: async () => {
				throw new Error(`\u001b[31m${"失败😀".repeat(100)}\u001b[0m`);
			},
		} as Pick<ExtensionAPI, "exec">),
	);
	const error = runtime.snapshot().lastError ?? "";
	expect(visibleWidth(error)).toBeLessThanOrEqual(220 + visibleWidth("RTK verification failed: "));
	expect(error).not.toContain("\u001b");
});

test("verifies one executable and preserves the selected path for rewrites", async () => {
	const binary = await fakeBinary();
	const selectedPath = `${binary.path}.shim`;
	await symlink(binary.path, selectedPath);
	const calls: Array<{ args: string[]; command: string }> = [];
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			calls.push({ args, command });
			if (command === "which") return result(`${selectedPath}\n`);
			if (args[0] === "--version") return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			if (args[0] === "rewrite") return result("rtk git status\n", 3);
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "git status"))).toBe("rtk git status");
	expect(runtime.snapshot()).toMatchObject({
		path: binary.path,
		sha256: binary.sha256,
		state: "ready",
		version: CERTIFIED_RTK_VERSION,
	});
	expect(calls.some((call) => call.command === selectedPath && call.args[0] === "rewrite")).toBe(true);
});

test("keeps the original command when RTK is missing and avoids repeated probes", async () => {
	let probes = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async () => {
			probes += 1;
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "git status"))).toBeUndefined();
	expect(await run(runtime.rewrite(pi, "git diff"))).toBeUndefined();
	expect(probes).toBe(1);
	expect(runtime.snapshot().state).toBe("unavailable");
});

test("accepts source builds but rejects a version change behind an unchanged shim", async () => {
	const binary = await fakeBinary();
	let rewriteCalls = 0;
	let dispatchedVersion = CERTIFIED_RTK_VERSION;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") return result(`rtk ${dispatchedVersion}\n`);
			if (args[0] === "rewrite") rewriteCalls += 1;
			return result("rtk git status\n", 3);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "git status"))).toBe("rtk git status");
	expect(rewriteCalls).toBe(1);
	expect(runtime.snapshot()).toMatchObject({ state: "ready" });
	dispatchedVersion = "0.44.0";
	expect(await run(runtime.rewrite(pi, "git status"))).toBeUndefined();
	expect(rewriteCalls).toBe(1);
	expect(runtime.snapshot()).toMatchObject({ state: "drifted" });
	expect(runtime.snapshot().lastError).toContain("0.44.0");
});

test("fails open on timeout and stops retrying the slow executable", async () => {
	const binary = await fakeBinary();
	let rewriteCalls = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[], options?: { signal?: AbortSignal }) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			if (args[0] === "rewrite") {
				rewriteCalls += 1;
				await new Promise<void>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
				});
			}
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime({ rewriteTimeoutMs: 5 });

	expect(await run(runtime.rewrite(pi, "git status"))).toBeUndefined();
	expect(await run(runtime.rewrite(pi, "git diff"))).toBeUndefined();
	expect(rewriteCalls).toBe(1);
	expect(runtime.snapshot()).toMatchObject({ lastError: "RTK rewrite timed out", state: "unavailable" });
});

test("deduplicates ordinary verification while serializing explicit refreshes", async () => {
	const binary = await fakeBinary();
	const releaseVersion = Promise.withResolvers<void>();
	let resolverCalls = 0;
	let versionCalls = 0;
	let waiting = true;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") {
				resolverCalls += 1;
				return result(`${binary.path}\n`);
			}
			if (args[0] === "--version") {
				versionCalls += 1;
				if (waiting) await releaseVersion.promise;
				return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			}
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	const first = run(runtime.verify(pi));
	const second = run(runtime.verify(pi));
	for (let attempt = 0; attempt < 20 && versionCalls === 0; attempt += 1) await Bun.sleep(1);
	expect(resolverCalls).toBe(1);
	expect(versionCalls).toBe(1);
	waiting = false;
	releaseVersion.resolve();
	expect((await Promise.all([first, second])).map(({ state }) => state)).toEqual(["ready", "ready"]);

	await Promise.all([run(runtime.verify(pi, { refresh: true })), run(runtime.verify(pi, { refresh: true }))]);
	expect(resolverCalls).toBe(3);
	expect(versionCalls).toBe(3);
});

test("reset invalidates an in-flight certification before it can publish", async () => {
	const binary = await fakeBinary();
	const releaseVersion = Promise.withResolvers<void>();
	let versionCalls = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") {
				versionCalls += 1;
				if (versionCalls === 1) await releaseVersion.promise;
				return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			}
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();
	const stale = run(runtime.verify(pi));
	for (let attempt = 0; attempt < 20 && versionCalls === 0; attempt += 1) await Bun.sleep(1);

	runtime.reset();
	releaseVersion.resolve();
	expect((await stale).state).toBe("unchecked");
	expect(runtime.snapshot().state).toBe("unchecked");
	expect((await run(runtime.verify(pi))).state).toBe("ready");
	expect(versionCalls).toBe(2);
});

test("interrupted certification stays unchecked and can be retried", async () => {
	const binary = await fakeBinary();
	let blockVersion = true;
	let versionCalls = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[], options?: { signal?: AbortSignal }) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") {
				versionCalls += 1;
				if (blockVersion) {
					await new Promise<void>((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
					});
				}
				return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			}
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();
	const controller = new AbortController();
	const interrupted = Effect.runPromise(runtime.verify(pi), { signal: controller.signal });
	for (let attempt = 0; attempt < 20 && versionCalls === 0; attempt += 1) await Bun.sleep(1);
	controller.abort();

	await expect(interrupted).rejects.toThrow();
	expect(runtime.snapshot().state).toBe("unchecked");
	blockVersion = false;
	expect((await run(runtime.verify(pi))).state).toBe("ready");
	expect(versionCalls).toBe(2);
});

test("detects path and executable drift before running rewritten commands", async () => {
	const first = await fakeBinary("first");
	const second = await fakeBinary("second");
	let selectedPath = first.path;
	let rewriteCalls = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") return result(`${selectedPath}\n`);
			if (args[0] === "--version") return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			if (args[0] === "rewrite") {
				rewriteCalls += 1;
				return result("rtk git status\n", 3);
			}
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "git status"))).toBe("rtk git status");
	selectedPath = second.path;
	expect(await run(runtime.rewrite(pi, "git diff"))).toBeUndefined();
	expect(rewriteCalls).toBe(1);
	expect(runtime.snapshot().state).toBe("drifted");
});

test("detects in-place binary drift and allows explicit re-certification", async () => {
	const binary = await fakeBinary("first");
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async (command: string, args: string[]) => {
			if (command === "which") return result(`${binary.path}\n`);
			if (args[0] === "--version") return result(`rtk ${CERTIFIED_RTK_VERSION}\n`);
			if (args[0] === "rewrite") return result("rtk git status\n", 3);
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "git status"))).toBeDefined();
	await writeFile(binary.path, "changed");
	expect(await run(runtime.rewrite(pi, "git status"))).toBeUndefined();
	expect(runtime.snapshot().state).toBe("drifted");

	const replacementRuntime = new RtkRuntime();
	expect((await run(replacementRuntime.verify(pi, { refresh: true }))).state).toBe("ready");
});

test("does not rewrite empty or already-RTK commands", async () => {
	let calls = 0;
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = {
		exec: async () => {
			calls += 1;
			return result("", 1);
		},
	} as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await run(runtime.rewrite(pi, "  "))).toBeUndefined();
	expect(await run(runtime.rewrite(pi, "rtk git status"))).toBeUndefined();
	expect(await run(runtime.rewrite(pi, "CI=1 rtk git status"))).toBeUndefined();
	expect(calls).toBe(0);
});
