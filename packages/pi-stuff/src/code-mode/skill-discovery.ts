import { type ExtensionAPI, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { registerContextPromptContributor } from "../context-management/index.ts";
import { CODE_MODE_TOOL_NAME, type PiStuffCodeModeOptions } from "./controls.ts";

const READ_TOOL_NAME = "read";
const CODE_MODE_READ_BRIDGE =
	"After selecting a Skill, call codemode directly and use tools.read on that entry's exact <location>. " +
	"tools.read is already available for Skill reads; do not call tool_search or scan first.";

function catalog(skills: Skill[] | undefined): string | undefined {
	if (!skills) return undefined;
	const prompt = formatSkillsForPrompt(skills).trim();
	return prompt ? `${prompt}\n\n${CODE_MODE_READ_BRIDGE}` : undefined;
}

export function registerCodeModeSkillDiscovery(
	pi: Pick<ExtensionAPI, "events" | "on">,
	options: Pick<PiStuffCodeModeOptions, "registry" | "surface">,
): void {
	let hostSkills: Skill[] | undefined;
	const reset = (): void => {
		hostSkills = undefined;
	};
	const virtualReadIsActive = (): boolean =>
		options.surface.isEnvelopeEnabled(CODE_MODE_TOOL_NAME) && options.registry.isActive(READ_TOOL_NAME);

	registerContextPromptContributor(pi, {
		id: "code-mode-skill-discovery",
		order: 200,
		renderAgent(event) {
			hostSkills = undefined;
			const selectedTools = event.systemPromptOptions.selectedTools;
			if (
				!virtualReadIsActive() ||
				!selectedTools?.includes(CODE_MODE_TOOL_NAME) ||
				selectedTools.includes(READ_TOOL_NAME)
			)
				return undefined;
			hostSkills = [...(event.systemPromptOptions.skills ?? [])];
			return catalog(hostSkills);
		},
		renderProvider: () => (virtualReadIsActive() ? catalog(hostSkills) : undefined),
	});
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
}
