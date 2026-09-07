/** Publish finalized launch recovery records without loading recovery-input validation. */

import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import type { BackgroundRecoveryDescriptor } from "./resolved-task.ts";

export function persistRecoveries(asyncDir: string, recoveries: BackgroundRecoveryDescriptor[]): void {
	if (recoveries.length === 1) {
		const recovery = recoveries[0];
		if (!recovery) throw new Error("Background recovery descriptor is missing.");
		writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recovery);
		return;
	}
	writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptors.json"), {
		version: 2,
		children: recoveries,
	});
}
