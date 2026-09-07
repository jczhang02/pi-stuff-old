import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { codeModeHostBinaryPath } from "../packages/pi-stuff/src/code-mode/host/binary.js";
import { resolveNativeBinary } from "../packages/pi-stuff/src/codex/native-runner.js";
import { CERTIFIED_RTK_VERSION } from "../packages/pi-stuff/src/rtk/runtime.js";
import { formatInstalledToolFailure, probeInstalledTool } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.js";

export type TestProfile = "offline" | "live";

export function requirementsForTest(file: string): string[] {
	const requirements = new Set<string>(["bun"]);
	if (file.endsWith("codex/native-tools.test.ts")) requirements.add("codex-native");
	if (file.endsWith(".node.ts")) requirements.add("node");
	if (
		/^tests\/(?:system|acceptance)\//u.test(file) ||
		file.endsWith("system-integration/repository/smoke-pi.test.ts") ||
		file.endsWith("system-integration/subagents/process-controls-recovery.test.ts")
	)
		requirements.add("pi");
	if (/tests\/(system-integration|acceptance)\/rtk\//u.test(file)) requirements.add("rtk");
	if (
		(!file.startsWith("tests/unit/") && /pty|watchdog/u.test(file)) ||
		file.endsWith("acceptance/code-mode/tui-offline.test.ts")
	) {
		requirements.add("tmux");
		requirements.add("expect");
	}
	if (/system-integration\/code-mode\/v8-real\.test\.ts$|acceptance\/code-mode\//u.test(file))
		requirements.add("code-mode-host");
	if (file.endsWith("context-management/magic-context-live.test.ts")) requirements.add("live-magic-context");
	if (file.endsWith("system-integration/notification/transport.test.ts")) requirements.add("tmux");
	return [...requirements].sort();
}

async function executable(name: string, args: string[] = ["--version"]): Promise<string | undefined> {
	try {
		const child = Bun.spawn([name, ...args], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return exitCode === 0 ? stdout.trim() || stderr.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function checkCodeModeHost(): Promise<string | undefined> {
	try {
		const path = codeModeHostBinaryPath();
		await access(path);
		if (process.platform !== "linux" || process.arch !== "x64") return undefined;
		// Executable extracted from the SHA-verified rust-v0.145.0 Linux x64 release archive.
		const expected = "60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8";
		const digest = createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
		return digest === expected ? path : undefined;
	} catch {
		return undefined;
	}
}

export async function preflightTests(files: readonly string[], profile: TestProfile = "offline"): Promise<void> {
	const requirements = new Set(files.flatMap(requirementsForTest));
	const missing: string[] = [];
	if (requirements.has("bun") && Bun.version !== "1.4.0") missing.push("Bun 1.4.0");
	if (requirements.has("codex-native")) {
		for (const tool of ["apply_patch", "view_image"] as const) {
			const path = resolveNativeBinary(tool);
			if (
				!path ||
				!(await access(path, constants.X_OK)
					.then(() => true)
					.catch(() => false))
			)
				missing.push(`Codex ${tool} executable`);
		}
	}
	if (requirements.has("node") && !(await executable("node"))) missing.push("Node");
	if (requirements.has("pi")) {
		const probe = await probeInstalledTool("Pi", CERTIFIED_PI_VERSION);
		if (probe.status !== "ready") missing.push(formatInstalledToolFailure(probe, CERTIFIED_PI_VERSION));
	}
	if (requirements.has("tmux") && !Bun.which("tmux")) missing.push("tmux");
	if (requirements.has("expect") && !Bun.which("expect")) missing.push("Expect");
	if (requirements.has("rtk")) {
		const probe = await probeInstalledTool("RTK", `rtk ${CERTIFIED_RTK_VERSION}`);
		if (probe.status !== "ready") missing.push(formatInstalledToolFailure(probe, `rtk ${CERTIFIED_RTK_VERSION}`));
	}
	if (requirements.has("code-mode-host") && !(await checkCodeModeHost())) missing.push("certified Code Mode host");
	if (requirements.has("live-magic-context")) {
		if (profile !== "live") missing.push("live profile selection");
		if (
			!(await access(resolve(`${homedir()}/.pi/agent/auth.json`))
				.then(() => true)
				.catch(() => false))
		)
			missing.push("Pi auth.json");
	}
	if (missing.length) throw new Error(`Test preflight failed: ${missing.join(", ")}`);
}
