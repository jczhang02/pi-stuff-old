import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SessionNamingController } from "../../../packages/pi-stuff/src/session-naming/controller.js";
import type { GeneratedSessionName } from "../../../packages/pi-stuff/src/session-naming/model.js";
import type { SessionNamingSettings } from "../../../packages/pi-stuff/src/session-naming/settings.js";
import {
	type RenameMarker,
	SESSION_NAMING_STATE_ENTRY_TYPE,
} from "../../../packages/pi-stuff/src/session-naming/state.js";

const SETTINGS: SessionNamingSettings = {
	schemaVersion: 1,
	enabled: true,
	cooldownMinutes: 10,
	respectManualName: false,
	fallbackModels: [],
};
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let entrySequence = 0;

function run<Value, ErrorType>(program: Effect.Effect<Value, ErrorType>): Promise<Value> {
	return Effect.runPromise(program);
}

function message(role: "assistant" | "user", content: string): SessionEntry {
	entrySequence += 1;
	const base = { id: `entry-${String(entrySequence)}`, parentId: null, timestamp: "2026-08-24T00:00:00.000Z" };
	if (role === "user") {
		return { ...base, type: "message", message: { role, content, timestamp: entrySequence } };
	}
	const assistant: AssistantMessage = {
		role,
		content: [{ type: "text", text: content }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: entrySequence,
	};
	return { ...base, type: "message", message: assistant };
}

function harness(overrides: Partial<SessionNamingSettings> = {}) {
	let now = 1_000;
	let name: string | undefined;
	const branch: SessionEntry[] = [message("user", "Implement automatic Session naming"), message("assistant", "Done")];
	const generated: (GeneratedSessionName | undefined)[] = [];
	const markers: RenameMarker[] = [];
	const requestedCurrentNames: (string | undefined)[] = [];
	const controller = new SessionNamingController(
		{ ...SETTINGS, ...overrides },
		{
			appendMarker(marker) {
				markers.push(marker);
				entrySequence += 1;
				branch.push({
					type: "custom",
					id: `entry-${String(entrySequence)}`,
					parentId: null,
					timestamp: "2026-08-24T00:00:00.000Z",
					customType: SESSION_NAMING_STATE_ENTRY_TYPE,
					data: marker,
				});
			},
			generate: (_messages, currentName) =>
				Effect.sync(() => {
					requestedCurrentNames.push(currentName);
					return generated.shift();
				}),
			getBranch: () => branch,
			getSessionName: () => name,
			now: () => now,
			setSessionName(next) {
				name = next;
			},
		},
	);
	return {
		branch,
		controller,
		generated,
		markers,
		requestedCurrentNames,
		name: () => name,
		setName: (next: string | undefined) => {
			name = next;
		},
		setNow: (next: number) => {
			now = next;
		},
	};
}

test("names the first settled direct-user exchange and persists branch state", async () => {
	const state = harness();
	state.generated.push({ name: "Automatic Session Naming", source: "ai" });
	state.controller.restore();

	expect(await run(state.controller.handleSettled())).toBe("Automatic Session Naming");
	expect(state.name()).toBe("Automatic Session Naming");
	expect(state.markers).toEqual([
		{ mode: "initial", source: "ai", timestamp: 1_000, name: "Automatic Session Naming" },
	]);
	expect(state.controller.getState()).toBe("named");
});

test("refreshes only after the cooldown", async () => {
	const state = harness();
	state.generated.push({ name: "Initial Name", source: "ai" }, { name: "Refreshed Name", source: "ai" });
	state.controller.restore();
	await run(state.controller.handleSettled());
	state.setNow(600_999);
	expect(await run(state.controller.handleSettled())).toBeUndefined();
	state.setNow(601_000);
	expect(await run(state.controller.handleSettled())).toBe("Refreshed Name");
	expect(state.requestedCurrentNames).toEqual([undefined, "Initial Name"]);
	expect(state.markers.at(-1)?.mode).toBe("periodic");
});

test("persists observed manual names and respects them after resume", async () => {
	const first = harness({ respectManualName: true });
	first.controller.restore();
	first.setName("Manual Session Name");
	first.controller.observeSessionNameChange("Manual Session Name");

	const second = harness({ respectManualName: true });
	second.branch.push(...first.branch.slice(2));
	second.setName("Manual Session Name");
	second.generated.push({ name: "Should Not Be Used", source: "ai" });
	second.controller.restore();

	expect(await run(second.controller.handleSettled())).toBeUndefined();
	expect(second.name()).toBe("Manual Session Name");
});

for (const respectManualName of [false, true]) {
	for (const markerKind of ["missing", "mismatched"] as const) {
		test(`treats an existing ${markerKind} name as manual ownership when respectManualName=${String(respectManualName)}`, async () => {
			const state = harness({ respectManualName });
			if (markerKind === "mismatched") {
				entrySequence += 1;
				state.branch.push({
					type: "custom",
					id: `entry-${String(entrySequence)}`,
					parentId: null,
					timestamp: "1970-01-01T00:00:00.500Z",
					customType: SESSION_NAMING_STATE_ENTRY_TYPE,
					data: { name: "Old generated name", source: "ai", timestamp: 500 },
				});
			}
			entrySequence += 1;
			state.branch.push({
				type: "session_info",
				id: `entry-${String(entrySequence)}`,
				parentId: null,
				timestamp: "1970-01-01T00:00:01.000Z",
				name: "Existing manual name",
			});
			state.setName("Existing manual name");
			state.generated.push({ name: "Periodic replacement", source: "ai" });

			state.controller.restore();
			expect(state.controller.getState()).toBe("named");
			state.setNow(601_000);

			if (respectManualName) {
				expect(await run(state.controller.handleSettled())).toBeUndefined();
				expect(state.name()).toBe("Existing manual name");
			} else {
				expect(await run(state.controller.handleSettled())).toBe("Periodic replacement");
				expect(state.markers.at(-1)?.mode).toBe("periodic");
			}
		});
	}
}

test("records a manual return to a previously generated name", async () => {
	const state = harness({ respectManualName: true });
	state.generated.push({ name: "Generated name", source: "ai" });
	state.controller.restore();
	await run(state.controller.handleSettled());

	state.setName("Different manual name");
	state.controller.observeSessionNameChange("Different manual name");
	state.setName("Generated name");
	state.controller.observeSessionNameChange("Generated name");

	expect(state.markers.map((marker) => marker.source)).toEqual(["ai", "user", "user"]);
	expect(state.markers.at(-1)?.name).toBe("Generated name");
	expect(await run(state.controller.handleSettled())).toBeUndefined();
});

test("returns to unnamed state when the native Session name is cleared", async () => {
	const state = harness();
	state.generated.push({ name: "Generated name", source: "ai" }, { name: "Replacement name", source: "ai" });
	state.controller.restore();
	await run(state.controller.handleSettled());

	state.setName(undefined);
	state.controller.observeSessionNameChange(undefined);

	expect(state.controller.getState()).toBe("unnamed");
	expect(await run(state.controller.handleSettled())).toBe("Replacement name");
});

test("marks /autoname as forced generation rather than an observed manual name", async () => {
	const state = harness({ respectManualName: true });
	state.generated.push({ name: "Forced Session Name", source: "ai" });
	state.controller.restore();

	expect(await run(state.controller.renameManually())).toBe("Forced Session Name");
	expect(state.markers.at(-1)?.mode).toBe("forced");
});

test("keeps explicit /autoname available when automatic naming is off", async () => {
	const state = harness({ enabled: false });
	state.generated.push({ name: "Explicit Session Name", source: "ai" });
	state.controller.restore();

	expect(await run(state.controller.handleSettled())).toBeUndefined();
	expect(await run(state.controller.renameManually())).toBe("Explicit Session Name");
	expect(state.name()).toBe("Explicit Session Name");
	expect(state.controller.getState()).toBe("disabled");
	expect(state.markers.at(-1)?.mode).toBe("forced");
});

test("retries a failed automatic name on the next settled user run", async () => {
	const state = harness();
	state.generated.push(undefined, { name: "Recovered Session Name", source: "ai" });
	state.controller.restore();

	expect(await run(state.controller.handleSettled())).toBeUndefined();
	expect(state.controller.getState()).toBe("failed");
	expect(await run(state.controller.handleSettled())).toBe("Recovered Session Name");
});

test("retries an automatic fallback on the next settled user run", async () => {
	const state = harness();
	state.generated.push({ name: "Local Fallback", source: "fallback" }, { name: "Semantic Name", source: "ai" });
	state.controller.restore();

	expect(await run(state.controller.handleSettled())).toBe("Local Fallback");
	expect(state.controller.getState()).toBe("fallback");
	expect(await run(state.controller.handleSettled())).toBe("Semantic Name");
	expect(state.controller.getState()).toBe("named");
});

test("ignores an automatic result superseded by /autoname", async () => {
	let name: string | undefined;
	const markers: RenameMarker[] = [];
	const pending = [
		Promise.withResolvers<GeneratedSessionName | undefined>(),
		Promise.withResolvers<GeneratedSessionName | undefined>(),
	];
	let requestIndex = 0;
	const controller = new SessionNamingController(SETTINGS, {
		appendMarker: (marker) => markers.push(marker),
		generate: () => Effect.promise(() => pending[requestIndex++]?.promise ?? Promise.resolve(undefined)),
		getBranch: () => [message("user", "Name this Session"), message("assistant", "Done")],
		getSessionName: () => name,
		now: () => 1_000,
		setSessionName: (next) => {
			name = next;
		},
	});
	controller.restore();

	const automatic = run(controller.handleSettled());
	await Promise.resolve();
	const forced = run(controller.renameManually());
	await Promise.resolve();
	pending[0]?.resolve({ name: "Stale Name", source: "ai" });
	pending[1]?.resolve({ name: "Current Name", source: "ai" });

	expect(await automatic).toBeUndefined();
	expect(await forced).toBe("Current Name");
	expect(name).toBe("Current Name");
	expect(markers).toHaveLength(1);
	expect(markers[0]?.mode).toBe("forced");
});

test("ignores an automatic result superseded by a native manual name", async () => {
	let name: string | undefined;
	const markers: RenameMarker[] = [];
	const pending = Promise.withResolvers<GeneratedSessionName | undefined>();
	const controller = new SessionNamingController(SETTINGS, {
		appendMarker: (marker) => markers.push(marker),
		generate: () => Effect.promise(() => pending.promise),
		getBranch: () => [message("user", "Name this Session"), message("assistant", "Done")],
		getSessionName: () => name,
		now: () => 1_000,
		setSessionName: (next) => {
			name = next;
		},
	});
	controller.restore();

	const automatic = run(controller.handleSettled());
	await Promise.resolve();
	name = "Manual release review";
	controller.observeSessionNameChange(name);
	pending.resolve({ name: "Stale automatic name", source: "ai" });

	expect(await automatic).toBeUndefined();
	expect(name).toBe("Manual release review");
	expect(markers).toEqual([{ name: "Manual release review", source: "user", timestamp: 1_000 }]);
});
