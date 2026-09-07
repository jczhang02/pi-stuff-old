import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piStuffRtk from "../../../packages/pi-stuff/src/rtk/index.js";
import { createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionCommandContext } from "../../fixtures/extension-context.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const originalAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (originalAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDirectory;
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

test("registers one /rtk surface and rejects the removed subcommands", async () => {
	const agentDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-extension-"));
	temporaryDirectories.push(agentDirectory);
	process.env["PI_CODING_AGENT_DIR"] = agentDirectory;
	const commands = new Map<string, Command>();
	await piStuffRtk(
		createExtensionApi({
			registerCommand: (name, command) => commands.set(name, command),
		}),
	);

	expect([...commands.keys()]).toEqual(["rtk"]);
	const notices: string[] = [];
	const context = createExtensionCommandContext({
		ui: { notify: (message) => notices.push(message) },
	});
	const command = commands.get("rtk");
	if (!command) throw new Error("missing /rtk command");
	for (const action of ["status", "settings", "verify", "stats", "clear-stats", "help"]) {
		await command.handler(action, context);
	}
	expect(notices).toEqual(Array.from({ length: 6 }, () => "/rtk takes no subcommands; run /rtk."));
});
