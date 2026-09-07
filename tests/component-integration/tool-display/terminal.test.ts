import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	boundTerminalLine,
	boundTerminalText,
	compactTerminalPath,
	graphemePrefix,
	truncateUtf8Graphemes,
} from "../../../packages/pi-stuff/src/tool-display/terminal.js";
import { isWellFormed } from "../../fixtures/terminal.js";

describe("terminal presentation bounds", () => {
	test("sanitizes before fitting emoji, CJK, combining marks, and ANSI text", () => {
		const emoji = boundTerminalLine("😀".repeat(31), 60);
		const cjk = boundTerminalLine("界".repeat(40), 21);
		const combining = boundTerminalLine("é".repeat(30), 12);
		const styled = boundTerminalText("\u001b[31m界界\u001b[0m\néé", 7);
		const malformed = boundTerminalLine("start\ud83d middle\udc00 end", 80);

		for (const [value, width] of [
			[emoji, 60],
			[cjk, 21],
			[combining, 12],
			[styled, 7],
		] as const) {
			expect(visibleWidth(value)).toBeLessThanOrEqual(width);
			expect(isWellFormed(value)).toBeTrue();
		}
		expect(emoji).toEndWith("…");
		expect(styled).toBe("界界\néé");
		expect(malformed).toBe("start� middle� end");
		expect(boundTerminalLine("👩‍💻", 8)).toBe("👩‍💻");
		expect(graphemePrefix("👩‍💻👩‍💻", 5)).toBe("👩‍💻");
		expect(truncateUtf8Graphemes("éé", 3)).toBe("é");
	});

	test("uses one cell-aware fold grammar for every path shape", () => {
		const cases = [
			["/workspace/.pi/agent", 14, "/.../.pi/agent"],
			["packages/pi-stuff/src/tool-display/contract.ts", 30, ".../tool-display/contract.ts"],
			["~/.local/share/mise/shims/rtk", 24, "~/.../shims/rtk"],
			["/workspace/project/.cache/state.json", 24, "/.../.cache/state.json"],
			["C:\\Users\\me\\project\\src\\index.ts", 24, "C:\\...\\src\\index.ts"],
			["/very/long/path/深层/file.ts", 14, ".../深层/file…"],
			["/workspace/🚀project/src/📄.ts", 16, "/.../src/📄.ts"],
		] as const;

		for (const [input, width, expected] of cases) {
			const result = compactTerminalPath(input, width, true);
			expect(result).toBe(expected);
			expect(visibleWidth(result)).toBeLessThanOrEqual(width);
			expect(result).not.toMatch(/(?:[⋯…][\\/]|[\\/][⋯…])/u);
			expect(result).toContain("...");
			expect(isWellFormed(result)).toBeTrue();
		}
	});
});
