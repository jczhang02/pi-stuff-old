import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, EXTRA_AGENT_DIRS_ENV } from "../../../packages/pi-stuff/src/subagents/src/agents/agents.ts";

const roots: string[] = [];
const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
const originalExtraDirs = process.env[EXTRA_AGENT_DIRS_ENV];

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	if (originalExtraDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
	else process.env[EXTRA_AGENT_DIRS_ENV] = originalExtraDirs;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-agent-definitions-"));
	roots.push(root);
	return root;
}

async function writeAgent(directory: string, name: string, description: string, extraFrontmatter = ""): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\nPrompt for ${description}.\n`,
	);
}

test("uses package < user < project precedence without a settings override layer", async () => {
	const root = await temporaryRoot();
	const user = join(root, "user");
	const project = join(root, "project");
	const nested = join(project, "src", "feature");
	const projectAgents = join(project, ".pi", "agents");
	const installedPackage = join(root, "sample-agents");
	process.env["PI_CODING_AGENT_DIR"] = user;

	await Promise.all([
		mkdir(nested, { recursive: true }),
		writeAgent(join(user, "agents"), "shared", "user definition"),
		writeAgent(projectAgents, "shared", "project definition"),
		writeAgent(join(installedPackage, "agent-definitions"), "shared", "package definition"),
		writeAgent(join(installedPackage, "agent-definitions"), "package-only", "package-only definition"),
	]);
	await writeFile(
		join(installedPackage, "package.json"),
		`${JSON.stringify({ name: "sample-agents", pi: { agents: ["./agent-definitions"] } })}\n`,
	);
	await writeFile(
		join(user, "settings.json"),
		`${JSON.stringify({
			packages: [`file:${installedPackage}`],
			subagents: { defaultModel: "ignored/model", disableBuiltins: true },
		})}\n`,
	);

	const both = (await discoverAgents(nested, "both")).agents;
	expect(both.find(({ name }) => name === "shared")).toMatchObject({
		description: "project definition",
		source: "project",
	});
	expect(both.find(({ name }) => name === "package-only")?.source).toBe("package");
	expect(new Set(both.map(({ source }) => source))).toEqual(new Set(["package", "project"]));

	const userOnly = (await discoverAgents(nested, "user")).agents;
	expect(userOnly.find(({ name }) => name === "shared")?.description).toBe("user definition");
	expect(userOnly.find(({ name }) => name === "package-only")?.source).toBe("package");
});

test("loads settings scan roots by scope while fixed Agent directories retain precedence", async () => {
	const root = await temporaryRoot();
	const user = join(root, "user");
	const project = join(root, "project");
	const nested = join(project, "src", "feature");
	const userFlows = join(root, "user-flows");
	const projectFlows = join(root, "project-flows");
	process.env["PI_CODING_AGENT_DIR"] = user;

	await Promise.all([
		mkdir(nested, { recursive: true }),
		mkdir(join(project, ".git"), { recursive: true }),
		writeAgent(join(userFlows, "one", "agents"), "shared", "user scanned"),
		writeAgent(join(userFlows, "one", "agents"), "user-scan", "user scan only"),
		writeAgent(join(user, "agents"), "shared", "user fixed"),
		writeAgent(join(projectFlows, "one", "agents"), "shared", "project scanned"),
		writeAgent(join(projectFlows, "one", "agents"), "project-scan", "project scan only"),
		writeAgent(join(project, ".pi", "agents"), "shared", "project fixed"),
	]);
	await Promise.all([
		writeFile(
			join(user, "settings.json"),
			`${JSON.stringify({ subagents: { agentScanDirs: [join(userFlows, "*", "agents")] } })}\n`,
		),
		writeFile(
			join(project, ".pi", "settings.json"),
			`${JSON.stringify({ subagents: { agentScanDirs: [join(projectFlows, "*", "agents")] } })}\n`,
		),
	]);

	const both = (await discoverAgents(nested, "both")).agents;
	expect(both.find(({ name }) => name === "shared")?.description).toBe("project fixed");
	expect(both.some(({ name }) => name === "user-scan")).toBeTrue();
	expect(both.some(({ name }) => name === "project-scan")).toBeTrue();

	const userOnly = (await discoverAgents(nested, "user")).agents;
	expect(userOnly.find(({ name }) => name === "shared")?.description).toBe("user fixed");
	expect(userOnly.some(({ name }) => name === "user-scan")).toBeTrue();
	expect(userOnly.some(({ name }) => name === "project-scan")).toBeFalse();

	const projectOnly = (await discoverAgents(nested, "project")).agents;
	expect(projectOnly.find(({ name }) => name === "shared")?.description).toBe("project fixed");
	expect(projectOnly.some(({ name }) => name === "project-scan")).toBeTrue();
	expect(projectOnly.some(({ name }) => name === "user-scan")).toBeFalse();
});

test("follows symlinked Agent directories once without recursing through cycles", async () => {
	const root = await temporaryRoot();
	const user = join(root, "user");
	const fixedRoot = join(user, "agents");
	const shared = join(root, "shared-agents");
	const linked = join(fixedRoot, "linked");
	process.env["PI_CODING_AGENT_DIR"] = user;
	await Promise.all([mkdir(fixedRoot, { recursive: true }), writeAgent(shared, "linked-agent", "linked Agent")]);
	const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
	await symlink(shared, linked, directoryLinkType);
	await symlink(shared, join(shared, "loop"), directoryLinkType);

	const agents = (await discoverAgents(root, "user")).agents;
	expect(agents.filter(({ name }) => name === "linked-agent")).toHaveLength(1);
	expect(agents.find(({ name }) => name === "linked-agent")?.filePath).toBe(join(linked, "linked-agent.md"));
});

test("parses only current execution controls and skips one malformed definition locally", async () => {
	const root = await temporaryRoot();
	const user = join(root, "user");
	process.env["PI_CODING_AGENT_DIR"] = user;
	await writeAgent(
		join(user, "agents"),
		"configured",
		"configured Agent",
		[
			"model: provider/model",
			"fallbackModels: provider/one, provider/two",
			"thinking: high",
			"tools: read, bash, mcp:browser/open",
			"excludeTools: write, made-up-tool",
			"systemPromptMode: replace",
			"inheritProjectContext: false",
			"inheritSkills: false",
			"skills: research, review",
			'turnBudget: {"maxTurns":4,"graceTurns":1}',
			'toolBudget: {"soft":6,"hard":8,"block":["read"]}',
			"toolTimeoutMs: 1200",
			"maxSubagentDepth: 2",
			"defaultAsync: true",
			"defaultTimeoutMs: 30000",
			"completionGuard: true",
			'memory: {"scope":"project","path":"retired"}',
			"output: retired.md",
			"",
		].join("\n"),
	);
	await writeAgent(join(user, "agents"), "broken", "broken Agent", "inheritSkills: maybe\n");

	const agents = (await discoverAgents(root, "user")).agents;
	expect(agents.some(({ name }) => name === "broken")).toBeFalse();
	const configured = agents.find(({ name }) => name === "configured");
	expect(configured).toMatchObject({
		fallbackModels: ["provider/one", "provider/two"],
		excludeTools: ["write", "made-up-tool"],
		inheritProjectContext: false,
		inheritSkills: false,
		maxSubagentDepth: 2,
		mcpDirectTools: ["browser/open"],
		model: "provider/model",
		skills: ["research", "review"],
		systemPromptMode: "replace",
		thinking: "high",
		toolBudget: { block: ["read"], hard: 8, soft: 6 },
		toolTimeoutMs: 1200,
		tools: ["read", "bash"],
	});
	for (const retiredField of [
		"defaultAsync",
		"defaultTimeoutMs",
		"defaultTurnBudget",
		"completionGuard",
		"memory",
		"output",
	]) {
		expect(configured).not.toHaveProperty(retiredField);
	}
});

test("supports explicitly installed file Packages but ignores the retired .agents convention", async () => {
	const root = await temporaryRoot();
	const user = join(root, "user");
	const project = join(root, "project");
	const installed = join(root, "installed-agent-package");
	process.env["PI_CODING_AGENT_DIR"] = user;
	await Promise.all([
		mkdir(join(project, ".git"), { recursive: true }),
		mkdir(join(project, ".pi", "agents"), { recursive: true }),
		writeAgent(join(project, ".agents"), "legacy", "retired convention"),
		writeAgent(join(installed, "agents"), "installed", "installed Package"),
		mkdir(user, { recursive: true }),
	]);
	await writeFile(
		join(project, ".pi", "agents", "retired.chain.md"),
		"---\nname: retired-chain\ndescription: retired chain definition\n---\n\nDo not discover this file.\n",
	);
	await writeFile(
		join(installed, "package.json"),
		`${JSON.stringify({ name: "installed-agent-package", pi: { agents: ["./agents"] } })}\n`,
	);
	await writeFile(join(user, "settings.json"), `${JSON.stringify({ packages: [`file:${installed}`] })}\n`);

	const agents = (await discoverAgents(project, "both")).agents;
	expect(agents.find(({ name }) => name === "installed")?.source).toBe("package");
	expect(agents.some(({ name }) => name === "legacy")).toBeFalse();
	expect(agents.some(({ name }) => name === "retired-chain")).toBeFalse();
});
