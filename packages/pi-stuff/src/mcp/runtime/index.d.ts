import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonInputValue } from "../../shared/json-value.ts";

export const MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1";
export const MCP_STATUS_SNAPSHOT_VERSION: 1;

export type McpServerRuntimeStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

export interface McpServerStatusSnapshot {
	readonly name: string;
	readonly status: McpServerRuntimeStatus;
	readonly toolCount: number;
	readonly resourceCount?: number;
	readonly failedAgoSeconds?: number;
	readonly failureDetail?: string;
	readonly disabled: boolean;
	readonly oauth?: boolean;
	readonly autoConnect?: boolean;
}

export interface McpStatusSnapshot {
	readonly version: typeof MCP_STATUS_SNAPSHOT_VERSION;
	readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
	readonly totalTools: number;
	readonly totalResources: number;
	readonly connectedCount: number;
	readonly disabledCount: number;
}

export interface McpAdapterOptions {
	config?: JsonInputValue;
	configPath?: string;
	deferStartupConnections?: boolean;
}

type AdapterCommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];
type AdapterCommandContext = Parameters<AdapterCommandSpec["handler"]>[1];

export type McpAdapterCommandSpec = Omit<AdapterCommandSpec, "handler"> & {
	handler(args: string, ctx: AdapterCommandContext): boolean | undefined | Promise<boolean | undefined>;
};

export type McpAdapterExtensionAPI = ExtensionAPI & {
	registerCommand(name: string, spec: McpAdapterCommandSpec): void;
};

export type McpAdapter = (pi: McpAdapterExtensionAPI) => void;

export function createMcpAdapter(options?: McpAdapterOptions): McpAdapter;

declare const mcpAdapter: McpAdapter;
export default mcpAdapter;
