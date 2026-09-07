import type { SuiteToolReplayDefinition } from "./contract.ts";

const BUILTIN_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);

export interface ResumeToolHandoff {
	readonly activeNames: readonly string[];
	readonly builtinNames: readonly string[];
	readonly toolDefinitions: readonly SuiteToolReplayDefinition[];
}

interface ResumeToolHandoffStore {
	pending: ResumeToolHandoff | undefined;
}

const RESUME_TOOL_HANDOFF = Symbol.for("@jczhang02/pi-stuff-tools/resume-tool-handoff/v3");

function handoffStore(): ResumeToolHandoffStore {
	// SAFETY: this process-global symbol is private to the Suite and always stores this module's handoff shape.
	const root = globalThis as {
		[key: symbol]: ResumeToolHandoffStore | undefined;
	};
	root[RESUME_TOOL_HANDOFF] ??= { pending: undefined };
	return root[RESUME_TOOL_HANDOFF];
}

/** Retain one consume-once ordered snapshot across the Host's in-process session replacement. */
export function prepareResumeToolHandoff(
	activeToolNames: readonly string[],
	toolDefinitions: readonly SuiteToolReplayDefinition[],
): void {
	const activeNames = [...activeToolNames];
	handoffStore().pending = {
		activeNames,
		builtinNames: activeNames.filter((name) => BUILTIN_NAMES.has(name)),
		toolDefinitions: [...toolDefinitions],
	};
}

/** Consume at most one pending snapshot; later factories cannot replay stale membership. */
export function consumeResumeToolHandoff(): ResumeToolHandoff | undefined {
	const store = handoffStore();
	const handoff = store.pending;
	store.pending = undefined;
	return handoff === undefined
		? undefined
		: {
				activeNames: [...handoff.activeNames],
				builtinNames: [...handoff.builtinNames],
				toolDefinitions: [...handoff.toolDefinitions],
			};
}

/** Preserve outgoing order without reviving non-builtins absent from the incoming runtime. */
export function restoreResumeActiveToolOrder(
	currentActiveNames: readonly string[],
	handoff: ResumeToolHandoff,
): string[] {
	const currentNonBuiltins = new Set(currentActiveNames.filter((name) => !BUILTIN_NAMES.has(name)));
	const restoredBuiltins = new Set(handoff.builtinNames);
	const restored: string[] = [];
	const seen = new Set<string>();
	for (const name of handoff.activeNames) {
		if (seen.has(name)) continue;
		if (BUILTIN_NAMES.has(name) ? restoredBuiltins.has(name) : currentNonBuiltins.has(name)) {
			restored.push(name);
			seen.add(name);
		}
	}
	for (const name of currentActiveNames) {
		if (BUILTIN_NAMES.has(name) || seen.has(name)) continue;
		restored.push(name);
		seen.add(name);
	}
	return restored;
}
