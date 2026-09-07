import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { extractPDFToMarkdown } from "../../../packages/pi-stuff/src/web/runtime/pdf-extract.ts";

function onePagePdf(text: string): ArrayBuffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
	return new TextEncoder().encode(pdf).buffer;
}

test("extracts a bounded local PDF and keeps its Markdown artifact", async () => {
	const originalAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
	const originalGeminiKey = process.env["GEMINI_API_KEY"];
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-pdf-effect-"));
	process.env["PI_CODING_AGENT_DIR"] = root;
	delete process.env["GEMINI_API_KEY"];
	try {
		const result = await Effect.runPromise(
			extractPDFToMarkdown(onePagePdf("Effect PDF"), "https://example.com/effect.pdf", {
				filename: "effect.md",
				outputDir: root,
			}),
		);
		expect(result.pages).toBe(1);
		expect(result.outputPath).toBe(join(root, "effect.md"));
		expect(await readFile(result.outputPath, "utf8")).toContain("Effect PDF");
	} finally {
		if (originalAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = originalAgentDirectory;
		if (originalGeminiKey === undefined) delete process.env["GEMINI_API_KEY"];
		else process.env["GEMINI_API_KEY"] = originalGeminiKey;
		await rm(root, { force: true, recursive: true });
	}
});
