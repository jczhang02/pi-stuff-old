import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { BackgroundWorkEffectOwner } from "../../packages/pi-stuff/src/background-work/src/effect-owner.js";
import { startMonitor } from "../../packages/pi-stuff/src/background-work/src/monitor.js";
import {
	BoundedOutputFile,
	foregroundOutputSnapshot,
	tryReadBoundedTail,
} from "../../packages/pi-stuff/src/background-work/src/output.js";
import {
	captureProcessIdentity,
	captureProcessIdentityWithRetry,
	processExists,
	signalProcessGroup,
} from "../../packages/pi-stuff/src/background-work/src/process.js";
import {
	type BackgroundMonitorActivity,
	type BackgroundWorkOutcome,
	BackgroundWorkRuntime,
	projectNotificationBatch,
} from "../../packages/pi-stuff/src/background-work/src/runtime.js";
import {
	createAuthenticatedRuntimeRecord,
	reconcileStaleRuns,
	type StoredProcessTask,
	WorkRunStorage,
} from "../../packages/pi-stuff/src/background-work/src/storage.js";
import { isForegroundBashResult } from "../../packages/pi-stuff/src/background-work/src/tools.js";
import {
	listenForAgentWorkOriginQueries,
	readAgentWorkOrigin,
} from "../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";
import {
	activateDiagnosticChannel,
	DiagnosticChannel,
	resetDiagnosticProcessState,
} from "../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import type {
	SuiteAgentMessage,
	SuiteAgentMessageHost,
	SuiteAgentMessageOptions,
} from "../../packages/pi-stuff/src/conversation-ui/suite-agent-message.js";
import { EffectFoundation } from "../../packages/pi-stuff/src/shared/effect-foundation.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const escapedProcessGroups: number[] = [];
const TEST_WORK_AUTHORITY_KEY = Buffer.alloc(32, 0x5a);
const COMPLETION_DETAILS_SCHEMA = Type.Object(
	{
		outcomes: Type.Array(
			Type.Object(
				{
					parentRunOrigin: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("user")])),
					status: Type.Union([
						Type.Literal("completed"),
						Type.Literal("failed"),
						Type.Literal("stopped"),
						Type.Literal("timed_out"),
					]),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);
type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type ExtensionEventPayload = Parameters<ExtensionEventListener>[0];

interface DeliveredMessage {
	readonly message: SuiteAgentMessage;
	readonly options: SuiteAgentMessageOptions;
}

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-work-test-"));
	roots.push(root);
	return root;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for condition");
}

async function leaderGoneProcessGroup(
	root: string,
	label: string,
): Promise<{
	childPid: number;
	leaderIdentity: NonNullable<ReturnType<typeof captureProcessIdentity>>;
}> {
	const childPath = join(root, `${label}.child.pid`);
	const releasePath = join(root, `${label}.release`);
	const leader = spawn(
		"/bin/sh",
		[
			"-c",
			'trap \'\' HUP; sh -c \'trap "" TERM HUP INT; while :; do sleep 1; done\' & echo $! > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done',
			"fixture",
			childPath,
			releasePath,
		],
		{ detached: true, stdio: "ignore" },
	);
	children.push(leader);
	if (!leader.pid) throw new Error("leader-gone process fixture did not start");
	const leaderPid = leader.pid;
	escapedProcessGroups.push(leaderPid);
	await waitUntil(() => existsSync(childPath) && captureProcessIdentity(leaderPid) !== undefined);
	const leaderIdentity = captureProcessIdentity(leaderPid);
	if (!leaderIdentity) throw new Error("leader-gone process fixture has no leader identity");
	const childPid = Number(readFileSync(childPath, "utf-8").trim());
	writeFileSync(releasePath, "release\n");
	await waitUntil(() => !processExists(leaderIdentity.pid) && processExists(childPid));
	return { childPid, leaderIdentity };
}

function context(cwd: string): ExtensionContext {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	return {
		cwd,
		model: undefined,
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionId: () => "work-test-session",
		},
		thinkingLevel: "off",
	} as ExtensionContext;
}

type RuntimeOptions = ConstructorParameters<typeof BackgroundWorkRuntime>[0];

function createBackgroundWorkEffectOwner(): BackgroundWorkEffectOwner {
	const foundation = new EffectFoundation();
	void foundation.startSession();
	const session = foundation.currentSession();
	if (!session) throw new Error("Test Effect Session Scope was not initialized.");
	return new BackgroundWorkEffectOwner(foundation, session);
}

function configuredRuntime(cwd: string, overrides: Partial<RuntimeOptions> = {}): BackgroundWorkRuntime {
	return new BackgroundWorkRuntime({
		cwd,
		effects: createBackgroundWorkEffectOwner(),
		pi: { sendMessage: () => {} },
		sessionId: "work-test-session",
		storage: new WorkRunStorage(cwd, "work-test-session", { authorityKey: TEST_WORK_AUTHORITY_KEY }),
		...overrides,
	});
}

function runtime(cwd: string, messages: DeliveredMessage[] = [], backgroundAfterMs?: number): BackgroundWorkRuntime {
	const pi = {
		sendMessage: (message: SuiteAgentMessage, options?: SuiteAgentMessageOptions) => {
			messages.push({ message, options });
		},
	};
	return configuredRuntime(
		cwd,
		Object.assign({ pi }, backgroundAfterMs === undefined ? undefined : { backgroundAfterMs }),
	);
}

function attributedRuntime(
	cwd: string,
	readOrigin: () => "automatic" | "user",
	messages: DeliveredMessage[] = [],
	sendMessage: SuiteAgentMessageHost["sendMessage"] = (message, options) => {
		messages.push({ message, options });
	},
) {
	let refreshRequests = 0;
	const listeners = new Map<string, Set<ExtensionEventListener>>();
	const events = {
		emit(event: string, data: ExtensionEventPayload) {
			if (event.includes("statusline-git-refresh-after-user-work-request")) refreshRequests += 1;
			for (const listener of Array.from(listeners.get(event) ?? [])) listener(data);
		},
		on(event: string, listener: ExtensionEventListener) {
			let registered = listeners.get(event);
			if (!registered) {
				registered = new Set();
				listeners.set(event, registered);
			}
			registered.add(listener);
			return () => registered?.delete(listener);
		},
	};
	const pi = {
		events,
		sendMessage,
	};
	listenForAgentWorkOriginQueries(pi, readOrigin);
	return {
		active: new BackgroundWorkRuntime({
			cwd,
			effects: createBackgroundWorkEffectOwner(),
			pi,
			sessionId: "work-test-session",
			storage: new WorkRunStorage(cwd, "work-test-session", { authorityKey: TEST_WORK_AUTHORITY_KEY }),
		}),
		readRefreshRequests: () => refreshRequests,
	};
}

class SecondPersistFailsStorage extends WorkRunStorage {
	private calls = 0;

	override persist(tasks: readonly StoredProcessTask[]): void {
		this.calls += 1;
		if (this.calls === 2) {
			throw Object.assign(new Error("injected metadata failure"), { code: "EIO" });
		}
		super.persist(tasks);
	}
}

class RunningMetadataDegradesStorage extends WorkRunStorage {
	private calls = 0;

	override persist(tasks: readonly StoredProcessTask[]): void {
		this.calls += 1;
		if (this.calls >= 3) {
			throw Object.assign(new Error("injected running metadata failure"), { code: "EIO" });
		}
		super.persist(tasks);
	}

	override cleanup(): void {
		throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
	}
}

export type {
	BackgroundMonitorActivity,
	BackgroundWorkOutcome,
	DeliveredMessage,
	SuiteAgentMessage,
	SuiteAgentMessageOptions,
};
export {
	activateDiagnosticChannel,
	attributedRuntime,
	BackgroundWorkRuntime,
	BoundedOutputFile,
	Check,
	COMPLETION_DETAILS_SCHEMA,
	captureProcessIdentity,
	captureProcessIdentityWithRetry,
	children,
	closeSync,
	configuredRuntime,
	context,
	createAuthenticatedRuntimeRecord,
	createBackgroundWorkEffectOwner,
	DiagnosticChannel,
	escapedProcessGroups,
	existsSync,
	foregroundOutputSnapshot,
	isForegroundBashResult,
	join,
	leaderGoneProcessGroup,
	mkdirSync,
	processExists,
	projectNotificationBatch,
	Readable,
	RunningMetadataDegradesStorage,
	readAgentWorkOrigin,
	readdirSync,
	readFileSync,
	reconcileStaleRuns,
	renameSync,
	resolve,
	rmSync,
	runtime,
	SecondPersistFailsStorage,
	signalProcessGroup,
	spawn,
	startMonitor,
	statSync,
	TEST_WORK_AUTHORITY_KEY,
	temporaryRoot,
	tryReadBoundedTail,
	WorkRunStorage,
	waitUntil,
	writeFileSync,
};

export async function cleanupRuntimeFixtures(): Promise<void> {
	resetDiagnosticProcessState();
	for (const child of children.splice(0)) {
		if (child.pid && processExists(child.pid)) signalProcessGroup(child.pid, "SIGKILL");
	}
	for (const pid of escapedProcessGroups.splice(0)) {
		signalProcessGroup(pid, "SIGKILL");
	}
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
}
