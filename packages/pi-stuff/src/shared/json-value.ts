export type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}

export type JsonInputValue = boolean | null | number | string | undefined | readonly JsonInputValue[] | JsonInputObject;

export interface JsonInputObject {
	[key: string]: JsonInputValue;
}

export function isJsonInputValue<Value>(value: Value): value is Value & JsonInputValue {
	return isJsonInputValueAt(value, new WeakSet());
}

function isJsonInputValueAt<Value>(value: Value, ancestors: WeakSet<object>): value is Value & JsonInputValue {
	if (value === null || isRuntimeBoolean(value) || isRuntimeString(value) || isRuntimeUndefined(value)) return true;
	if (isRuntimeNumber(value)) return Number.isFinite(value);
	if (!Array.isArray(value) && !isPlainJsonObject(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Object.values(value).every((item) => isJsonInputValueAt(item, ancestors));
	ancestors.delete(value);
	return valid;
}

export function isJsonInputObject<Value>(value: Value): value is Value & JsonInputObject {
	return isPlainJsonObject(value) && isJsonInputValue(value);
}

/** Validate JSON-compatible input, where `undefined` represents an omitted optional value. */
export function requireJsonInputValue<Value>(value: Value, description: string): Value & JsonInputValue {
	if (!isJsonInputValue(value)) throw new TypeError(`${description} must contain only JSON values`);
	return value;
}

/** A value observed at a runtime boundary that already conforms to the JSON grammar. */
export type JsonSourceValue = boolean | null | number | string | readonly JsonSourceValue[] | JsonSourceObject;

export interface JsonSourceObject {
	readonly [key: string]: JsonSourceValue;
}

export function isJsonSourceValue<Value>(value: Value): value is Value & JsonSourceValue {
	return isJsonSourceValueAt(value, new WeakSet());
}

function isJsonSourceValueAt<Value>(value: Value, ancestors: WeakSet<object>): value is Value & JsonSourceValue {
	if (value === null || isRuntimeBoolean(value) || isRuntimeString(value)) return true;
	if (isRuntimeNumber(value)) return Number.isFinite(value);
	if (!Array.isArray(value) && !isPlainJsonObject(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Object.values(value).every((item) => isJsonSourceValueAt(item, ancestors));
	ancestors.delete(value);
	return valid;
}

export function jsonInputKind(
	value: JsonInputValue,
): "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined" {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (isRuntimeBoolean(value)) return "boolean";
	if (isRuntimeNumber(value)) return "number";
	if (isRuntimeString(value)) return "string";
	return Array.isArray(value) ? "array" : "object";
}

export function parseJsonValue(text: string): JsonValue {
	const value = JSON.parse(text);
	if (!isJsonSourceValue(value)) throw new TypeError("Parsed JSON must contain only finite JSON values");
	return value;
}

export function parseJsonObject(text: string): JsonObject {
	const value = parseJsonValue(text);
	if (!isJsonObject(value)) throw new TypeError("Expected a JSON object");
	return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && isRuntimeObject(value) && !Array.isArray(value);
}

function isPlainJsonObject<Value>(value: Value): value is Value & JsonInputObject {
	if (value === null || !isRuntimeObject(value) || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
	isRuntimeUndefined,
} from "./runtime-type.ts";
