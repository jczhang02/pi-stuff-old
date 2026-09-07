import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSessionCompatibilityScope,
	buildSessionGovernorCompatibilityScope,
	resolveCurrentSessionIdentity,
	sessionArtifactMatches,
} from "../../../packages/pi-stuff/src/subagents/src/shared/session-identity.js";

const roots = new Set<string>();

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-session-identity-"));
	roots.add(root);
	return root;
}

function header(file: string, id: string, timestamp: string): void {
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/project" })}\n`, {
		mode: 0o600,
	});
}

function manager(file: string | undefined, id: string) {
	return { getSessionFile: () => file, getSessionId: () => id };
}

function launchEntry(callId: string) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "subagent", arguments: { agent: "worker", task: "Inspect" } }],
		},
	};
}

function parallelLaunchEntry(callId: string, count: number) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "subagent",
					arguments: {
						tasks: Array.from({ length: count }, (_, index) => ({ agent: "worker", task: `Task ${index}` })),
					},
				},
			],
		},
	};
}

function legacyRunId(callId: string): string {
	return createHash("sha256").update("\0").update(callId).digest("hex").slice(0, 12);
}

describe("physical Pi session identity", () => {
	test("bridges only branch-proven v1 artifacts when one path is reused by a new header", () => {
		const root = fixture();
		const file = path.join(root, "reused.jsonl");
		header(file, "header-a", "2026-08-06T00:00:00.000Z");
		const identityA = resolveCurrentSessionIdentity(manager(file, "header-a"), "/project");
		const callA = "call-a";
		const scopeA = buildSessionCompatibilityScope(identityA, [launchEntry(callA)]);

		header(file, "header-b", "2026-08-06T01:00:00.000Z");
		const identityB = resolveCurrentSessionIdentity(manager(file, "header-b"), "/project");
		const callB = "call-b";
		const scopeB = buildSessionCompatibilityScope(identityB, [launchEntry(callB)]);

		expect(identityB.sessionId).not.toBe(identityA.sessionId);
		expect(sessionArtifactMatches(scopeA, file, legacyRunId(callA))).toBeTrue();
		expect(sessionArtifactMatches(scopeB, file, legacyRunId(callA))).toBeFalse();
		expect(sessionArtifactMatches(scopeB, file, legacyRunId(callB))).toBeTrue();
		expect(sessionArtifactMatches(scopeB, identityB.sessionId, "any-v2-run")).toBeTrue();
	});

	test("keeps copied same-header paths isolated in both artifact and default governor namespaces", () => {
		const root = fixture();
		const first = path.join(root, "first.jsonl");
		const second = path.join(root, "second.jsonl");
		header(first, "same-header", "2026-08-06T00:00:00.000Z");
		fs.copyFileSync(first, second);

		const firstIdentity = resolveCurrentSessionIdentity(manager(first, "same-header"), "/project");
		const secondIdentity = resolveCurrentSessionIdentity(manager(second, "same-header"), "/project");

		expect(firstIdentity.sessionId).not.toBe(secondIdentity.sessionId);
		expect(firstIdentity.governorSessionId).toBe(firstIdentity.sessionId);
		expect(secondIdentity.governorSessionId).toBe(secondIdentity.sessionId);
		expect(firstIdentity.governorSessionId).not.toBe(secondIdentity.governorSessionId);
	});

	test("keeps one ephemeral logical session stable across extension reload nonces", () => {
		const first = resolveCurrentSessionIdentity(manager(undefined, "ephemeral-id"), "/project", "host-a");
		const second = resolveCurrentSessionIdentity(manager(undefined, "ephemeral-id"), "/project", "host-b");
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.governorSessionId).toBe(first.governorSessionId);
	});

	test("keeps a missing session path stable before and after creation through a symlinked parent", () => {
		if (process.platform === "win32") return;
		const root = fixture();
		const real = path.join(root, "real");
		const linked = path.join(root, "linked");
		fs.mkdirSync(real);
		fs.symlinkSync(real, linked, "dir");
		const file = path.join(linked, "new-session.jsonl");

		const before = resolveCurrentSessionIdentity(manager(file, "stable-header"), "/project");
		header(file, "stable-header", "2026-08-06T00:00:00.000Z");
		const after = resolveCurrentSessionIdentity(manager(file, "stable-header"), "/project");

		expect(after.sessionId).toBe(before.sessionId);
	});

	test("accepts the same bounded header position as Pi after blank and malformed prefix lines", () => {
		const root = fixture();
		const file = path.join(root, "prefixed.jsonl");
		fs.writeFileSync(
			file,
			`\nnot-json\n${JSON.stringify({
				type: "session",
				id: "prefixed-header",
				timestamp: "2026-08-06T00:00:00.000Z",
			})}\n`,
		);

		const identity = resolveCurrentSessionIdentity(manager(file, "prefixed-header"), "/project");

		expect(identity.legacyArtifactSessionId).toBe(file);
		expect(identity.startedAtMs).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
	});

	test("separates exact governor launch records from artifact and unpaired management results", () => {
		const identity = resolveCurrentSessionIdentity(manager(undefined, "governor-scope"), "/project");
		const callId = "parallel-call";
		const runId = legacyRunId(callId);
		const entries = [
			parallelLaunchEntry(callId, 2),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: callId,
					details: { mode: "parallel", runId, results: [{}, {}] },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "management-call",
					details: { runId: "foreign-management-result", asyncId: "foreign-management-result" },
				},
			},
		];

		const scope = buildSessionGovernorCompatibilityScope(identity, entries);

		expect([...scope.declaredLogicalAgentIds].sort()).toEqual([`${runId}:0`, `${runId}:1`]);
		expect([...scope.startedLogicalAgentIds].sort()).toEqual([`${runId}:0`, `${runId}:1`]);
		expect(scope.declaredLogicalAgentIds.has(`${runId}:99`)).toBeFalse();
		expect([...scope.startedLogicalAgentIds].some((id) => id.startsWith("foreign-management-result"))).toBeFalse();
	});
});
