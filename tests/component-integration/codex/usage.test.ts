import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { CodexAccountContext } from "../../../packages/pi-stuff/src/codex/account.js";
import { runCodexUsageOperation } from "../../../packages/pi-stuff/src/codex/index.js";
import {
	buildCodexUsageUrl,
	fetchCodexUsage,
	formatCodexUsage,
	parseCodexUsage,
	weeklyRemainingPercent,
} from "../../../packages/pi-stuff/src/codex/usage.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";

function jwt(accountId: string): string {
	const encode = (value: JsonInputObject): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.x`;
}

function accountContext(accountId = "account-42"): CodexAccountContext {
	const token = jwt(accountId);
	return {
		model: {
			api: "openai-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
			contextWindow: 200_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			headers: { "x-placeholder": "remove-me" },
			id: "gpt-5.2-codex",
			input: ["text"],
			maxTokens: 16_384,
			name: "GPT-5.2 Codex",
			provider: "openai-codex",
			reasoning: true,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				apiKey: token,
				headers: { "X-Placeholder": null },
				ok: true,
			}),
		},
	};
}

test("normalizes primary and secondary Codex windows", () => {
	const usage = parseCodexUsage({
		plan_type: "pro",
		rate_limit: {
			primary_window: { resets_at: 1_800_000_000, used_percent: 25, window_minutes: 300 },
			secondary_window: { resets_at: 1_800_500_000, used_percent: 72.4, window_minutes: 10_080 },
		},
	});
	expect(usage).toEqual({
		fiveHour: { resetsAt: 1_800_000_000, usedPercent: 25, windowMinutes: 300 },
		plan: "pro",
		weekly: { resetsAt: 1_800_500_000, usedPercent: 72.4, windowMinutes: 10_080 },
	});
	expect(weeklyRemainingPercent(usage)).toBeCloseTo(27.6);
	expect(formatCodexUsage(usage)).toContain("Weekly 28% left");
});

test("recognizes accounts where the weekly window is the only primary window", () => {
	const usage = parseCodexUsage({
		rate_limit: { primary: { limit_window_seconds: 604_800, used_percent: 4 } },
	});
	expect(usage.fiveHour).toBeUndefined();
	expect(usage.weekly).toEqual({ usedPercent: 4, windowMinutes: 10_080 });
	expect(weeklyRemainingPercent(usage)).toBe(96);
	expect(formatCodexUsage(usage)).toBe("Weekly 96% left");
	expect(formatCodexUsage(usage)).not.toContain("5h");
});

test("omits unavailable windows instead of rendering an unknown quota", () => {
	expect(formatCodexUsage({ plan: "unknown" })).toBe("Usage unavailable");
	expect(formatCodexUsage({ fiveHour: { usedPercent: 30 }, plan: "pro" })).toBe("5h 70% left");
});

test("builds the authenticated usage request only when explicitly invoked", async () => {
	const token = jwt("account-42");
	const ctx = accountContext();
	let request: Request | undefined;
	const usage = await Effect.runPromise(
		fetchCodexUsage(ctx, async (input, init) => {
			if (input instanceof Request) request = new Request(input, init);
			else request = new Request(input.toString(), init);
			return new Response(
				JSON.stringify({ rate_limit: { secondary: { used_percent: 10, window_minutes: 10_080 } } }),
				{ status: 200 },
			);
		}),
	);
	expect(request?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
	expect(request?.headers.get("authorization")).toBe(`Bearer ${token}`);
	expect(request?.headers.get("chatgpt-account-id")).toBe("account-42");
	expect(request?.headers.get("x-placeholder")).toBeNull();
	expect(weeklyRemainingPercent(usage)).toBe(90);
	expect(buildCodexUsageUrl("https://example.test/codex/responses")).toBe("https://example.test/wham/usage");
});

test("preserves response and decoding failures", async () => {
	const ctx = accountContext();
	await expect(
		Effect.runPromise(fetchCodexUsage(ctx, async () => new Response("busy", { status: 429 }))),
	).rejects.toThrow("Codex usage request failed (429).");
	await expect(
		Effect.runPromise(fetchCodexUsage(ctx, async () => new Response("not-json", { status: 200 }))),
	).rejects.toThrow("Codex usage returned invalid JSON.");
});

test("replaces the manual request timer with an interrupting Effect timeout", async () => {
	let aborted = false;
	const request = fetchCodexUsage(
		accountContext(),
		(_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return reject(new Error("missing Effect cancellation signal"));
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			}),
		1,
	);
	await expect(Effect.runPromise(request)).rejects.toThrow("Codex usage request timed out.");
	expect(aborted).toBeTrue();
});

test("commits success and projects failures and caller cancellation at the Pi boundary", async () => {
	const foundation = new EffectFoundation();
	await foundation.startSession();
	let committed = false;
	await runCodexUsageOperation(foundation, Effect.succeed({ plan: "pro" }), () => {
		committed = true;
	});
	expect(committed).toBeTrue();
	const failure = new Error("expected usage failure");
	await expect(runCodexUsageOperation(foundation, Effect.fail(failure), () => undefined)).rejects.toBe(failure);

	const controller = new AbortController();
	const reason = new Error("caller cancelled usage");
	const cancelled = runCodexUsageOperation(foundation, Effect.never, () => undefined, controller.signal);
	controller.abort(reason);
	await expect(cancelled).rejects.toBe(reason);
	await foundation.shutdown();
});

test("a replaced Session cannot publish a late usage result", async () => {
	const foundation = new EffectFoundation();
	await foundation.startSession();
	const late = Promise.withResolvers<{ readonly plan: string }>();
	let published = false;
	const request = runCodexUsageOperation(
		foundation,
		Effect.promise(() => late.promise),
		() => {
			published = true;
		},
	).catch(() => undefined);
	await Promise.resolve();
	const replacement = foundation.startSession();
	late.resolve({ plan: "too late" });
	await replacement;
	await request;
	expect(published).toBeFalse();
	await foundation.shutdown();
});
