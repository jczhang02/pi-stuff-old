import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function writeEvaluationProfile(
	home: string,
	packageDirectory: string,
	observerPath: string,
): Promise<void> {
	const agentDirectory = join(home, ".pi", "agent");
	await mkdir(agentDirectory, { recursive: true });
	await mkdir(join(agentDirectory, "agents"), { recursive: true });
	await mkdir(join(home, ".config", "cortexkit"), { recursive: true });
	await Bun.write(
		join(agentDirectory, "settings.json"),
		`${JSON.stringify(
			{
				defaultProvider: "openai-codex",
				defaultModel: "gpt-5.6-luna",
				defaultThinkingLevel: "max",
				extensions: [observerPath],
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		join(agentDirectory, "pi-stuff.json"),
		JSON.stringify({
			sessionNaming: {
				schemaVersion: 1,
				enabled: true,
				cooldownMinutes: 10,
				respectManualName: false,
				model: "openai-codex/gpt-5.6-luna",
				fallbackModels: [],
			},
		}),
	);
	await Bun.write(
		join(home, ".config", "cortexkit", "magic-context.jsonc"),
		`${JSON.stringify(
			{
				enabled: true,
				fail_closed_blocking: false,
				toast_duration_ms: 0,
				todowrite: { enabled: false, overlay: false },
				memory: { enabled: true, auto_search: { enabled: true } },
				historian: { pi: { model: "openai-codex/gpt-5.6-luna", thinking_level: "max", fallback_models: [] } },
				dreamer: { pi: { model: "openai-codex/gpt-5.6-luna", thinking_level: "max", fallback_models: [] } },
				sidekick: { model: "openai-codex/gpt-5.6-luna", thinking_level: "max", fallback_models: [] },
				embedding: { provider: "off" },
				pi: { subagent_extensions: [join(packageDirectory, "index.ts"), observerPath] },
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		join(agentDirectory, "agents", "default.md"),
		`---\nname: default\ndescription: General-purpose delegated work\nmodel: openai-codex/gpt-5.6-luna\nthinking: max\nextensions: ${observerPath}\n---\nComplete the assigned task and report the result with relevant evidence.\n`,
	);
}
