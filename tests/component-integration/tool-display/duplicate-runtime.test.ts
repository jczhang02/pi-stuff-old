import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ToolUiRuntimeHost } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { ToolUiSettingsStore } from "../../../packages/pi-stuff/src/tool-display/settings.js";

type ContractModule = typeof import("../../../packages/pi-stuff/src/tool-display/contract.js");

test("physical Tool Display Module copies share one runtime through the stable global registry", async () => {
	const directory = mkdtempSync(join(process.cwd(), ".pi-stuff-tools-duplicates-"));
	const source = join(process.cwd(), "packages/pi-stuff/src/tool-display");
	const firstPath = join(directory, "first", "src", "tool-display");
	const secondPath = join(directory, "second", "src", "tool-display");
	for (const copy of [firstPath, secondPath]) {
		mkdirSync(copy, { recursive: true });
		cpSync(source, copy, { recursive: true });
		symlinkSync(
			join(process.cwd(), "packages/pi-stuff/src/conversation-ui"),
			join(copy, "..", "conversation-ui"),
			"dir",
		);
		symlinkSync(join(process.cwd(), "packages/pi-stuff/src/shared"), join(copy, "..", "shared"), "dir");
	}
	try {
		// SAFETY: this test controls the value and supplies every ContractModule member exercised by this case.
		const first = (await import(pathToFileURL(join(firstPath, "contract.ts")).href)) as ContractModule;
		// SAFETY: this test controls the value and supplies every ContractModule member exercised by this case.
		const second = (await import(pathToFileURL(join(secondPath, "contract.ts")).href)) as ContractModule;
		const api = { events: createEventBus(), on: () => undefined } satisfies ToolUiRuntimeHost;
		const beforeInstall = first.getToolUiRuntime(api);
		const afterInstall = second.installToolUiRuntime(
			api,
			ToolUiSettingsStore.memory({ liveElapsed: false, schemaVersion: 1 }),
		);

		expect(afterInstall).toBe(beforeInstall);
		expect(second.getToolUiRuntime(api)).toBe(beforeInstall);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
