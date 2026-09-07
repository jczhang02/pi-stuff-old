import { expect, test } from "bun:test";
import {
	isCodemodeValue,
	parseForCodemode,
	parseForStorage,
	stringifyForStorage,
} from "../../../packages/pi-stuff/src/code-mode/cloudflare/codec.js";
import { stableStringify } from "../../../packages/pi-stuff/src/code-mode/cloudflare/stable-stringify.js";

interface CyclicFixture {
	self?: CyclicFixture;
}

test("Code Mode values reject lossy objects, cycles, and non-finite numbers", () => {
	const cyclic: CyclicFixture = {};
	cyclic.self = cyclic;

	expect(isCodemodeValue({ bytes: new Uint8Array([1, 2]), value: 3n })).toBe(true);
	expect(isCodemodeValue(cyclic)).toBe(false);
	expect(isCodemodeValue(new Date())).toBe(false);
	expect(isCodemodeValue(Number.POSITIVE_INFINITY)).toBe(false);
	expect(() => stringifyForStorage(cyclic)).toThrow("not serializable");
	expect(() => parseForStorage("1e400")).toThrow("storage value is invalid");
});

test("Code Mode codecs reject malformed envelopes without corrupting tagged user objects", () => {
	expect(() => parseForCodemode('{"__codemode_binary_v1__":"bogus","data":"AQI="}')).toThrow(
		"binary envelope is invalid",
	);
	expect(parseForCodemode('{"__codemode_binary_v1__":"bogus","data":"AQI=","label":"user"}')).toEqual({
		__codemode_binary_v1__: "bogus",
		data: "AQI=",
		label: "user",
	});
	expect(parseForStorage('{"__codemode_bigint_v1__":"7","label":"user"}')).toEqual({
		__codemode_bigint_v1__: "7",
		label: "user",
	});
	expect(() => parseForStorage('{"__codemode_bigint_v1__":"01"}')).toThrow("bigint envelope is invalid");
});

test("stable stringify uses deterministic code-unit key order", () => {
	const composedFirst = { é: 1, é: 2 };
	const decomposedFirst = { é: 2, é: 1 };
	expect(stableStringify(composedFirst)).toBe(stableStringify(decomposedFirst));
});
