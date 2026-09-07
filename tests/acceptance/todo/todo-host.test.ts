import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.js";

const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");
const TODO_TOOL_INSPECTOR = resolve(import.meta.dir, "../../fixtures/assert-todo-tools.ts");
const PI_BINARY = resolvePiBinary();
test("the certified Pi Host loads all Todo tools through the single Pi Stuff Package", async () => {
	const result = await runPiRpcSmoke({
		extensions: [TODO_TOOL_INSPECTOR],
		packages: [AGGREGATE_PACKAGE],
		piBinary: PI_BINARY,
	});

	expect(result.stderr).toBe("");
	expect(result.commandNames).toContain("todo-tools-certified");
}, 30_000);
