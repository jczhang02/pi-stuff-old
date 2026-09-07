import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAsyncRecoveryDescriptor } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-resume.js";
import { sanitizeSummary } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/nested-summary.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("retired Agent surfaces", () => {
	test("rejects legacy recovery descriptors that request memory or sharing", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-legacy-recovery-"));
		temporaryDirectories.push(asyncDir);
		const descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
		const baseDescriptor = {
			version: 1,
			sourceRunId: "legacy-run",
			agent: "general-purpose",
			cwd: asyncDir,
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: true,
			maxSubagentDepth: 2,
			outputMode: "inline",
		};

		fs.writeFileSync(
			descriptorPath,
			JSON.stringify({ ...baseDescriptor, memory: { scope: "project", path: "/tmp/memory" } }),
		);
		expect(() => readAsyncRecoveryDescriptor(asyncDir)).toThrow("unknown field 'memory'");

		fs.writeFileSync(descriptorPath, JSON.stringify({ ...baseDescriptor, share: true }));
		expect(() => readAsyncRecoveryDescriptor(asyncDir)).toThrow("unknown field 'share'");

		fs.writeFileSync(descriptorPath, JSON.stringify(baseDescriptor));
		expect(readAsyncRecoveryDescriptor(asyncDir)).toMatchObject(baseDescriptor);
	});

	test("drops legacy nested-run mode metadata without dropping transcript evidence", () => {
		const summary = sanitizeSummary({
			id: "nested-run",
			parentRunId: "root-run",
			depth: 1,
			path: [{ runId: "root-run", stepIndex: 0, agent: "general-purpose" }],
			state: "running",
			mode: "chain",
			chainStepCount: 2,
			sessionFile: "/tmp/nested.jsonl",
			steps: [
				{
					agent: "general-purpose",
					status: "running",
					sessionFile: "/tmp/child.jsonl",
					transcriptPath: "/tmp/child.md",
				},
			],
		});

		expect(summary).toMatchObject({
			id: "nested-run",
			sessionFile: "/tmp/nested.jsonl",
			steps: [{ sessionFile: "/tmp/child.jsonl", transcriptPath: "/tmp/child.md" }],
		});
		expect(summary).not.toHaveProperty("mode");
		expect(summary).not.toHaveProperty("chainStepCount");
	});
});
