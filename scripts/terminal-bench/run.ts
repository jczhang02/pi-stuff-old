import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import manifest from "../../tests/benchmarks/terminal-bench-2.1/manifest.json" with { type: "json" };
import { CERTIFIED_PI_VERSION } from "../pi-host-contract.js";
import { archiveUnfinishedTrials, type EvaluationReport, summarizeEvaluation } from "./results.js";
import {
	CONTAINER_ROOT,
	command,
	evaluationRuntime,
	fingerprintAssets,
	prepareEvaluationAssets,
	prepareEvaluationCredentials,
} from "./runtime.js";
import { freezeEvaluationSource } from "./source.js";

export type EvaluationOptions = {
	tasks: string[];
	repetitions: number;
	concurrency: number;
	worktree?: string;
	output?: string;
	resume?: string;
};

const PROTOCOL = Type.Object({
	schemaVersion: Type.Literal(1),
	tasks: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
	repetitions: Type.Integer({ minimum: 1 }),
	assetsSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	configSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	harborVersion: Type.Literal("0.22.0"),
});

async function fileDigest(path: string): Promise<string> {
	return createHash("sha256")
		.update(await Bun.file(path).bytes())
		.digest("hex");
}

async function prepare(directory: string, options: EvaluationOptions, python: string): Promise<void> {
	await mkdir(dirname(directory), { recursive: true });
	await mkdir(directory, { mode: 0o700 });
	const assets = join(directory, "assets");
	const source = await freezeEvaluationSource(
		resolve(import.meta.dir, "../.."),
		join(assets, "source"),
		options.worktree,
	);
	await prepareEvaluationAssets(assets);
	await Bun.write(join(assets, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const configPath = join(directory, "harbor.json");
	await Bun.write(
		configPath,
		JSON.stringify({
			job_name: "job",
			jobs_dir: directory,
			n_attempts: options.repetitions,
			n_concurrent_trials: options.concurrency,
			retry: { max_retries: 0 },
			environment: {
				type: "docker",
				mounts: [{ type: "bind", source: assets, target: CONTAINER_ROOT, read_only: true }],
			},
			agents: [{ import_path: manifest.agent.importPath, model_name: manifest.model.id }],
			selected_tasks: options.tasks,
		}),
	);
	console.log("Resolving the pinned 89-task upstream manifest…");
	await command([python, join(assets, "pi_stuff_agent.py"), join(assets, "manifest.json"), configPath]);
	await Bun.write(
		join(directory, "protocol.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				tasks: options.tasks,
				repetitions: options.repetitions,
				concurrency: options.concurrency,
				source,
				model: manifest.model,
				harborVersion: manifest.harborVersion,
				piVersion: CERTIFIED_PI_VERSION,
				createdAt: new Date().toISOString(),
				dataset: manifest.dataset,
				assetsSha256: await fingerprintAssets(assets),
				configSha256: await fileDigest(configPath),
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(join(directory, "protocol.sha256"), `${await fileDigest(join(directory, "protocol.json"))}\n`);
}

export async function verifyResume(directory: string): Promise<void> {
	if (
		(await fileDigest(join(directory, "protocol.json"))) !==
		(await Bun.file(join(directory, "protocol.sha256")).text()).trim()
	)
		throw new Error("Frozen evaluation protocol changed; resume requires the original snapshot");
	if (!(await Bun.file(join(directory, "job", "config.json")).exists()))
		throw new Error("Cannot resume without the original Harbor job state");
	const value: unknown = await Bun.file(join(directory, "protocol.json")).json();
	if (!Check(PROTOCOL, value)) throw new Error("Invalid or incompatible frozen evaluation protocol");
	if (
		(await fingerprintAssets(join(directory, "assets"))) !== value.assetsSha256 ||
		(await fileDigest(join(directory, "harbor.json"))) !== value.configSha256
	) {
		throw new Error("Frozen evaluation assets/configuration changed; resume requires the original snapshot");
	}
	await archiveUnfinishedTrials(directory);
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
	const path = join(directory, "running.pid");
	if (await Bun.file(path).exists()) {
		const pid = Number(await Bun.file(path).text());
		if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid evaluation process lock");
		try {
			process.kill(pid, 0);
			throw new Error(`Evaluation is already running in process ${pid}`);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
		}
		await rm(path);
	}
	const lock = await open(path, "wx", 0o600);
	await lock.writeFile(String(process.pid));
	await lock.close();
	return () => rm(path);
}

function reportLine(report: EvaluationReport): string {
	return `${report.completed}/${report.denominator} complete · ${report.passed} passed · ${report.observedTokens} observed tokens · $${report.observedCost.toFixed(6)} observed cost · ${report.pendingCalls} calls with unresolved usage`;
}

async function execute(
	directory: string,
	resume: boolean,
	runtime: Awaited<ReturnType<typeof evaluationRuntime>>,
): Promise<number> {
	const args = resume
		? ["jobs", "resume", "--job-path", join(directory, "job")]
		: ["run", "--config", join(directory, "harbor.json")];
	const child = Bun.spawn([runtime.harbor, ...args], {
		cwd: directory,
		detached: true,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...runtime.environment, PYTHONPATH: join(directory, "assets"), PYTHONDONTWRITEBYTECODE: "1" },
	});
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
		child.kill("SIGINT");
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	let lastLine = "";
	let pending: Promise<void> | undefined;
	let reportError: unknown;
	const timer = setInterval(() => {
		if (pending) return;
		pending = summarizeEvaluation(directory)
			.then(async (report) => {
				const line = reportLine(report);
				if (line !== lastLine) {
					console.log(line);
					lastLine = line;
				}
				await Bun.write(join(directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
			})
			.catch((error) => {
				reportError = error;
				interrupt();
			})
			.finally(() => {
				pending = undefined;
			});
	}, 5_000);
	try {
		const code = await child.exited;
		if (reportError) throw reportError;
		return interrupted ? 130 : code;
	} finally {
		clearInterval(timer);
		await pending;
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

export async function runEvaluation(options: EvaluationOptions): Promise<void> {
	const directory = resolve(
		options.resume ??
			options.output ??
			join(".artifacts", "terminal-bench", `${Date.now()}-${randomUUID().slice(0, 8)}`),
	);
	const runtime = await evaluationRuntime();
	try {
		if (!options.resume) await prepare(directory, options, runtime.python);
		const unlock = await acquireLock(directory);
		try {
			if (options.resume) await verifyResume(directory);
			await prepareEvaluationCredentials(join(directory, "assets"));
			console.log(`Evaluation evidence: ${directory}`);
			const exitCode = await execute(directory, Boolean(options.resume), runtime);
			const report = await summarizeEvaluation(directory);
			await Bun.write(join(directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
			console.log(reportLine(report));
			if (
				exitCode !== 0 ||
				report.incomplete ||
				report.invalidTrials ||
				report.duplicateTrials ||
				report.missingUsageTrials ||
				report.pendingCalls ||
				report.malformedUsageLogs
			) {
				process.exitCode = exitCode || 1;
				console.error(
					`Evaluation is incomplete or has incomplete evidence; inspect ${directory}. Use --resume only to run unfinished tasks.`,
				);
			}
		} finally {
			await rm(join(directory, "assets", "auth.json"), { force: true });
			await rm(join(directory, "assets", "model-store.json"), { force: true });
			await unlock();
		}
	} finally {
		await runtime.cleanup();
	}
}
