import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { readWebConfig } from "./config.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isGeminiApiAvailable } from "./gemini-api.ts";
import { extractPDFViaGemini } from "./gemini-pdf-extract.ts";
import { nativePromise } from "./utils.ts";

export interface PDFExtractResult {
	title: string;
	pages: number;
	chars: number;
	outputPath: string;
}

export interface PDFExtractOptions {
	maxPages?: number;
	outputDir?: string;
	filename?: string;
	geminiTimeoutMs?: number;
}

export interface PDFConfig {
	maxSizeMB: number;
}

export const DEFAULT_PDF_MAX_SIZE_MB = 20;
export const MAX_PDF_MAX_SIZE_MB = 50;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_OUTPUT_DIR = join(tmpdir(), "pi-web-pdf");
const PAGE_MARKER_PATTERN = /^<!-- Page (\d+) -->$/gm;

export function loadPDFConfig(): PDFConfig {
	const root = readWebConfig();
	const pdf = isJsonInputObject(root?.["pdf"]) ? root["pdf"] : {};
	const configured = pdf["maxSizeMB"];
	const normalized =
		isRuntimeNumber(configured) && Number.isFinite(configured) && configured > 0
			? Math.min(configured, MAX_PDF_MAX_SIZE_MB)
			: DEFAULT_PDF_MAX_SIZE_MB;
	return { maxSizeMB: normalized };
}

function getUnpdf() {
	return Effect.all([nativePromise(() => import("unpdf")), nativePromise(() => import("unpdf/pdfjs"))]).pipe(
		Effect.flatMap(([unpdf, pdfjs]) =>
			Effect.try({
				try: () => {
					const verbosityLevel = "VerbosityLevel" in pdfjs ? pdfjs.VerbosityLevel : undefined;
					if (!isJsonInputObject(verbosityLevel) || !isRuntimeNumber(verbosityLevel.ERRORS)) {
						throw new Error("unpdf did not expose its expected verbosity levels");
					}
					return { getDocumentProxy: unpdf.getDocumentProxy, VerbosityLevel: verbosityLevel };
				},
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			}),
		),
	);
}

/** Extract text from a PDF buffer and save it to a Markdown file. */
export function extractPDFToMarkdown(
	buffer: ArrayBuffer,
	url: string,
	options: PDFExtractOptions = {},
): Effect.Effect<PDFExtractResult, Error> {
	return Effect.suspend(() => {
		const { maxPages = DEFAULT_MAX_PAGES, outputDir = DEFAULT_OUTPUT_DIR, filename, geminiTimeoutMs } = options;
		const safeMaxPages = Number.isFinite(maxPages) ? Math.max(1, Math.floor(maxPages)) : DEFAULT_MAX_PAGES;
		const urlTitle = extractTitleFromURL(url);
		const local = () => extractPDFLocally(buffer, url, safeMaxPages, outputDir, filename, urlTitle);
		if (!isGeminiApiAvailable()) return local();

		const geminiOptions = { maxPages: safeMaxPages, title: urlTitle };
		if (geminiTimeoutMs !== undefined) Object.assign(geminiOptions, { timeoutMs: geminiTimeoutMs });
		return extractPDFViaGemini(buffer, geminiOptions).pipe(
			Effect.flatMap((markdownBody) =>
				writeMarkdownResult({
					markdownBody,
					title: urlTitle,
					pages: countPageMarkers(markdownBody),
					outputDir,
					filename,
					url,
				}),
			),
			Effect.catch((error) => (shouldRethrowGeminiError(error) ? Effect.fail(error) : local())),
		);
	});
}

function extractPDFLocally(
	buffer: ArrayBuffer,
	url: string,
	maxPages: number,
	outputDir: string,
	filename: string | undefined,
	urlTitle: string,
): Effect.Effect<PDFExtractResult, Error> {
	return Effect.gen(function* () {
		const { getDocumentProxy, VerbosityLevel } = yield* getUnpdf();
		const pdf = yield* nativePromise(() =>
			getDocumentProxy(new Uint8Array(buffer), { verbosity: VerbosityLevel.ERRORS }),
		);
		const metadata = yield* nativePromise(() => pdf.getMetadata());
		const metadataInfo = isJsonInputObject(metadata.info) ? metadata.info : null;
		const metaTitle = isRuntimeString(metadataInfo?.["Title"]) ? metadataInfo["Title"] : undefined;
		const metaAuthor = isRuntimeString(metadataInfo?.["Author"]) ? metadataInfo["Author"] : undefined;
		const title = metaTitle?.trim() || urlTitle;
		const pagesToExtract = Math.min(pdf.numPages, maxPages);
		const pages = yield* Effect.forEach(
			Array.from({ length: pagesToExtract }, (_, index) => index + 1),
			(pageNum) =>
				nativePromise(async () => {
					const page = await pdf.getPage(pageNum);
					const textContent = await page.getTextContent();
					const text = textContent.items
						.map((item: JsonInputValue) =>
							isJsonInputObject(item) && isRuntimeString(item["str"]) ? item["str"] : "",
						)
						.join(" ")
						.replace(/\s+/g, " ")
						.trim();
					return { pageNum, text };
				}),
			{ concurrency: 1 },
		);
		const bodyLines: string[] = [];
		for (const [index, page] of pages.filter((page) => page.text).entries()) {
			if (index > 0) bodyLines.push("", `<!-- Page ${String(page.pageNum)} -->`, "");
			bodyLines.push(page.text);
		}
		return yield* writeMarkdownResult({
			markdownBody: bodyLines.join("\n"),
			title,
			pages: pdf.numPages,
			outputDir,
			filename,
			url,
			metaAuthor,
			truncated: pdf.numPages > maxPages,
			pagesToExtract,
		});
	});
}

function writeMarkdownResult(options: {
	markdownBody: string;
	title: string;
	pages: number;
	outputDir: string;
	filename?: string | undefined;
	url: string;
	metaAuthor?: string | undefined;
	truncated?: boolean;
	pagesToExtract?: number;
}): Effect.Effect<PDFExtractResult, Error> {
	const lines = [
		`# ${options.title}`,
		"",
		`> Source: ${options.url}`,
		`> Pages: ${String(options.pages)}${options.truncated ? ` (extracted first ${String(options.pagesToExtract)})` : ""}`,
	];
	if (options.metaAuthor) lines.push(`> Author: ${options.metaAuthor}`);
	lines.push("", "---", "");
	if (options.markdownBody) lines.push(options.markdownBody);
	if (options.truncated) {
		lines.push(
			"",
			"---",
			"",
			`*[Truncated: Only first ${String(options.pagesToExtract)} of ${String(options.pages)} pages extracted]*`,
		);
	}
	const content = lines.join("\n");
	const outputPath = join(options.outputDir, options.filename || `${sanitizeFilename(options.title)}.md`);
	return Effect.gen(function* () {
		yield* nativePromise(() => mkdir(options.outputDir, { recursive: true }));
		yield* nativePromise((signal) => writeFile(outputPath, content, { encoding: "utf-8", signal }));
		return { title: options.title, pages: options.pages, chars: content.length, outputPath };
	});
}

function countPageMarkers(markdown: string): number {
	return [...markdown.matchAll(PAGE_MARKER_PATTERN)].length;
}

function shouldRethrowGeminiError(error: Error): boolean {
	if (error instanceof CredentialResolutionError) return true;
	return error.message.startsWith("Failed to parse ");
}

function extractTitleFromURL(url: string): string {
	try {
		const urlObj = new URL(url);
		let filename = basename(urlObj.pathname, ".pdf");
		if (urlObj.hostname.includes("arxiv.org")) {
			const match = urlObj.pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
			if (match) filename = `arxiv-${match[1]}`;
		}
		filename = filename.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
		return filename || "document";
	} catch {
		return "document";
	}
}

function sanitizeFilename(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.slice(0, 100)
			.replace(/^-|-$/g, "") || "document"
	);
}

export function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}
