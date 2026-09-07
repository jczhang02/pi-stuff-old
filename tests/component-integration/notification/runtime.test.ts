import { expect, test } from "bun:test";
import {
	createWorkCycleState,
	type NotificationAlert,
	type NotificationClock,
	NotificationRuntime,
	type NotificationRuntimeSettings,
	reduceWorkCycle,
} from "../../../packages/pi-stuff/src/notification/runtime.ts";

class FakeClock implements NotificationClock {
	private current = 0;
	private readonly timers = new Set<{ at: number; callback: () => void; cancelled: boolean }>();
	cancelCount = 0;

	now(): number {
		return this.current;
	}

	schedule(callback: () => void, delayMs: number): () => void {
		const timer = {
			at: this.current + delayMs,
			callback,
			cancelled: false,
		};
		this.timers.add(timer);
		return () => {
			if (timer.cancelled) return;
			timer.cancelled = true;
			this.cancelCount += 1;
		};
	}

	advance(milliseconds: number): void {
		const target = this.current + milliseconds;
		while (true) {
			const next = [...this.timers]
				.filter((timer) => !timer.cancelled && timer.at <= target)
				.sort((left, right) => left.at - right.at)[0];
			if (!next) break;
			this.timers.delete(next);
			this.current = next.at;
			next.callback();
		}
		this.current = target;
	}
}

function notificationFixture(
	settings: Partial<NotificationRuntimeSettings> = {},
	isQuiet: () => boolean = () => true,
	notify?: (alert: NotificationAlert) => void,
) {
	const alerts: NotificationAlert[] = [];
	const clock = new FakeClock();
	return {
		alerts,
		clock,
		runtime: new NotificationRuntime({
			clock,
			getSettings: () => ({
				completionAlerts: true,
				enabled: true,
				failureAlerts: true,
				gracePeriodMs: 2_000,
				minimumDurationMs: 10_000,
				...settings,
			}),
			isQuiet,
			notify: notify ?? ((alert) => alerts.push(alert)),
		}),
	};
}

test("the latest finalized Assistant result replaces a provider error in one work cycle", () => {
	let state = createWorkCycleState();
	state = reduceWorkCycle(state, { now: 100, type: "agent_start" });
	state = reduceWorkCycle(state, { type: "user_work" });
	state = reduceWorkCycle(state, {
		errorMessage: "HTTP 503",
		stopReason: "error",
		type: "assistant_finalized",
	});
	state = reduceWorkCycle(state, { now: 200, type: "agent_start" });
	state = reduceWorkCycle(state, { stopReason: "toolUse", type: "assistant_finalized" });
	state = reduceWorkCycle(state, { now: 900, type: "agent_settled" });

	expect(state).toEqual({
		generation: 1,
		includesUserWork: true,
		latestAssistant: { stopReason: "toolUse" },
		promptDepth: 0,
		promptStartedAt: null,
		promptWaitMs: 0,
		settledAt: 900,
		startedAt: 100,
		status: "pending",
	});
});

test("a real user receives one completion alert after long work settles", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(1_999);
	expect(alerts).toEqual([]);
	clock.advance(1);
	expect(alerts).toEqual([{ elapsedMs: 10_000, outcome: "completion" }]);
	clock.advance(10_000);
	expect(alerts).toHaveLength(1);
});

test("an open user prompt wait does not turn short Agent work into a completion alert", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(9_000);
	runtime.observe({ type: "ui_prompt_start" });
	clock.advance(5_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(2_000);

	expect(alerts).toEqual([]);
});

test("nested user prompts exclude the complete outer wait from Agent work", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(9_000);
	runtime.observe({ type: "ui_prompt_start" });
	clock.advance(1_000);
	runtime.observe({ type: "ui_prompt_start" });
	clock.advance(3_000);
	runtime.observe({ type: "ui_prompt_end" });
	clock.advance(1_000);
	runtime.observe({ type: "ui_prompt_end" });
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(2_000);

	expect(alerts).toEqual([]);
});

test("the settled alert carries only the latest finalized Assistant preview", () => {
	const { alerts, clock, runtime } = notificationFixture({ gracePeriodMs: 0, minimumDurationMs: 0 });

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	runtime.observe({ preview: "temporary provider failure", stopReason: "error", type: "assistant_finalized" });
	runtime.observe({ type: "agent_start" });
	runtime.observe({ preview: "The final result is ready.", stopReason: "stop", type: "assistant_finalized" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(0);

	expect(alerts).toEqual([{ elapsedMs: 0, outcome: "completion", preview: "The final result is ready." }]);
});

test("a user who types during the grace period is not interrupted by a stale alert", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(1_000);
	runtime.observe({ type: "input" });
	clock.advance(10_000);

	expect(alerts).toEqual([]);
});

test("an automatic retry, compaction, or Goal continuation rejects the stale generation before one final alert", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", errorMessage: "temporary outage", stopReason: "error" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(1_000);
	runtime.observe({ type: "agent_start" });
	clock.advance(3_000);
	expect(alerts).toEqual([]);

	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	clock.advance(2_000);

	expect(alerts).toEqual([{ elapsedMs: 14_000, outcome: "completion" }]);
});

test("session replacement, reload, or shutdown releases a pending alert", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	runtime.dispose();
	expect(clock.cancelCount).toBe(1);
	clock.advance(10_000);

	expect(alerts).toEqual([]);
});

test("a stray terminal key during grace cancels the alert without being consumed", () => {
	const { alerts, clock, runtime } = notificationFixture();

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	runtime.observe({ type: "terminal_input" });
	clock.advance(2_000);

	expect(alerts).toEqual([]);
});

test("input cancels a deferred alert even when queued Host work outlives the first timer", () => {
	let quiet = true;
	const { alerts, clock, runtime } = notificationFixture({}, () => quiet);

	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	clock.advance(10_000);
	runtime.observe({ type: "assistant_finalized", stopReason: "stop" });
	runtime.observe({ type: "agent_settled" });
	quiet = false;
	clock.advance(2_000);
	runtime.observe({ type: "input" });
	quiet = true;
	runtime.observe({ type: "agent_settled" });
	clock.advance(2_000);

	expect(alerts).toEqual([]);
});

test("the settled outcome matrix follows the latest finalized Assistant message", () => {
	const cases: Array<{
		readonly events: Array<Parameters<NotificationRuntime["observe"]>[0]>;
		readonly expected: "completion" | "failure" | undefined;
		readonly name: string;
	}> = [
		{ events: [{ stopReason: "stop", type: "assistant_finalized" }], expected: "completion", name: "ordinary" },
		{ events: [{ stopReason: "toolUse", type: "assistant_finalized" }], expected: "completion", name: "tool" },
		{
			events: [{ errorMessage: "denied", stopReason: "error", type: "assistant_finalized" }],
			expected: "failure",
			name: "exhausted retry or final error",
		},
		{ events: [{ stopReason: "aborted", type: "assistant_finalized" }], expected: undefined, name: "abort" },
		{ events: [], expected: undefined, name: "missing Assistant" },
		{
			events: [
				{ errorMessage: "HTTP 503", stopReason: "error", type: "assistant_finalized" },
				{ type: "agent_start" },
				{ stopReason: "stop", type: "assistant_finalized" },
			],
			expected: "completion",
			name: "retry recovery",
		},
		{
			events: [{ type: "agent_end" }, { type: "agent_end" }, { stopReason: "stop", type: "assistant_finalized" }],
			expected: "completion",
			name: "several agent_end events",
		},
	];

	for (const scenario of cases) {
		const { alerts, clock, runtime } = notificationFixture({ gracePeriodMs: 0, minimumDurationMs: 0 });
		runtime.observe({ type: "agent_start" });
		runtime.observe({ type: "user_work" });
		for (const event of scenario.events) runtime.observe(event);
		runtime.observe({ type: "agent_settled" });
		clock.advance(0);
		expect(
			alerts.map((alert) => alert.outcome),
			scenario.name,
		).toEqual(scenario.expected ? [scenario.expected] : []);
	}
});

test("short, automatic, disabled, and outcome-disabled work remains silent", () => {
	const cases = [
		{
			completionAlerts: true,
			enabled: true,
			failureAlerts: true,
			name: "short",
			outcome: "completion",
			user: true,
		},
		{
			completionAlerts: true,
			enabled: true,
			failureAlerts: true,
			name: "automatic",
			outcome: "completion",
			user: false,
		},
		{
			completionAlerts: true,
			enabled: false,
			failureAlerts: true,
			name: "disabled",
			outcome: "completion",
			user: true,
		},
		{
			completionAlerts: false,
			enabled: true,
			failureAlerts: true,
			name: "completion disabled",
			outcome: "completion",
			user: true,
		},
		{
			completionAlerts: true,
			enabled: true,
			failureAlerts: false,
			name: "failure disabled",
			outcome: "failure",
			user: true,
		},
	] as const;
	for (const scenario of cases) {
		const { alerts, clock, runtime } = notificationFixture(scenario);
		runtime.observe({ type: "agent_start" });
		if (scenario.user) runtime.observe({ type: "user_work" });
		clock.advance(scenario.name === "short" ? 9_999 : 10_000);
		runtime.observe(
			scenario.outcome === "failure"
				? { errorMessage: "final failure", stopReason: "error", type: "assistant_finalized" }
				: { stopReason: "stop", type: "assistant_finalized" },
		);
		runtime.observe({ type: "agent_settled" });
		clock.advance(2_000);
		expect(alerts, scenario.name).toEqual([]);
	}
});

test("a failed quiet check and delivery degrade silently", () => {
	const { clock, runtime } = notificationFixture(
		{ minimumDurationMs: 0 },
		() => {
			throw new Error("Host is replacing the session");
		},
		() => {
			throw new Error("should not notify");
		},
	);
	runtime.observe({ type: "agent_start" });
	runtime.observe({ type: "user_work" });
	runtime.observe({ stopReason: "stop", type: "assistant_finalized" });
	runtime.observe({ type: "agent_settled" });
	expect(() => clock.advance(2_000)).not.toThrow();

	const { clock: deliveryClock, runtime: deliveryRuntime } = notificationFixture(
		{ gracePeriodMs: 0, minimumDurationMs: 0 },
		undefined,
		() => {
			throw new Error("terminal closed");
		},
	);
	deliveryRuntime.observe({ type: "agent_start" });
	deliveryRuntime.observe({ type: "user_work" });
	deliveryRuntime.observe({ stopReason: "stop", type: "assistant_finalized" });
	deliveryRuntime.observe({ type: "agent_settled" });
	expect(() => deliveryClock.advance(0)).not.toThrow();
});
