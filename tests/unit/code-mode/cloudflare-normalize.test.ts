import { expect, test } from "bun:test";
import { normalizeCode } from "../../../packages/pi-stuff/src/code-mode/cloudflare/normalize.js";

test("vendored Cloudflare normalization accepts the common model program forms", () => {
	expect(normalizeCode("async () => { return 1; }")).toBe("async () => { return 1; }");
	expect(normalizeCode("const x = 10;\nx * 2")).toBe("async () => {\nconst x = 10;\nreturn (x * 2)\n}");
	expect(normalizeCode("return 42")).toBe("async () => {\nreturn 42\n}");
	expect(normalizeCode("```js\nexport default async () => 7\n```")).toBe("async () => 7");
});
