import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StatusContext } from "./policy.ts";
import type { GoalSettings } from "./settings.ts";

export const GOAL_COMPLETE_TOOL = "goal_complete";
export const GOAL_BLOCKED_TOOL = "goal_blocked";

const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;

export interface GoalToolVisibilitySnapshot {
	activeTools: string[];
	goalToolsUnlocked: boolean;
	goalToolsHiddenByPolicy: string[];
}

/** Owns the Host tool allowlist changes made by Goal's lazy visibility policy. */
export class GoalToolPolicy {
	readonly pi: ExtensionAPI;
	/** Once true, goal tools stay in the active set for this runtime (prompt-cache stable). */
	goalToolsUnlocked = false;
	/** Exact lazy goal tools this runtime removed and may restore on a mode change. */
	goalToolsHiddenByPolicy = new Set<string>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	isGoalToolName(name: string) {
		return GOAL_TOOL_NAMES.some((toolName) => toolName === name);
	}

	goalToolsAvailable() {
		const active = new Set(this.pi.getActiveTools());
		return GOAL_TOOL_NAMES.every((name) => active.has(name));
	}

	hideGoalToolsIfLocked() {
		if (this.goalToolsUnlocked) return;
		const active = this.pi.getActiveTools();
		const hidden = active.filter((name) => this.isGoalToolName(name));
		if (hidden.length === 0) return;
		this.pi.setActiveTools(active.filter((name) => !this.isGoalToolName(name)));
		for (const name of hidden) this.goalToolsHiddenByPolicy.add(name);
	}

	restoreGoalToolsHiddenByPolicy() {
		const activeBeforeRestore = this.pi.getActiveTools();
		const activeSet = new Set(activeBeforeRestore);
		const missingOwnedTools = [...this.goalToolsHiddenByPolicy].filter((name) => !activeSet.has(name));
		if (missingOwnedTools.length === 0) {
			this.goalToolsHiddenByPolicy.clear();
			return;
		}
		try {
			this.pi.setActiveTools([...activeBeforeRestore, ...missingOwnedTools]);
			const restored = new Set(this.pi.getActiveTools());
			if (missingOwnedTools.some((name) => !restored.has(name))) {
				throw new Error("the active tool policy rejected a previously hidden goal tool");
			}
			this.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			this.pi.setActiveTools(activeBeforeRestore);
			throw error;
		}
	}

	assertGoalToolsAvailable() {
		if (this.goalToolsAvailable()) return;
		throw new Error(
			"goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
		);
	}

	ensureGoalToolsVisible() {
		const active = this.pi.getActiveTools();
		const activeSet = new Set(active);
		const missing = GOAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
		if (missing.length > 0) this.pi.setActiveTools([...active, ...missing]);
		this.assertGoalToolsAvailable();
	}

	protected prepareGoalToolsForVisibility(toolVisibility: GoalSettings["toolVisibility"], ctx: StatusContext) {
		if (toolVisibility === "after-first-goal") {
			if (!this.goalToolsAvailable() && ctx.isIdle?.() !== true) {
				throw new Error("wait until Pi is idle before revealing the goal tools");
			}
			this.revealGoalTools();
			return;
		}
		this.assertGoalToolsAvailable();
	}

	/** Mark lazy tools permanently desired for this runtime and make them active now. */
	revealGoalTools() {
		const activeBeforeReveal = this.pi.getActiveTools();
		const wasUnlocked = this.goalToolsUnlocked;
		try {
			this.ensureGoalToolsVisible();
			this.goalToolsUnlocked = true;
			this.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			this.pi.setActiveTools(activeBeforeReveal);
			this.goalToolsUnlocked = wasUnlocked;
			throw error;
		}
	}

	snapshotGoalToolVisibility(): GoalToolVisibilitySnapshot {
		return {
			activeTools: this.pi.getActiveTools(),
			goalToolsUnlocked: this.goalToolsUnlocked,
			goalToolsHiddenByPolicy: [...this.goalToolsHiddenByPolicy],
		};
	}

	restoreGoalToolVisibility(snapshot: GoalToolVisibilitySnapshot) {
		this.pi.setActiveTools(snapshot.activeTools);
		this.goalToolsUnlocked = snapshot.goalToolsUnlocked;
		this.goalToolsHiddenByPolicy.clear();
		for (const name of snapshot.goalToolsHiddenByPolicy) this.goalToolsHiddenByPolicy.add(name);
	}
}
