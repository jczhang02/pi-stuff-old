import { type BeforeAgentStartEvent, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { getPonytailInstructions } from "./instructions.ts";
import type { PonytailMode } from "./types.ts";

export const PONYTAIL_SKILL_NAMES = [
	"ponytail",
	"ponytail-review",
	"ponytail-audit",
	"ponytail-gain",
	"ponytail-debt",
	"ponytail-help",
] as const;

const PONYTAIL_SKILL_NAME_SET = new Set<string>(PONYTAIL_SKILL_NAMES);
const PONYTAIL_CATALOG_MARKER = "<name>ponytail</name>";
const ACTIVE_SKILL_DESCRIPTIONS = {
	ponytail: "Load the complete Ponytail coding-discipline rules when the active compact policy needs detail.",
	"ponytail-review": "Review changed code only for unnecessary complexity and what to delete or simplify.",
	"ponytail-audit": "Audit the repository for over-engineering, bloat, and stdlib or native replacements.",
	"ponytail-gain": "Show Ponytail's published benchmark impact scoreboard.",
	"ponytail-debt": "Collect ponytail: shortcut comments into a read-only debt ledger.",
	"ponytail-help": "Show the Ponytail modes, Skills, and command reference.",
} as const satisfies Record<(typeof PONYTAIL_SKILL_NAMES)[number], string>;

function modelVisibleSkill(skill: Skill): Skill {
	// SAFETY: callers pass only Skills whose names were checked against PONYTAIL_SKILL_NAME_SET.
	const name = skill.name as (typeof PONYTAIL_SKILL_NAMES)[number];
	return {
		...skill,
		description: ACTIVE_SKILL_DESCRIPTIONS[name],
		disableModelInvocation: false,
	};
}

export class PonytailPromptRenderer {
	private visibleSkills: Skill[] = [];

	renderAgent(event: BeforeAgentStartEvent, mode: PonytailMode): string | undefined {
		this.visibleSkills = (event.systemPromptOptions.skills ?? []).filter((skill) =>
			PONYTAIL_SKILL_NAME_SET.has(skill.name),
		);
		return this.render(mode, event.systemPrompt);
	}

	renderProvider(mode: PonytailMode): string | undefined {
		return this.render(mode, "");
	}

	private render(mode: PonytailMode, currentSystemPrompt: string): string | undefined {
		if (mode === "off") return undefined;
		const catalog =
			this.visibleSkills.length > 0 && !currentSystemPrompt.includes(PONYTAIL_CATALOG_MARKER)
				? formatSkillsForPrompt(this.visibleSkills.map(modelVisibleSkill))
				: undefined;
		const instructions = getPonytailInstructions(mode);
		const parts = [catalog, instructions].filter((part): part is string => Boolean(part?.trim()));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}
}
