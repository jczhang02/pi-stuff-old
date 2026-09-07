import { access, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import { type JsonObject, type JsonValue, parseJsonObject } from "../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";

const DEFAULT_HISTORIAN_MODEL = "openai-codex/gpt-5.6-terra";
const FLAT_AGENT_EXECUTION_FIELDS = ["model", "fallback_models", "variant", "thinking_level"] as const;
const FLAT_TASK_EXECUTION_FIELDS = [...FLAT_AGENT_EXECUTION_FIELDS, "timeout_minutes"] as const;
function homeDirectory(): string {
	return process.env["HOME"]?.trim() || homedir();
}

function configHome(): string {
	const configured = process.env["XDG_CONFIG_HOME"]?.trim();
	return configured && isAbsolute(configured) ? configured : join(homeDirectory(), ".config");
}

function configVariants(base: string): readonly string[] {
	return [`${base}.jsonc`, `${base}.json`];
}

function canonicalUserConfigPaths(): readonly string[] {
	return configVariants(join(configHome(), "cortexkit", "magic-context"));
}

function migratableUserConfigPaths(): readonly string[] {
	return [
		...configVariants(join(configHome(), "opencode", "magic-context")),
		...configVariants(join(homeDirectory(), ".pi", "agent", "magic-context")),
	];
}

function userScopeConfigPaths(): ReadonlySet<string> {
	return new Set([...canonicalUserConfigPaths(), ...migratableUserConfigPaths()]);
}

function contextDirectory(ctx: ExtensionContext): string {
	return isRuntimeString(ctx.cwd) && ctx.cwd.trim() ? ctx.cwd : process.cwd();
}

function canonicalProjectConfigPaths(ctx: ExtensionContext): readonly string[] {
	return configVariants(join(contextDirectory(ctx), ".cortexkit", "magic-context"));
}

function migratableProjectConfigPaths(ctx: ExtensionContext): readonly string[] {
	const directory = contextDirectory(ctx);
	const userPaths = userScopeConfigPaths();
	return [
		...configVariants(join(directory, "magic-context")),
		...configVariants(join(directory, ".opencode", "magic-context")),
		...configVariants(join(directory, ".pi", "magic-context")),
	].filter((path) => !userPaths.has(path));
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
	for (const path of paths) {
		if (await exists(path)) return true;
	}
	return false;
}

function configRecord(value: JsonValue | undefined): JsonObject | undefined {
	return value !== null && value !== undefined && isRuntimeObject(value) && !Array.isArray(value) ? value : undefined;
}

function hasAnyOwnField(value: JsonValue | undefined, fields: readonly string[]): boolean {
	const record = configRecord(value);
	return record !== undefined && fields.some((field) => Object.hasOwn(record, field));
}

function needsPerHarnessMigration(contents: string): boolean {
	let root: JsonObject;
	try {
		root = parseJsonObject(stripJsonComments(contents, { trailingCommas: true }));
	} catch {
		return true;
	}
	if (["historian", "dreamer"].some((name) => hasAnyOwnField(root[name], FLAT_AGENT_EXECUTION_FIELDS))) {
		return true;
	}
	const tasks = configRecord(configRecord(root["dreamer"])?.["tasks"]);
	return tasks !== undefined && Object.values(tasks).some((task) => hasAnyOwnField(task, FLAT_TASK_EXECUTION_FIELDS));
}

async function canonicalUserConfigNeedsMigration(paths: readonly string[]): Promise<boolean> {
	for (const path of paths) {
		if (!(await exists(path))) continue;
		try {
			return needsPerHarnessMigration(await readFile(path, "utf8"));
		} catch {
			return true;
		}
	}
	return false;
}

function historianModel(ctx: ExtensionContext): string {
	const provider = ctx.model?.provider?.trim();
	const id = ctx.model?.id?.trim();
	return provider && id ? `${provider}/${id}` : DEFAULT_HISTORIAN_MODEL;
}

function defaultConfig(ctx: ExtensionContext): string {
	const model = historianModel(ctx);
	return `${JSON.stringify(
		{
			$schema: "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
			enabled: true,
			fail_closed_blocking: false,
			toast_duration_ms: 0,
			historian: {
				opencode: { model },
				pi: { model, thinking_level: "medium" },
			},
			embedding: {
				provider: "off",
			},
			dreamer: { disable: true },
			sidekick: { disable: true },
			todowrite: { enabled: false, overlay: false },
			memory: { enabled: true, auto_search: { enabled: true } },
		},
		null,
		"\t",
	)}\n`;
}

export type MagicContextPreparation = "ready" | "deferred";

export interface MagicContextPreparationOptions {
	/** Permit first-use configuration and the upstream factory's documented migrations. */
	readonly allowConfigurationMutation: boolean;
}

/**
 * Give a first-time Pi Stuff installation a usable official Magic Context
 * configuration without overwriting an existing user or project file.
 * Mutation-free startup may use an existing canonical config, but cannot hand
 * an existing legacy config to the upstream factory because that factory
 * migrates files during initialization. First-use creation or migration waits
 * for direct interactive/RPC input or an explicit Context projection.
 */
export async function prepareMagicContext(
	ctx: ExtensionContext,
	options: MagicContextPreparationOptions = { allowConfigurationMutation: true },
): Promise<MagicContextPreparation> {
	const canonicalUser = canonicalUserConfigPaths();
	const canonicalProject = canonicalProjectConfigPaths(ctx);
	const migratableUser = migratableUserConfigPaths();
	const migratableProject = migratableProjectConfigPaths(ctx);
	if (!options.allowConfigurationMutation) {
		const migrationsPending =
			(await anyExists(migratableUser)) ||
			(await anyExists(migratableProject)) ||
			(await canonicalUserConfigNeedsMigration(canonicalUser));
		if (migrationsPending) return "deferred";
		const recognizedConfig = (await anyExists(canonicalUser)) || (await anyExists(canonicalProject));
		return recognizedConfig ? "ready" : "deferred";
	}
	const recognizedConfig =
		(await anyExists(canonicalUser)) ||
		(await anyExists(canonicalProject)) ||
		(await anyExists(migratableUser)) ||
		(await anyExists(migratableProject));
	if (recognizedConfig) return "ready";
	const path = canonicalUser[0];
	if (!path) throw new Error("Magic Context canonical configuration path is unavailable.");
	await mkdir(dirname(path), { mode: 0o700, recursive: true });
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, "wx", 0o600);
		await file.writeFile(defaultConfig(ctx), "utf8");
	} catch (error) {
		if (!isRuntimeObject(error) || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
	} finally {
		await file?.close();
	}
	return "ready";
}
