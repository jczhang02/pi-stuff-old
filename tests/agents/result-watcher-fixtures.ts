import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { CompletionNotification } from "../../packages/pi-stuff/src/subagents/src/runs/background/notify.js";
import {
	createResultWatcher,
	type ResultWatcherState,
} from "../../packages/pi-stuff/src/subagents/src/runs/background/result-watcher.js";
import { reconcileAsyncRun } from "../../packages/pi-stuff/src/subagents/src/runs/background/stale-run-reconciler.js";
import { readBoundedOwnedFileSnapshot } from "../../packages/pi-stuff/src/subagents/src/shared/private-directory.js";
import {
	type IntercomEventBus,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { createTestAgentEffectOwner } from "./agent-effect-owner-fixture.js";

const temporaryDirectories: string[] = [];
const INTERCOM_PAYLOAD_SCHEMA = Type.Object(
	{
		requestId: Type.Optional(Type.String()),
		runId: Type.String(),
		to: Type.String(),
	},
	{ additionalProperties: true },
);
const LEGACY_COMPLETION_SCHEMA = Type.Object(
	{
		results: Type.Array(
			Type.Object(
				{
					sessionFile: Type.Optional(Type.String()),
					transcriptPath: Type.Optional(Type.String()),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);
const COMPLETION_EVENT_SCHEMA = Type.Object(
	{
		parentRunOrigin: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("user")])),
	},
	{ additionalProperties: true },
);
type IntercomPayload = Parameters<Parameters<IntercomEventBus["on"]>[1]>[0];
type IntercomListener = Parameters<IntercomEventBus["on"]>[1];
type ReceivedIntercomPayload = Static<typeof INTERCOM_PAYLOAD_SCHEMA>;
type RecordingResultWatcherOptions = Omit<
	NonNullable<Parameters<typeof createResultWatcher>[4]>,
	"effects" | "notifier"
> & {
	readonly effects?: NonNullable<Parameters<typeof createResultWatcher>[4]>["effects"];
	readonly events?: IntercomEventBus;
	readonly sessionId?: string;
};

const INERT_INTERCOM_BUS: IntercomEventBus = { emit: () => {}, on: () => () => {} };

function createIntercomBus(deliveries: boolean[]) {
	const handlers = new Map<string, Set<IntercomListener>>();
	const received: ReceivedIntercomPayload[] = [];
	const bus: IntercomEventBus = {
		on(channel, handler) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
		emit(channel, data) {
			if (channel === SUBAGENT_RESULT_INTERCOM_EVENT && Check(INTERCOM_PAYLOAD_SCHEMA, data)) {
				received.push(data);
				const delivered = deliveries.shift() ?? false;
				for (const handler of handlers.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) {
					handler({ requestId: data.requestId, delivered });
				}
			}
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
	return { bus, received };
}

function writeTargetedResult(resultsDir: string, id: string): string {
	const resultPath = path.join(resultsDir, `${id}.json`);
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id,
			runId: id,
			sessionId: "root-session",
			intercomTarget: "parent-agent",
			success: true,
			state: "complete",
			summary: "cold completion",
			results: [{ agent: "worker", output: "done", success: true }],
		}),
	);
	return resultPath;
}

export function createResultWatcherState(currentSessionId = "root-session"): ResultWatcherState {
	return {
		completionSeen: new Map(),
		currentSessionId,
	};
}

export function createRecordingResultWatcher(resultsDir: string, options: RecordingResultWatcherOptions = {}) {
	const { effects = createTestAgentEffectOwner(), events = INERT_INTERCOM_BUS, sessionId, ...deps } = options;
	const delivered: CompletionNotification[] = [];
	const state = createResultWatcherState(sessionId);
	const watcher = createResultWatcher({ events }, state, resultsDir, 60_000, {
		...deps,
		effects,
		notifier: {
			deliver: async (notification) => {
				delivered.push(notification);
				return true;
			},
		},
	});
	return { delivered, state, watcher };
}

export async function waitForResultWatcher(
	predicate: () => boolean,
	attempts = 100,
	delayMilliseconds = 10,
): Promise<void> {
	for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) await Bun.sleep(delayMilliseconds);
}

export type { CompletionNotification, IntercomPayload, ResultWatcherState };
export {
	Check,
	COMPLETION_EVENT_SCHEMA,
	createIntercomBus,
	createResultWatcher,
	fs,
	LEGACY_COMPLETION_SCHEMA,
	os,
	path,
	readBoundedOwnedFileSnapshot,
	reconcileAsyncRun,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	temporaryDirectories,
	writeTargetedResult,
};

export function cleanupResultWatcherFixtures(): void {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
}
