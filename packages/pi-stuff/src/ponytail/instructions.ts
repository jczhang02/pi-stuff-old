import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { readTextFileEffect } from "../shared/settings-io/index.ts";
import { normalizePonytailMode, PONYTAIL_DEFAULT_MODE, type PonytailMode } from "./types.ts";

const SKILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills", "ponytail", "SKILL.md");
let canonicalSkill: string | undefined;

const SHARED_DISCIPLINE = [
	"Stay active for every response. Understand the task and affected flow before choosing the smallest solution.",
	"Before editing, inspect the owning implementation and callers; fix a shared root cause once instead of patching symptoms.",
	"Use the first adequate rung: skip speculative work, reuse existing code, prefer stdlib/native features, then installed dependencies, then the minimum new code.",
	"Do not add unrequested abstractions, dependencies, boilerplate, scaffolding, files, or flexibility for later. Prefer deletion and boring direct code.",
	"Never simplify away explicit requirements, trust-boundary validation, data-loss prevention, security, accessibility, or necessary hardware calibration.",
	"A branch, loop, parser, money/security path, or other non-trivial logic leaves the smallest runnable check. Trivial one-liners need none unless asked.",
	"Mark a deliberate simplification with a real known ceiling as a ponytail: comment naming the ceiling and upgrade trigger.",
	"Code first. Unless the user asks for explanation, finish in at most three short lines: what was skipped and when to add it.",
] as const;

const MODE_DISCIPLINE = {
	lite: "Build the explicit request, then name a materially lazier alternative in one line and let the user choose.",
	full: "Enforce the ladder. Use the shortest correct diff and explanation; implement only current evidence and requirements.",
	ultra: "Be a YAGNI extremist: deletion before addition, challenge speculative parts, and ship the smallest correct implementation while still honoring explicit requirements.",
} as const satisfies Record<Exclude<PonytailMode, "off">, string>;

export function filterPonytailSkillBodyForMode(body: string, mode: PonytailMode): string {
	const effectiveMode = normalizePonytailMode(mode) ?? PONYTAIL_DEFAULT_MODE;
	const withoutFrontmatter = String(body || "").replace(/^---[\s\S]*?---\s*/u, "");
	return withoutFrontmatter
		.split(/\r?\n/u)
		.filter((line) => {
			const tableLabel = /^\|\s*\*\*(.+?)\*\*\s*\|/u.exec(line);
			if (tableLabel?.[1]) {
				const labelMode = normalizePonytailMode(tableLabel[1].trim());
				if (labelMode && labelMode !== "off") return labelMode === effectiveMode;
			}
			const exampleLabel = /^-\s*([^:]+):\s*"/u.exec(line);
			if (exampleLabel?.[1]) {
				const labelMode = normalizePonytailMode(exampleLabel[1].trim());
				if (labelMode && labelMode !== "off") return labelMode === effectiveMode;
			}
			return true;
		})
		.join("\n");
}

/** Load the reviewed upstream Skill once so missing Package resources still fail during initialization. */
export function preparePonytailInstructions(): Effect.Effect<string, Error> {
	if (canonicalSkill !== undefined) return Effect.succeed(canonicalSkill);
	return Effect.map(readTextFileEffect(SKILL_PATH), (skill) => {
		canonicalSkill = skill;
		return skill;
	});
}

/** Project the compact standing policy; the complete upstream rules remain available through /skill:ponytail. */
export function getPonytailInstructions(mode: PonytailMode): string | undefined {
	if (mode === "off") return undefined;
	return [`PONYTAIL MODE ACTIVE — level: ${mode}`, ...SHARED_DISCIPLINE, MODE_DISCIPLINE[mode]].join("\n");
}

export function clearPonytailInstructionCacheForTest(): void {
	canonicalSkill = undefined;
}
