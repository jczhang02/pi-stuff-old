import { expect, test } from "bun:test";
import { summarizePtyObservations } from "../../../scripts/pty-observation.js";

test("continuous observation retains a stalled frame and capture uncertainty", () => {
	const observations = [
		{ captureStartedMs: 0, capturedMs: 2, spinner: "A" },
		{ captureStartedMs: 10, capturedMs: 12, spinner: "A" },
		{ captureStartedMs: 500, capturedMs: 502, spinner: "B" },
		{ captureStartedMs: 510, capturedMs: 512, spinner: "B" },
	];
	expect(summarizePtyObservations(observations)).toEqual({
		captureCount: 4,
		durationMs: 512,
		maximumCaptureMs: 2,
		maximumObservationGapMs: 490,
		maximumSpinnerAbsenceMs: 0,
		maximumSpinnerFrameMs: 502,
		spinnerChanges: 1,
	});
	expect(summarizePtyObservations(observations.slice(2)).maximumSpinnerFrameMs).toBe(12);
});

test("missing and invalid observations cannot masquerade as continuous evidence", () => {
	expect(() => summarizePtyObservations([])).toThrow("empty");
	expect(() => summarizePtyObservations([{ captureStartedMs: 0, capturedMs: Number.NaN }])).toThrow("invalid");
	expect(() =>
		summarizePtyObservations([
			{ captureStartedMs: 0, capturedMs: 2 },
			{ captureStartedMs: 1, capturedMs: 3 },
		]),
	).toThrow("overlap");
	expect(
		summarizePtyObservations([
			{ captureStartedMs: 0, capturedMs: 2, spinner: "A" },
			{ captureStartedMs: 10, capturedMs: 12 },
			{ captureStartedMs: 20, capturedMs: 22, spinner: "B" },
		]).maximumSpinnerAbsenceMs,
	).toBe(22);
});
