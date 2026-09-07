import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as runtimeConfig from "../../../packages/pi-stuff/src/web/runtime/config.js";
import piWebAccess, {
	type PiWebAccessHost,
	type WebRuntimeEffectOptions,
} from "../../../packages/pi-stuff/src/web/runtime/implementation.js";
import { loadSsrfConfig } from "../../../packages/pi-stuff/src/web/runtime/ssrf-protection.js";
import { WebSettingsStore } from "../../../packages/pi-stuff/src/web/settings.js";

const roots: string[] = [];
const originalAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
type CapturedTool = Parameters<PiWebAccessHost["registerTool"]>[0];

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "pi-stuff-web-config-"));
	roots.push(value);
	return value;
}

afterEach(async () => {
	if (originalAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDirectory;
	await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

async function installWeb(
	agentDirectory: string,
): Promise<{ definitions: Map<string, CapturedTool>; settings: WebSettingsStore; tools: string[] }> {
	process.env["PI_CODING_AGENT_DIR"] = agentDirectory;
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDirectory));
	const tools: string[] = [];
	const definitions = new Map<string, CapturedTool>();
	const host: PiWebAccessHost = {
		appendEntry: () => undefined,
		on: () => undefined,
		registerTool: (tool) => {
			tools.push(tool.name);
			// SAFETY: the fixture stores the complete Tool object and erases only its schema-specific generic parameters.
			definitions.set(tool.name, tool as CapturedTool);
		},
	};
	const effects: WebRuntimeEffectOptions = {
		prepareFetch: () => Effect.void,
		readSettings: () => settings.get(),
		runContentOperation: async (_ctx, program, handlers, signal) =>
			handlers.success(await Effect.runPromise(program, { signal })),
	};
	piWebAccess(host, effects);
	return { definitions, settings, tools };
}

test("Web configuration stays read-only until an explicit update", async () => {
	const agentDir = await root();
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	expect(settings.get()).toEqual({});
	expect(await Bun.file(join(agentDir, "pi-stuff.json")).exists()).toBe(false);
});

test("invalid Web configuration diagnoses and keeps strict built-in defaults active", async () => {
	const agentDir = await root();
	await writeFile(join(agentDir, "pi-stuff.json"), "{");
	expect((await installWeb(agentDir)).tools).toEqual(["web_search", "fetch_content", "get_search_content"]);
	expect(runtimeConfig.readWebConfig()).toEqual({});
	expect(loadSsrfConfig()).toEqual({ allowRanges: [], trustEnvProxy: false });
});

test("invalid stored SSRF fields fail closed", async () => {
	const agentDir = await root();
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await writeFile(join(agentDir, "pi-stuff.json"), JSON.stringify({ web: { ssrf: { allowRanges: "private" } } }));
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	expect(() => runtimeConfig.withWebConfigSnapshot(settings.get(), loadSsrfConfig)).toThrow("ssrf.allowRanges");
});

test("the installed search Tool reaches the deferred provider runtime", async () => {
	const agentDir = await root();
	const { definitions, settings } = await installWeb(agentDir);
	await Effect.runPromise(settings.update({ tavilyApiKey: "$$tavily-secret" }));
	const tool = definitions.get("web_search");
	if (!tool) throw new Error("web_search was not registered");
	const originalFetch = globalThis.fetch;
	const fetchMock = async (..._arguments: Parameters<typeof fetch>): ReturnType<typeof fetch> =>
		Response.json({
			answer: "Deferred provider loaded",
			results: [{ content: "source", title: "Lazy", url: "https://example.com/lazy" }],
		});
	// SAFETY: this provider test exercises only fetch's request/response signature; preconnect is never used.
	globalThis.fetch = fetchMock as typeof fetch;
	try {
		// SAFETY: the captured Tool owns the exact schema; this fixture supplies only its bounded public fields.
		const result = await tool.execute(
			"lazy-search",
			{ provider: "tavily", query: "lazy provider" } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(JSON.stringify(result)).toContain("https://example.com/lazy");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Web configuration I/O failures propagate during initialization", async () => {
	const agentDir = await root();
	await mkdir(join(agentDir, "pi-stuff.json"));
	await expect(installWeb(agentDir)).rejects.toThrow();
});

test("explicit update lifts legacy Web configuration and preserves sibling namespaces", async () => {
	const agentDir = await root();
	const legacyPath = join(agentDir, "web-search.json");
	await writeFile(legacyPath, JSON.stringify({ parallelApiKey: "op://Private/Parallel/key", provider: "parallel" }));
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	expect(settings.get()["parallelApiKey"]).toBe("op://Private/Parallel/key");
	await writeFile(join(agentDir, "pi-stuff.json"), JSON.stringify({ ui: { statusline: true } }));
	await Effect.runPromise(settings.update({ searchModel: "model-a" }));
	expect(JSON.parse(await readFile(join(agentDir, "pi-stuff.json"), "utf8"))).toEqual({
		ui: { statusline: true },
		web: { parallelApiKey: "op://Private/Parallel/key", provider: "parallel", searchModel: "model-a" },
	});
	expect(await Bun.file(legacyPath).exists()).toBe(false);
});

test("canonical Web configuration wins and concurrent updates retain both fields", async () => {
	const agentDir = await root();
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await writeFile(join(agentDir, "pi-stuff.json"), JSON.stringify({ web: { provider: "brave" } }));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ provider: "parallel" }));
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	await runtimeConfig.withWebConfigSnapshot(settings.get(), async () => {
		expect(runtimeConfig.readWebConfig()["provider"]).toBe("brave");
		await Effect.runPromise(settings.update({ provider: "parallel" }));
		expect(runtimeConfig.readWebConfig()["provider"]).toBe("brave");
	});
	expect(settings.get()["provider"]).toBe("parallel");
	await Promise.all([
		Effect.runPromise(settings.update({ recencyFilter: "month" })),
		Effect.runPromise(settings.update({ searchModel: "model-a" })),
	]);
	expect(settings.get()).toEqual({
		provider: "parallel",
		recencyFilter: "month",
		searchModel: "model-a",
	});
	expect(await Bun.file(join(agentDir, "web-search.json")).exists()).toBe(false);
});

test("invalid canonical Web configuration never deletes legacy credentials", async () => {
	const agentDir = await root();
	await writeFile(join(agentDir, "pi-stuff.json"), JSON.stringify({ web: false }));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ parallelApiKey: "secret" }));
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	await expect(Effect.runPromise(settings.update({ provider: "parallel" }))).rejects.toThrow("not a JSON object");
	expect(await Bun.file(join(agentDir, "web-search.json")).exists()).toBe(true);
});

test("an interrupted legacy migration remains readable and resumes on the next explicit update", async () => {
	const agentDir = await root();
	const stagedPath = join(agentDir, "web-search.json.migrating");
	await writeFile(stagedPath, JSON.stringify({ provider: "parallel", parallelApiKey: "op://Private/key" }));
	const settings = await Effect.runPromise(WebSettingsStore.load(agentDir));
	expect(settings.get()["provider"]).toBe("parallel");

	await Effect.runPromise(settings.update({ workflow: "none" }));
	expect(settings.get()).toEqual({
		provider: "parallel",
		parallelApiKey: "op://Private/key",
		workflow: "none",
	});
	expect(await Bun.file(stagedPath).exists()).toBe(false);
});
