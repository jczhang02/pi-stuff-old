import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function smokePackage(pi: ExtensionAPI): void {
	pi.registerCommand("pi-stuff-package-smoke", {
		description: "Expose an observable command for Package-loader tests",
		handler: () => Promise.resolve(),
	});
}
