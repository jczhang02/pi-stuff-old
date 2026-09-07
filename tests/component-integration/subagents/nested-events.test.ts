import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { routeLiveNestedAgentControl } from "../../../packages/pi-stuff/src/subagents/src/extension/nested-control-router.js";
import { listAsyncRuns } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-status.js";
import {
	consumeSteerRequestsFromDir,
	steerRequestsDir,
	stopRequestsDir,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";
import {
	buildNestedRouteIndex,
	createNestedRoute,
	finalizeNestedRouteRoot,
	NESTED_EVENTS_DIR,
	nestedSummaryFromAsyncStatus,
	projectNestedEvents,
	projectNestedEventsAuthoritatively,
	readNestedRegistry,
	retireCompletedNestedRoute,
	retireUnusedNestedRoute,
	writeNestedEvent,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/nested-events.js";
import { tryAcquireDurableClaim } from "../../../packages/pi-stuff/src/subagents/src/shared/durable-claim.js";
import {
	type NestedRouteInfo,
	type SubagentState,
	TEMP_ROOT_DIR,
} from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";

const routeRoots: string[] = [];
const nestedRunRoots: string[] = [];

afterEach(() => {
	for (const routeRoot of routeRoots.splice(0)) fs.rmSync(routeRoot, { recursive: true, force: true });
	for (const runRoot of nestedRunRoots.splice(0)) fs.rmSync(runRoot, { recursive: true, force: true });
});

function route(prefix: string): NestedRouteInfo {
	const created = createNestedRoute(`${prefix}-${randomUUID()}`);
	routeRoots.push(path.dirname(created.eventSink));
	return created;
}

function runningChild(rootRunId: string, childId: string) {
	return {
		id: childId,
		parentRunId: rootRunId,
		parentStepIndex: 0,
		depth: 1,
		path: [{ runId: rootRunId, stepIndex: 0 }],
		state: "running" as const,
		agent: "reviewer",
		startedAt: Date.now(),
		lastUpdate: Date.now(),
	};
}

function writeRunningChild(routeInfo: NestedRouteInfo, childId: string): void {
	writeNestedEvent(routeInfo, {
		type: "subagent.nested.started",
		ts: Date.now(),
		parentRunId: routeInfo.rootRunId,
		parentStepIndex: 0,
		child: runningChild(routeInfo.rootRunId, childId),
	});
}

function terminalRootRuntime(routeInfo: NestedRouteInfo): string {
	const asyncDir = path.join(TEMP_ROOT_DIR, "foreground-runs", routeInfo.rootRunId);
	nestedRunRoots.push(asyncDir);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: routeInfo.rootRunId,
			mode: "single",
			state: "complete",
			startedAt: Date.now() - 10,
			endedAt: Date.now(),
			lastUpdate: Date.now(),
			steps: [{ agent: "root", status: "complete" }],
			nestedRoute: routeInfo,
		}),
		{ mode: 0o600 },
	);
	return asyncDir;
}

function stateWithRoute(routeInfo: NestedRouteInfo): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "nested-race-session",
		asyncJobs: new Map([
			[
				routeInfo.rootRunId,
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				{
					asyncId: routeInfo.rootRunId,
					sessionId: "nested-race-session",
					nestedRoute: routeInfo,
				} as never,
			],
		]),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		lastUiContext: null,
		completionSeen: new Map(),
	};
}

function storageSnapshot(root: string): string {
	const records: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const target = path.join(directory, entry.name);
			const relative = path.relative(root, target);
			if (entry.isDirectory()) {
				records.push(`d:${relative}`);
				visit(target);
			} else if (entry.isFile()) {
				records.push(`f:${relative}:${fs.readFileSync(target).toString("base64")}`);
			} else if (entry.isSymbolicLink()) {
				records.push(`l:${relative}:${fs.readlinkSync(target)}`);
			}
		}
	};
	visit(root);
	return records.join("\n");
}

test("keeps reconcile-false session restoration byte-for-byte observation-only", () => {
	const routeInfo = route("nested-startup-observation");
	writeRunningChild(routeInfo, "pending-child");
	const routeRoot = path.dirname(routeInfo.eventSink);
	const asyncRoot = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "async-startup-observation-"));
	nestedRunRoots.push(asyncRoot);
	const asyncDir = path.join(asyncRoot, routeInfo.rootRunId);
	fs.mkdirSync(asyncDir, { mode: 0o700 });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: routeInfo.rootRunId,
			sessionId: "startup-session",
			mode: "single",
			state: "running",
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "root", status: "running" }],
			nestedRoute: routeInfo,
		}),
		{ mode: 0o600 },
	);
	const before = storageSnapshot(routeRoot);

	const runs = listAsyncRuns(asyncRoot, { sessionId: "startup-session", reconcile: false });

	expect(runs).toHaveLength(1);
	expect(runs[0]?.nestedChildren).toBeUndefined();
	expect(storageSnapshot(routeRoot)).toBe(before);
	expect(projectNestedEvents(routeInfo).children.map((child) => child.id)).toEqual(["pending-child"]);
});

test("publishes routes atomically and retires the exact unused route", async () => {
	const routeInfo = route("nested-route-retirement");
	const routeRoot = path.dirname(routeInfo.eventSink);
	const parentEntries = fs.readdirSync(path.dirname(routeRoot));

	expect(
		parentEntries.some((entry) => entry.includes(routeInfo.capabilityToken) && entry.startsWith(".creating-")),
	).toBe(false);
	expect(await retireUnusedNestedRoute(routeInfo)).toBe(true);
	expect(fs.existsSync(routeRoot)).toBe(false);
});

test("never indexes crash-left creating or retired route directories as live authority", () => {
	const routeInfo = route("nested-route-staging");
	const routeRoot = path.dirname(routeInfo.eventSink);
	const routeName = path.basename(routeRoot);
	const creatingRoot = path.join(NESTED_EVENTS_DIR, `.creating-${routeName}`);
	const retiredRoot = path.join(NESTED_EVENTS_DIR, `.retired-${routeName}-${randomUUID()}`);
	fs.cpSync(routeRoot, creatingRoot, { recursive: true });
	fs.cpSync(routeRoot, retiredRoot, { recursive: true });
	routeRoots.push(creatingRoot, retiredRoot);
	fs.rmSync(routeRoot, { recursive: true });

	expect(buildNestedRouteIndex().has(routeInfo.rootRunId)).toBeFalse();
});

test("does not discard nested evidence through the unused-route cleanup path", async () => {
	const routeInfo = route("nested-route-evidence");
	const routeRoot = path.dirname(routeInfo.eventSink);
	const rootAsyncDir = terminalRootRuntime(routeInfo);
	writeRunningChild(routeInfo, "nested-route-evidence-child");

	expect(await retireUnusedNestedRoute(routeInfo)).toBe(false);
	expect(fs.existsSync(routeRoot)).toBe(true);
	expect(await finalizeNestedRouteRoot(routeInfo, rootAsyncDir)).toBe(false);
	expect(fs.existsSync(routeRoot)).toBe(true);
	writeNestedEvent(routeInfo, {
		type: "subagent.nested.completed",
		ts: Date.now() + 1,
		parentRunId: routeInfo.rootRunId,
		parentStepIndex: 0,
		child: {
			...runningChild(routeInfo.rootRunId, "nested-route-evidence-child"),
			parentRunOrigin: "user",
			state: "complete",
		},
	});
	expect(await retireCompletedNestedRoute(routeInfo)).toBe(true);
	expect(fs.existsSync(routeRoot)).toBe(false);
	expect(JSON.parse(fs.readFileSync(path.join(rootAsyncDir, "status.json"), "utf8"))).toMatchObject({
		parentRunOrigin: "user",
		steps: [
			{
				children: [{ id: "nested-route-evidence-child", parentRunOrigin: "user", state: "complete" }],
			},
		],
	});
});

test("authoritative projection waits for a competing projector instead of returning an empty snapshot", async () => {
	const routeInfo = route("nested-authoritative");
	const claim = tryAcquireDurableClaim(path.dirname(routeInfo.eventSink), "registry-project.lock");
	expect(claim).toBeDefined();
	writeRunningChild(routeInfo, "nested-child");

	expect(projectNestedEvents(routeInfo).children).toHaveLength(0);
	const projected = projectNestedEventsAuthoritatively(routeInfo, { timeoutMs: 1_000 });
	setTimeout(() => claim?.release(), 40);

	expect((await projected).children.map((child) => child.id)).toEqual(["nested-child"]);
});

test("authoritative projection drains more than one event batch before returning terminal state", async () => {
	const routeInfo = route("nested-drain");
	const childId = "nested-drain-child";
	const startedAt = Date.now();
	for (let index = 0; index < 2_001; index++) {
		const terminal = index === 2_000;
		writeNestedEvent(routeInfo, {
			type:
				index === 0
					? "subagent.nested.started"
					: terminal
						? "subagent.nested.completed"
						: "subagent.nested.updated",
			ts: startedAt + index,
			parentRunId: routeInfo.rootRunId,
			parentStepIndex: 0,
			child: Object.assign(
				{
					...runningChild(routeInfo.rootRunId, childId),
					state: terminal ? ("complete" as const) : ("running" as const),
					lastUpdate: startedAt + index,
				},
				terminal ? { endedAt: startedAt + index } : undefined,
			),
		});
	}

	const registry = await projectNestedEventsAuthoritatively(routeInfo, { timeoutMs: 5_000 });
	expect(registry.children).toHaveLength(1);
	expect(registry.children[0]?.state).toBe("complete");
});

test("keeps the full 200-child control forest within the durable registry bound", async () => {
	const routeInfo = route("nested-cardinality");
	const startedAt = Date.now();
	for (let index = 0; index < 200; index += 1) {
		const childId = `nested-cardinality-${String(index).padStart(3, "0")}`;
		writeNestedEvent(routeInfo, {
			type: "subagent.nested.started",
			ts: startedAt + index,
			parentRunId: routeInfo.rootRunId,
			parentStepIndex: index,
			child: {
				...runningChild(routeInfo.rootRunId, childId),
				parentStepIndex: index,
				lastUpdate: startedAt + index,
				asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", routeInfo.rootRunId, childId),
				steps: Array.from({ length: 18 }, (_, stepIndex) => ({
					agent: `worker-${stepIndex}`,
					status: "running" as const,
					task: "t".repeat(500),
					description: "d".repeat(500),
					error: "e".repeat(1_024),
					currentPath: `/${"p".repeat(700)}`,
					sessionFile: `/${"s".repeat(700)}`,
					transcriptPath: `/${"x".repeat(700)}`,
					transcriptError: "r".repeat(1_024),
				})),
			},
		});
	}

	const registry = await projectNestedEventsAuthoritatively(routeInfo, { timeoutMs: 5_000 });
	const registryPath = path.join(path.dirname(routeInfo.eventSink), "registry.json");

	expect(registry.children).toHaveLength(200);
	expect(new Set(registry.children.map((child) => child.id)).size).toBe(200);
	expect(registry.children.every((child) => child.controlInbox === routeInfo.controlInbox)).toBeTrue();
	expect(fs.statSync(registryPath).size).toBeLessThanOrEqual(8 * 1024 * 1024);
});

test("reuses an unchanged registry snapshot and invalidates it after atomic replacement", () => {
	const routeInfo = route("nested-registry-cache");
	writeRunningChild(routeInfo, "nested-registry-cache-child");
	projectNestedEvents(routeInfo);

	const first = readNestedRegistry(routeInfo);
	const unchanged = readNestedRegistry(routeInfo);
	expect(unchanged).toBe(first);

	const filePath = path.join(path.dirname(routeInfo.eventSink), "registry.json");
	const replacementPath = path.join(path.dirname(filePath), `.registry-${randomUUID()}.tmp`);
	const replacement = {
		...first,
		updatedAt: first.updatedAt + 1,
		processedEvents: [...first.processedEvents, "cache-refresh.json"],
	};
	fs.writeFileSync(replacementPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600, flag: "wx" });
	fs.renameSync(replacementPath, filePath);

	const refreshed = readNestedRegistry(routeInfo);
	expect(refreshed).not.toBe(first);
	expect(refreshed.updatedAt).toBe(replacement.updatedAt);
	expect(refreshed.processedEvents).toContain("cache-refresh.json");
	expect(readNestedRegistry(routeInfo)).toBe(refreshed);
});

test("evicts least-recently-used registries before the aggregate memory budget is exceeded", async () => {
	const routes = [route("nested-cache-budget-a"), route("nested-cache-budget-b"), route("nested-cache-budget-c")];
	const padding = "x".repeat(6 * 1024 * 1024);
	const firstSnapshots: ReturnType<typeof readNestedRegistry>[] = [];
	for (const routeInfo of routes) {
		const filePath = path.join(path.dirname(routeInfo.eventSink), "registry.json");
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({
				rootRunId: routeInfo.rootRunId,
				updatedAt: 1,
				children: [],
				pendingChildren: [],
				processedEvents: [],
				padding,
			})}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		firstSnapshots.push(readNestedRegistry(routeInfo));
	}

	const oldestRoute = routes[0];
	if (!oldestRoute) throw new Error("Expected a cache-budget route.");
	const oldestReloaded = readNestedRegistry(oldestRoute);
	expect(oldestReloaded).not.toBe(firstSnapshots[0]);
	expect(oldestReloaded.rootRunId).toBe(oldestRoute.rootRunId);

	for (const routeInfo of routes) {
		expect(await retireUnusedNestedRoute(routeInfo)).toBeTrue();
	}
});

test("nested stop waits through a projector race and reaches the exact child", async () => {
	const routeInfo = route("nested-control");
	const childId = "nested-control-child";
	const runRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", routeInfo.rootRunId);
	nestedRunRoots.push(runRoot);
	const asyncDir = path.join(runRoot, childId);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	writeRunningChild(routeInfo, childId);
	const claim = tryAcquireDurableClaim(path.dirname(routeInfo.eventSink), "registry-project.lock");
	expect(claim).toBeDefined();
	setTimeout(() => claim?.release(), 40);

	const result = await routeLiveNestedAgentControl(
		{ action: "stop", id: childId },
		stateWithRoute(routeInfo),
		new AbortController().signal,
		{ parentRunOrigin: "automatic", timeoutMs: 1_000 },
	);

	expect(result?.isError).not.toBe(true);
	expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Interrupt requested") });
	expect(fs.readdirSync(stopRequestsDir(asyncDir))).toHaveLength(1);
});

test("nested user steering remains user-attributed through completion and registry reload", async () => {
	const routeInfo = route("nested-user-steer");
	const childId = "nested-user-steer-child";
	const runRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", routeInfo.rootRunId);
	nestedRunRoots.push(runRoot);
	const asyncDir = path.join(runRoot, childId);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	writeRunningChild(routeInfo, childId);

	const result = await routeLiveNestedAgentControl(
		{ action: "steer", id: childId, message: "Apply the user's correction." },
		stateWithRoute(routeInfo),
		new AbortController().signal,
		{ parentRunOrigin: "user", timeoutMs: 0 },
	);

	expect(result?.isError).not.toBe(true);
	expect(consumeSteerRequestsFromDir(steerRequestsDir(asyncDir))).toEqual([
		expect.objectContaining({
			message: "Apply the user's correction.",
			parentRunOrigin: "user",
			type: "steer",
		}),
	]);

	const completed = nestedSummaryFromAsyncStatus(
		{
			runId: childId,
			parentRunOrigin: "user",
			mode: "single",
			state: "complete",
			startedAt: 1,
			endedAt: 2,
			lastUpdate: 2,
			steps: [{ agent: "reviewer", status: "complete" }],
		},
		asyncDir,
		{
			id: childId,
			parentRunId: routeInfo.rootRunId,
			parentStepIndex: 0,
			depth: 1,
			ts: 2,
		},
	);
	writeNestedEvent(routeInfo, {
		type: "subagent.nested.completed",
		ts: 2,
		parentRunId: routeInfo.rootRunId,
		parentStepIndex: 0,
		child: completed,
	});
	expect(projectNestedEvents(routeInfo).children[0]?.parentRunOrigin).toBe("user");

	// A later automatic projection must not downgrade a direct user takeover.
	writeNestedEvent(routeInfo, {
		type: "subagent.nested.completed",
		ts: 3,
		parentRunId: routeInfo.rootRunId,
		parentStepIndex: 0,
		child: { ...completed, parentRunOrigin: "automatic", lastUpdate: 3 },
	});
	projectNestedEvents(routeInfo);
	// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
	const persisted = JSON.parse(
		fs.readFileSync(path.join(path.dirname(routeInfo.eventSink), "registry.json"), "utf8"),
	) as { children: Array<{ parentRunOrigin?: string }> };
	expect(persisted.children[0]?.parentRunOrigin).toBe("user");
});

test("nested control reports a busy registry instead of falling through as not found", async () => {
	const routeInfo = route("nested-control-timeout");
	const childId = "nested-timeout-child";
	writeRunningChild(routeInfo, childId);
	const claim = tryAcquireDurableClaim(path.dirname(routeInfo.eventSink), "registry-project.lock");
	expect(claim).toBeDefined();
	try {
		const result = await routeLiveNestedAgentControl(
			{ action: "stop", id: childId },
			stateWithRoute(routeInfo),
			new AbortController().signal,
			{ parentRunOrigin: "automatic", timeoutMs: 30 },
		);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("remained busy"),
		});
	} finally {
		claim?.release();
	}
});

test("routes an exact top-level id without waiting for an unrelated busy nested registry", async () => {
	const routeInfo = route("nested-control-top-level");
	writeRunningChild(routeInfo, "unrelated-nested-child");
	const claim = tryAcquireDurableClaim(path.dirname(routeInfo.eventSink), "registry-project.lock");
	expect(claim).toBeDefined();
	try {
		const startedAt = Date.now();
		const result = await routeLiveNestedAgentControl(
			{ action: "stop", id: routeInfo.rootRunId },
			stateWithRoute(routeInfo),
			new AbortController().signal,
			{ parentRunOrigin: "automatic", timeoutMs: 500 },
		);

		expect(result).toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(100);
	} finally {
		claim?.release();
	}
});
