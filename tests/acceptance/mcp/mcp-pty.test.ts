import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyMcpPty } from "../../../scripts/verify-mcp-pty.ts";

test(
	"MCP setup and Tool interaction in the real terminal",
	() =>
		verifyMcpPty({
			piBinary: resolvePiBinary(),
			packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff"),
			columns: 64,
			rows: 28,
		}),
	120_000,
);
