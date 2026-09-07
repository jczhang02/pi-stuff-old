import { describe, expect, test } from "bun:test";
import { validateWebFetchInput } from "../../../packages/pi-stuff/src/web/url-policy.js";

describe("Pi Stuff Web URL boundary", () => {
	test("accepts bounded public HTTP(S) input", () => {
		expect(validateWebFetchInput({ mode: "readable", url: "https://example.com/report.pdf" })).toEqual({
			input: { mode: "readable", url: "https://example.com/report.pdf" },
			ok: true,
		});
		expect(validateWebFetchInput({ urls: ["https://example.com", "http://example.org"] }).ok).toBe(true);
	});

	test("rejects ambiguous, local, credential-bearing, and non-HTTP input", () => {
		for (const input of [
			{},
			{ url: "https://example.com", urls: ["https://example.org"] },
			{ url: "file:///etc/passwd" },
			{ url: "http://localhost:3000" },
			{ url: "http://127.0.0.1" },
			{ url: "http://2130706433" },
			{ url: "http://[::1]" },
			{ url: "https://93.184.216.34" },
			{ url: "https://198.18.4.8" },
			{ url: "https://user:secret@example.com" },
		]) {
			const result = validateWebFetchInput(input);
			expect(result.ok).toBe(false);
		}
	});

	test("bounds batch size before any upstream work", () => {
		const result = validateWebFetchInput({
			urls: Array.from({ length: 11 }, (_, index) => `https://example.com/${String(index)}`),
		});
		expect(result).toEqual({ error: "At most 10 URLs may be fetched at once.", ok: false });
	});

	test("does not echo malformed URL secrets", () => {
		const result = validateWebFetchInput({ url: "https://[broken]?token=secret-value" });
		expect(result).toEqual({ error: "Invalid URL.", ok: false });
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});
});
