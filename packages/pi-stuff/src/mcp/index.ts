import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installMcpCapability } from "./adapter.ts";

export { createMcpAdapterApi, installMcpCapability, suppressMcpFooterContext } from "./adapter.ts";
export { createMcpControlView } from "./mcp-dialog.ts";
export { McpStatusStore, parseMcpStatusSnapshot } from "./status-store.ts";

export default function piStuffMcp(pi: ExtensionAPI): void {
	installMcpCapability(pi);
}
