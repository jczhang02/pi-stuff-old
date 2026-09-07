import assert from "node:assert/strict";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.ts";

const LIMITS_SCHEMA = Type.Object({
	hostBinarySha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	maximumObservationGapMs: Type.Number({ minimum: 0 }),
	maximumActiveSpinnerAbsenceMs: Type.Number({ minimum: 0 }),
	spinnerMs: Type.Number({ minimum: 0 }),
	startupInputMs: Type.Number({ minimum: 0 }),
	steadyInputMs: Type.Number({ minimum: 0 }),
	selectionMs: Type.Number({ minimum: 0 }),
});

export function parseResponsivenessGates(text: string, hostBinarySha256: string) {
	const limits = parseJsonValue(text);
	assert(Check(LIMITS_SCHEMA, limits), "Invalid responsiveness gates");
	assert.equal(
		limits.hostBinarySha256,
		hostBinarySha256,
		"Responsiveness gates do not match the observed Host binary; calibrate its native baseline first",
	);
	return limits;
}
