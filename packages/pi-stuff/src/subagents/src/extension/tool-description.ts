export interface AgentToolRosterEntry {
	readonly description: string;
	readonly name: string;
	readonly tools?: readonly string[];
}

function oneLine(value: string): string {
	return value.replaceAll(/\s+/gu, " ").trim();
}

function formatAgentRoster(entries: readonly AgentToolRosterEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	return [
		"Available Agents:",
		...entries.map((entry) => {
			const tools = entry.tools === undefined ? "all inherited tools" : entry.tools.join(", ") || "none";
			return `- ${entry.name} — ${oneLine(entry.description)} (tools: ${tools})`;
		}),
	].join("\n");
}

export function buildSubagentToolDescription(roster: readonly AgentToolRosterEntry[] = []): string {
	return [
		"Delegate one or several concrete tasks to isolated current-session Agents.",
		'Choose exactly one shape per call: single uses agent + task; grouped parallel uses tasks; control uses action="status", "steer", "stop", or "resume".',
		"For control, id identifies an Agent Target; agent selects an Agent definition only for launch, and taskId is never valid here.",
		"Do not combine single, parallel, or control fields.",
		"Pi may also issue several independent single calls in one assistant response; those foreground calls run concurrently under the same session limits.",
		"A short 3–5 word description improves the UI; put the complete execution instruction in task.",
		"Pi Stuff does not provide built-in Agent definitions; select an available Package, user, or project Agent.",
		"Omit timeoutMs and toolBudget for ordinary tasks; set them only when the task explicitly needs a tighter bound.",
		"Do not invent or pass a background field. Omit foreground for the default background launch; set foreground=true only when the findings must inform the current answer.",
		"Background results return automatically for integration into the original task; a handoff update does not finish pending delegated work. Foreground returns only direct-child summaries; inspect full and nested transcripts through /agents.",
		formatAgentRoster(roster),
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}

export function buildFanoutChildSubagentToolDescription(): string {
	return [
		"Delegate one or several concrete tasks to isolated nested Agents.",
		"Choose exactly one launch shape per call: single uses agent + task; grouped parallel uses tasks.",
		"Do not combine single and parallel fields.",
		"Several independent single calls in one assistant response run concurrently under the same session limits.",
		"A short 3–5 word description improves the UI; put the complete execution instruction in task.",
		"Pi Stuff does not provide built-in Agent definitions; select an available Package, user, or project Agent.",
		"Omit timeoutMs and toolBudget for ordinary tasks; set them only when the task explicitly needs a tighter bound.",
		"Nested launches are always owner-blocking and collected before this Agent can finish; detached background launch is unavailable here.",
		"Results contain direct-child summaries; inspect full and nested transcripts through /agents.",
	].join(" ");
}
