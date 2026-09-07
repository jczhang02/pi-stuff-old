import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ponytailRuntimeRegistry } from "../../../packages/pi-stuff/src/ponytail/state.js";
import { PONYTAIL_CHILD_MODE_ENV, type PonytailMode } from "../../../packages/pi-stuff/src/ponytail/types.js";
import {
	buildWriterProcessEnv,
	ponytailWriterEnvironmentOverrides,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.js";
import { ponytailLaunchSnapshot } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.js";

const owners: object[] = [];

afterEach(() => {
	for (const owner of owners.splice(0)) ponytailRuntimeRegistry().owners.delete(owner);
});

describe("Ponytail child launch snapshot", () => {
	test("captures the current parent mode at each launch including explicit off", () => {
		const owner = {};
		owners.push(owner);
		let mode: PonytailMode = "off";
		ponytailRuntimeRegistry().owners.set(owner, { currentMode: () => mode });
		// SAFETY: this fixture supplies the exact events identity consumed by the launch snapshot helper.
		const pi = { events: owner } as Pick<ExtensionAPI, "events">;
		expect(ponytailLaunchSnapshot(pi)).toEqual({ ponytailMode: "off" });
		mode = "ultra";
		expect(ponytailLaunchSnapshot(pi)).toEqual({ ponytailMode: "ultra" });
	});

	test("falls back to the inherited launch snapshot when no live runtime reader is available", () => {
		const previous = process.env[PONYTAIL_CHILD_MODE_ENV];
		process.env[PONYTAIL_CHILD_MODE_ENV] = "lite";
		try {
			// SAFETY: this fixture supplies the only events identity consumed by the snapshot helper.
			const pi = { events: {} } as Pick<ExtensionAPI, "events">;
			expect(ponytailLaunchSnapshot(pi)).toEqual({ ponytailMode: "lite" });
		} finally {
			if (previous === undefined) delete process.env[PONYTAIL_CHILD_MODE_ENV];
			else process.env[PONYTAIL_CHILD_MODE_ENV] = previous;
		}
	});

	test("writes the snapshot into the child environment and clears accidental inheritance", () => {
		const inherited = { [PONYTAIL_CHILD_MODE_ENV]: "full", KEEP: "yes" };
		const explicitOff = buildWriterProcessEnv(inherited, ponytailWriterEnvironmentOverrides("off"));
		expect(explicitOff[PONYTAIL_CHILD_MODE_ENV]).toBe("off");
		expect(explicitOff["KEEP"]).toBe("yes");
		const absent = buildWriterProcessEnv(inherited, ponytailWriterEnvironmentOverrides(undefined));
		expect(absent[PONYTAIL_CHILD_MODE_ENV]).toBeUndefined();
	});
});
