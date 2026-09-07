import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import {
	acquireSessionLease,
	SessionLeaseConflictError,
	sessionLeaseDir,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/session-lease.js";

const roots = new Set<string>();
const LEGACY_OWNER_SCHEMA = Type.Object({ asyncDir: Type.Optional(Type.String()) }, { additionalProperties: true });

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-session-lease-"));
	roots.add(root);
	const leases = path.join(root, "leases");
	const sessionFile = path.join(root, "session.jsonl");
	const oldAsyncDir = path.join(root, "old-run");
	const nextAsyncDir = path.join(root, "next-run");
	fs.writeFileSync(sessionFile, "", { mode: 0o600 });
	fs.mkdirSync(oldAsyncDir, { mode: 0o700 });
	fs.mkdirSync(nextAsyncDir, { mode: 0o700 });
	return { leases, sessionFile, oldAsyncDir, nextAsyncDir };
}

function acquireOriginal(input: ReturnType<typeof fixture>) {
	return acquireSessionLease(
		{
			sessionFile: input.sessionFile,
			asyncDir: input.oldAsyncDir,
			runId: "old-run",
			sourceRunId: "source-run",
		},
		{
			rootDir: input.leases,
			pid: 101,
			hostname: "test-host",
			processStartIdentity: "runner-old",
			getProcessStartIdentity: (pid) => (pid === 202 ? "writer-old" : undefined),
		},
	);
}

function acquireContender(
	input: ReturnType<typeof fixture>,
	inspectWriterLiveness: (asyncDir: string) => boolean | undefined,
	isProcessAlive: (pid: number) => boolean | undefined = () => false,
) {
	return acquireSessionLease(
		{
			sessionFile: input.sessionFile,
			asyncDir: input.nextAsyncDir,
			runId: "next-run",
			sourceRunId: "source-run",
		},
		{
			rootDir: input.leases,
			pid: 303,
			hostname: "test-host",
			processStartIdentity: "runner-next",
			isProcessAlive,
			getProcessStartIdentity: () => undefined,
			inspectWriterLiveness,
		},
	);
}

describe("canonical Agent session lease", () => {
	test("retains the lease while the authenticated writer registry reports a survivor", () => {
		const input = fixture();
		const original = acquireOriginal(input);
		original.updateWriter({ state: "running", pid: 202 });
		let inspectedPath: string | undefined;

		expect(() =>
			acquireContender(input, (asyncDir) => {
				inspectedPath = asyncDir;
				return true;
			}),
		).toThrow(SessionLeaseConflictError);
		expect(inspectedPath).toBe(fs.realpathSync(input.oldAsyncDir));
		expect(original.release()).toBeTrue();
	});

	test("retains unknown and legacy leases instead of guessing that writers are gone", () => {
		for (const mode of ["unknown", "legacy"] as const) {
			const input = fixture();
			const original = acquireOriginal(input);
			if (mode === "legacy") {
				const ownerPath = path.join(sessionLeaseDir(input.sessionFile, input.leases), "owner.json");
				const owner = parseJsonValue(fs.readFileSync(ownerPath, "utf-8"));
				if (!Check(LEGACY_OWNER_SCHEMA, owner)) throw new Error("Expected a Session lease owner object");
				delete owner.asyncDir;
				fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
			}

			expect(() => acquireContender(input, () => undefined)).toThrow(SessionLeaseConflictError);
			if (mode === "unknown") expect(original.release()).toBeTrue();
		}
	});

	test("requires registry absence even during the lease-none crash window", () => {
		const input = fixture();
		const original = acquireOriginal(input);

		expect(() => acquireContender(input, () => true)).toThrow(SessionLeaseConflictError);
		expect(original.release()).toBeTrue();
	});

	test("allows exactly one new owner after both processes and every writer group are proven absent", () => {
		const input = fixture();
		const original = acquireOriginal(input);
		original.updateWriter({ state: "running", pid: 202 });
		const winner = acquireContender(input, () => false);

		expect(winner.owner.runId).toBe("next-run");
		expect(original.release()).toBeFalse();
		expect(() =>
			acquireContender(
				input,
				() => false,
				(pid) => pid === 303,
			),
		).toThrow(SessionLeaseConflictError);
		expect(winner.release()).toBeTrue();
	});
});
