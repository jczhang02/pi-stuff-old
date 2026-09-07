import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";

const SAMPLE_SCHEMA = Type.Object({
	directory: Type.String(),
	maximumSpinnerFrameMs: Type.Number(),
	maximumObservationGapMs: Type.Number(),
	purpose: Type.String(),
	observationTimeoutMs: Type.Number(),
});
const EVIDENCE_SCHEMA = Type.Object({
	actions: Type.Array(
		Type.Object({ kind: Type.String(), phase: Type.String(), startedMs: Type.Number(), visibleMs: Type.Number() }),
	),
	providerLog: Type.String(),
	sessions: Type.Array(Type.String(), { minItems: 1 }),
});

function rescheduleGaps(evidence: Static<typeof EVIDENCE_SCHEMA>): number[] {
	const gaps = evidence.actions.flatMap((action, index) => {
		const previous = evidence.actions[index - 1];
		return previous && previous.kind !== "selection-setup"
			? [action.startedMs - previous.startedMs - previous.visibleMs]
			: [];
	});
	expect(gaps.length).toBeGreaterThan(0);
	return gaps;
}

test.each(["--cpu-profile", "--diagnostic"])("rejects %s with acceptance gates before starting Pi", async (flag) => {
	const child = Bun.spawn(
		[process.execPath, resolve("scripts/benchmark-responsiveness.ts"), flag, "--gates", "unused"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode).not.toBe(0);
	expect(stderr).toContain("Diagnostic collection cannot use gates");
});

test.each(["startup", "pre-tool", "settlement"])(
	"continuous native PTY observation detects an injected %s stall",
	async (phase) => {
		const child = Bun.spawn(
			[
				process.execPath,
				resolve("scripts/benchmark-responsiveness.ts"),
				"--pi",
				process.env["PI_BIN"] ?? "/opt/bin/pi",
				"--block-ms",
				"350",
				"--block-phase",
				phase,
				...(phase === "startup" ? ["--diagnostic"] : []),
			],
			{ stderr: "pipe", stdout: "pipe" },
		);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr, stdout).toBe("");
			expect(exitCode, stdout).toBe(0);
			const sample = parseJsonValue(stdout);
			if (!Check(SAMPLE_SCHEMA, sample)) throw new Error("Missing native observation summary");
			expect(sample.purpose).toBe(phase === "startup" ? "extended-diagnosis" : "observer-validation");
			expect(sample.observationTimeoutMs).toBe(phase === "startup" ? 75_000 : 30_000);
			const evidenceText = await readFile(join(sample.directory, "evidence.json"), "utf8");
			const artifactDirectory = process.env["PI_STUFF_UI_PTY_ARTIFACT_DIR"];
			if (artifactDirectory) {
				expect(await readFile(join(artifactDirectory, `${basename(sample.directory)}.json`), "utf8")).toBe(
					evidenceText,
				);
			}
			const evidence = parseJsonValue(evidenceText);
			if (!Check(EVIDENCE_SCHEMA, evidence)) throw new Error("Missing continuous interaction evidence");
			expect(evidence.providerLog).toContain('"response-complete"');
			expect(evidence.sessions.join("\n")).toContain("PSYON_CADENCE_DONE");
			// Negative-control detection floors, not product acceptance limits.
			const observedPhase = phase === "pre-tool" ? "active" : phase;
			const latencies = evidence.actions
				.filter((action) => action.phase === observedPhase)
				.map((action) => action.visibleMs);
			expect(Math.max(...latencies)).toBeGreaterThan(100);
			// A detected pause alone does not rule out blind windows at another timing alignment.
			expect(sample.maximumObservationGapMs).toBeLessThan(100);
			expect(Math.max(...rescheduleGaps(evidence))).toBeLessThan(100);
			if (phase === "pre-tool") expect(sample.maximumSpinnerFrameMs).toBeGreaterThan(350);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
		}
	},
	45_000,
);

test.each(["foreground", "background", "context", "goal"])(
	"continuous Suite observation verifies %s work through its public results",
	async (mode) => {
		const agent = mode === "foreground" || mode === "background";
		const child = Bun.spawn(
			[
				"unshare",
				"--user",
				"--map-root-user",
				"--net",
				"--pid",
				"--fork",
				"--kill-child",
				"--mount-proc",
				// Keep PID > 1 and a namespace-local process group for the existing birth-identity watchdog.
				"setsid",
				"sh",
				"-c",
				'"$@"; exit $?',
				"psyon-pid-init",
				process.execPath,
				resolve("scripts/benchmark-responsiveness.ts"),
				"--pi",
				process.env["PI_BIN"] ?? "/opt/bin/pi",
				"--suite",
				"--package",
				resolve("packages/pi-stuff"),
				...(agent ? ["--agent", mode] : [`--${mode}`]),
			],
			{
				stderr: "pipe",
				stdout: "pipe",
				env: { ...process.env, PSYON_PARENT_NETNS: readlinkSync("/proc/self/ns/net") },
			},
		);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr, stdout).toBe("");
			expect(exitCode, stdout).toBe(0);
			const sample = parseJsonValue(stdout);
			if (!Check(SAMPLE_SCHEMA, sample)) throw new Error("Missing Suite observation summary");
			const evidence = parseJsonValue(await readFile(join(sample.directory, "evidence.json"), "utf8"));
			if (!Check(EVIDENCE_SCHEMA, evidence)) throw new Error("Missing Suite interaction evidence");
			// Normal measurements keep their calibrated action cadence.
			expect(Math.min(...rescheduleGaps(evidence))).toBeGreaterThanOrEqual(250);
			expect(
				Check(
					Type.Object({
						source: Type.Object({
							package: Type.Object({
								directory: Type.Literal(resolve("packages/pi-stuff")),
								commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
								diff: Type.String(),
							}),
						}),
					}),
					evidence,
				),
			).toBe(true);
			const schema = Type.Object({
				completedChildTools: Type.Literal(agent ? 1 : 0),
				reapedChildProcesses: Type.Literal(agent ? 1 : 0),
				agentRowObserved: Type.Literal(agent),
				automaticUsageRefreshes: Type.Literal(mode === "background" ? 2 : 1),
				backgroundOutcomes: Type.Literal(mode === "background" ? 1 : 0),
				backgroundIntegrationRequests: Type.Literal(mode === "background" ? 1 : 0),
				parentCompletedWhileChildRunning: Type.Literal(mode === "background"),
				contextProjectionRequests: Type.Literal(mode === "context" ? 3 : 0),
				contextRetrievals: Type.Literal(mode === "context" ? 1 : 0),
			});
			if (agent) expect(Check(Type.Object({ agentMode: Type.Literal(mode) }), sample)).toBe(true);
			if (mode === "goal")
				expect(
					Check(
						Type.Object({ goalCompleted: Type.Literal(true), goalContinuationRequests: Type.Literal(1) }),
						sample,
					),
				).toBe(true);
			expect(Check(schema, sample)).toBe(true);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
		}
	},
	65_000,
);
