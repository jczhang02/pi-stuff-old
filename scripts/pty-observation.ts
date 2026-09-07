export interface PtyObservation {
	readonly captureStartedMs: number;
	readonly capturedMs: number;
	readonly spinner?: string;
}

export function summarizePtyObservations(observations: readonly PtyObservation[]) {
	const first = observations[0];
	if (!first) throw new Error("Continuous PTY observation is empty");
	const summary = {
		captureCount: observations.length,
		durationMs: 0,
		maximumCaptureMs: 0,
		maximumObservationGapMs: 0,
		maximumSpinnerAbsenceMs: 0,
		maximumSpinnerFrameMs: 0,
		spinnerChanges: 0,
	};
	let previous: PtyObservation | undefined;
	let runStartedMs = first.captureStartedMs;
	const closeRun = (endMs: number): void => {
		const duration = endMs - runStartedMs;
		if (previous?.spinner) summary.maximumSpinnerFrameMs = Math.max(summary.maximumSpinnerFrameMs, duration);
		else summary.maximumSpinnerAbsenceMs = Math.max(summary.maximumSpinnerAbsenceMs, duration);
	};
	for (const observation of observations) {
		if (
			!Number.isFinite(observation.captureStartedMs) ||
			!Number.isFinite(observation.capturedMs) ||
			observation.capturedMs < observation.captureStartedMs ||
			(previous && observation.captureStartedMs < previous.capturedMs)
		) {
			throw new Error("Continuous PTY capture timestamps are invalid or overlap");
		}
		summary.maximumCaptureMs = Math.max(
			summary.maximumCaptureMs,
			observation.capturedMs - observation.captureStartedMs,
		);
		if (previous) {
			summary.maximumObservationGapMs = Math.max(
				summary.maximumObservationGapMs,
				observation.capturedMs - previous.capturedMs,
			);
			if (observation.spinner !== previous.spinner) {
				closeRun(observation.capturedMs);
				if (observation.spinner && previous.spinner) summary.spinnerChanges += 1;
				// The change happened after the previous capture began, not necessarily at this capture.
				runStartedMs = previous.captureStartedMs;
			}
		}
		previous = observation;
	}
	if (previous) {
		closeRun(previous.capturedMs);
		summary.durationMs = previous.capturedMs - first.captureStartedMs;
	}
	return summary;
}
