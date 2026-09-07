import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { balancedArmOrder, comparePairedSamples } from "../../../scripts/benchmark-statistics.js";
import {
	MAGIC_CONTEXT_SAMPLE_SCHEMA,
	numericMagicContextMetrics,
} from "../../../scripts/magic-context-benchmark-core.js";

const repeatedPairs = (ratio: number) =>
	Array.from({ length: 15 }, (_value, index) => ({ baseline: 100 + index, candidate: (100 + index) * ratio }));

test("classifies paired measurements against the comparison thresholds", () => {
	expect(comparePairedSamples(repeatedPairs(0.9)).classification).toBe("improved");
	expect(comparePairedSamples(repeatedPairs(1.05)).classification).toBe("non-inferior");
	expect(comparePairedSamples(repeatedPairs(1.2)).classification).toBe("regressed");
});

test("rotates every arm through the first measurement position", () => {
	const arms = ["host", "baseline", "candidate"] as const;
	expect([0, 1, 2].map((run) => balancedArmOrder(arms, run)[0])).toEqual([...arms]);
	expect(balancedArmOrder(arms, 3)).toEqual([...arms]);
});

test("keeps Worker start independent in Magic Context benchmark samples", () => {
	const projection = { firstProjectionMs: 1, fullSnapshotMs: 1, hostEffectMs: null, incrementalLeafMs: 1 };
	const sample = {
		bundleBytes: 1,
		cases: { fresh: projection, long: projection, "malformed-image": projection, short: projection },
		initializeAndTokenizerPreloadMs: 3,
		packageVersion: "fixture",
		queue: { estimatedQueueWaitMs: 1, parallelPairMs: 2, singleCommandMs: 1 },
		workerBuildMs: 4,
		workerStartMs: 2,
	};
	expect(Check(MAGIC_CONTEXT_SAMPLE_SCHEMA, sample)).toBe(true);
	expect(numericMagicContextMetrics(sample).get("workerStartMs")).toBe(2);
	expect(Check(MAGIC_CONTEXT_SAMPLE_SCHEMA, { ...sample, workerStartMs: undefined })).toBe(false);
});
