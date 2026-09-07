import { describe, expect, test } from "bun:test";
import {
	formatTerminalError,
	resolveCommandSecret,
	resolveServerUrl,
} from "../../../packages/pi-stuff/src/mcp/runtime/utils.ts";

describe("MCP command secrets", () => {
	test("does not block the Host event loop while the command runs", async () => {
		let timerRan = false;
		const timer = setTimeout(() => {
			timerRan = true;
		}, 5);

		const secret = await resolveCommandSecret("!sleep 0.05; printf secret", "test secret");

		clearTimeout(timer);
		expect(secret).toBe("secret");
		expect(timerRan).toBe(true);
	});

	test("does not expose interpolated secrets in invalid URL errors", () => {
		const name = "PI_STUFF_TEST_MCP_URL_SECRET";
		const previous = process.env[name];
		process.env[name] = "sensitive-token";
		try {
			let failure: unknown;
			try {
				resolveServerUrl({ url: `http://[\${${name}}]` });
			} catch (error) {
				failure = error;
			}
			expect(formatTerminalError(failure)).toBe("Invalid MCP server URL after environment interpolation");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});
});
