import type { PlannedRetrievalGroup } from "./activity.ts";

const TIMER_STATE_LIMIT = 768;
export const TOOL_ACTIVITY_TICK_MS = 600;

interface ToolTimerState {
	invalidate: () => void;
	setMarkerVisible: (visible: boolean) => void;
	visible: boolean;
}

type ActivityClockHooks = {
	leaderIdFor: (toolCallId: string) => string | undefined;
	reconcileLeader: (leaderId: string) => void;
	reconcileTool: (toolCallId: string) => void;
	runningMemberId: (leaderId: string) => string | undefined;
	setLeaderMarker: (leaderId: string, visible: boolean, invalidate: boolean) => void;
};

export interface ActivityClockWakes {
	readonly groups: () => void;
	readonly tools: () => void;
}

export class ToolActivityClock {
	private readonly groupPulses = new Map<string, { visible: boolean }>();
	private groupWake: (() => void) | undefined;
	private readonly timerStates = new Map<string, ToolTimerState>();
	private timerWake: (() => void) | undefined;
	private readonly hooks: ActivityClockHooks;

	constructor(hooks: ActivityClockHooks) {
		this.hooks = hooks;
	}

	bindWakes(wakes: ActivityClockWakes): () => void {
		this.groupWake = wakes.groups;
		this.timerWake = wakes.tools;
		if (this.groupPulses.size > 0) wakes.groups();
		if (this.timerStates.size > 0) wakes.tools();
		return () => {
			if (this.groupWake === wakes.groups) this.groupWake = undefined;
			if (this.timerWake === wakes.tools) this.timerWake = undefined;
		};
	}

	hasGroupPulses(): boolean {
		return this.groupPulses.size > 0;
	}

	hasToolTimers(): boolean {
		return this.timerStates.size > 0;
	}

	start(toolCallId: string, invalidate: () => void, setMarkerVisible: (visible: boolean) => void = () => {}): void {
		const wasIdle = this.timerStates.size === 0;
		const existing = this.timerStates.get(toolCallId);
		const visible = existing?.visible ?? true;
		if (existing) this.timerStates.delete(toolCallId);
		while (this.timerStates.size >= TIMER_STATE_LIMIT) {
			const oldestId = this.timerStates.keys().next().value;
			if (!oldestId) break;
			const oldest = this.timerStates.get(oldestId);
			this.timerStates.delete(oldestId);
			oldest?.setMarkerVisible(true);
			this.pulseGroup(oldestId, true);
			this.hooks.reconcileTool(oldestId);
		}
		this.timerStates.set(toolCallId, { invalidate, setMarkerVisible, visible });
		setMarkerVisible(visible);
		if (this.isGroupMarkerDriver(toolCallId)) this.pulseGroup(toolCallId, visible);
		if (wasIdle) this.timerWake?.();
		this.hooks.reconcileTool(toolCallId);
	}

	stop(toolCallId: string): void {
		const state = this.timerStates.get(toolCallId);
		if (!state) return;
		this.timerStates.delete(toolCallId);
		state.setMarkerVisible(true);
		if (this.timerStates.size === 0) this.timerWake?.();
		this.pulseGroup(toolCallId, true);
		this.hooks.reconcileTool(toolCallId);
	}

	sync(): void {
		for (const [toolCallId, state] of this.timerStates) {
			state.visible = true;
			state.setMarkerVisible(true);
			this.pulseGroup(toolCallId, true);
			state.invalidate();
		}
		this.reconcileTimerGroups();
	}

	suspend(): void {
		for (const toolCallId of Array.from(this.timerStates.keys())) this.stop(toolCallId);
		for (const leaderId of Array.from(this.groupPulses.keys())) this.dropGroup(leaderId);
	}

	reconcileGroup(group: PlannedRetrievalGroup, active: boolean): void {
		const hasToolTimer = group.members.some((member) => this.timerStates.has(member.id));
		if (!active || hasToolTimer) {
			this.dropGroup(group.leaderId);
			return;
		}
		if (this.groupPulses.has(group.leaderId)) return;
		const wasIdle = this.groupPulses.size === 0;
		this.groupPulses.set(group.leaderId, { visible: true });
		if (wasIdle) this.groupWake?.();
	}

	dropGroup(leaderId: string): void {
		if (!this.groupPulses.delete(leaderId)) return;
		if (this.groupPulses.size === 0) this.groupWake?.();
		this.hooks.setLeaderMarker(leaderId, true, true);
	}

	pruneGroups(validLeaderIds: ReadonlySet<string>): void {
		for (const leaderId of Array.from(this.groupPulses.keys())) {
			if (!validLeaderIds.has(leaderId)) this.dropGroup(leaderId);
		}
	}

	tickToolTimers(): void {
		for (const [toolCallId, state] of this.timerStates) {
			state.visible = !state.visible;
			state.setMarkerVisible(state.visible);
			if (this.isGroupMarkerDriver(toolCallId)) this.pulseGroup(toolCallId, state.visible);
			state.invalidate();
		}
		this.reconcileTimerGroups();
	}

	tickGroupPulses(): void {
		for (const [leaderId, pulse] of this.groupPulses) {
			pulse.visible = !pulse.visible;
			this.hooks.setLeaderMarker(leaderId, pulse.visible, true);
			this.hooks.reconcileLeader(leaderId);
		}
	}

	private reconcileTimerGroups(): void {
		const leaders = new Set<string>();
		for (const toolCallId of this.timerStates.keys()) {
			const leaderId = this.hooks.leaderIdFor(toolCallId);
			if (leaderId) leaders.add(leaderId);
			else this.hooks.reconcileTool(toolCallId);
		}
		for (const leaderId of leaders) this.hooks.reconcileLeader(leaderId);
	}

	private pulseGroup(toolCallId: string, visible: boolean): void {
		const leaderId = this.hooks.leaderIdFor(toolCallId);
		if (leaderId) this.hooks.setLeaderMarker(leaderId, visible, false);
	}

	private isGroupMarkerDriver(toolCallId: string): boolean {
		const leaderId = this.hooks.leaderIdFor(toolCallId);
		return !leaderId || this.hooks.runningMemberId(leaderId) === toolCallId;
	}
}
