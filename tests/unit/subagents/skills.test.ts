import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { resolveSkills } from "../../../packages/pi-stuff/src/subagents/src/agents/skills.ts";

test("skips local skill paths when no resolvable skill was requested", () => {
	const statSync = spyOn(fs, "statSync");
	try {
		expect(resolveSkills(["", " pi-subagents "], process.cwd(), ["unused-skills"])).toEqual({
			resolved: [],
			missing: ["pi-subagents"],
		});
		expect(statSync).not.toHaveBeenCalled();
	} finally {
		statSync.mockRestore();
	}
});
