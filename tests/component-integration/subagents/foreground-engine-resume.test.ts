import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	agent,
	cleanupForegroundEngineFixtures,
	context,
	createNestedRoute,
	type executeAsyncSingle,
	executor,
	fs,
	os,
	path,
	projectForegroundCompletion,
	replayForegroundRuns,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	setupForegroundEngineFixtures,
	state,
	temporaryDirectories,
} from "../../agents/foreground-engine-fixtures.js";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("resume labels the revived Agent from the follow-up while preserving the recovery task", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-resume-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const childSession = path.join(cwd, "child.jsonl");
	fs.writeFileSync(childSession, "");
	const runState = state();
	const sessionIdentity = path.join(cwd, "parent.jsonl");
	runState.currentSessionId = sessionIdentity;
	runState.foregroundRuns?.set("source-run", {
		children: [
			{
				agent: "general-purpose",
				index: 0,
				sessionFile: childSession,
				status: "completed",
				task: "Inspect every parser edge case in full detail",
			},
		],
		cwd,
		mode: "single",
		runId: "source-run",
		sessionId: sessionIdentity,
		updatedAt: 1_000,
	});
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	const result = await executor(
		cwd,
		runState,
		(launch) => {
			captured = launch;
		},
		{ codeModeEnabled: false },
	).execute(
		"resume-call",
		{ action: "resume", id: "source-run", message: "复核恢复结果 🧪" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	if (result.isError) {
		throw new Error(result.content.map((part) => ("text" in part ? part.text : "")).join("\n"));
	}
	expect(captured?.description).toBe("复核恢复结果 🧪");
	expect(captured?.codeModeEnabled).toBe(false);
	expect(captured?.task).toContain("复核恢复结果 🧪");
	expect(captured?.task).toContain("source-run");
	expect(captured?.nestedRoute?.rootRunId).toBe(result.details.asyncId);
	if (captured?.nestedRoute) temporaryDirectories.push(path.dirname(captured.nestedRoute.eventSink));
});

test("resolves a resumed Agent from the parent project while preserving its execution cwd", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-resume-parent-"));
	const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-resume-child-"));
	temporaryDirectories.push(parentCwd, childCwd);
	const parentSession = path.join(parentCwd, "parent.jsonl");
	const childSession = path.join(childCwd, "child.jsonl");
	fs.writeFileSync(parentSession, "");
	fs.writeFileSync(childSession, "");
	const runState = state();
	runState.currentSessionId = parentSession;
	runState.foregroundRuns?.set("resume-parent-roster", {
		children: [
			{
				agent: "general-purpose",
				cwd: childCwd,
				index: 0,
				sessionFile: childSession,
				status: "completed",
				task: "Inspect the child package",
			},
		],
		cwd: childCwd,
		mode: "single",
		runId: "resume-parent-roster",
		sessionId: parentSession,
		updatedAt: 1_000,
	});
	const discoveredFrom: string[] = [];
	let resumedFrom: string | undefined;
	const result = await executor(
		parentCwd,
		runState,
		(launch) => {
			resumedFrom = launch.cwd;
		},
		{
			discoverAgents: (cwd) => {
				discoveredFrom.push(cwd);
				return { agents: cwd === parentCwd ? [agent()] : [] };
			},
		},
	).execute(
		"resume-parent-roster-call",
		{ action: "resume", id: "resume-parent-roster", message: "Continue the child package review" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);

	expect(result.isError).not.toBeTrue();
	expect(discoveredFrom).toEqual([parentCwd]);
	expect(resumedFrom).toBe(childCwd);
});

test("keeps an inherited nested route when a child Agent is resumed and can fan out again", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-nested-resume-"));
	temporaryDirectories.push(cwd);
	const sessionIdentity = path.join(cwd, "parent.jsonl");
	const childSession = path.join(cwd, "child.jsonl");
	fs.writeFileSync(sessionIdentity, "");
	fs.writeFileSync(childSession, "");
	const route = createNestedRoute("nested-resume-root");
	temporaryDirectories.push(path.dirname(route.eventSink));
	const runState = state();
	runState.currentSessionId = sessionIdentity;
	runState.foregroundRuns?.set("nested-resume-source", {
		children: [
			{
				agent: "general-purpose",
				index: 0,
				sessionFile: childSession,
				status: "completed",
				task: "Continue nested work",
			},
		],
		cwd,
		mode: "single",
		runId: "nested-resume-source",
		sessionId: sessionIdentity,
		updatedAt: 1_000,
	});
	const environment = {
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
		[SUBAGENT_PARENT_RUN_ID_ENV]: "nested-owner",
		[SUBAGENT_PARENT_CHILD_INDEX_ENV]: "0",
		[SUBAGENT_PARENT_DEPTH_ENV]: "1",
	};
	const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]] as const));
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	try {
		Object.assign(process.env, environment);
		const result = await executor(cwd, runState, (launch) => {
			captured = launch;
		}).execute(
			"nested-resume-call",
			{ action: "resume", id: "nested-resume-source", message: "Continue and delegate" },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
		expect(result.isError).not.toBeTrue();
		expect(captured?.nestedRoute).toEqual(route);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("rejects user-stopped foreground resume before and after cold replay", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-stopped-resume-"));
	temporaryDirectories.push(cwd);
	const sessionIdentity = path.join(cwd, "parent.jsonl");
	const childSession = path.join(cwd, "child.jsonl");
	fs.writeFileSync(sessionIdentity, "");
	fs.writeFileSync(childSession, "");
	const stoppedChild = {
		agent: "general-purpose",
		exitCode: 143,
		index: 0,
		sessionFile: childSession,
		status: "stopped" as const,
		task: "Inspect every parser edge case",
	};
	const warmState = state();
	warmState.currentSessionId = sessionIdentity;
	warmState.foregroundRuns?.set("stopped-run", {
		children: [stoppedChild],
		cwd,
		mode: "single",
		runId: "stopped-run",
		sessionId: sessionIdentity,
		updatedAt: 1_000,
	});
	const coldState = state();
	coldState.currentSessionId = sessionIdentity;
	coldState.foregroundRuns = replayForegroundRuns(
		[
			{
				type: "message",
				timestamp: "2026-08-06T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: {
						cwd,
						mode: "single",
						results: [{ ...stoppedChild, stopped: true }],
						runId: "stopped-run",
					},
				},
			},
		],
		sessionIdentity,
	);

	let launches = 0;
	for (const runState of [warmState, coldState]) {
		const result = await executor(cwd, runState, () => {
			launches += 1;
		}).execute(
			"stopped-resume-call",
			{ action: "resume", id: "stopped-run", message: "Continue" },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
		expect(result.isError).toBeTrue();
		expect(result.content.map((part) => ("text" in part ? part.text : "")).join("\n")).toContain(
			"stopped by the user and cannot be resumed",
		);
	}
	expect(launches).toBe(0);
});

test("cold-replayed foreground resume preserves its exact non-default cwd", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-cold-resume-"));
	temporaryDirectories.push(parentCwd);
	const effectiveCwd = path.join(parentCwd, "packages", "target");
	fs.mkdirSync(effectiveCwd, { recursive: true });
	fs.writeFileSync(path.join(parentCwd, "parent.jsonl"), "");
	const childSession = path.join(effectiveCwd, "child.jsonl");
	fs.writeFileSync(childSession, "");
	const config = {
		version: 2 as const,
		id: "cold-source-run",
		cwd: effectiveCwd,
		asyncDir: path.join(parentCwd, "async"),
		resultPath: path.join(parentCwd, "result.json"),
		work: {
			mode: "single" as const,
			task: {
				agent: "general-purpose",
				task: "Inspect from the package directory",
				cwd: effectiveCwd,
				inheritProjectContext: true,
				inheritSkills: false,
			},
		},
	};
	const persisted = projectForegroundCompletion(config, {
		id: config.id,
		runId: config.id,
		mode: "single",
		state: "complete",
		success: true,
		results: [
			{
				agent: "general-purpose",
				output: "done",
				success: true,
				exitCode: 0,
				sessionFile: childSession,
			},
		],
	});
	expect(persisted.details.cwd).toBe(effectiveCwd);
	const sessionIdentity = path.join(parentCwd, "parent.jsonl");
	const runState = state();
	runState.currentSessionId = sessionIdentity;
	runState.foregroundRuns = replayForegroundRuns(
		[
			{
				type: "message",
				timestamp: "2026-08-06T10:00:00.000Z",
				message: { role: "toolResult", toolName: "subagent", details: persisted.details },
			},
		],
		sessionIdentity,
	);
	let resumedCwd: string | undefined;
	const result = await executor(parentCwd, runState, (launch) => {
		resumedCwd = launch.cwd;
	}).execute(
		"cold-resume-call",
		{ action: "resume", id: config.id, message: "Continue from the persisted package state" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);

	if (result.isError) {
		throw new Error(result.content.map((part) => ("text" in part ? part.text : "")).join("\n"));
	}
	expect(resumedCwd).toBe(effectiveCwd);
});

test("live and cold parallel child resume both preserve the selected child's exact cwd", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-parallel-cwd-"));
	temporaryDirectories.push(parentCwd);
	const firstCwd = path.join(parentCwd, "packages", "first");
	const secondCwd = path.join(parentCwd, "packages", "second");
	fs.mkdirSync(firstCwd, { recursive: true });
	fs.mkdirSync(secondCwd, { recursive: true });
	fs.writeFileSync(path.join(parentCwd, "parent.jsonl"), "");
	const liveState = state();
	const completion = await executor(parentCwd, liveState).execute(
		"parallel-cwd-source",
		{
			async: false,
			tasks: [
				{ agent: "general-purpose", task: "Inspect first", cwd: firstCwd },
				{ agent: "general-purpose", task: "Inspect second", cwd: secondCwd },
			],
		},
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);
	const sourceRunId = completion.details.runId;
	if (!sourceRunId) throw new Error("Expected foreground run id");
	for (const child of completion.details.results) {
		if (child.sessionFile) fs.writeFileSync(child.sessionFile, "");
	}
	expect(completion.details.results.map((child) => child.cwd)).toEqual([firstCwd, secondCwd]);

	let liveResumeCwd: string | undefined;
	await executor(parentCwd, liveState, (launch) => {
		liveResumeCwd = launch.cwd;
	}).execute(
		"parallel-live-resume",
		{ action: "resume", id: sourceRunId, index: 1, message: "Continue second" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);
	expect(liveResumeCwd).toBe(secondCwd);

	const sessionIdentity = path.join(parentCwd, "parent.jsonl");
	const coldState = state();
	coldState.currentSessionId = sessionIdentity;
	coldState.foregroundRuns = replayForegroundRuns(
		[
			{
				type: "message",
				timestamp: "2026-08-06T10:00:00.000Z",
				message: { role: "toolResult", toolName: "subagent", details: completion.details },
			},
		],
		sessionIdentity,
	);
	let coldResumeCwd: string | undefined;
	await executor(parentCwd, coldState, (launch) => {
		coldResumeCwd = launch.cwd;
	}).execute(
		"parallel-cold-resume",
		{ action: "resume", id: `${sourceRunId}:1`, message: "Continue second after reload" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);
	expect(coldResumeCwd).toBe(secondCwd);
});
