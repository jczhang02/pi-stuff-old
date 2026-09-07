import { expect, test } from "bun:test";
import agentsConfig from "../../../config/typescript/agents.json" with { type: "json" };
import agentsTestsConfig from "../../../config/typescript/agents-tests.json" with { type: "json" };
import rtkConfig from "../../../config/typescript/rtk.json" with { type: "json" };
import packageManifest from "../../../package.json" with { type: "json" };
import packageConfig from "../../../packages/pi-stuff/tsconfig.json" with { type: "json" };
import rootConfig from "../../../tsconfig.json" with { type: "json" };

test("runs every TypeScript profile in one build process with isolated incremental state", () => {
	expect(packageManifest.scripts.typecheck).toBe(
		"tsc -b tsconfig.json config/typescript/rtk.json config/typescript/agents.json config/typescript/agents-tests.json packages/pi-stuff/tsconfig.json --pretty false",
	);
	for (const [config, buildInfo] of [
		[rootConfig, "node_modules/.cache/pi-stuff/typecheck/root.tsbuildinfo"],
		[rtkConfig, "../../node_modules/.cache/pi-stuff/typecheck/rtk.tsbuildinfo"],
		[agentsConfig, "../../node_modules/.cache/pi-stuff/typecheck/agents.tsbuildinfo"],
		[agentsTestsConfig, "../../node_modules/.cache/pi-stuff/typecheck/agents-tests.tsbuildinfo"],
		[packageConfig, "../../node_modules/.cache/pi-stuff/typecheck/package.tsbuildinfo"],
	] as const) {
		expect(config).toHaveProperty("compilerOptions.incremental", true);
		expect(config).toHaveProperty("compilerOptions.tsBuildInfoFile", buildInfo);
	}
});
