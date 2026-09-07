import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	durableClaimBackendForPlatform,
	tryAcquireDurableClaim,
} from "../../../packages/pi-stuff/src/subagents/src/shared/durable-claim.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable cross-process claims", () => {
	test("excludes another process and releases the same stable inode after SIGKILL", async () => {
		if (process.platform !== "linux") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-durable-claim-process-"));
		roots.push(root);
		fs.chmodSync(root, 0o700);
		const moduleUrl = pathToFileURL(path.resolve("packages/pi-stuff/src/subagents/src/shared/durable-claim.ts")).href;
		const script = `
const { tryAcquireDurableClaim } = await import(${JSON.stringify(moduleUrl)});
const claim = tryAcquireDurableClaim(${JSON.stringify(root)}, "delivery");
if (!claim) process.exit(2);
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`;
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Child claim timed out: ${stderr}`)), 3_000);
				child.once("error", reject);
				child.stdout?.once("data", (chunk: Buffer) => {
					if (!chunk.toString("utf8").includes("ready")) return;
					clearTimeout(timeout);
					resolve();
				});
			});
			const lockPath = path.join(root, "delivery.lock");
			const heldIdentity = fs.statSync(lockPath);
			expect(tryAcquireDurableClaim(root, "delivery")).toBeUndefined();

			child.kill("SIGKILL");
			await new Promise<void>((resolve) => child.once("close", () => resolve()));
			let reclaimed: ReturnType<typeof tryAcquireDurableClaim>;
			for (let attempt = 0; attempt < 100 && !reclaimed; attempt += 1) {
				reclaimed = tryAcquireDurableClaim(root, "delivery");
				if (!reclaimed) await Bun.sleep(5);
			}
			expect(reclaimed).toBeDefined();
			const reclaimedIdentity = fs.statSync(lockPath);
			expect({ dev: reclaimedIdentity.dev, ino: reclaimedIdentity.ino }).toEqual({
				dev: heldIdentity.dev,
				ino: heldIdentity.ino,
			});
			reclaimed?.release();
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	}, 5_000);

	test("keeps one stable inode mutually exclusive and releases it on descriptor close", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-durable-claim-"));
		roots.push(root);
		fs.chmodSync(root, 0o700);
		const first = tryAcquireDurableClaim(root, "delivery");
		expect(first).toBeDefined();
		expect(tryAcquireDurableClaim(root, "delivery")).toBeUndefined();
		first?.release();
		const next = tryAcquireDurableClaim(root, "delivery");
		expect(next).toBeDefined();
		next?.release();
	});

	test("selects a process-death-safe kernel backend on every supported desktop platform", () => {
		expect(durableClaimBackendForPlatform("linux")).toBe("flock");
		expect(durableClaimBackendForPlatform("darwin")).toBe("flock");
		expect(durableClaimBackendForPlatform("freebsd")).toBe("flock");
		expect(durableClaimBackendForPlatform("win32")).toBe("windows-lock-file-ex");
	});
});
