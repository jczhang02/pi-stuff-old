import {
	isRuntimeBigInt,
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
	isRuntimeUndefined,
} from "../../shared/runtime-type.ts";
/**
 * Host-side value codec.
 *
 * Two layers share the binary encoding (a tagged base64 envelope):
 *
 * - **Transport** (`stringifyForCodemode`/`parseForCodemode`): used for the
 *   host↔sandbox tool-call boundary. Must stay in lockstep with the sandbox's
 *   own codec (`SANDBOX_CODEC` in executor.ts).
 * - **Storage** (`stringifyForStorage`/`parseForStorage`): used by the
 *   CodemodeRuntime facet to persist args/results in SQLite. Builds on the
 *   transport encoding and additionally round-trips `bigint` (which plain
 *   `JSON.stringify` rejects). The bigint tag is storage-only — it never
 *   crosses into the sandbox.
 */

export const BINARY_TAG = "__codemode_binary_v1__";
const BIGINT_TAG = "__codemode_bigint_v1__";

type EncodedBinary = {
	[BINARY_TAG]: "Uint8Array" | "ArrayBuffer" | "ArrayBufferView";
	data: string;
};

export type CodemodeValue =
	| ArrayBuffer
	| ArrayBufferView
	| bigint
	| boolean
	| null
	| number
	| readonly CodemodeValue[]
	| CodemodeObject
	| string
	| undefined;

export interface CodemodeObject {
	readonly [key: string]: CodemodeValue;
}

export function isCodemodeValue<Value>(value: Value): value is Value & CodemodeValue {
	return isCodemodeValueAt(value, new WeakSet());
}

export function requireCodemodeValue<Value>(value: Value, description: string): Value & CodemodeValue {
	if (!isCodemodeValue(value)) throw new TypeError(`${description} is not a Code Mode transport value`);
	return value;
}

export function isCodemodeObject<Value>(value: Value): value is Value & CodemodeObject {
	if (value === null || !isRuntimeObject(value) || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isCodemodeValueAt<Value>(value: Value, ancestors: WeakSet<object>): value is Value & CodemodeValue {
	if (
		value === null ||
		isRuntimeBigInt(value) ||
		isRuntimeBoolean(value) ||
		isRuntimeString(value) ||
		isRuntimeUndefined(value)
	) {
		return true;
	}
	if (isRuntimeNumber(value)) return Number.isFinite(value);
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
	if (!Array.isArray(value) && !isCodemodeObject(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Object.values(value).every((item) => isCodemodeValueAt(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.byteLength; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function encodeCodemodeValue<Value>(value: Value): EncodedBinary | Value {
	if (value instanceof Uint8Array) {
		return { [BINARY_TAG]: "Uint8Array", data: bytesToBase64(value) };
	}
	if (value instanceof ArrayBuffer) {
		return {
			[BINARY_TAG]: "ArrayBuffer",
			data: bytesToBase64(new Uint8Array(value)),
		};
	}
	if (ArrayBuffer.isView(value)) {
		const view = value;
		return {
			[BINARY_TAG]: "ArrayBufferView",
			data: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
		};
	}
	return value;
}

export function decodeCodemodeValue<Value>(value: Value): ArrayBuffer | Uint8Array | Value {
	if (!value || !isRuntimeObject(value) || !Object.hasOwn(value, BINARY_TAG)) {
		return value;
	}
	if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "data")) return value;
	const tag: unknown = Object.getOwnPropertyDescriptor(value, BINARY_TAG)?.value;
	const data: unknown = Object.getOwnPropertyDescriptor(value, "data")?.value;
	if ((tag !== "ArrayBuffer" && tag !== "ArrayBufferView" && tag !== "Uint8Array") || !isRuntimeString(data)) {
		throw new TypeError("Code Mode binary envelope is invalid");
	}
	const bytes = base64ToBytes(data);
	if (tag === "ArrayBuffer") {
		return bytes.slice().buffer;
	}
	return bytes;
}

export function stringifyForCodemode<Value>(value: Value): string {
	if (!isCodemodeValue(value)) throw new TypeError("Code Mode transport value is not serializable");
	return JSON.stringify(value, (_key, nested) => encodeCodemodeValue(nested));
}

export function parseForCodemode(json: string): CodemodeValue {
	const value = JSON.parse(json, (_key, nested) => decodeCodemodeValue(nested));
	if (!isCodemodeValue(value)) throw new TypeError("Code Mode transport value is invalid");
	return value;
}

// ---------------------------------------------------------------------------
// Storage codec — binary + bigint, for the runtime's SQLite columns.
// ---------------------------------------------------------------------------

/**
 * Serialize a value for durable storage. Returns `undefined` when the value is
 * `undefined` (callers store SQL NULL — distinguishing "no value" from a
 * recorded `null`, which serializes to the string `"null"`).
 *
 * Throws on values JSON cannot represent even with the codec (e.g. cycles):
 * a durable replay log cannot faithfully store such a value, and silently
 * storing an approximation would corrupt replay.
 */
export function stringifyForStorage<Value>(value: Value): string | undefined {
	if (value === undefined) return undefined;
	if (!isCodemodeValue(value)) throw new TypeError("Code Mode storage value is not serializable");
	return JSON.stringify(value, (_key, nested) => {
		if (isRuntimeBigInt(nested)) {
			return { [BIGINT_TAG]: nested.toString() };
		}
		return encodeCodemodeValue(nested);
	});
}

export function parseForStorage(json: string | null): CodemodeValue {
	if (json === null) return undefined;
	const value = JSON.parse(json, (_key, nested) => {
		const isBigIntEnvelope =
			nested && isRuntimeObject(nested) && Object.hasOwn(nested, BIGINT_TAG) && Object.keys(nested).length === 1;
		const encodedBigInt = isBigIntEnvelope ? nested[BIGINT_TAG] : undefined;
		if (isBigIntEnvelope && isRuntimeString(encodedBigInt) && /^-?(?:0|[1-9]\d*)$/u.test(encodedBigInt)) {
			return BigInt(encodedBigInt);
		}
		if (isBigIntEnvelope) throw new TypeError("Code Mode bigint envelope is invalid");
		return decodeCodemodeValue(nested);
	});
	if (!isCodemodeValue(value)) throw new TypeError("Code Mode storage value is invalid");
	return value;
}
