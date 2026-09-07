import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MagicWorkerMessage } from "../../packages/pi-stuff/src/context-management/magic-worker-protocol.js";
import { isRuntimeObject } from "../../packages/pi-stuff/src/shared/runtime-type.js";

/** Fault injection around the real Worker; the Suite and engine code remain unchanged. */
export default function recoveryFault(pi: ExtensionAPI): void {
	const mode = process.env["PI_STUFF_CONTEXT_RECOVERY_MODE"];
	if (mode !== "worker-crash" && mode !== "lost-ack" && mode !== "uncertain-ack") return;
	const NativeWorker = globalThis.Worker;
	let injected = false;
	const record = (type: string): void => {
		const log = process.env["PI_STUFF_CONTEXT_PTY_LOG"];
		if (log) appendFileSync(log, `${JSON.stringify({ type })}\n`);
	};
	globalThis.Worker = class extends NativeWorker {
		constructor(...args: ConstructorParameters<typeof NativeWorker>) {
			super(...args);
			if (args[1]?.name !== "pi-stuff-magic-context") return;
			record("worker-start");
			const post = this.postMessage.bind(this);
			this.postMessage = (message, options) => {
				if (
					!injected &&
					mode === "worker-crash" &&
					isRuntimeObject(message) &&
					message !== null &&
					"type" in message &&
					message.type === "event" &&
					"name" in message &&
					message.name === "session_before_compact"
				) {
					injected = true;
					record("worker-crash");
					void this.terminate();
					return;
				}
				if (Array.isArray(options)) post(message, options);
				else post(message, options);
			};
			this.addEventListener(
				"message",
				(event: MessageEvent<MagicWorkerMessage>) => {
					const message = event.data;
					if (
						!injected &&
						(mode === "lost-ack" || mode === "uncertain-ack") &&
						message.type === "event-result" &&
						message.result.event === "session_before_compact" &&
						message.result.result?.compaction
					) {
						injected = true;
						event.stopImmediatePropagation();
						record("lost-compaction-ack");
						if (mode === "uncertain-ack") {
							const root = process.env["MAGIC_CONTEXT_TEST_DATA_DIR"];
							if (!root) throw new Error("Missing isolated Magic data directory.");
							const db = new Database(join(root, "cortexkit/magic-context/context.db"));
							try {
								db.run(
									"UPDATE session_meta SET pending_pi_compaction_marker_state = '{' WHERE pending_pi_compaction_marker_state IS NOT NULL",
								);
							} finally {
								db.close();
							}
						}
						void this.terminate();
					}
				},
				{ capture: true },
			);
		}
	};
	pi.on("session_shutdown", () => {
		globalThis.Worker = NativeWorker;
	});
}
