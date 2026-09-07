import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_AGENT_WORK_COST_POLICY,
	SessionAgentGovernor,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function governor(label: string): Promise<{ rootDir: string; governor: SessionAgentGovernor }> {
	const root = await mkdtemp(join(tmpdir(), `pi-stuff-work-usage-${label}-`));
	roots.push(root);
	const rootDir = join(root, "state");
	return {
		rootDir,
		governor: new SessionAgentGovernor({ rootDir, sessionId: `session-${label}`, pid: 4_001 }),
	};
}

async function spawn(governor: SessionAgentGovernor, logicalAgentId: string): Promise<void> {
	const result = await governor.acquireSpawn({ logicalAgentId, pid: 5_001 });
	if (!result.ok) throw new Error(result.error.message);
	await governor.release(result.lease);
}

test("durably aggregates attempts and resumes without merging unrelated work units", async () => {
	const created = await governor("durable");
	await spawn(created.governor, "review-a");
	await spawn(created.governor, "review-b");
	await spawn(created.governor, "review-c");

	await created.governor.recordWorkAttempt({
		logicalAgentId: "review-a",
		turns: 4,
		toolCalls: 7,
		inputTokens: 300_000,
		outputTokens: 20_000,
		reportedCostUsd: 1.25,
	});
	await created.governor.recordWorkAttempt({
		logicalAgentId: "review-a",
		turns: 3,
		toolCalls: 5,
		inputTokens: 200_000,
		outputTokens: 10_000,
	});
	const resumed = await created.governor.acquireResume({ logicalAgentId: "review-a", pid: 5_002 });
	if (!resumed.ok) throw new Error(resumed.error.message);
	await created.governor.release(resumed.lease);

	const reloaded = new SessionAgentGovernor({
		rootDir: created.rootDir,
		sessionId: "session-durable",
		pid: 4_002,
	});
	expect((await reloaded.workUnit("review-a")).usage).toEqual({
		turns: 7,
		toolCalls: 12,
		inputTokens: 500_000,
		outputTokens: 30_000,
		reportedCostUsd: 1.25,
		modelAttempts: 2,
		resumes: 1,
	});
	expect((await reloaded.workUnit("review-b")).usage).toEqual({
		turns: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		modelAttempts: 0,
		resumes: 0,
	});
	await reloaded.recordWorkAttempt({
		logicalAgentId: "review-c",
		turns: 1,
		toolCalls: 2,
		inputTokens: 10,
		outputTokens: 3,
	});
	await reloaded.recordWorkAttempt({
		logicalAgentId: "review-c",
		turns: 2,
		toolCalls: 1,
		inputTokens: 20,
		outputTokens: 4,
		reportedCostUsd: 0.5,
	});
	expect((await reloaded.workUnit("review-c")).usage).toEqual({
		turns: 3,
		toolCalls: 3,
		inputTokens: 30,
		outputTokens: 7,
		reportedCostUsd: 0.5,
		modelAttempts: 2,
		resumes: 0,
	});
});

test("blocks only later automatic expansion at the frozen token and reported-cost thresholds", async () => {
	const created = await governor("boundaries");
	await spawn(created.governor, "tokens-below");
	await spawn(created.governor, "tokens-at");
	await spawn(created.governor, "tokens-above");
	await spawn(created.governor, "cost-below");
	await spawn(created.governor, "cost-at");
	await spawn(created.governor, "cost-above");

	await created.governor.recordWorkAttempt({
		logicalAgentId: "tokens-below",
		turns: 1,
		toolCalls: 1,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit - 2,
		outputTokens: 1,
	});
	expect(await created.governor.authorizeWorkExpansion("tokens-below")).toMatchObject({ allowed: true });

	await created.governor.recordWorkAttempt({
		logicalAgentId: "tokens-at",
		turns: 1,
		toolCalls: 1,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit,
		outputTokens: 0,
	});
	expect(await created.governor.authorizeWorkExpansion("tokens-at")).toMatchObject({
		allowed: false,
		reason: "reported_tokens",
	});
	await created.governor.recordWorkAttempt({
		logicalAgentId: "tokens-above",
		turns: 1,
		toolCalls: 1,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit,
		outputTokens: 1,
	});
	expect(await created.governor.authorizeWorkExpansion("tokens-above")).toMatchObject({
		allowed: false,
		reason: "reported_tokens",
	});

	await created.governor.recordWorkAttempt({
		logicalAgentId: "cost-below",
		turns: 1,
		toolCalls: 1,
		inputTokens: 1,
		outputTokens: 0,
		reportedCostUsd: DEFAULT_AGENT_WORK_COST_POLICY.reportedCostUsdLimit - 0.01,
	});
	expect(await created.governor.authorizeWorkExpansion("cost-below")).toMatchObject({ allowed: true });

	await created.governor.recordWorkAttempt({
		logicalAgentId: "cost-at",
		turns: 1,
		toolCalls: 1,
		inputTokens: 1,
		outputTokens: 0,
		reportedCostUsd: DEFAULT_AGENT_WORK_COST_POLICY.reportedCostUsdLimit,
	});
	expect(await created.governor.authorizeWorkExpansion("cost-at")).toMatchObject({
		allowed: false,
		reason: "reported_cost_usd",
	});
	await created.governor.recordWorkAttempt({
		logicalAgentId: "cost-above",
		turns: 1,
		toolCalls: 1,
		inputTokens: 1,
		outputTokens: 0,
		reportedCostUsd: DEFAULT_AGENT_WORK_COST_POLICY.reportedCostUsdLimit + 0.01,
	});
	expect(await created.governor.authorizeWorkExpansion("cost-above")).toMatchObject({
		allowed: false,
		reason: "reported_cost_usd",
	});
});

test("requires acknowledgement for a cost-limited resume and never resets prior totals", async () => {
	const created = await governor("acknowledge");
	await spawn(created.governor, "retained-review");
	await created.governor.recordWorkAttempt({
		logicalAgentId: "retained-review",
		turns: 66,
		toolCalls: 94,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit + 1,
		outputTokens: 12_180,
		reportedCostUsd: DEFAULT_AGENT_WORK_COST_POLICY.reportedCostUsdLimit + 0.01,
	});

	expect(await created.governor.acquireResume({ logicalAgentId: "retained-review", pid: 5_003 })).toMatchObject({
		ok: false,
		error: { kind: "cost_guard", code: "reported_tokens" },
	});
	const acknowledged = await created.governor.acquireResume({
		logicalAgentId: "retained-review",
		pid: 5_004,
		acknowledgeCost: true,
	});
	if (!acknowledged.ok) throw new Error(acknowledged.error.message);
	expect(acknowledged.snapshot.agents[0]?.workUsage).toMatchObject({
		turns: 66,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit + 1,
		resumes: 1,
	});
});

test("blocks a later nested launch without terminating its in-flight owner", async () => {
	const created = await governor("nested-launch");
	const parent = await created.governor.acquireSpawn({ logicalAgentId: "parent", pid: 5_010 });
	if (!parent.ok) throw new Error(parent.error.message);
	await created.governor.recordWorkAttempt({
		logicalAgentId: "parent",
		turns: 70,
		toolCalls: 140,
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit,
		outputTokens: 0,
	});

	const nested = new SessionAgentGovernor({
		rootDir: created.rootDir,
		sessionId: "session-nested-launch",
		ownerAgentPath: ["parent"],
		pid: 4_002,
	});
	expect(await nested.acquireSpawn({ logicalAgentId: "blocked-child", pid: 5_011 })).toMatchObject({
		ok: false,
		error: { kind: "cost_guard", code: "reported_tokens", logicalAgentId: "parent" },
		snapshot: { running: 1, total: 1 },
	});
	expect((await created.governor.snapshot()).leases).toHaveLength(1);
});
