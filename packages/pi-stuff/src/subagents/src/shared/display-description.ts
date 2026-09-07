import { boundTerminalLine } from "../../../tool-display/index.ts";

const MAX_DISPLAY_DESCRIPTION_WIDTH = 60;
const MAX_DISPLAY_SOURCE_WIDTH = 4_096;
const QUOTED_PATH_TOKEN = /(["'`])(?:file:\/{2,}|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^"'`<>|]+\1/giu;
const FILE_URL_TOKEN = /\bfile:\/{2,}[^\s"'`<>|]+(?:[ \t]+[^\s"'`<>|/\\]+[/\\][^\s"'`<>|]+)*/giu;
const PATH_TOKEN =
	/(?<![\p{L}\p{N}_/\\.-])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|]+(?:[ \t]+[^\s"'`<>|/\\]+[/\\][^\s"'`<>|]+)*/gu;

function basename(token: string): string {
	const normalized = token.replaceAll("\\", "/").replace(/[.。]+$/u, "");
	return normalized.split("/").filter(Boolean).at(-1) ?? token;
}

export function compactAbsolutePaths(value: string): string {
	return value
		.replace(QUOTED_PATH_TOKEN, (token) => `${token[0]}${basename(token.slice(1, -1))}${token.at(-1)}`)
		.replace(FILE_URL_TOKEN, basename)
		.replace(PATH_TOKEN, basename);
}

/** Strip terminal controls and collapse one bounded display line. */
export function boundedTerminalLine(value: string | null | undefined): string {
	return boundTerminalLine(value, MAX_DISPLAY_SOURCE_WIDTH);
}

/** Match only exact task text or the deterministic wrappers emitted by Agent runtimes. */
export function isTaskOnlyAgentText(value: string | null | undefined, task: string | null | undefined): boolean {
	const expected = boundedTerminalLine(task);
	if (!expected) return false;
	let candidate = boundedTerminalLine(value);
	candidate = candidate.replace(/^(?:User|You)(?:\s*:)?\s+/iu, "").replace(/^Task\s*:\s*/iu, "");
	const xml = candidate.match(/^<task>\s*(.*?)\s*<\/task>$/iu)?.[1];
	return (xml ?? candidate) === expected;
}

/** Resolve one terminal-safe, bounded label without asking another model. */
export function resolveDisplayDescription(
	description: string | null | undefined,
	task: string | null | undefined,
): string {
	const explicit = boundedTerminalLine(description);
	if (explicit) return boundTerminalLine(explicit, MAX_DISPLAY_DESCRIPTION_WIDTH);
	const legacyTask = compactAbsolutePaths(boundedTerminalLine(task));
	const source = legacyTask || "Agent task";
	return boundTerminalLine(source, MAX_DISPLAY_DESCRIPTION_WIDTH);
}
