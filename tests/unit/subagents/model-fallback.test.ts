import { describe, expect, test } from "bun:test";
import {
	buildModelCandidates,
	formatSubagentModelVerificationError,
	isContextOverflow,
	isRetryableModelFailure,
	isRetryableModelFailureAttempt,
	MAX_MODEL_CANDIDATES_PER_CHILD,
	resolveEffectiveSubagentModel,
	resolveModelCandidate,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/model-fallback.js";

const availableModels = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
];

describe("Agent model fallback proof bounds", () => {
	test("accepts 64 total candidates and rejects the 65th before any writer can spawn", () => {
		const sixtyThreeFallbacks = Array.from(
			{ length: MAX_MODEL_CANDIDATES_PER_CHILD - 1 },
			(_, index) => `provider/fallback-${index}`,
		);
		expect(buildModelCandidates("provider/primary", sixtyThreeFallbacks, undefined)).toHaveLength(
			MAX_MODEL_CANDIDATES_PER_CHILD,
		);
		expect(() =>
			buildModelCandidates("provider/primary", [...sixtyThreeFallbacks, "provider/fallback-overflow"], undefined),
		).toThrow("at most 64 model candidates");
	});

	test("retries a larger fallback after the terminal child-payload gate rejects a small model", () => {
		expect(
			isRetryableModelFailure(
				"Agent launch stopped before the provider request: the final child payload is estimated at 5,012 input tokens (20,048 UTF-8 bytes), above the safe 4,000-token input bound for this model.",
			),
		).toBeTrue();
	});

	test("resolves owner/name ids without treating the owner as a provider", () => {
		const registry = [
			...availableModels,
			{
				provider: "huggingface",
				id: "thinkingmachines/Inkling",
				fullId: "huggingface/thinkingmachines/Inkling",
			},
		];
		expect(resolveModelCandidate("thinkingmachines/Inkling:high", registry)).toBe(
			"huggingface/thinkingmachines/Inkling:high",
		);
	});

	test("rejects explicit unknown models but lets configured fallbacks replace unavailable models", () => {
		expect(() =>
			resolveEffectiveSubagentModel("does-not-exist", "openai/gpt-5-mini", undefined, availableModels),
		).toThrow("Unknown subagent model 'does-not-exist'");
		expect(
			buildModelCandidates("does-not-exist", ["anthropic/claude-sonnet-4"], availableModels, undefined, {
				origin: "configured",
			}),
		).toEqual(["anthropic/claude-sonnet-4"]);
		expect(() =>
			buildModelCandidates("does-not-exist", ["anthropic/claude-sonnet-4"], availableModels, undefined, {
				origin: "explicit",
			}),
		).toThrow("Unknown subagent model 'does-not-exist'");
	});

	test("trusts inherited parent models and preserves raw candidates when no registry is available", () => {
		expect(
			buildModelCandidates("gateway/parent-model", undefined, availableModels, undefined, { origin: "inherited" }),
		).toEqual(["gateway/parent-model"]);
		expect(buildModelCandidates("provider/primary", ["provider/fallback"], [])).toEqual([
			"provider/primary",
			"provider/fallback",
		]);
	});

	test("verifies the launched model while accepting driver-reported ids and leaves", () => {
		const gatewayModels = [
			{
				provider: "bifrost-anthropic",
				id: "vertex/claude-fable-5",
				fullId: "bifrost-anthropic/vertex/claude-fable-5",
			},
		];
		expect(
			formatSubagentModelVerificationError(
				"bifrost-anthropic/vertex/claude-fable-5:high",
				"claude-fable-5",
				gatewayModels,
			),
		).toBeUndefined();
		expect(
			formatSubagentModelVerificationError(
				"bifrost-anthropic/vertex/claude-fable-5:high",
				"wrong-provider/claude-fable-5",
				gatewayModels,
			),
		).toContain("model_verification_failed");
	});

	test("retries provider failures only before useful child activity", () => {
		for (const error of [
			"The usage limit has been reached",
			"APIConnectionError: Connection closed.",
			"internal server error",
			"500",
		]) {
			expect(isRetryableModelFailure(error)).toBeTrue();
		}
		expect(
			isRetryableModelFailureAttempt({
				error: "APIConnectionError: Connection closed.",
				messages: [{ role: "assistant" }],
				toolCount: 0,
			}),
		).toBeFalse();
		expect(
			isRetryableModelFailureAttempt({
				error: "APIConnectionError: Connection closed.",
				messages: [{ role: "assistant", errorMessage: "APIConnectionError: Connection closed." }],
				toolCount: 0,
			}),
		).toBeTrue();
		const overflow = "model error: maximum context length exceeded";
		expect(isContextOverflow(overflow)).toBeTrue();
		expect(isRetryableModelFailure(overflow)).toBeFalse();
	});
});
