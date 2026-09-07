import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function smokeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pi-stuff-smoke", {
		description: "Expose an observable command for host-loading tests",
		handler: () => Promise.resolve(),
	});
}
