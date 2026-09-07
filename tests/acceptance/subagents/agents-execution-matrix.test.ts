import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import {
	parseCompleteLogRecords,
	verifyAgentsExecutionMatrix,
} from "../../../scripts/verify-agents-execution-matrix.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("execution-matrix polling ignores only a JSONL record still being appended", () => {
	const complete = JSON.stringify({ kind: "child-finish", scenario: "parallel-fresh-background" });
	const partial = '{"kind":"child-finish","scenario":"parallel-fresh';
	expect(parseCompleteLogRecords(`${complete}\n${partial}`)).toEqual([
		{ kind: "child-finish", scenario: "parallel-fresh-background" },
	]);
	expect(() => parseCompleteLogRecords('{"kind":}\n')).toThrow();
});

test("real Pi executes the Agent shape, context, and scheduling matrix with parallel provider overlap", async () => {
	await verifyAgentsExecutionMatrix({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE });
}, 300_000);
