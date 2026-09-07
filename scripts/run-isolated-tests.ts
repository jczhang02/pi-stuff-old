import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolvePiBinary } from "./installed-tools.ts";
import { preflightTests, requirementsForTest, type TestProfile } from "./test-environment.ts";
import { prepareGoalTests } from "./test-goal-upstream.ts";
import { discoverTestFiles } from "./test-inventory.ts";
import { readVerificationPlan } from "./verification-plan-contract.ts";

const LEVELS = new Set(["unit", "component-integration", "system", "system-integration", "acceptance"]);

function runTestFiles(
	testFiles: readonly string[],
	options: {
		nodeRoot: string;
		repositoryRoot: string;
		nativeDirectory: string;
		names: readonly string[];
		profile: TestProfile;
		acceptanceMatrix: "full" | "representative";
		reportPath: string;
		keepGoing: boolean;
	},
) {
	const { nodeRoot, repositoryRoot, nativeDirectory, names, profile, acceptanceMatrix, reportPath, keepGoing } =
		options;
	const results: { file: string; exitCode: number; durationMs: number; executed: number; skipped: number }[] = [];
	const persist = (status: "running" | "failed", inProgress?: string) =>
		writeFileSync(
			reportPath,
			`${JSON.stringify({ profile, status, acceptanceMatrix, scope: { files: testFiles }, results, inProgress: inProgress ? [inProgress] : [], notRun: testFiles.slice(results.length + (inProgress ? 1 : 0)), cancelled: [] }, null, 2)}\n`,
		);
	for (const [index, testFile] of testFiles.entries()) {
		persist("running", testFile);
		const title = `[${index + 1}/${testFiles.length}] ${testFile}`;
		const githubGroup = process.env["GITHUB_ACTIONS"] === "true";
		if (githubGroup) console.log(`::group::${title}`);
		else console.log(`\n${title}`);

		const started = performance.now();
		const nodeTest = testFile.endsWith(".node.ts");
		const nameArgs = names.length > 0 ? ["--test-name-pattern", `(?:${names.join(")|(?:")})`] : [];
		const nativeReport = join(nativeDirectory, `${index}.junit.xml`);
		rmSync(nativeReport, { force: true });
		const command = nodeTest
			? [
					"node",
					...nameArgs,
					"--test-reporter=spec",
					"--test-reporter-destination=stdout",
					"--test-reporter=junit",
					`--test-reporter-destination=${nativeReport}`,
					testFile.replace(/\.ts$/u, ".js"),
				]
			: [
					process.execPath,
					"test",
					"--timeout",
					"30000",
					...(names.length ? ["--pass-with-no-tests"] : []),
					"--reporter=junit",
					`--reporter-outfile=${nativeReport}`,
					...nameArgs,
					`./${testFile}`,
				];
		const result = Bun.spawnSync({
			cmd: command,
			cwd: nodeTest ? nodeRoot : repositoryRoot,
			env: {
				...process.env,
				PI_BIN: requirementsForTest(testFile).includes("pi") ? resolvePiBinary() : process.env["PI_BIN"],
				PI_STUFF_TEST_PROFILE: profile,
				PI_STUFF_ACCEPTANCE_MATRIX: acceptanceMatrix,
			},
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});

		if (githubGroup) console.log("::endgroup::");
		const nativeOutput = existsSync(nativeReport) ? readFileSync(nativeReport, "utf8") : "";
		const skipped = (nativeOutput.match(/<skipped\b/gu) ?? []).length;
		const executed = Math.max(0, (nativeOutput.match(/<testcase\b/gu) ?? []).length - skipped);
		const exitCode = result.exitCode || (!nativeOutput || (names.length === 0 && executed === 0) ? 1 : 0);
		results.push({
			file: testFile,
			exitCode,
			durationMs: performance.now() - started,
			executed,
			skipped,
		});
		persist(exitCode === 0 ? "running" : "failed");
		if (exitCode !== 0 && !keepGoing) break;
	}
	return results;
}

function parseTestArguments(args: string[]) {
	return parseArgs({
		args,
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			list: { type: "boolean" },
			file: { type: "string", multiple: true },
			level: { type: "string", multiple: true },
			capability: { type: "string", multiple: true },
			name: { type: "string", multiple: true },
			output: { type: "string" },
			profile: { type: "string" },
			matrix: { type: "string" },
			plan: { type: "string" },
			"keep-going": { type: "boolean" },
		},
	});
}

function selectTestFiles({ values, positionals }: ReturnType<typeof parseTestArguments>) {
	if (values.plan === "" || values.output === "") throw new Error("--plan and --output require a non-empty path");
	const profile = values.profile ?? "offline";
	if (profile !== "offline" && profile !== "live") throw new Error(`Unknown test profile: ${profile}`);
	const repositoryRoot = process.cwd();
	const testRoot = resolve(repositoryRoot, "tests");
	const filters = [...(values.file ?? []), ...positionals];
	const levels = values.level ?? [];
	const capabilities = values.capability ?? [];
	const names = values.name ?? [];
	const plan = values.plan ? readVerificationPlan(values.plan, repositoryRoot) : undefined;
	if (plan && ([...filters, ...levels, ...capabilities, ...names].length > 0 || values.profile || values.matrix))
		throw new Error("--plan cannot be combined with test selectors, --profile, or --matrix");
	for (const level of levels) if (!LEVELS.has(level)) throw new Error(`Unknown test level: ${level}`);
	if ([...filters, ...capabilities, ...names].some((filter) => filter.length === 0))
		throw new Error("Test selectors must not be empty");
	const discovered = (plan ? plan.files.map((file) => resolve(repositoryRoot, file)) : discoverTestFiles(testRoot))
		.map((path) => relative(repositoryRoot, path))
		.filter((path) => (profile === "live" ? path.endsWith("-live.test.ts") : !path.endsWith("-live.test.ts")));
	for (const filter of filters) {
		if (!discovered.some((path) => path.includes(filter))) throw new Error(`No test files match: ${filter}`);
	}
	for (const capability of capabilities) {
		if (!discovered.some((path) => path.split("/")[2] === capability))
			throw new Error(`No test files match capability: ${capability}`);
	}
	for (const name of names) {
		try {
			new RegExp(name, "u");
		} catch {
			throw new Error(`Invalid test name pattern: ${name}`);
		}
	}
	const testFiles = discovered.filter((path) => {
		const parts = path.split("/");
		return (
			(filters.length === 0 || filters.some((filter) => path.includes(filter))) &&
			(levels.length === 0 || levels.includes(parts[1] ?? "")) &&
			(capabilities.length === 0 || capabilities.includes(parts[2] ?? ""))
		);
	});
	const acceptanceMatrix = plan?.acceptanceMatrix ?? values.matrix ?? "full";
	if (acceptanceMatrix !== "full" && acceptanceMatrix !== "representative")
		throw new Error(`Unknown acceptance matrix: ${acceptanceMatrix}`);
	return { profile, repositoryRoot, levels, capabilities, names, plan, testFiles, acceptanceMatrix } as const;
}

async function prepareTestRun(selection: ReturnType<typeof selectTestFiles>, reportPath: string) {
	const { testFiles, profile, repositoryRoot, acceptanceMatrix } = selection;
	const started = performance.now();
	const pending = {
		profile,
		acceptanceMatrix,
		scope: { files: testFiles },
		results: [],
		notRun: testFiles,
		cancelled: [],
		inProgress: [],
	};
	writeFileSync(reportPath, `${JSON.stringify({ ...pending, status: "running" }, null, 2)}\n`);
	try {
		await preflightTests(testFiles, profile);
		const nodeRoot = testFiles.some((path) => path.endsWith(".node.ts"))
			? await prepareGoalTests(repositoryRoot)
			: repositoryRoot;
		return { nodeRoot, setupDurationMs: performance.now() - started };
	} catch (error) {
		writeFileSync(
			reportPath,
			`${JSON.stringify({ ...pending, status: "preflight-failed", error: String(error) }, null, 2)}\n`,
		);
		throw error;
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseTestArguments(process.argv.slice(2));
	if (values.help) {
		console.log(
			"Usage: bun run test [--level <level>] [--capability <name>] [--name <pattern>] [--file <path-fragment>] [file ...] [--list] [--profile offline|live] [--matrix full|representative] [--keep-going] [--plan <plan.json>] [--output <report.json>]",
		);
		console.log("Offline tests, one OS process per file. --list previews without executing tests.");
		return;
	}
	const selection = selectTestFiles({ values, positionals });
	const { profile, repositoryRoot, levels, capabilities, names, plan, testFiles, acceptanceMatrix } = selection;
	const keepGoing = values["keep-going"] === true;
	const reportPath = resolve(
		values.output ?? `.artifacts/tests/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.json`,
	);
	if (testFiles.length === 0) {
		if (plan?.mode === "none") {
			console.log(`Plan selected no tests: ${plan.reason}`);
			if (!values.list) {
				mkdirSync(dirname(reportPath), { recursive: true });
				writeFileSync(
					reportPath,
					`${JSON.stringify({ profile, status: "not-run", plan, results: [] }, null, 2)}\n`,
				);
			}
			return;
		}
		console.error("No test files were discovered under tests/.");
		process.exitCode = 1;
		return;
	}

	console.log(
		`Profile: ${profile}; ${profile === "offline" ? "no live Providers" : "live Provider calls"}. Report: ${reportPath}`,
	);
	console.log(
		`Selected ${testFiles.length} test files, each in its own Bun or Node OS process. Acceptance matrix: ${acceptanceMatrix}; ${keepGoing ? "complete diagnostics" : "stop on failure"}.`,
	);
	if (values.list) {
		console.log(testFiles.map((file) => `${file} [${requirementsForTest(file).join(", ")}]`).join("\n"));
		if (names.length)
			console.log(
				`Name patterns ${JSON.stringify(names)} are applied by the native runner; listed files are candidates.`,
			);
		return;
	}
	mkdirSync(dirname(reportPath), { recursive: true });
	const { nodeRoot, setupDurationMs } = await prepareTestRun(selection, reportPath);
	const nativeDirectory = `${reportPath}.native`;
	mkdirSync(nativeDirectory, { recursive: true });
	const results = runTestFiles(testFiles, {
		nodeRoot,
		repositoryRoot,
		nativeDirectory,
		names,
		profile,
		acceptanceMatrix,
		reportPath,
		keepGoing,
	});
	const notRun = testFiles.slice(results.length);
	const matched = names.length === 0 || results.some((result) => result.executed > 0);
	const status =
		!matched || results.some((result) => result.exitCode !== 0) ? "failed" : notRun.length ? "incomplete" : "passed";
	writeFileSync(
		reportPath,
		`${JSON.stringify(
			{
				profile,
				status,
				acceptanceMatrix,
				keepGoing,
				setupDurationMs,
				scope: { levels, capabilities, names, files: testFiles },
				results,
				notRun,
				cancelled: [],
				inProgress: [],
				totals: {
					nativeExecuted: results.reduce((sum, result) => sum + result.executed, 0),
					skipped: results.reduce((sum, result) => sum + result.skipped, 0),
					durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
				},
			},
			null,
			2,
		)}\n`,
	);
	const failures = results.filter((result) => result.exitCode !== 0).map((result) => result.file);

	if (failures.length > 0 || notRun.length > 0) {
		console.error(`\n${failures.length} isolated test file(s) failed:`);
		for (const testFile of failures) console.error(`- failed: ${testFile}`);
		for (const testFile of notRun) console.error(`- not run: ${testFile}`);
		process.exitCode = 1;
		return;
	}
	if (!matched) {
		console.error("No tests matched the requested name pattern(s).");
		process.exitCode = 1;
		return;
	}

	console.log(`\nAll ${testFiles.length} isolated test files passed.`);
}

if (import.meta.main) await main();
