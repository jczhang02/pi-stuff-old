import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionRootDependencies } from "./src/extension/index.ts";
import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";

export default async function registerSubagents(
	pi: ExtensionAPI,
	overrides: Partial<ExtensionRootDependencies> = {},
): Promise<void> {
	if (overrides.isChildProcess === undefined && process.env[SUBAGENT_CHILD_ENV] === "1") return;
	const { default: registerRoot } = await import("./src/extension/index.ts");
	registerRoot(pi, overrides);
}
