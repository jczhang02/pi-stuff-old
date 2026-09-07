import { isRuntimeBigInt, isRuntimeObject } from "../../shared/runtime-type.ts";
import type { CodemodeValue } from "./codec.ts";
/**
 * Deterministic JSON of a value: object keys sorted recursively, BigInt tagged.
 * Used to compare a replayed call's args against the recorded args. Best-effort
 * — returns `undefined` if the value can't be serialized (e.g. a cycle), in
 * which case the caller skips the args check rather than reporting a false
 * divergence.
 */
export function stableStringify(value: CodemodeValue): string | undefined {
	try {
		return JSON.stringify(value, (_key, val) => {
			if (isRuntimeBigInt(val)) return `__bigint__:${val.toString()}`;
			if (val && isRuntimeObject(val) && !Array.isArray(val)) {
				return Object.fromEntries(
					Object.entries(val).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
				);
			}
			return val;
		});
	} catch {
		return undefined;
	}
}
