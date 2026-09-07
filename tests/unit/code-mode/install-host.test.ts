import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodeModeHost } from "../../../packages/pi-stuff/src/code-mode/host/install-host.js";

test("host installation releases its lock when temporary staging cannot start", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-installer-"));
	const invalidTemporaryRoot = join(directory, "not-a-directory");
	const destination = join(directory, "cache", "codex-code-mode-host");
	await writeFile(invalidTemporaryRoot, "fixture");
	try {
		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				temporaryDirectory: invalidTemporaryRoot,
			}),
		).rejects.toThrow();
		expect(await Bun.file(`${destination}.lock`).exists()).toBe(false);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("stale-age recovery never steals a lock from a live installer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-live-lock-"));
	const destination = join(directory, "cache", "codex-code-mode-host");
	const lockPath = `${destination}.lock`;
	try {
		await mkdir(lockPath, { recursive: true });
		await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`);
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);

		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				signal: AbortSignal.timeout(50),
			}),
		).rejects.toThrow();
		expect(await Bun.file(join(lockPath, "owner.json")).exists()).toBe(true);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("stale-age recovery reclaims a lock whose recorded owner is gone", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-dead-lock-"));
	const invalidTemporaryRoot = join(directory, "not-a-directory");
	const destination = join(directory, "cache", "codex-code-mode-host");
	const lockPath = `${destination}.lock`;
	try {
		await mkdir(lockPath, { recursive: true });
		await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" })}\n`);
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);
		await writeFile(invalidTemporaryRoot, "fixture");

		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				temporaryDirectory: invalidTemporaryRoot,
			}),
		).rejects.toThrow();
		expect(await Bun.file(lockPath).exists()).toBe(false);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("stale-age recovery reclaims a malformed legacy lock under the reclaim mutex", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-invalid-lock-"));
	const invalidTemporaryRoot = join(directory, "not-a-directory");
	const destination = join(directory, "cache", "codex-code-mode-host");
	const lockPath = `${destination}.lock`;
	try {
		await mkdir(lockPath, { recursive: true });
		await writeFile(join(lockPath, "owner.json"), "not-json\n");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);
		await writeFile(invalidTemporaryRoot, "fixture");

		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				temporaryDirectory: invalidTemporaryRoot,
			}),
		).rejects.toThrow();
		expect(await Bun.file(lockPath).exists()).toBe(false);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("acquisition removes an abandoned stale candidate without touching the active lock path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-candidate-cleanup-"));
	const invalidTemporaryRoot = join(directory, "not-a-directory");
	const destination = join(directory, "cache", "codex-code-mode-host");
	const candidate = `${destination}.lock.candidate-abandoned`;
	try {
		await mkdir(candidate, { recursive: true });
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(candidate, old, old);
		await writeFile(invalidTemporaryRoot, "fixture");

		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				temporaryDirectory: invalidTemporaryRoot,
			}),
		).rejects.toThrow();
		expect(await Bun.file(candidate).exists()).toBe(false);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("stale-age recovery distinguishes a reused live pid from the original process identity", async () => {
	if (process.platform !== "linux") return;
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-reused-pid-lock-"));
	const invalidTemporaryRoot = join(directory, "not-a-directory");
	const destination = join(directory, "cache", "codex-code-mode-host");
	const lockPath = `${destination}.lock`;
	try {
		await mkdir(lockPath, { recursive: true });
		await writeFile(
			join(lockPath, "owner.json"),
			`${JSON.stringify({ pid: process.pid, processIdentity: "former-boot:1", token: "former-owner" })}\n`,
		);
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);
		await writeFile(invalidTemporaryRoot, "fixture");

		await expect(
			installCodeModeHost({
				arch: "x64",
				destination,
				platform: "linux",
				temporaryDirectory: invalidTemporaryRoot,
			}),
		).rejects.toThrow();
		expect(await Bun.file(lockPath).exists()).toBe(false);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
