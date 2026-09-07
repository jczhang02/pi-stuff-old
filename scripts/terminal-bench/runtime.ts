import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { codeModeHostBinaryPath } from "../../packages/pi-stuff/src/code-mode/host/binary.js";
import { CERTIFIED_RTK_VERSION } from "../../packages/pi-stuff/src/rtk/runtime.js";
import { probeInstalledTool, resolvePiBinary } from "../installed-tools.js";
import { stageSupportedPiHost } from "../verify-pi-host-provenance.js";
import { writeEvaluationProfile } from "./profile.js";

export const CONTAINER_ROOT = "/opt/pi-stuff-evaluation";

export async function command(args: string[], cwd?: string, environment = process.env): Promise<string> {
	const child = Bun.spawn(args, { cwd: cwd ?? process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`);
	return stdout.trim();
}

async function installed(name: string, miseName: string): Promise<string> {
	const configured = process.env[`${name.toUpperCase().replaceAll("-", "_")}_BIN`];
	const found = configured ?? Bun.which(name);
	if (found) {
		const resolved = await realpath(found);
		return basename(resolved) === "mise" ? command([resolved, "which", name]) : resolved;
	}
	const mise = Bun.which("mise");
	if (mise) {
		const active = Bun.spawnSync([mise, "which", name], { stdout: "pipe", stderr: "pipe" });
		if (active.exitCode === 0) return realpath(active.stdout.toString().trim());
		const location = await command([mise, "where", miseName]);
		const tool = miseName.includes("@") ? miseName : `${miseName}@${basename(location)}`;
		return realpath(await command([mise, "which", name, "--tool", tool]));
	}
	throw new Error(
		`${name} is not installed; install ${miseName} with mise or set ${name.toUpperCase().replaceAll("-", "_")}_BIN`,
	);
}

export async function evaluationRuntime(): Promise<{
	harbor: string;
	python: string;
	environment: NodeJS.ProcessEnv;
	cleanup: () => Promise<void>;
}> {
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("Terminal-Bench requires the certified Linux x64 runtime");
	const harbor = await installed("harbor", "pipx:harbor@0.22.0");
	const version = await command([harbor, "--version"]);
	if (!/\b0\.22\.0\b/.test(version)) throw new Error(`Expected Harbor 0.22.0, received ${version}`);
	const docker = await installed("docker", "docker-cli");
	const compose = await installed("docker-compose", "docker-compose");
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${dirname(docker)}:${dirname(compose)}:${process.env["PATH"] ?? ""}`,
	};
	const socket = `/run/user/${process.getuid?.()}/podman/podman.sock`;
	if (
		!environment["DOCKER_HOST"] &&
		(await stat(socket).then(
			(value) => value.isSocket(),
			() => false,
		))
	)
		environment["DOCKER_HOST"] = `unix://${socket}`;
	await command([docker, "info", "--format", "{{.ServerVersion}}"], undefined, environment);
	const python = join(dirname(harbor), "python");
	await command([
		python,
		"-c",
		"import harbor; from importlib.metadata import version; assert version('harbor') == '0.22.0'",
	]);
	const dockerConfig = await mkdtemp(join(tmpdir(), "pi-stuff-docker-"));
	const cleanup = () => rm(dockerConfig, { recursive: true, force: true });
	try {
		await Bun.write(join(dockerConfig, "config.json"), JSON.stringify({ cliPluginsExtraDirs: [dirname(compose)] }));
		environment["DOCKER_CONFIG"] = dockerConfig;
		await command([docker, "compose", "version"], undefined, environment);
		return { harbor, python, environment, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

export async function prepareEvaluationAssets(assets: string): Promise<void> {
	const source = join(assets, "source");
	console.log("Preparing frozen Package dependencies and installed runtime assets…");
	await command([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], source);
	const staged = await stageSupportedPiHost(resolvePiBinary(), assets);
	await rename(dirname(staged.binaryPath), join(assets, "pi-host"));
	const rtkBinary = await installed("rtk", `rtk@${CERTIFIED_RTK_VERSION}`);
	const rtk = await probeInstalledTool("RTK", `rtk ${CERTIFIED_RTK_VERSION}`, rtkBinary);
	if (rtk.status !== "ready" || !rtk.path) throw new Error(`RTK preflight: ${rtk.status}`);
	await mkdir(join(assets, "bin"));
	for (const [name, binary] of [
		["bun", process.execPath],
		["rtk", rtkBinary],
		["code-mode-host", codeModeHostBinaryPath()],
	] as const) {
		await cp(await realpath(binary), join(assets, "bin", name));
		await chmod(join(assets, "bin", name), 0o755);
	}
	await cp(join(import.meta.dir, "usage-extension.ts"), join(assets, "source", "usage-extension.ts"));
	await cp(join(import.meta.dir, "pi_stuff_agent.py"), join(assets, "pi_stuff_agent.py"));
	await writeEvaluationProfile(
		join(assets, "profile"),
		`${CONTAINER_ROOT}/source/packages/pi-stuff`,
		`${CONTAINER_ROOT}/source/usage-extension.ts`,
	);
	await command(["chmod", "-R", "a+rX", assets]);
}

export async function prepareEvaluationCredentials(assets: string): Promise<void> {
	const credential = readStoredCredential("openai-codex");
	if (!credential)
		throw new Error("Pi has no configured openai-codex credential; configure Luna authentication before evaluation");
	const authPath = join(assets, "auth.json");
	await Bun.write(authPath, JSON.stringify({ "openai-codex": credential }), { mode: 0o600 });
	await chmod(authPath, 0o600);
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath: null,
		modelsStorePath: join(assets, "model-store.json"),
		refreshOnCreate: false,
	});
	const model = runtime.getModel("openai-codex", "gpt-5.6-luna");
	if (!model?.reasoning || model.thinkingLevelMap?.max !== "max")
		throw new Error("Installed model catalog does not support Luna/max");
	if (!(await runtime.getAuth(model))) throw new Error("Luna authentication could not be resolved");
}

export async function fingerprintAssets(assets: string): Promise<string> {
	const tar = Bun.spawn(
		[
			"tar",
			"--sort=name",
			"--mtime=@0",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"--exclude=./auth.json",
			"--exclude=./model-store.json",
			"--exclude=__pycache__",
			"-cf",
			"-",
			".",
		],
		{ cwd: assets, stdout: "pipe", stderr: "pipe" },
	);
	const digest = createHash("sha256");
	const error = new Response(tar.stderr).text();
	for await (const chunk of tar.stdout) digest.update(chunk);
	if ((await tar.exited) !== 0) throw new Error(`Cannot fingerprint evaluation assets: ${await error}`);
	await error;
	return digest.digest("hex");
}
