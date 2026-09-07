import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseResponsivenessGates } from "../../../scripts/responsiveness-gates.ts";

const gates = {
	hostBinarySha256: "a".repeat(64),
	maximumObservationGapMs: 40,
	maximumActiveSpinnerAbsenceMs: 0,
	spinnerMs: 200,
	startupInputMs: 150,
	steadyInputMs: 150,
	selectionMs: 150,
};

test("accepts calibrated limits only for the exact observed Host binary", () => {
	expect(parseResponsivenessGates(JSON.stringify(gates), gates.hostBinarySha256)).toEqual(gates);
	expect(() => parseResponsivenessGates(JSON.stringify(gates), "b".repeat(64))).toThrow(
		"do not match the observed Host binary",
	);
});

test("historical Pi 0.85.0 gates cannot certify a different Host", async () => {
	const historical = await readFile("docs/reports/suite-responsiveness-gates-2026-09-05.json", "utf8");
	expect(() => parseResponsivenessGates(historical, gates.hostBinarySha256)).toThrow(
		"do not match the observed Host binary",
	);
});

test.each([
	{ hostBinarySha256: "invalid" },
	{ spinnerMs: -1 },
	{ selectionMs: "150" },
	{ maximumObservationGapMs: null },
])("rejects malformed limits %j", (invalid) => {
	expect(() => parseResponsivenessGates(JSON.stringify({ ...gates, ...invalid }), gates.hostBinarySha256)).toThrow(
		"Invalid responsiveness gates",
	);
});
