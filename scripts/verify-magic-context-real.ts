import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { resolvePiBinary } from "./installed-tools.ts";
import { MAGIC_CONTEXT_REAL_CONTRACT, runMagicContextRealScenario } from "./magic-context-real-scenario.js";

const root = resolve(import.meta.dir, "..");
const PRESSURE_FILE_BYTES = 48 * 1024;
const PRESSURE_FILE_COUNT = 12;
const EXECUTE_THRESHOLD_PERCENTAGE = 65;
const HISTORIAN_MODEL = "openai-codex/gpt-5.6-terra";
const HISTORIAN_TIMEOUT_MS = 10 * 60_000;
const PACKAGE_MANIFEST_SCHEMA = Type.Object(
	{
		name: Type.String(),
		private: Type.Optional(Type.Boolean()),
		version: Type.String(),
	},
	{ additionalProperties: true },
);

type EvidenceFile = Readonly<{ bytes: number; path: string; sha256: string }>;

function fail(message: string): never {
	throw new Error(`Magic Context real-provider acceptance failed: ${message}`);
}

function parseOptions(argv: readonly string[]) {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || !value) {
			fail(
				"Usage: PI_STUFF_REAL_ACCEPTANCE=1 bun scripts/verify-magic-context-real.ts [--package <path> | --archive <package.tgz>] [--report <path>] [--pi <path>] [--auth <path>]",
			);
		}
		values.set(flag, value);
	}
	const archive = values.get("--archive");
	const packagePath = values.get("--package");
	if (archive && packagePath) fail("--archive and --package are mutually exclusive");
	for (const key of values.keys()) {
		if (!["--archive", "--auth", "--package", "--pi", "--report"].includes(key)) fail(`unknown option ${key}`);
	}
	const options = {
		authPath: resolve(values.get("--auth") ?? join(homedir(), ".pi/agent/auth.json")),
		packagePath: resolve(packagePath ?? join(root, "packages/pi-stuff")),
		piBinary: resolve(values.get("--pi") ?? resolvePiBinary()),
		reportPath: resolve(values.get("--report") ?? join(root, "docs/reports/magic-context-real-acceptance.json")),
	};
	return { ...options, archivePath: archive ? resolve(archive) : undefined };
}

type Options = ReturnType<typeof parseOptions>;

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function command(commandLine: readonly string[], cwd: string): string {
	const result = Bun.spawnSync([...commandLine], { cwd, stderr: "pipe", stdout: "pipe" });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		fail(
			`${basename(commandLine[0] ?? "command")} exited ${String(result.exitCode)}: ${stderr.trim() || stdout.trim()}`,
		);
	}
	return stdout;
}

function assertSafeArchiveEntries(entries: readonly string[]): void {
	if (entries.length === 0) fail("Suite Package archive is empty");
	for (const entry of entries) {
		if (!entry.startsWith("package/") || entry.includes("/../") || entry.startsWith("/") || entry.includes("\\")) {
			fail(`unsafe Suite Package archive path: ${entry}`);
		}
	}
}

async function verifyLocalPackage(packagePath: string): Promise<string> {
	const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
	if (
		!Check(PACKAGE_MANIFEST_SCHEMA, manifest) ||
		manifest.name !== "@jczhang02/pi-stuff" ||
		manifest.private !== true
	) {
		fail(`path is not the private local @jczhang02/pi-stuff Package: ${JSON.stringify(manifest)}`);
	}
	const resolver = createRequire(join(packagePath, "package.json"));
	const officialManifest = JSON.parse(
		await readFile(resolver.resolve("@cortexkit/pi-magic-context/package.json"), "utf8"),
	);
	if (
		!Check(PACKAGE_MANIFEST_SCHEMA, officialManifest) ||
		officialManifest.name !== "@cortexkit/pi-magic-context" ||
		officialManifest.version !== "0.41.1"
	) {
		fail(`Pi Stuff does not resolve the audited official Magic Context 0.41.1: ${JSON.stringify(officialManifest)}`);
	}
	return packagePath;
}

async function extractPackage(archivePath: string, destination: string): Promise<string> {
	const entries = command(["tar", "--list", "--gzip", "--file", archivePath], destination)
		.trim()
		.split("\n")
		.filter(Boolean);
	assertSafeArchiveEntries(entries);
	command(["tar", "--extract", "--gzip", "--file", archivePath, "--directory", destination], destination);
	const packagePath = join(destination, "package");
	const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
	if (!Check(PACKAGE_MANIFEST_SCHEMA, manifest) || manifest.name !== "@jczhang02/pi-stuff") {
		fail(`archive is not @jczhang02/pi-stuff: ${JSON.stringify(manifest)}`);
	}
	await symlink(join(root, "packages/pi-stuff/node_modules"), join(packagePath, "node_modules"), "dir");
	return verifyLocalPackage(packagePath);
}

function acceptancePaths(workspace: string) {
	return {
		agent: join(workspace, "agent"),
		audit: join(workspace, "audit.jsonl"),
		cache: join(workspace, "cache"),
		data: join(workspace, "data"),
		home: join(workspace, "home"),
		magicConfig: join(workspace, "config/cortexkit/magic-context.jsonc"),
		magicLog: join(workspace, "magic-context.log"),
		packageRoot: join(workspace, "aggregate"),
		projectA: join(workspace, "projects/project-a"),
		projectB: join(workspace, "projects/project-b"),
		sessions: join(workspace, "sessions"),
		settings: join(workspace, "agent/settings.json"),
		state: join(workspace, "state"),
		xdgConfig: join(workspace, "config"),
	};
}

type AcceptancePaths = ReturnType<typeof acceptancePaths>;

function environment(paths: AcceptancePaths): NodeJS.ProcessEnv {
	const isolated: NodeJS.ProcessEnv = {
		...process.env,
		HOME: paths.home,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		MAGIC_CONTEXT_LOG_PATH: paths.magicLog,
		MAGIC_CONTEXT_TEST_DATA_DIR: paths.data,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: paths.agent,
		PI_OFFLINE: "1",
		PI_STUFF_MAGIC_REAL_AUDIT: paths.audit,
		PI_TELEMETRY: "0",
		TERM: "dumb",
		XDG_CACHE_HOME: paths.cache,
		XDG_CONFIG_HOME: paths.xdgConfig,
		XDG_STATE_HOME: paths.state,
	};
	delete isolated["XDG_DATA_HOME"];
	return isolated;
}

async function writePressureFiles(projectDirectory: string): Promise<string[]> {
	const vocabulary =
		"boundary historian compartment pressure continuity session marker cache project retrieval tool context evidence resume durable verification".split(
			" ",
		);
	const paths: string[] = [];
	for (let fileIndex = 1; fileIndex <= PRESSURE_FILE_COUNT; fileIndex += 1) {
		const lines: string[] = [];
		let bytes = 0;
		for (let lineIndex = 1; bytes < PRESSURE_FILE_BYTES; lineIndex += 1) {
			const words = Array.from(
				{ length: 14 },
				(_, wordIndex) => vocabulary[(fileIndex * 7 + lineIndex * 3 + wordIndex) % vocabulary.length],
			);
			const line = `pressure-${String(fileIndex).padStart(2, "0")}-${String(lineIndex).padStart(4, "0")} ${words.join(" ")}`;
			lines.push(line);
			bytes += Buffer.byteLength(`${line}\n`);
		}
		const path = join(projectDirectory, `pressure-${String(fileIndex).padStart(2, "0")}.txt`);
		await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
		paths.push(path);
	}
	return paths;
}

async function initializeIsolatedProject(projectDirectory: string, identity: string): Promise<void> {
	await writeFile(join(projectDirectory, "acceptance-project.txt"), `${identity}\n`, { mode: 0o600 });
	command(["git", "init", "--quiet"], projectDirectory);
	command(["git", "config", "user.email", "pi-stuff-acceptance@example.invalid"], projectDirectory);
	command(["git", "config", "user.name", "Pi Stuff Acceptance"], projectDirectory);
	command(["git", "add", "acceptance-project.txt"], projectDirectory);
	command(
		["git", "-c", "commit.gpgsign=false", "commit", "--quiet", "--message", `Initialize ${identity}`],
		projectDirectory,
	);
}

async function writeAcceptanceConfiguration(paths: AcceptancePaths, authPath: string): Promise<void> {
	await Promise.all(
		[
			paths.agent,
			paths.cache,
			paths.data,
			paths.home,
			dirname(paths.magicConfig),
			paths.packageRoot,
			paths.projectA,
			paths.projectB,
			paths.sessions,
			paths.state,
		].map((path) => mkdir(path, { mode: 0o700, recursive: true })),
	);
	await Promise.all([
		copyFile(authPath, join(paths.agent, "auth.json")),
		writeFile(paths.audit, "", { mode: 0o600 }),
		writeFile(paths.magicLog, "", { mode: 0o600 }),
		writeFile(
			paths.settings,
			`${JSON.stringify({
				compaction: { enabled: false },
				defaultProjectTrust: "always",
				quietStartup: true,
				retry: { enabled: true, maxRetries: 3 },
				tuiMode: "fullscreen",
			})}\n`,
			{ mode: 0o600 },
		),
		writeFile(
			paths.magicConfig,
			`${JSON.stringify({
				compressor: { enabled: false },
				dreamer: { disable: true },
				embedding: { provider: "off" },
				execute_threshold_percentage: EXECUTE_THRESHOLD_PERCENTAGE,
				fail_closed_blocking: false,
				historian: {
					opencode: { model: HISTORIAN_MODEL },
					pi: { model: HISTORIAN_MODEL, thinking_level: "medium" },
				},
				historian_timeout_ms: HISTORIAN_TIMEOUT_MS,
				memory: {
					auto_promote: false,
					auto_search: { enabled: false },
					enabled: true,
					git_commit_indexing: { enabled: false },
				},
				sidekick: { disable: true },
				toast_duration_ms: 0,
				todowrite: { enabled: false, overlay: false },
			})}\n`,
			{ mode: 0o600 },
		),
	]);
}

async function prepareRun(options: Options, paths: AcceptancePaths) {
	await writeAcceptanceConfiguration(paths, options.authPath);
	await initializeIsolatedProject(paths.projectA, "Magic Context acceptance project A");
	await initializeIsolatedProject(paths.projectB, "Magic Context acceptance project B");
	const packagePath = options.archivePath
		? await extractPackage(options.archivePath, paths.packageRoot)
		: await verifyLocalPackage(options.packagePath);
	return {
		databasePath: join(paths.data, "cortexkit/magic-context/context.db"),
		environment: environment(paths),
		packagePath,
		pressureFiles: await writePressureFiles(paths.projectA),
	};
}

async function preserveEvidence(
	workspace: string,
	evidenceDirectory: string,
	paths: {
		readonly audit: string;
		readonly database: string;
		readonly magicConfig: string;
		readonly magicLog: string;
		readonly session: string;
		readonly settings: string;
	},
): Promise<Record<string, EvidenceFile>> {
	await mkdir(evidenceDirectory, { mode: 0o700, recursive: true });
	const evidence: Record<string, EvidenceFile> = {};
	for (const [name, source] of Object.entries(paths)) {
		const extension = name === "database" ? ".db" : name === "session" || name === "audit" ? ".jsonl" : ".txt";
		const target = join(evidenceDirectory, `${name}${extension}`);
		await copyFile(source, target);
		const contents = await readFile(target);
		evidence[name] = {
			bytes: contents.byteLength,
			path: relative(root, target),
			sha256: sha256(contents),
		};
	}
	await rm(workspace, { force: true, recursive: true });
	return evidence;
}

async function artifactEvidence(options: Options) {
	if (options.archivePath) {
		return { archive: basename(options.archivePath), sha256: sha256(await readFile(options.archivePath)) };
	}
	return {
		package: relative(root, options.packagePath),
		sha256: sha256(
			`${await readFile(join(options.packagePath, "package.json"), "utf8")}\n${await readFile(join(options.packagePath, "index.ts"), "utf8")}`,
		),
	};
}

async function main(): Promise<void> {
	if (process.env["PI_STUFF_REAL_ACCEPTANCE"] !== "1") {
		fail("set PI_STUFF_REAL_ACCEPTANCE=1 to acknowledge that this verification makes real provider calls");
	}
	const options = parseOptions(process.argv.slice(2));
	const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
	const acceptanceRoot = join(root, ".artifacts/acceptance");
	await mkdir(acceptanceRoot, { mode: 0o700, recursive: true });
	const workspace = await mkdtemp(join(acceptanceRoot, ".magic-context-real-work-"));
	const evidenceDirectory = join(acceptanceRoot, `magic-context-real-${runId}`);
	const paths = acceptancePaths(workspace);
	try {
		const prepared = await prepareRun(options, paths);
		const scenario = await runMagicContextRealScenario({
			auditPath: paths.audit,
			databasePath: prepared.databasePath,
			environment: prepared.environment,
			magicLogPath: paths.magicLog,
			packagePath: prepared.packagePath,
			piBinary: options.piBinary,
			pressureFiles: prepared.pressureFiles,
			projectA: paths.projectA,
			projectB: paths.projectB,
			sessionDirectory: paths.sessions,
		});
		const evidence = await preserveEvidence(workspace, evidenceDirectory, {
			audit: paths.audit,
			database: prepared.databasePath,
			magicConfig: paths.magicConfig,
			magicLog: paths.magicLog,
			session: scenario.sessionFile,
			settings: paths.settings,
		});
		const report = {
			artifact: await artifactEvidence(options),
			cache: {
				cacheRead: scenario.provider.cacheRead,
				hitPercentage: Number(
					(
						(scenario.provider.cacheRead /
							Math.max(1, scenario.provider.cacheRead + scenario.provider.uncachedInput)) *
						100
					).toFixed(2),
				),
				uncachedInput: scenario.provider.uncachedInput,
			},
			continuity: {
				canarySha256: sha256(scenario.canary),
				cancellationRecovery: scenario.realHost.cancellationRecovery,
				coldResume: true,
				goalStatus: "paused",
				liveSessionSwitch: scenario.realHost.liveSessionSwitch,
				projectIsolation: {
					distinct: true,
					isolatedIdentitySha256: sha256(scenario.database.isolatedIdentity),
					mainIdentitySha256: sha256(scenario.database.mainIdentity),
				},
				todoSubjectSha256: sha256(scenario.todoSubject),
			},
			database: scenario.database.database,
			evidence,
			host: { piVersion: command([options.piBinary, "--version"], root).trim() },
			magicContext: {
				executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
				historianModel: HISTORIAN_MODEL,
				package: "@cortexkit/pi-magic-context@0.41.1",
				usableContextLimit: scenario.magicContextLimit,
			},
			model: {
				contextWindow: MAGIC_CONTEXT_REAL_CONTRACT.contextWindow,
				id: MAGIC_CONTEXT_REAL_CONTRACT.model,
				maxOutputTokens: MAGIC_CONTEXT_REAL_CONTRACT.maxOutputTokens,
				provider: MAGIC_CONTEXT_REAL_CONTRACT.provider,
			},
			ownership: {
				compartmentRanges: scenario.database.compartmentRanges,
				magicBoundaries: scenario.session.magic.length,
				magicBoundaryOrdinals: scenario.session.boundaryOrdinals,
				nativeAutoCompactionEnabled: false,
				nativeBoundaries: scenario.session.native.length,
				nativeLifecycleEvents: 0,
			},
			passed: true,
			pressure: {
				maximumContextCharacters: scenario.session.maximumContextCharacters,
				maximumObservedAfterTurn: scenario.provider.maximumPressure,
				maximumProviderPrompt: {
					percent: Number(
						((scenario.provider.providerPromptTokens / MAGIC_CONTEXT_REAL_CONTRACT.contextWindow) * 100).toFixed(
							2,
						),
					),
					tokens: scenario.provider.providerPromptTokens,
				},
				officialMagicMaximum: scenario.provider.magicPressure,
				observations: scenario.observations,
			},
			runAt: new Date().toISOString(),
			schemaVersion: 1,
			session: {
				entries: scenario.session.entries.length,
				sha256: sha256(scenario.session.raw),
			},
		};
		await mkdir(dirname(options.reportPath), { recursive: true });
		await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		console.log(`Magic-only real-provider acceptance passed; report: ${options.reportPath}`);
		console.log(`Retained credential-free evidence: ${evidenceDirectory}`);
	} catch (error) {
		console.error(`Raw diagnostic workspace retained until manual cleanup: ${workspace}`);
		throw error;
	} finally {
		await rm(join(paths.agent, "auth.json"), { force: true }).catch(() => undefined);
	}
}

await main();
