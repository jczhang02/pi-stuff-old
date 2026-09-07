import { describe, expect, test } from "bun:test";
import { isRuntimeNumber, isRuntimeObject } from "../../../packages/pi-stuff/src/shared/runtime-type.js";

describe("runtime type guards", () => {
	test("preserve JavaScript number and object categories", () => {
		for (const value of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(isRuntimeNumber(value)).toBe(true);
		}
		expect(isRuntimeNumber("0")).toBe(false);

		for (const value of [{}, [], null]) expect(isRuntimeObject(value)).toBe(true);
		expect(isRuntimeObject(() => undefined)).toBe(false);
	});
});
