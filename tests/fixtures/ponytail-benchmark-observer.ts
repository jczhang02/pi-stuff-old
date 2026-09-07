import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeObject, isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";

const CONTRIBUTION_START = "<!-- pi-stuff:prompt-contribution:ponytail:start -->";
const CONTRIBUTION_END = "<!-- pi-stuff:prompt-contribution:ponytail:end -->";
const PONYTAIL_SKILL = /<name>ponytail(?:-[^<]+)?<\/name>/gu;

function count(text: string, marker: string): number {
	return text.split(marker).length - 1;
}
function providerToolName<Value>(value: Value): string | undefined {
	if (!isRuntimeObject(value) || value === null) return undefined;
	if ("name" in value && isRuntimeString(value.name)) return value.name;
	if (!("function" in value) || !isRuntimeObject(value["function"]) || value["function"] === null) return undefined;
	const definition = value["function"];
	return "name" in definition && isRuntimeString(definition.name) ? definition.name : undefined;
}
export function providerToolNames<Value>(payload: Value): readonly string[] {
	if (!isRuntimeObject(payload) || payload === null || !("tools" in payload) || !Array.isArray(payload.tools))
		return [];
	return [...new Set(payload.tools.map(providerToolName).filter(isRuntimeString))].sort();
}

export default function ponytailBenchmarkObserver(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const logPath = process.env["PI_STUFF_PONYTAIL_BENCHMARK_LOG"];
		if (!logPath) return;
		const payload = JSON.stringify(event.payload);
		const start = payload.indexOf(CONTRIBUTION_START);
		const end = start < 0 ? -1 : payload.indexOf(CONTRIBUTION_END, start);
		const contribution = start < 0 || end < 0 ? "" : payload.slice(start, end + CONTRIBUTION_END.length);
		appendFileSync(
			logPath,
			`${JSON.stringify({
				type: "provider-request",
				markerCount: count(payload, CONTRIBUTION_START),
				contributionCharacters: contribution.length,
				hasModePolicy: payload.includes("PONYTAIL MODE ACTIVE — level:"),
				hasUpstreamLongForm: payload.includes("HARD RULE: branch or loop only when each leaf has a test"),
				skillNames: [...new Set(payload.match(PONYTAIL_SKILL) ?? [])].sort(),
				toolNames: providerToolNames(event.payload),
			})}\n`,
		);
	});
}
