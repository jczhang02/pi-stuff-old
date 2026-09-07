import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { MAX_MODEL_CANDIDATES_PER_CHILD } from "../runs/shared/model-fallback.ts";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveToolTimeoutMs } from "../runs/shared/tool-timeout.ts";
import type { ToolBudgetConfig } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";

export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "package" | "user" | "project";
export type SystemPromptMode = "append" | "replace";

/** Runtime shape consumed by the owned child-process engine. */
export interface AgentConfig {
	readonly name: string;
	readonly localName?: string;
	readonly packageName?: string;
	readonly description: string;
	readonly tools?: string[];
	readonly excludeTools?: string[];
	readonly mcpDirectTools?: string[];
	readonly model?: string;
	readonly fallbackModels?: string[];
	readonly thinking?: string | false;
	readonly systemPromptMode: SystemPromptMode;
	readonly inheritProjectContext: boolean;
	readonly inheritSkills: boolean;
	readonly systemPrompt: string;
	readonly source: AgentSource;
	readonly filePath: string;
	readonly skills?: string[];
	readonly skillPath?: string[];
	readonly extensions?: string[];
	readonly subagentOnlyExtensions?: string[];
	readonly maxSubagentDepth?: number;
	readonly toolBudget?: ToolBudgetConfig;
	readonly toolTimeoutMs?: number;
}

export interface AgentDiscoveryResult {
	readonly agents: AgentConfig[];
	readonly projectAgentsDir: string | null;
	readonly modelScope?: ModelScopeConfig;
}

export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRUNED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export function defaultSystemPromptMode(): SystemPromptMode {
	return "append";
}

export function defaultInheritProjectContext(): boolean {
	return true;
}

export function defaultInheritSkills(): boolean {
	return true;
}

export async function findNearestProjectRoot(cwd: string): Promise<string | null> {
	let current = path.resolve(cwd);
	let gitRoot: string | null = null;
	while (true) {
		const configDir = getProjectConfigDir(current);
		if (
			(await isDirectory(path.join(configDir, "agents"))) ||
			(await pathExists(path.join(configDir, "settings.json")))
		) {
			return current;
		}
		if (!gitRoot && (await pathExists(path.join(current, ".git")))) gitRoot = current;
		const parent = path.dirname(current);
		if (parent === current) return gitRoot;
		current = parent;
	}
}

export async function discoverAgents(cwd: string, scope: AgentScope): Promise<AgentDiscoveryResult> {
	const projectRoot = await findNearestProjectRoot(cwd);
	const projectAgentsDir = projectRoot ? path.join(getProjectConfigDir(projectRoot), "agents") : null;
	const includeUser = scope !== "project";
	const includeProject = scope !== "user";

	const packagePaths = await collectPackageAgentPaths(cwd, projectRoot, { includeProject, includeUser });
	const packageAgents = await loadUniqueAgents(packagePaths, "package", false);
	const userPaths = includeUser
		? [
				...extraUserAgentDirs(),
				...(await settingsAgentScanDirs(path.join(getAgentDir(), "settings.json"))),
				path.join(getAgentDir(), "agents"),
			]
		: [];
	const userAgents = await loadUniqueAgents(userPaths, "user", true);
	const projectScanDirs =
		includeProject && projectRoot
			? await settingsAgentScanDirs(path.join(getProjectConfigDir(projectRoot), "settings.json"))
			: [];
	const projectAgents =
		includeProject && projectAgentsDir
			? await loadUniqueAgents([...projectScanDirs, projectAgentsDir], "project", true)
			: [];

	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, packageAgents);
	return { agents, projectAgentsDir };
}

async function loadUniqueAgents(
	directories: readonly string[],
	source: AgentSource,
	laterWins: boolean,
): Promise<AgentConfig[]> {
	const byName = new Map<string, AgentConfig>();
	for (const directory of uniquePaths(directories)) {
		for (const agent of await loadAgentsFromDir(directory, source)) {
			if (laterWins || !byName.has(agent.name)) byName.set(agent.name, agent);
		}
	}
	return [...byName.values()];
}

async function loadAgentsFromDir(directory: string, source: AgentSource): Promise<AgentConfig[]> {
	const agents: AgentConfig[] = [];
	for (const filePath of await listAgentFiles(directory)) {
		const agent = await loadAgent(filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

async function loadAgent(filePath: string, source: AgentSource): Promise<AgentConfig | undefined> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}

	try {
		const { frontmatter, body } = parseFrontmatter(content);
		const localName = frontmatter["name"]?.trim();
		const description = frontmatter["description"]?.trim();
		if (!localName || !AGENT_NAME.test(localName) || !description || !body.trim()) return undefined;

		const parsedPackage = parsePackageName(frontmatter["package"], `Agent '${localName}' package`);
		if (parsedPackage.error) return undefined;
		const packageName = parsedPackage.packageName;
		const rawTools = parseFrontmatterList(frontmatter["tools"]);
		const { tools, mcpDirectTools } = splitTools(rawTools);
		const excludeTools = parseFrontmatterList(frontmatter["excludeTools"]);
		const fallbackModels = nonEmpty(parseFrontmatterList(frontmatter["fallbackModels"]));
		if (fallbackModels && fallbackModels.length >= MAX_MODEL_CANDIDATES_PER_CHILD) return undefined;
		const skills = nonEmpty(parseFrontmatterList(frontmatter["skill"] ?? frontmatter["skills"]));
		const skillPath = nonEmpty(parseFrontmatterList(frontmatter["skillPath"]));
		const extensions = parseFrontmatterList(frontmatter["extensions"]);
		const subagentOnlyExtensions = nonEmpty(parseFrontmatterList(frontmatter["subagentOnlyExtensions"]));

		const toolBudget = parseToolBudget(frontmatter["toolBudget"], localName);
		const toolTimeoutMs = parseToolTimeout(frontmatter["toolTimeoutMs"], localName);
		const maxSubagentDepth = optionalNonNegativeInteger(frontmatter["maxSubagentDepth"]);
		if (frontmatter["maxSubagentDepth"] !== undefined && maxSubagentDepth === undefined) return undefined;

		const systemPromptMode =
			optionalEnum(frontmatter["systemPromptMode"], ["append", "replace"] as const) ?? defaultSystemPromptMode();
		const inheritProjectContext =
			optionalBoolean(frontmatter["inheritProjectContext"]) ?? defaultInheritProjectContext();
		const inheritSkills = optionalBoolean(frontmatter["inheritSkills"]) ?? defaultInheritSkills();
		if (
			frontmatter["systemPromptMode"] !== undefined &&
			!["append", "replace"].includes(frontmatter["systemPromptMode"])
		) {
			return undefined;
		}
		if (
			frontmatter["inheritProjectContext"] !== undefined &&
			optionalBoolean(frontmatter["inheritProjectContext"]) === undefined
		) {
			return undefined;
		}
		if (frontmatter["inheritSkills"] !== undefined && optionalBoolean(frontmatter["inheritSkills"]) === undefined) {
			return undefined;
		}

		let agent: AgentConfig = {
			name: buildRuntimeName(localName, packageName),
			localName,
			description,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			systemPrompt: body.trim(),
			source,
			filePath,
		};
		if (packageName) agent = { ...agent, packageName };
		if (rawTools !== undefined) agent = { ...agent, tools };
		if (excludeTools !== undefined) agent = { ...agent, excludeTools };
		if (mcpDirectTools.length > 0) agent = { ...agent, mcpDirectTools };
		if (optionalText(frontmatter["model"])) agent = { ...agent, model: frontmatter["model"].trim() };
		if (fallbackModels) agent = { ...agent, fallbackModels };
		if (frontmatter["thinking"] === "false") agent = { ...agent, thinking: false };
		else if (optionalText(frontmatter["thinking"])) agent = { ...agent, thinking: frontmatter["thinking"].trim() };
		if (skills) agent = { ...agent, skills };
		if (skillPath) agent = { ...agent, skillPath };
		if (extensions !== undefined) agent = { ...agent, extensions };
		if (subagentOnlyExtensions) agent = { ...agent, subagentOnlyExtensions };
		if (maxSubagentDepth !== undefined) agent = { ...agent, maxSubagentDepth };
		if (toolBudget) agent = { ...agent, toolBudget };
		if (toolTimeoutMs !== undefined) agent = { ...agent, toolTimeoutMs };
		return agent;
	} catch {
		// One malformed optional Agent definition must not make the Agent tool unavailable.
		return undefined;
	}
}

function parseToolBudget(value: string | undefined, name: string): ToolBudgetConfig | undefined {
	if (!optionalText(value)) return undefined;
	const parsed = parseJsonValue(value);
	const result = validateToolBudgetConfig(parsed, `Agent '${name}' toolBudget`);
	if (result.error) throw new Error(result.error);
	return result.budget;
}

function parseToolTimeout(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const result = resolveToolTimeoutMs({ agentValue: Number(value) });
	if (result.error) throw new Error(`Agent '${name}' ${result.error}`);
	return result.toolTimeoutMs;
}

async function listAgentFiles(directory: string, visitedDirectories = new Set<string>()): Promise<string[]> {
	const files: string[] = [];
	let realDirectory: string;
	try {
		realDirectory = await fs.promises.realpath(directory);
	} catch {
		return files;
	}
	if (visitedDirectories.has(realDirectory)) return files;
	visitedDirectories.add(realDirectory);
	let entries: fs.Dirent[];
	try {
		entries = (await fs.promises.readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (PRUNED_DIRECTORY_NAMES.has(entry.name)) continue;
		const candidate = path.join(directory, entry.name);
		const directoryEntry = entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(candidate)));
		if (directoryEntry) {
			files.push(...(await listAgentFiles(candidate, visitedDirectories)));
			continue;
		}
		if (
			(entry.isFile() || entry.isSymbolicLink()) &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		) {
			files.push(candidate);
		}
	}
	return files;
}

interface PackageSearchScope {
	readonly includeProject: boolean;
	readonly includeUser: boolean;
}

async function collectPackageAgentPaths(
	cwd: string,
	projectRoot: string | null,
	scope: PackageSearchScope,
): Promise<string[]> {
	const roots: string[] = [];
	if (scope.includeProject && projectRoot) {
		const configDir = getProjectConfigDir(projectRoot);
		roots.push(projectRoot);
		roots.push(...(await packageRootsInNodeModules(path.join(configDir, "npm", "node_modules"))));
		roots.push(...(await packageRootsFromSettings(path.join(configDir, "settings.json"), configDir)));
	}
	if (scope.includeUser) {
		const agentDir = getAgentDir();
		roots.push(...(await packageRootsInNodeModules(path.join(agentDir, "npm", "node_modules"))));
		roots.push(...(await packageRootsFromSettings(path.join(agentDir, "settings.json"), agentDir)));
	}
	if (!projectRoot && scope.includeProject) roots.push(path.resolve(cwd));

	const paths: string[] = [];
	for (const root of uniquePaths(roots)) paths.push(...(await packageAgentPaths(root)));
	return paths;
}

async function packageAgentPaths(packageRoot: string): Promise<string[]> {
	const manifest = await readJson(path.join(packageRoot, "package.json"));
	if (!isRecord(manifest)) return [];
	const pi = isRecord(manifest["pi"]) ? manifest["pi"] : undefined;
	const piSubagents = isRecord(pi?.["subagents"]) ? pi["subagents"] : undefined;
	const legacy = isRecord(manifest["pi-subagents"]) ? manifest["pi-subagents"] : undefined;
	const entries = [
		...stringArray(pi?.["agents"]),
		...stringArray(piSubagents?.["agents"]),
		...stringArray(legacy?.["agents"]),
	];
	const root = path.resolve(packageRoot);
	return entries.map((entry) => path.resolve(root, entry)).filter((candidate) => isWithin(candidate, root));
}

async function packageRootsInNodeModules(nodeModules: string): Promise<string[]> {
	const roots: string[] = [];
	for (const entry of await readDirectories(nodeModules)) {
		const candidate = path.join(nodeModules, entry);
		if (!entry.startsWith("@")) {
			roots.push(candidate);
			continue;
		}
		for (const child of await readDirectories(candidate)) roots.push(path.join(candidate, child));
	}
	return roots;
}

async function packageRootsFromSettings(settingsPath: string, baseDir: string): Promise<string[]> {
	const settings = await readJson(settingsPath);
	if (!isRecord(settings) || !Array.isArray(settings["packages"])) return [];
	const roots: string[] = [];
	for (const entry of settings["packages"]) {
		const source = isRuntimeString(entry) ? entry : isRecord(entry) ? entry["source"] : undefined;
		if (!isRuntimeString(source)) continue;
		const resolved = resolvePackageSource(source, baseDir);
		if (resolved) roots.push(resolved);
	}
	return roots;
}

function resolvePackageSource(source: string, baseDir: string): string | undefined {
	const value = source.trim();
	if (!value) return undefined;
	if (value.startsWith("npm:")) {
		const packageName = npmPackageName(value.slice(4));
		return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
	}
	if (value.startsWith("git:")) {
		const gitPath = gitCachePath(value.slice(4));
		return gitPath ? path.join(baseDir, "git", ...gitPath) : undefined;
	}
	const file = value.startsWith("file:") ? value.slice(5) : value;
	if (file === "~") return os.homedir();
	if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
	if (path.isAbsolute(file)) return path.resolve(file);
	if (file === "." || file === ".." || file.startsWith("./") || file.startsWith("../")) {
		return path.resolve(baseDir, file);
	}
	return undefined;
}

function npmPackageName(specifier: string): string | undefined {
	const value = specifier.trim();
	const match = value.startsWith("@") ? value.match(/^(@[^/@]+\/[^/@]+)(?:@.+)?$/) : value.match(/^([^/@]+)(?:@.+)?$/);
	const name = match?.[1];
	return name && safeRelativeSegments(name) ? name : undefined;
}

function gitCachePath(specifier: string): string[] | undefined {
	let host: string;
	let repository: string;
	const scp = specifier.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1] ?? "";
		repository = scp[2] ?? "";
	} else {
		try {
			const url = new URL(specifier);
			host = url.hostname;
			repository = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	}
	repository = repository.split(/[?#]/, 1)[0]?.replace(/\.git$/, "") ?? "";
	if (!safeRelativeSegments(host) || !safeRelativeSegments(repository)) return undefined;
	return [host, ...repository.split("/")];
}

function extraUserAgentDirs(): string[] {
	return (process.env[EXTRA_AGENT_DIRS_ENV] ?? "")
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

async function settingsAgentScanDirs(settingsPath: string): Promise<string[]> {
	const settings = await readJson(settingsPath);
	if (!isRecord(settings)) return [];
	const subagents = settings["subagents"];
	if (!isRecord(subagents)) return [];
	const patterns = stringArray(subagents["agentScanDirs"]);
	return uniquePaths((await Promise.all(patterns.map(expandAgentScanDirPattern))).flat());
}

async function expandAgentScanDirPattern(pattern: string): Promise<string[]> {
	const trimmed = pattern.trim();
	const homeExpanded =
		trimmed === "~"
			? os.homedir()
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? path.join(os.homedir(), trimmed.slice(2))
				: trimmed;
	const expanded = homeExpanded.replace(/[\\/]+/g, path.sep);
	const wildcardCount = [...expanded.matchAll(/\*/g)].length;
	if (wildcardCount === 0) return (await isDirectory(path.resolve(expanded))) ? [path.resolve(expanded)] : [];
	const parts = expanded.split(path.sep);
	const wildcardIndex = parts.indexOf("*");
	if (wildcardCount !== 1 || wildcardIndex < 0) return [];
	const base = path.resolve(parts.slice(0, wildcardIndex).join(path.sep) || path.sep);
	const suffix = parts.slice(wildcardIndex + 1);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(base, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates = await Promise.all(
		entries.map(async (entry) => {
			const candidate = path.join(base, entry.name, ...suffix);
			return (entry.isDirectory() || entry.isSymbolicLink()) && (await isDirectory(candidate))
				? candidate
				: undefined;
		}),
	);
	return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

function splitTools(values: string[] | undefined) {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const value of values ?? []) {
		if (value.startsWith("mcp:") && value.length > 4) mcpDirectTools.push(value.slice(4));
		else tools.push(value);
	}
	return { tools, mcpDirectTools };
}

function optionalBoolean(value: string | undefined): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function optionalEnum<const Values extends readonly string[]>(
	value: string | undefined,
	values: Values,
): Values[number] | undefined {
	return value !== undefined && values.includes(value) ? value : undefined;
}

function optionalNonNegativeInteger(value: string | undefined): number | undefined {
	if (!optionalText(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalText(value: string | undefined): value is string {
	return isRuntimeString(value) && value.trim().length > 0;
}

function nonEmpty(values: string[] | undefined): string[] | undefined {
	return values && values.length > 0 ? values : undefined;
}

async function readDirectories(directory: string): Promise<string[]> {
	try {
		return (await fs.promises.readdir(directory, { withFileTypes: true }))
			.filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function readJson(filePath: string): Promise<JsonValue | undefined> {
	try {
		return parseJsonValue(await fs.promises.readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function stringArray(value: JsonValue | undefined): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => isRuntimeString(entry) && entry.trim().length > 0)
		: [];
}

function safeRelativeSegments(value: string): boolean {
	return (
		value.length > 0 &&
		!path.isAbsolute(value) &&
		value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
	);
}

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

async function isDirectory(candidate: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(candidate)).isDirectory();
	} catch {
		return false;
	}
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await fs.promises.lstat(candidate);
		return true;
	} catch {
		return false;
	}
}

function uniquePaths(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => path.resolve(value)))];
}
