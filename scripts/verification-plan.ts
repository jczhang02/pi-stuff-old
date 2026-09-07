import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverTestFiles, suiteCapabilities, testCapability } from "./test-inventory.ts";
import { verificationDependencies } from "./verification-dependencies.ts";

export type VerificationPlan = {
	version: 1;
	profile: "offline";
	base: string | null;
	head: string | null;
	mode: "all" | "selected" | "none";
	reason: string;
	changedFiles: string[];
	files: string[];
	acceptanceMatrix?: "full" | "representative";
	previousFullRun?: number;
};

const ZERO = "0".repeat(40);
const CODE = /\.(?:[cm]?[jt]sx?|mjs|cjs|py|rb|sh|bash|html)$/u;
const CONTRACT =
	/(?:^|\/)(?:AGENTS|CONTEXT|DESIGN)\.md$|^docs\/(?:compatibility|code-quality)\.md$|(?:^|\/)SKILL\.md$/u;

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function ref(root: string, value: string | undefined): string | null {
	if (!value || value === ZERO) return null;
	try {
		return git(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]).trim();
	} catch {
		return null;
	}
}
function allTests(root: string): string[] {
	return discoverTestFiles(resolve(root, "tests"))
		.map((file) => relative(root, file))
		.filter((file) => !file.endsWith("-live.test.ts"));
}
function names(root: string, args: string[]): string[] {
	return git(root, args).split("\0").filter(Boolean);
}
function committed(root: string, base: string, head: string): string[] {
	return names(root, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", base, head]);
}
function localChanges(root: string): string[] {
	const paths = new Set([
		...names(root, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z"]),
		...names(root, ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"]),
		...names(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return [...paths].sort();
}
function content(root: string, path: string, revision?: string): string {
	try {
		return revision === ":"
			? git(root, ["show", `:${path}`])
			: revision
				? git(root, ["show", `${revision}:${path}`])
				: readFileSync(resolve(root, path), "utf8");
	} catch {
		return "";
	}
}
function metadataPath(path: string): boolean {
	return /^(?:[^/]+|docs\/.*)\.md$/u.test(path) || /^\.beads\/(?:issues\.jsonl|metadata\.json)$/u.test(path);
}
function executableText(text: string): boolean {
	return /```|~~~/u.test(text) || /<script\b|<iframe\b|\bon(?:click|load|error)\s*=|javascript:/iu.test(text);
}
function pureMetadata(root: string, path: string, base: string | null): boolean {
	if (!metadataPath(path) || CONTRACT.test(path)) return false;
	return ![
		content(root, path, base ?? undefined),
		content(root, path, "HEAD"),
		content(root, path),
		content(root, path, ":"),
	].some(executableText);
}
function sharedChange(path: string): boolean {
	return (
		path === "packages/pi-stuff/suite.json" ||
		path.startsWith("packages/pi-stuff/package.json") ||
		path.startsWith("packages/pi-stuff/src/suite-") ||
		path.startsWith("config/") ||
		path.startsWith("schemas/") ||
		path.startsWith(".github/") ||
		path.startsWith("scripts/") ||
		path === "package.json" ||
		path.startsWith("bun.lock") ||
		path.startsWith("tsconfig") ||
		path === "AGENTS.md" ||
		path === "CONTEXT.md" ||
		path === "DESIGN.md" ||
		path === "docs/compatibility.md" ||
		path === "docs/code-quality.md" ||
		path.endsWith("/SKILL.md")
	);
}
function sourceCapability(path: string, capabilities: Set<string>): string | undefined {
	const capability = /^packages\/pi-stuff\/src\/([^/]+)\//u.exec(path)?.[1];
	return capability && (capabilities.has(capability) ? capability : undefined);
}
function affectsAcceptanceDimensions(root: string, path: string, base: string | null): boolean {
	if (!CODE.test(path)) return true;
	const dimension =
		/(?:conversation-ui|theme|geometry|viewport|pty|render|layout|terminal|screen|column|width|height)/iu;
	if (dimension.test(path)) return true;
	const changedText = base ? git(root, ["diff", "--unified=0", base, "--", path]) : "";
	return dimension.test(changedText || content(root, path));
}
function sourceFiles(root: string): string[] {
	return names(root, ["ls-files", "-coz", "--exclude-standard", "--", "packages/pi-stuff", "scripts", "tests"]).filter(
		(path) => CODE.test(path),
	);
}
function dependencyCapabilities(root: string, changed: string[], all: string[], capabilities: Set<string>) {
	const { reverse, uncertain } = verificationDependencies(root, sourceFiles(root), all);
	const seen = new Set(changed);
	const caps = new Set<string>();
	for (const path of changed) {
		const cap = sourceCapability(path, capabilities);
		if (cap) caps.add(cap);
	}
	const queue = [...changed];
	for (const current of queue) {
		for (const dependent of reverse.get(current) ?? []) {
			if (seen.has(dependent)) continue;
			seen.add(dependent);
			queue.push(dependent);
			const cap =
				sourceCapability(dependent, capabilities) ??
				(dependent.startsWith("tests/") ? testCapability(dependent, capabilities) : undefined);
			if (cap) caps.add(cap);
		}
	}
	return { caps, uncertain };
}
type TestSelection = { files: string[]; reason: string; acceptanceMatrix?: "full" | "representative" };
export function selectAffectedTests(root: string, changed: string[], base: string | null = null): TestSelection {
	const all = allTests(root);
	if (!changed.length) return { files: all, reason: "clean or empty change set; all applicable offline tests" };
	const capabilities = suiteCapabilities(root);
	const known = (path: string): boolean =>
		sourceCapability(path, capabilities) !== undefined ||
		(path.startsWith("tests/") && testCapability(path, capabilities) !== undefined) ||
		pureMetadata(root, path, base);
	if (
		changed.some(
			(path) =>
				sharedChange(path) ||
				!existsSync(resolve(root, path)) ||
				!known(path) ||
				(metadataPath(path) && !pureMetadata(root, path, base)),
		)
	)
		return { files: all, reason: "shared infrastructure or uncertain path; all applicable offline tests" };
	if (changed.every((path) => pureMetadata(root, path, base)))
		return { files: [], reason: "proven non-executable metadata-only change" };
	const { caps, uncertain } = dependencyCapabilities(root, changed, all, capabilities);
	if (uncertain) return { files: all, reason: "dynamic or unresolved dependency; all applicable offline tests" };
	const productionChanged = changed.some((path) => path.startsWith("packages/pi-stuff/src/"));
	for (const path of changed) {
		const cap =
			sourceCapability(path, capabilities) ??
			(path.startsWith("tests/") ? testCapability(path, capabilities) : undefined);
		if (cap) caps.add(cap);
	}
	if (!caps.size) return { files: all, reason: "unknown impact; all applicable offline tests" };
	const files = all.filter((file) => {
		return (
			caps.has(testCapability(file, capabilities) ?? "") ||
			((productionChanged || caps.has("repository")) && testCapability(file, capabilities) === "repository")
		);
	});
	return {
		files: files.length ? files : all,
		reason: `selected changed Capability(s): ${[...caps].sort().join(", ")}`,
		acceptanceMatrix: changed.some((path) => affectsAcceptanceDimensions(root, path, base))
			? "full"
			: "representative",
	};
}
function plan(
	root: string,
	base: string | null,
	head: string | null,
	changed: string[],
	reason?: string,
): VerificationPlan {
	const all = allTests(root);
	const selected = reason ? { files: all, reason } : selectAffectedTests(root, changed, base);
	return {
		version: 1,
		profile: "offline",
		base,
		head,
		mode: selected.files.length === 0 ? "none" : selected.files.length === all.length ? "all" : "selected",
		reason: selected.reason,
		changedFiles: changed,
		files: selected.files,
		acceptanceMatrix: selected.files.length === all.length ? "full" : (selected.acceptanceMatrix ?? "full"),
	};
}
export function buildVerificationPlan(
	root = process.cwd(),
	environment: NodeJS.ProcessEnv = process.env,
): VerificationPlan {
	const head = ref(root, "HEAD");
	const ci = environment["VERIFICATION_PLAN_CI"] === "1";
	if (ci) {
		if (environment["GITHUB_EVENT_NAME"] === "schedule") {
			const previousFullRun = Number(environment["CI_PREVIOUS_FULL_RUN"]);
			if (
				head &&
				environment["CI_PREVIOUS_FULL_SHA"] === head &&
				Number.isSafeInteger(previousFullRun) &&
				previousFullRun > 0
			)
				return {
					version: 1,
					profile: "offline",
					base: head,
					head,
					mode: "none",
					reason: `scheduled main already passed full verification in run ${previousFullRun}`,
					changedFiles: [],
					files: [],
					acceptanceMatrix: "full",
					previousFullRun,
				};
			return plan(
				root,
				null,
				head,
				[],
				"nightly full verification; no reusable full evidence for this main revision",
			);
		}
		if (environment["GITHUB_EVENT_NAME"] === "workflow_dispatch")
			return plan(
				root,
				ref(root, environment["CI_BASE_SHA"]),
				head,
				[],
				"manual dispatch always runs all applicable offline tests",
			);
		if (environment["GITHUB_EVENT_NAME"] !== "pull_request" && environment["GITHUB_EVENT_NAME"] !== "push")
			return plan(root, null, head, [], "missing or unsupported CI event; all applicable offline tests");
		const ciBase = ref(root, environment["CI_BASE_SHA"]);
		const ciHead = ref(root, environment["CI_HEAD_SHA"]);
		if (!ciBase || !ciHead || ciHead !== head)
			return plan(root, ciBase, head, [], "missing or unreliable CI revision range; all applicable offline tests");
		try {
			const base =
				environment["GITHUB_EVENT_NAME"] === "pull_request"
					? git(root, ["merge-base", ciBase, ciHead]).trim()
					: ciBase;
			return plan(root, base, head, committed(root, base, ciHead));
		} catch {
			return plan(
				root,
				ciBase,
				head,
				[],
				"could not establish a reliable CI change range; all applicable offline tests",
			);
		}
	}
	const override = environment["VERIFY_BASE"];
	const target = ref(root, override ?? "origin/main");
	if (override && !target)
		return plan(root, null, head, [], "attempted base is invalid; all applicable offline tests");
	if (!target || !head)
		return plan(
			root,
			target,
			head,
			[],
			"could not establish a reliable local change range; all applicable offline tests",
		);
	try {
		const base = git(root, ["merge-base", target, head]).trim();
		return plan(root, base, head, [...new Set([...committed(root, base, head), ...localChanges(root)])].sort());
	} catch {
		return plan(
			root,
			target,
			head,
			[],
			"could not establish a reliable local change range; all applicable offline tests",
		);
	}
}

function main(): void {
	try {
		const { values } = parseArgs({
			options: { ci: { type: "boolean" }, output: { type: "string" }, help: { type: "boolean", short: "h" } },
			allowPositionals: false,
		});
		if (values.help) {
			console.log("Usage: bun scripts/verification-plan.ts [--ci] [--output <path>]");
			return;
		}
		const env = values.ci ? { ...process.env, VERIFICATION_PLAN_CI: "1" } : process.env;
		if (values.output === "") throw new Error("--output requires a path");
		const output = resolve(values.output ?? ".artifacts/verification-plan.json");
		mkdirSync(dirname(output), { recursive: true });
		const verification = buildVerificationPlan(process.cwd(), env);
		writeFileSync(output, `${JSON.stringify(verification, null, 2)}\n`);
		if (process.env["GITHUB_OUTPUT"])
			appendFileSync(
				process.env["GITHUB_OUTPUT"],
				`tests_required=${verification.mode === "none" ? "false" : "true"}\n`,
			);
		console.log(`${verification.mode}: ${verification.reason}`);
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
if (import.meta.main) main();
