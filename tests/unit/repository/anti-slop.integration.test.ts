import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RULES = [
	"no-chained-type-assertions",
	"no-conditional-empty-object-spread",
	"no-known-value-widening",
	"no-module-mocking",
	"no-object-parameters",
	"no-reflect-apply",
	"no-reflect-get",
	"no-runtime-typeof",
	"no-shape-in-symbol-names",
	"no-unknown-parameters",
	"no-unknown-returns",
	"no-unknown-type-aliases",
	"no-unsafe-dictionary-type",
	"no-widen-then-assert",
	"require-safety-comment-for-type-assertion",
] as const;

const INVALID_FIXTURE = `
import { makeFixtureService } from "./fixture-service.ts";

declare const callable: (...args: string[]) => string;
declare const receiver: { value: string };
declare const argumentsList: string[];

const chained = "value" as string as number;
const conditionalSpread = { ...(true ? { value: 1 } : {}) };
const widened: unknown = { value: 1 };
const narrowed = widened as { value: number };
vi.mock("./dependency");
function acceptsObject(value: object): void { void value; }
Reflect.apply(callable, receiver, argumentsList);
Reflect.get(receiver, "value");
const runtimeKind = typeof receiver;
const shape = runtimeKind;
function acceptsUnknown(value: unknown): void { void value; }
function returnsUnknown(): unknown { return receiver; }
type HiddenUnknown = unknown;
type UnsafeDictionary = Record<string, unknown>;
const assertionWithoutSafety = receiver as { value: string };
void [makeFixtureService, chained, conditionalSpread, narrowed, shape, assertionWithoutSafety];
`;

const VALID_FIXTURE = `
interface Input { value: string }
declare const callable: (...args: string[]) => string;
declare const receiver: Input;
declare const argumentsList: string[];
declare const vi: { fn(): void };

// SAFETY: fixture value is declared as Input above.
const singleAssertion = receiver as Input;
const conditionalSpread = { ...(true ? { value: 1 } : { value: 2 }) };
const inferred = { value: 1 };
vi.fn();
function acceptsInput(value: Input): void { void value; }
callable(...argumentsList);
receiver.value;
const runtimeKind = "object";
const geometry = runtimeKind;
function acceptsGeneric<Value>(value: Value): Value { return value; }
function returnsString(): string { return receiver.value; }
type Text = string;
type SafeDictionary = Record<string, number>;
void [singleAssertion, conditionalSpread, inferred, geometry, acceptsGeneric, returnsString];
`;

test("repository Oxlint config wires every anti-slop rule with positive and negative fixtures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-anti-slop-"));
	try {
		const invalidPath = join(directory, "invalid.ts");
		const validPath = join(directory, "valid.ts");
		await Promise.all([Bun.write(invalidPath, INVALID_FIXTURE), Bun.write(validPath, VALID_FIXTURE)]);
		const root = join(import.meta.dir, "../../..");
		const oxlint = join(root, "node_modules", ".bin", "oxlint");
		const run = (path: string) =>
			Bun.spawnSync([oxlint, "--config", join(root, ".oxlintrc.json"), path], {
				cwd: root,
				stderr: "pipe",
				stdout: "pipe",
			});

		const invalid = run(invalidPath);
		const diagnostics = `${invalid.stdout.toString()}\n${invalid.stderr.toString()}`;
		expect(invalid.exitCode).not.toBe(0);
		for (const rule of RULES) expect(diagnostics).toContain(`anti-slop(${rule})`);
		expect(diagnostics).toContain("anti-slop-effect(no-service-constructor-imports)");

		const valid = run(validPath);
		const validDiagnostics = `${valid.stdout.toString()}\n${valid.stderr.toString()}`;
		expect(validDiagnostics).not.toContain("anti-slop(");
		expect(validDiagnostics).not.toContain("anti-slop-effect(");
		expect(valid.exitCode).toBe(0);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
