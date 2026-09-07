import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonObject } from "../../shared/json-value.ts";
import { piStuffStatePath } from "../../xdg/index.ts";
import { getAgentPath } from "./agent-dir.ts";

export interface McpOnboardingState {
	version: 1;
	setupCompleted: boolean;
}

const DEFAULT_STATE: McpOnboardingState = {
	version: 1,
	setupCompleted: false,
};

export function getOnboardingStatePath(): string {
	return piStuffStatePath("mcp", "mcp-onboarding.json");
}

export function loadOnboardingState(): McpOnboardingState {
	const currentPath = getOnboardingStatePath();
	const path = existsSync(currentPath) ? currentPath : getAgentPath("mcp-onboarding.json");
	if (!existsSync(path)) return { ...DEFAULT_STATE };

	try {
		const raw = parseJsonObject(readFileSync(path, "utf-8"));
		return {
			version: 1,
			setupCompleted: raw["setupCompleted"] === true,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

export function saveOnboardingState(state: McpOnboardingState): void {
	const path = getOnboardingStatePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

export function updateOnboardingState(updater: (state: McpOnboardingState) => McpOnboardingState): McpOnboardingState {
	const next = updater(loadOnboardingState());
	saveOnboardingState(next);
	return next;
}

export function markSetupCompleted(): McpOnboardingState {
	return updateOnboardingState((state) => ({
		...state,
		setupCompleted: true,
	}));
}
