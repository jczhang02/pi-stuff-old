import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillInjection, resolveSkills } from "../../../packages/pi-stuff/src/subagents/src/agents/skills.ts";

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

test("reads only selected Skill metadata, reuses it, and invalidates changed files", () => {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-stuff-skill-metadata-"));
	const selectedPath = join(directory, "selected.md");
	fs.writeFileSync(selectedPath, '---\r\ndescription: "A & B < C"\r\n---\r\nPrivate skill body.\r\n');
	fs.writeFileSync(join(directory, "unselected.md"), `---\ndescription: Unused\n---\n${"unused\n".repeat(20_000)}`);
	const readFileSync = spyOn(fs, "readFileSync");
	try {
		const first = resolveSkills(["selected"], directory, [directory]);
		expect(readFileSync).toHaveBeenCalledTimes(1);
		expect(readFileSync.mock.calls[0]?.[0]).toBe(selectedPath);
		expect(first).toEqual({
			resolved: [{ name: "selected", path: selectedPath, description: "A & B < C", source: "unknown" }],
			missing: [],
		});
		expect(buildSkillInjection(first.resolved)).toBe(
			[
				"The following configured skills are available to this subagent.",
				"Use the read tool to load a skill's file when the task matches its description.",
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
				"",
				"<available_skills>",
				"  <skill>",
				"    <name>selected</name>",
				"    <description>A &amp; B &lt; C</description>",
				`    <location>${selectedPath}</location>`,
				"  </skill>",
				"</available_skills>",
			].join("\n"),
		);
		readFileSync.mockClear();
		expect(resolveSkills(["selected"], directory, [directory])).toEqual(first);
		expect(readFileSync).not.toHaveBeenCalled();
		fs.writeFileSync(selectedPath, "---\ndescription: Updated\n---\nChanged body.\n");
		const changedAt = new Date(Date.now() + 1000);
		fs.utimesSync(selectedPath, changedAt, changedAt);
		expect(resolveSkills(["selected"], directory, [directory]).resolved[0]?.description).toBe("Updated");
		expect(readFileSync).toHaveBeenCalledTimes(1);
	} finally {
		readFileSync.mockRestore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
