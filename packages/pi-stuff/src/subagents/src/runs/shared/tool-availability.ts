import * as fs from "node:fs";
import * as path from "node:path";
import { isJsonInputObject, type JsonInputValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeString } from "../../../../shared/runtime-type.ts";

export const REQUIRED_CHILD_TOOLS_ENV = "PI_SUBAGENT_REQUIRED_TOOLS";
export const MCP_DIRECT_CHILD_TOOLS_ENV = "PI_SUBAGENT_MCP_DIRECT_TOOLS";
export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = "PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH";

export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
	missingMcpDirectTools?: string[];
	launchError?: string;
}

const PI_CORE_CHILD_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);

export function writeChildToolDiagnostic(
	filePath: string,
	required: string[],
	available: string[],
	agent?: string,
	mcpDirectTools?: string[],
): ChildToolDiagnostic | undefined {
	const availableNames = new Set([...available, ...PI_CORE_CHILD_TOOLS]);
	const missing = required.filter((name) => !availableNames.has(name));
	if (missing.length === 0) {
		fs.rmSync(filePath, { force: true });
		return undefined;
	}

	const missingMcpDirectTools = mcpDirectTools?.length ? missing.filter((name) => mcpDirectTools.includes(name)) : [];
	const diagnostic: ChildToolDiagnostic = { required, available, missing };
	if (agent !== undefined) diagnostic.agent = agent;
	if (missingMcpDirectTools.length > 0) diagnostic.missingMcpDirectTools = missingMcpDirectTools;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(diagnostic), { mode: 0o600 });
	return diagnostic;
}

export function writeChildLaunchDiagnostic(filePath: string, launchError: string): ChildToolDiagnostic {
	const diagnostic: ChildToolDiagnostic = {
		required: [],
		available: [],
		missing: [],
		launchError: launchError.slice(0, 8_192),
	};
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(diagnostic), { mode: 0o600 });
	return diagnostic;
}

export function readChildToolDiagnostic(filePath: string | undefined): ChildToolDiagnostic | undefined {
	if (!filePath || !fs.existsSync(filePath)) return undefined;
	const parsed = parseJsonValue(fs.readFileSync(filePath, "utf-8"));
	if (!isJsonInputObject(parsed)) throw new Error(`Malformed child tool diagnostic at '${filePath}'.`);
	const stringArray = (value: JsonInputValue): value is string[] =>
		Array.isArray(value) && value.every((entry) => isRuntimeString(entry) && entry.length > 0);
	if (
		!stringArray(parsed["required"]) ||
		!stringArray(parsed["available"]) ||
		!stringArray(parsed["missing"]) ||
		(parsed["agent"] !== undefined && !isRuntimeString(parsed["agent"])) ||
		(parsed["missingMcpDirectTools"] !== undefined && !stringArray(parsed["missingMcpDirectTools"])) ||
		(parsed["launchError"] !== undefined &&
			(!isRuntimeString(parsed["launchError"]) || parsed["launchError"].length > 8_192))
	) {
		throw new Error(`Malformed child tool diagnostic at '${filePath}'.`);
	}
	const diagnostic: ChildToolDiagnostic = {
		required: parsed["required"],
		available: parsed["available"],
		missing: parsed["missing"],
	};
	if (parsed["agent"]) diagnostic.agent = parsed["agent"];
	if (parsed["missingMcpDirectTools"]) diagnostic.missingMcpDirectTools = parsed["missingMcpDirectTools"];
	if (parsed["launchError"]) diagnostic.launchError = parsed["launchError"];
	return diagnostic;
}

export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic): string {
	if (diagnostic.launchError) return diagnostic.launchError;
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [
					`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. This indicates a host/pi-mcp-adapter registration problem, not a tool-call failure.`,
				]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}

export function readChildToolDiagnosticError(filePath: string | undefined): string | undefined {
	try {
		const diagnostic = readChildToolDiagnostic(filePath);
		return diagnostic ? formatChildToolDiagnostic(diagnostic) : undefined;
	} catch (error) {
		return `Failed to read child tool availability diagnostic: ${error instanceof Error ? error.message : String(error)}`;
	}
}
