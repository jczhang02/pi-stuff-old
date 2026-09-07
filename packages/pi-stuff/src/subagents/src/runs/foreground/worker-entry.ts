/** Execute one foreground run off the UI thread, retaining its Pi process owner. */
import { isMainThread } from "node:worker_threads";
import type { AsyncStatus } from "../../shared/types.ts";
import type { BackgroundRunnerStatus } from "../background/initial-status.ts";
import { runConfiguredBackground } from "../background/subagent-runner.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";

export interface ForegroundWorkerRequest {
	readonly ownerPid: number;
	readonly config: BackgroundRunnerConfig;
	readonly committedStatus: BackgroundRunnerStatus | undefined;
}

export type ForegroundWorkerMessage =
	| { readonly type: "status"; readonly status: AsyncStatus }
	| { readonly type: "complete" }
	| { readonly type: "error"; readonly message: string };

function send(message: ForegroundWorkerMessage): void {
	postMessage(message);
}

addEventListener(
	"message",
	async (event: MessageEvent<ForegroundWorkerRequest>) => {
		try {
			const { ownerPid, config, committedStatus } = event.data;
			if (isMainThread || ownerPid !== process.pid) throw new Error("Foreground Worker lost its Pi process owner.");
			await runConfiguredBackground(
				config,
				{ afterStatusUpdate: (status) => send({ type: "status", status }) },
				committedStatus,
			);
			send({ type: "complete" });
		} catch (error) {
			send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	},
	{ once: true },
);
