import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Host-only control: no Magic or Suite lifecycle handlers. */
export default function cancellationControl(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event) => {
		if (event.reason !== "overflow") return { cancel: true };
		if (!event.signal.aborted) {
			await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
		}
		return { cancel: true };
	});
}
