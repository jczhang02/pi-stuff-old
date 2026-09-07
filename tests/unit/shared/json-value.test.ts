import { expect, test } from "bun:test";
import {
	isJsonInputValue,
	isJsonSourceValue,
	parseJsonValue,
} from "../../../packages/pi-stuff/src/shared/json-value.js";

interface CyclicFixture {
	self?: CyclicFixture;
}

test("JSON guards reject cycles and non-plain objects without rejecting shared values", () => {
	const cyclic: CyclicFixture = {};
	cyclic.self = cyclic;
	const shared = { value: 1 };
	const nullPrototype = Object.assign(Object.create(null), { value: 1 });

	expect(isJsonInputValue(cyclic)).toBe(false);
	expect(isJsonSourceValue(cyclic)).toBe(false);
	expect(isJsonInputValue({ left: shared, right: shared })).toBe(true);
	expect(isJsonInputValue(nullPrototype)).toBe(true);
	expect(isJsonInputValue(new Date())).toBe(false);
	expect(isJsonInputValue(new Map())).toBe(false);
});

test("JSON input preserves omission semantics while parsed JSON requires finite source values", () => {
	expect(isJsonInputValue({ optional: undefined })).toBe(true);
	expect(isJsonSourceValue({ optional: undefined })).toBe(false);
	expect(() => parseJsonValue("1e400")).toThrow("finite JSON values");
	expect(parseJsonValue('{"value":1}')).toEqual({ value: 1 });
});
