import { expect, test } from "bun:test";
import type { JsonInputValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { extractRSCContent } from "../../../packages/pi-stuff/src/web/runtime/rsc-extract.js";

function rscPage(chunks: readonly (readonly [string, JsonInputValue])[]): string {
	const payload = chunks.map(([id, node]) => `${id}:${JSON.stringify(node)}`).join("\n");
	return `<title>Guide | Docs</title><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
}

function element(tag: string, children: JsonInputValue): JsonInputValue {
	return ["$", tag, null, { children }];
}

test("extracts referenced RSC content and escapes markdown tables", () => {
	const body = "Detailed reference content. ".repeat(6);
	const result = extractRSCContent(
		rscPage([
			["23", element("article", [element("h1", "Guide"), element("p", body), "$L24"])],
			[
				"24",
				element("table", [
					element("thead", element("tr", [element("th", "Name"), element("th", "Value")])),
					element("tbody", element("tr", [element("td", "a\\b|c"), element("td", element("code", "ok"))])),
				]),
			],
		]),
	);

	expect(result?.title).toBe("Guide");
	expect(result?.content).toContain(`# Guide\n\n${body.trim()}`);
	expect(result?.content).toContain("| Name | Value |\n| --- | --- |\n| a\\\\b\\|c | `ok` |");
});
