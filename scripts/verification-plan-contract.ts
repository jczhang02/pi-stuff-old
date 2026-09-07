import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { discoverTestFiles } from "./test-inventory.ts";
import type { VerificationPlan } from "./verification-plan.ts";

const SHA = /^[0-9a-f]{40}$/u;
const PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/u;

const VERIFICATION_PLAN_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		profile: Type.Literal("offline"),
		base: Type.Union([Type.String(), Type.Null()]),
		head: Type.Union([Type.String(), Type.Null()]),
		mode: Type.Union([Type.Literal("all"), Type.Literal("selected"), Type.Literal("none")]),
		reason: Type.String(),
		changedFiles: Type.Array(Type.String()),
		files: Type.Array(Type.String()),
		acceptanceMatrix: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("representative")])),
		previousFullRun: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
type PlanDocument = Static<typeof VERIFICATION_PLAN_SCHEMA>;

function gitHead(root: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function validSha(value: string | null): value is string {
	return value !== null && SHA.test(value) && !/^0{40}$/u.test(value);
}

function pathIsSafe(value: string): boolean {
	return PATH.test(value);
}

function validatePlan(value: PlanDocument, root: string): VerificationPlan {
	if (value.base !== null && !validSha(value.base)) throw new Error("Verification plan has an invalid base");
	if (!validSha(value.head)) throw new Error("Verification plan must contain a valid head");
	if (value.head !== gitHead(root)) throw new Error(`Verification plan is stale: expected ${value.head}`);
	const offline = discoverTestFiles(resolve(root, "tests"))
		.map((file) => relative(root, file))
		.filter((file) => !file.endsWith("-live.test.ts"))
		.sort();
	const known = new Set(offline);
	const validatePaths = (paths: readonly string[], label: string): void => {
		const seen = new Set<string>();
		for (const path of paths) {
			if (!pathIsSafe(path)) throw new Error(`Verification plan contains unsafe ${label} path: ${path}`);
			if (seen.has(path)) throw new Error(`Verification plan contains duplicate ${label} path: ${path}`);
			seen.add(path);
		}
	};
	validatePaths(value.changedFiles, "changed-file");
	validatePaths(value.files, "test");
	for (const file of value.files) {
		if (!known.has(file) || file.endsWith("-live.test.ts"))
			throw new Error(`Verification plan contains unknown or live test: ${file}`);
	}
	if (
		value.mode === "all" &&
		(value.files.length !== offline.length ||
			value.files.some((file, i) => file !== offline[i]) ||
			value.acceptanceMatrix === "representative")
	)
		throw new Error("An all verification plan must contain the complete offline test inventory");
	if (value.mode === "selected" && value.files.length === 0)
		throw new Error("A selected verification plan must contain files");
	const reusedFullRun =
		value.previousFullRun !== undefined && value.base === value.head && value.changedFiles.length === 0;
	if (value.previousFullRun !== undefined && (value.mode !== "none" || !reusedFullRun))
		throw new Error("Reused full-run evidence requires an unchanged none plan");
	if (
		value.mode === "none" &&
		(value.files.length !== 0 || (value.changedFiles.length === 0 && !reusedFullRun) || value.base === null)
	)
		throw new Error("A none verification plan requires changed files, a resolved base, and no tests");
	if (value.files.length === offline.length && value.mode === "selected")
		throw new Error("A complete test inventory must use all mode");
	return value;
}

export function readVerificationPlan(path: string, root = process.cwd()): VerificationPlan {
	const raw: unknown = JSON.parse(readFileSync(resolve(root, path), "utf8"));
	if (!Value.Check(VERIFICATION_PLAN_SCHEMA, raw)) throw new Error("Invalid verification plan schema");
	return validatePlan(Value.Parse(VERIFICATION_PLAN_SCHEMA, raw), root);
}
