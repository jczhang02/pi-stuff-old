import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { CERTIFIED_RTK_VERSION, RtkRuntime } from "../../../packages/pi-stuff/src/rtk/runtime.js";
import { formatInstalledToolFailure, probeInstalledTool } from "../../../scripts/installed-tools.ts";

const localRtkProbe = await probeInstalledTool("RTK", `rtk ${CERTIFIED_RTK_VERSION}`);
const localRtk = localRtkProbe.path ?? "";

async function execute(command: string, args: string[], options: { timeout?: number } = {}) {
	if (command === "which") {
		return { code: localRtk ? 0 : 1, killed: false, stderr: "", stdout: localRtk ? `${localRtk}\n` : "" };
	}
	const child = Bun.spawn([command, ...args], { stderr: "pipe", stdout: "pipe" });
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		child.kill(9);
	}, options.timeout ?? 2_500);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	clearTimeout(timer);
	return { code, killed, stderr, stdout };
}

test("uses the supported RTK 0.45.0 executable", async () => {
	if (localRtkProbe.status !== "ready")
		throw new Error(formatInstalledToolFailure(localRtkProbe, `rtk ${CERTIFIED_RTK_VERSION}`));
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const pi = { exec: execute } as Pick<ExtensionAPI, "exec">;
	const runtime = new RtkRuntime();

	expect(await Effect.runPromise(runtime.rewrite(pi, "git status"))).toBe("rtk git status");
	expect(await Effect.runPromise(runtime.rewrite(pi, "rg --files -g '*.ts' packages"))).toBe(
		"rtk rg --files -g '*.ts' packages",
	);
	expect(await Effect.runPromise(runtime.rewrite(pi, "rg -n CERTIFIED_RTK_VERSION packages/pi-stuff/src/rtk"))).toBe(
		"rtk rg -n CERTIFIED_RTK_VERSION packages/pi-stuff/src/rtk",
	);
	const snapshot = runtime.snapshot();
	expect(snapshot).toMatchObject({
		path: realpathSync(localRtk),
		state: "ready",
		version: CERTIFIED_RTK_VERSION,
	});

	const files = await execute(localRtk, ["rg", "--files", "-g", "*.ts", "packages"]);
	expect(files.code).toBe(0);
	expect(files.stdout).toContain("packages/pi-stuff/src/rtk/runtime.ts");
	const matches = await execute(localRtk, ["rg", "-n", "CERTIFIED_RTK_VERSION", "packages/pi-stuff/src/rtk"]);
	expect(matches.code).toBe(0);
	expect(matches.stdout).toContain("runtime.ts");
});
