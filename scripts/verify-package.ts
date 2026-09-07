import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject, isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { waitForDetachedProcess } from "./detached-process.ts";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_HOST_PROFILE, CERTIFIED_PI_SOURCE_COMMIT, CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { runPiRpcSmoke } from "./smoke-pi.ts";
import { stageSupportedPiHost } from "./verify-pi-host-provenance.ts";

export { CERTIFIED_PI_HOST_PROFILE, CERTIFIED_PI_SOURCE_COMMIT, CERTIFIED_PI_VERSION };

const root = resolve(import.meta.dir, "..");
const packageDirectory = join(root, "packages", "pi-stuff");
const goalToolInspector = join(root, "tests/fixtures/assert-goal-tools.ts");
const webToolInspector = join(root, "tests/fixtures/assert-web-tools.ts");
const mcpToolInspector = join(root, "tests/fixtures/assert-mcp-tools.ts");
const workToolInspector = join(root, "tests/fixtures/assert-work-tools.ts");
const RTK_TECHNIQUE_FILES = [
	"ansi.ts",
	"build.ts",
	"command-detection.ts",
	"git.ts",
	"index.ts",
	"linter.ts",
	"path-utils.ts",
	"search.ts",
	"source.ts",
	"test-output.ts",
	"truncate.ts",
] as const;

const REQUIRED_SOURCE_FILES = [
	"package/index.ts",
	"package/src/lifecycle-deadline.ts",
	"package/src/lifecycle-performance.ts",
	"package/src/suite-loader.ts",
	"package/src/suite-runtime.ts",
	"package/src/conversation-ui/index.ts",
	"package/src/conversation-ui/statusline.ts",
	"package/src/tool-display/index.ts",
	"package/src/code-mode/index.ts",
	"package/src/code-mode/extension.ts",
	"package/src/code-mode/connector.ts",
	"package/src/code-mode/ledger.ts",
	"package/src/code-mode/runtime.ts",
	"package/src/code-mode/v8-executor.ts",
	"package/src/code-mode/cloudflare/codec.ts",
	"package/src/code-mode/cloudflare/normalize.ts",
	"package/src/code-mode/host/host-client.ts",
	"package/src/code-mode/host/host-assets.ts",
	"package/src/code-mode/LICENSES/Apache-2.0.txt",
	"package/src/code-mode/LICENSES/Cloudflare-MIT.txt",
	"package/src/code-mode/THIRD_PARTY_NOTICES.md",
	"package/src/context-management/index.ts",
	"package/src/ponytail/index.ts",
	"package/src/ponytail/LICENSE.upstream",
	"package/src/ponytail/THIRD_PARTY_NOTICES.md",
	"package/src/ponytail/UPSTREAM.md",
	"package/src/ponytail/UPSTREAM.sha256",
	"package/src/ponytail/skills/ponytail/SKILL.md",
	"package/src/ponytail/skills/ponytail-review/SKILL.md",
	"package/src/ponytail/skills/ponytail-audit/SKILL.md",
	"package/src/ponytail/skills/ponytail-debt/SKILL.md",
	"package/src/ponytail/skills/ponytail-gain/SKILL.md",
	"package/src/ponytail/skills/ponytail-help/SKILL.md",
	"package/src/rtk/index.ts",
	"package/src/codex/index.ts",
	"package/src/codex/native/apply-patch/linux-x64/apply_patch",
	"package/src/codex/native/imagegen/linux-x64/imagegen",
	"package/src/codex/native/view-image/linux-x64/view_image",
	"package/src/codex/LICENSES/Apache-2.0.txt",
	"package/src/codex/THIRD_PARTY_NOTICES.md",
	"package/src/goal/index.ts",
	"package/src/web/index.ts",
	"package/src/web/runtime/index.js",
	"package/src/web/runtime/implementation.ts",
	"package/src/web/runtime/LICENSE",
	"package/src/web/runtime/SECURITY.md",
	"package/src/web/runtime/UPSTREAM.md",
	"package/src/mcp/index.ts",
	"package/src/mcp/runtime/index.js",
	"package/src/mcp/runtime/implementation.ts",
	"package/src/mcp/runtime/mcp-keyring-helper.cjs",
	"package/src/mcp/runtime/LICENSE",
	"package/src/mcp/runtime/UPSTREAM.md",
	...RTK_TECHNIQUE_FILES.map((file) => `package/src/rtk/upstream/techniques/${file}`),
	"package/src/background-work/index.ts",
	"package/src/background-work/src/process-supervisor.mjs",
	"package/src/subagents/index.ts",
	"package/src/todo/index.ts",
	"package/src/btw/index.ts",
	"package/src/btw/prompts/btw-system.txt",
	"package/src/notification/index.ts",
	"package/src/notification/format.ts",
	"package/src/notification/notification-settings-dialog.ts",
	"package/src/notification/runtime.ts",
	"package/src/notification/settings.ts",
	"package/src/notification/transport.ts",
	"package/themes/catppuccin-frappe.json",
	"package/themes/catppuccin-latte.json",
	"package/themes/catppuccin-macchiato.json",
	"package/themes/catppuccin-mocha.json",
	"package/themes/LICENSE",
	"package/themes/README.md",
] as const;

const PROVENANCE_REQUIREMENTS = {
	"background-work": ["pi-background-tasks", "Pi Stuff delta"],
	btw: ["@juicesharp/rpiv-btw", "Pi Stuff delta"],
	"code-mode": ["@howaboua/pi-codex-conversion", "Cloudflare Code Mode", "Pi Stuff delta"],
	codex: ["@howaboua/pi-codex-conversion", "Pi Stuff delta"],
	"context-management": ["cortexkit/magic-context", "Pi Stuff adapter policy"],
	goal: ["@narumitw/pi-goal", "Pi Stuff delta"],
	mcp: ["nicobailon/pi-mcp-adapter", "Pi Stuff delta"],
	ponytail: ["@dietrichgebert/ponytail", "Pi Stuff"],
	rtk: ["pi-rtk-optimizer", "Pi Stuff delta"],
	subagents: ["pi-subagents", "Pi Stuff delta"],
	todo: ["@juicesharp/rpiv-todo", "Pi Stuff delta"],
	"tool-display": ["@mobrienv/pi-tidy-tools", "Pi Stuff delta"],
	web: ["nicobailon/pi-web-access", "Pi Stuff delta"],
} satisfies Readonly<Record<string, readonly string[]>>;

export interface PackageManifest {
	dependencies?: unknown;
	files?: unknown;
	name?: unknown;
	private?: unknown;
	pi?: unknown;
	bundledDependencies?: unknown;
}

const PACKAGE_MANIFEST_SCHEMA = Type.Object(
	{
		bundledDependencies: Type.Optional(Type.Unknown()),
		dependencies: Type.Optional(Type.Unknown()),
		files: Type.Optional(Type.Unknown()),
		name: Type.Optional(Type.Unknown()),
		pi: Type.Optional(Type.Unknown()),
		private: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: true },
);
const RUNTIME_MANIFEST_SCHEMA = Type.Object(
	{ dependencies: Type.Optional(Type.Record(Type.String(), Type.Unknown())) },
	{ additionalProperties: true },
);
const INSTALLED_MANIFEST_SCHEMA = Type.Object(
	{ name: Type.Optional(Type.Unknown()), version: Type.Optional(Type.Unknown()) },
	{ additionalProperties: true },
);
const INSTALLED_COMMANDS_SCHEMA = Type.Object(
	{
		id: Type.Literal("pi-stuff-installed"),
		success: Type.Literal(true),
		data: Type.Object(
			{ commands: Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: true })) },
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);

function run(command: readonly string[], cwd = root): string {
	const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed with ${result.exitCode}: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}

function normalizedFilesEntry(entry: string): string {
	const normalized = entry.replace(/^\.\//u, "");
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		normalized.includes("\\") ||
		normalized.split("/").includes("..")
	) {
		throw new Error(`Invalid Package files entry: ${entry}`);
	}
	return normalized;
}

export function verifyPackageManifest(manifest: PackageManifest): void {
	if (manifest.name !== "@jczhang02/pi-stuff") throw new Error("Package has the wrong identity");
	if (manifest.private !== true) throw new Error("Pi Stuff must remain a private local Package");
	if (
		JSON.stringify(manifest.pi) !==
		JSON.stringify({
			extensions: ["./index.ts"],
			skills: ["./src/ponytail/skills"],
			themes: ["./themes/*.json"],
		})
	) {
		throw new Error("Package has an invalid Pi resource manifest");
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
		throw new Error("Package manifest files must be a non-empty array");
	}
	for (const entry of manifest.files) {
		if (!isRuntimeString(entry)) throw new Error("Package manifest files must contain only strings");
		normalizedFilesEntry(entry);
	}
	if (manifest.bundledDependencies !== undefined) {
		throw new Error("The local single Package must not use bundledDependencies");
	}
	if (
		!isRuntimeObject(manifest.dependencies) ||
		manifest.dependencies === null ||
		Object.keys(manifest.dependencies).some((name) => name.startsWith("@jczhang02/pi-"))
	) {
		throw new Error("The local Package must declare only external runtime dependencies");
	}
}

export async function verifyPackageSource(baseDirectory = packageDirectory): Promise<void> {
	const manifest = await Bun.file(join(baseDirectory, "package.json")).json();
	if (!Check(PACKAGE_MANIFEST_SCHEMA, manifest)) throw new Error("Package manifest must be an object");
	verifyPackageManifest(manifest);
	const files = [...new Bun.Glob("**/*").scanSync({ cwd: baseDirectory, onlyFiles: true, dot: true })];
	const missing = REQUIRED_SOURCE_FILES.map((path) => path.replace(/^package\//u, "")).filter(
		(path) => !files.includes(path),
	);
	if (missing.length > 0) throw new Error(`Package is missing runtime files:\n${missing.join("\n")}`);
	const forbidden = files.filter(
		(path) =>
			path.startsWith("node_modules/") ||
			path.startsWith("src/subagents/agents/") ||
			/codex-code-mode-host(?:\.exe)?$/u.test(path) ||
			path.split("/").includes(".changeset") ||
			(path !== "package.json" && path.endsWith("/package.json")),
	);
	if (forbidden.length > 0) throw new Error(`Package contains forbidden files:\n${forbidden.sort().join("\n")}`);
	await verifyProvenanceAndLicenses(baseDirectory);
	for (const binary of [
		"src/codex/native/apply-patch/linux-x64/apply_patch",
		"src/codex/native/imagegen/linux-x64/imagegen",
		"src/codex/native/view-image/linux-x64/view_image",
	]) {
		if (((await stat(join(baseDirectory, binary))).mode & 0o111) === 0) {
			throw new Error(`Native Tool is not executable: ${binary}`);
		}
	}
}

export async function verifyStaticPackage(): Promise<void> {
	await verifySinglePackageBoundary();
	await verifyInstalledRuntimeDependencies();
	await verifyPackageSource();
}

async function verifySinglePackageBoundary(): Promise<void> {
	const packageEntries = (await readdir(join(root, "packages"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	if (packageEntries.join("\n") !== "pi-stuff") {
		throw new Error(`Expected one Package directory, found: ${packageEntries.join(", ")}`);
	}
	const nestedManifests = [...new Bun.Glob("src/**/package.json").scanSync({ cwd: packageDirectory })];
	if (nestedManifests.length > 0) {
		throw new Error(`Internal modules must not contain Package manifests:\n${nestedManifests.sort().join("\n")}`);
	}
}

export async function verifyInstalledRuntimeDependencies(baseDirectory = packageDirectory): Promise<void> {
	const manifest = await Bun.file(join(baseDirectory, "package.json")).json();
	if (!Check(RUNTIME_MANIFEST_SCHEMA, manifest)) throw new Error("Package manifest must be a JSON object");
	for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
		if (
			!isRuntimeString(version) ||
			!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(version)
		) {
			throw new Error(`Runtime dependency ${name} must use an exact version`);
		}
		const installedManifestPath = join(baseDirectory, "node_modules", name, "package.json");
		let installedManifest: Static<typeof INSTALLED_MANIFEST_SCHEMA>;
		try {
			const parsed = parseJsonValue(await readFile(installedManifestPath, "utf8"));
			if (!Check(INSTALLED_MANIFEST_SCHEMA, parsed)) throw new Error("installed manifest must be an object");
			installedManifest = parsed;
		} catch (error) {
			throw new Error(`Cannot read installed runtime dependency ${name}`, { cause: error });
		}
		if (installedManifest.name !== name || installedManifest.version !== version) {
			throw new Error(
				`Runtime dependency ${name} resolved to ${String(installedManifest.name)}@${String(installedManifest.version)}, expected ${name}@${version}`,
			);
		}
	}
}

async function verifyProvenanceAndLicenses(baseDirectory: string): Promise<void> {
	await access(join(baseDirectory, "src", "conversation-ui", "LICENSE"));
	for (const [module, required] of Object.entries(PROVENANCE_REQUIREMENTS)) {
		const moduleDirectory = join(baseDirectory, "src", module);
		await access(join(moduleDirectory, module === "ponytail" ? "LICENSE.upstream" : "LICENSE"));
		const provenance = await readFile(join(moduleDirectory, "UPSTREAM.md"), "utf8");
		for (const marker of required) {
			if (!provenance.includes(marker)) throw new Error(`${module}/UPSTREAM.md is missing ${marker}`);
		}
	}
	for (const adapted of ["web/runtime", "mcp/runtime"] as const) {
		await access(join(baseDirectory, "src", adapted, "LICENSE"));
		await access(join(baseDirectory, "src", adapted, "UPSTREAM.md"));
	}
	await access(join(baseDirectory, "src", "web", "runtime", "SECURITY.md"));
	await access(join(baseDirectory, "src", "codex", "LICENSES", "Apache-2.0.txt"));
	await access(join(baseDirectory, "src", "codex", "THIRD_PARTY_NOTICES.md"));
	await access(join(baseDirectory, "src", "code-mode", "LICENSES", "Apache-2.0.txt"));
	await access(join(baseDirectory, "src", "code-mode", "LICENSES", "Cloudflare-MIT.txt"));
	await access(join(baseDirectory, "src", "code-mode", "THIRD_PARTY_NOTICES.md"));
	for (const technique of RTK_TECHNIQUE_FILES) {
		await access(join(baseDirectory, "src", "rtk", "upstream", "techniques", technique));
	}
}

function verifyPiVersion(piBinary: string): void {
	const version = run([piBinary, "--version"]).trim();
	if (version !== CERTIFIED_PI_VERSION) {
		throw new Error(`Expected Pi ${CERTIFIED_PI_VERSION}, received ${version || "no version"}`);
	}
}

async function installSourcePackage(piBinary: string, temporaryDirectory: string): Promise<string> {
	const agentDirectory = join(temporaryDirectory, "agent");
	await mkdir(agentDirectory, { recursive: true });
	const env = {
		...process.env,
		HOME: join(temporaryDirectory, "home"),
		PI_CODING_AGENT_DIR: agentDirectory,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		XDG_CACHE_HOME: join(temporaryDirectory, "cache"),
		XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
		XDG_DATA_HOME: join(temporaryDirectory, "data"),
		XDG_STATE_HOME: join(temporaryDirectory, "state"),
	};
	const result = Bun.spawnSync([piBinary, "install", packageDirectory], {
		cwd: temporaryDirectory,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`pi install failed with ${result.exitCode}: ${result.stderr.toString().trim()}`);
	}
	const settingsPath = join(agentDirectory, "settings.json");
	const settings = parseJsonValue(await readFile(settingsPath, "utf8"));
	if (
		!isRuntimeObject(settings) ||
		settings === null ||
		Array.isArray(settings) ||
		!Array.isArray(settings["packages"]) ||
		settings["packages"].length !== 1
	) {
		throw new Error("pi install did not create an isolated Package configuration");
	}
	const configuredPath = settings["packages"][0];
	if (!isRuntimeString(configuredPath) || resolve(agentDirectory, configuredPath) !== packageDirectory) {
		throw new Error(`pi install configured an unexpected Package path: ${String(configuredPath)}`);
	}
	return agentDirectory;
}

async function verifyInstalledSuiteSurface(
	piBinary: string,
	temporaryDirectory: string,
	agentDirectory: string,
): Promise<void> {
	const child = Bun.spawn(
		[
			piBinary,
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-builtin-tools",
			"--no-approve",
		],
		{
			cwd: temporaryDirectory,
			detached: true,
			env: {
				...process.env,
				HOME: join(temporaryDirectory, "home"),
				PI_CODING_AGENT_DIR: agentDirectory,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				XDG_CACHE_HOME: join(temporaryDirectory, "cache"),
				XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
				XDG_DATA_HOME: join(temporaryDirectory, "data"),
				XDG_STATE_HOME: join(temporaryDirectory, "state"),
			},
			stdin: new Blob(['{"id":"pi-stuff-installed","type":"get_commands"}\n']),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [{ exitCode, timedOut }, stdout, stderr] = await Promise.all([
		waitForDetachedProcess(child, 60_000),
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (timedOut) throw new Error("Installed Pi RPC smoke timed out");
	if (exitCode !== 0) throw new Error(`Installed Pi RPC smoke exited with ${exitCode}: ${stderr.trim()}`);
	const records = stdout.trim().split("\n").map(parseJsonValue);
	const response = records.find((record) => Check(INSTALLED_COMMANDS_SCHEMA, record));
	if (!response || !Check(INSTALLED_COMMANDS_SCHEMA, response))
		throw new Error("Installed Pi returned no successful command response");
	const commands = response.data.commands.map((command) => command.name);
	if (!commands.includes("notifications") || !commands.includes("ui") || !commands.includes("codemode")) {
		throw new Error("Pi did not load the installed source Package");
	}
}

export async function verifySuiteSurface(piBinary: string, packagePath: string): Promise<void> {
	const smoke = await runPiRpcSmoke({
		piBinary,
		extensions: [goalToolInspector, webToolInspector, mcpToolInspector, workToolInspector],
		packages: [packagePath],
		probeCommand: "/notifications",
		timeoutMs: 60_000,
	});
	const requiredCommands = [
		"ui",
		"codemode",
		"goal",
		"ponytail",
		"ponytail-review",
		"ponytail-audit",
		"ponytail-debt",
		"ponytail-gain",
		"ponytail-help",
		"goal-tools-certified",
		"web-tools-certified",
		"mcp-tools-certified",
		"mcp",
		"tasks",
		"notifications",
		"work-tools-certified",
	];
	const missing = requiredCommands.filter((command) => !smoke.commandNames.includes(command));
	if (missing.length > 0) throw new Error(`Pi Stuff is missing commands: ${missing.join(", ")}`);
	if (smoke.commandNames.includes("mcp-auth")) throw new Error("Legacy /mcp-auth must remain removed");
	if (smoke.createdFiles.includes("agent/pi-stuff-notification.json")) {
		throw new Error("/notifications created Notification settings during the RPC purity probe");
	}
	if (smoke.commandNames.includes("tool-settings")) throw new Error("Legacy /tool-settings must remain removed");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (
		args.some((arg) => !["--help", "--list", "--static"].includes(arg)) ||
		args.filter((arg) => arg === "--static").length > 1
	) {
		throw new Error(
			`Unknown argument: ${args.find((arg) => !["--help", "--list", "--static"].includes(arg)) ?? "--static"}`,
		);
	}
	if (args.includes("--help")) {
		console.log("Usage: bun scripts/verify-package.ts [--static|--list|--help]");
		return;
	}
	if (args.includes("--list")) {
		console.log("static-package\nsource-install");
		return;
	}
	if (args.includes("--static")) {
		await verifyStaticPackage();
		console.log("Static Package validation passed");
		return;
	}
	await verifySourceInstallation();
}

export async function verifySourceInstallation(): Promise<void> {
	const PI_BIN = resolvePiBinary();
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-local-package-"));
	try {
		const host = await stageSupportedPiHost(PI_BIN, temporaryDirectory);
		verifyPiVersion(host.binaryPath);
		const agentDirectory = await installSourcePackage(host.binaryPath, temporaryDirectory);
		await verifyInstalledSuiteSurface(host.binaryPath, temporaryDirectory, agentDirectory);
		console.log(`Certified source installation of @jczhang02/pi-stuff with Pi Host ${CERTIFIED_PI_HOST_PROFILE}`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();
