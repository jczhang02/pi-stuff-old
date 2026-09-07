import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyToolsGroupingPty } from "../../../scripts/verify-tools-grouping-pty.js";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

function tmux(socket: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

test("real Pi groups complete Tool activity independently of an inherited tmux server", async () => {
	const parentDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-grouping-parent-"));
	const parentSocket = join(parentDirectory, "tmux.sock");
	const originalTmux = process.env["TMUX"];
	try {
		tmux(parentSocket, ["-f", "/dev/null", "new-session", "-d", "-s", "hostile-parent"]);
		tmux(parentSocket, ["set-option", "-s", "extended-keys", "off"]);
		process.env["TMUX"] = `${parentSocket},1,0`;

		for (const scenario of ["lifecycle", "compaction", "resume", "tree"] as const) {
			await verifyToolsGroupingPty({
				columns: 100,
				packagePath: AGGREGATE_PACKAGE,
				piBinary: PI_BIN,
				rows: 32,
				scenario,
			});
		}
		await verifyToolsGroupingPty({
			columns: 64,
			packagePath: AGGREGATE_PACKAGE,
			piBinary: PI_BIN,
			rows: 28,
		});
		if (tmux(parentSocket, ["show-option", "-gv", "extended-keys"]) !== "off") {
			throw new Error("Tool grouping PTY verification mutated its inherited tmux server");
		}
	} finally {
		if (originalTmux === undefined) delete process.env["TMUX"];
		else process.env["TMUX"] = originalTmux;
		Bun.spawnSync(["tmux", "-S", parentSocket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
		await rm(parentDirectory, { force: true, recursive: true });
	}
}, 180_000);
