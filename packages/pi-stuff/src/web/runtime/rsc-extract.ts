import { isJsonInputObject, type JsonInputValue, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match?.[1]) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function referenceId(value: string): string | null {
	return /^\$L([0-9a-f]+)$/i.exec(value)?.[1] ?? null;
}
/**
 * RSC Content Extractor
 *
 * Extracts readable content from Next.js React Server Components (RSC) flight payloads.
 * RSC pages embed content as JSON in <script>self.__next_f.push([...])</script> tags.
 */

export interface RSCExtractResult {
	title: string;
	content: string;
}

type ParsedChunk = (id: string) => JsonInputValue | null;

interface ExtractContext {
	readonly inCode: boolean;
	readonly inTable: boolean;
}

interface TableState {
	headerRowCount: number;
	readonly rows: string[][];
}

const DEFAULT_CONTEXT: ExtractContext = { inTable: false, inCode: false };
const SKIP_TAGS = new Set([
	"script",
	"style",
	"svg",
	"path",
	"circle",
	"link",
	"meta",
	"template",
	"button",
	"input",
	"nav",
	"footer",
	"aside",
]);

function parseRSCChunks(html: string): Map<string, string> {
	const chunkMap = new Map<string, string>();
	const scriptRegex = /<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
	for (const match of html.matchAll(scriptRegex)) {
		let content: string;
		try {
			const parsedContent = parseJsonValue(`"${match[1]}"`);
			if (!isRuntimeString(parsedContent)) continue;
			content = parsedContent;
		} catch {
			continue;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			const colonIdx = line.indexOf(":");
			if (colonIdx <= 0 || colonIdx > 4) continue;
			const id = line.slice(0, colonIdx);
			if (!/^[0-9a-f]+$/i.test(id)) continue;
			const payload = line.slice(colonIdx + 1);
			if (!payload) continue;
			const existing = chunkMap.get(id);
			if (!existing || payload.length > existing.length) chunkMap.set(id, payload);
		}
	}
	return chunkMap;
}

function createChunkReader(chunkMap: ReadonlyMap<string, string>): ParsedChunk {
	const parsedCache = new Map<string, JsonInputValue | null>();
	return (id) => {
		if (parsedCache.has(id)) return parsedCache.get(id);
		const chunk = chunkMap.get(id);
		if (!chunk?.startsWith("[")) {
			parsedCache.set(id, null);
			return null;
		}
		try {
			const parsed = parseJsonValue(chunk);
			parsedCache.set(id, parsed);
			return parsed;
		} catch {
			parsedCache.set(id, null);
			return null;
		}
	};
}

class RSCNodeExtractor {
	private readonly getParsedChunk: ParsedChunk;
	private readonly visitedRefs = new Set<string>();

	constructor(getParsedChunk: ParsedChunk) {
		this.getParsedChunk = getParsedChunk;
	}

	clearReferences(): void {
		this.visitedRefs.clear();
	}

	extract(node: JsonInputValue, ctx: ExtractContext = DEFAULT_CONTEXT): string {
		if (node === null || node === undefined) return "";
		if (isRuntimeString(node)) {
			const refId = referenceId(node);
			if (refId) return this.extractReference(refId, ctx);
			if (!ctx.inCode && (node === "$undefined" || node === "$" || /^\$[A-Z]/.test(node))) return "";
			return node.trim() ? node : "";
		}
		if (isRuntimeNumber(node)) return String(node);
		if (isRuntimeBoolean(node)) return "";
		if (!Array.isArray(node)) return "";
		return node[0] === "$" && isRuntimeString(node[1])
			? this.extractElement(node, ctx)
			: node.map((child) => this.extract(child, ctx)).join("");
	}

	private extractReference(id: string, ctx: ExtractContext, missing: () => string = () => ""): string {
		if (this.visitedRefs.has(id)) return "";
		this.visitedRefs.add(id);
		const node = this.getParsedChunk(id);
		const result = node ? this.extract(node, ctx) : missing();
		this.visitedRefs.delete(id);
		return result;
	}

	private visitReference(id: string, visit: (node: JsonInputValue) => void): void {
		if (this.visitedRefs.has(id)) return;
		this.visitedRefs.add(id);
		const node = this.getParsedChunk(id);
		if (node) visit(node);
		this.visitedRefs.delete(id);
	}

	private extractElement(node: JsonInputValue[], ctx: ExtractContext): string {
		const tag = node[1];
		if (!isRuntimeString(tag)) return "";
		const props = isJsonInputObject(node[3]) ? node[3] : {};
		if (SKIP_TAGS.has(tag)) return "";
		if (tag.startsWith("$L")) {
			const refId = tag.slice(2);
			if (this.visitedRefs.has(refId)) return "";
			if (props["baseId"] && props["children"]) return `## ${String(props["children"])}\n\n`;
			return this.extractReference(refId, ctx, () =>
				props["children"] ? this.extract(props["children"], ctx) : "",
			);
		}
		const children = props["children"];
		const content = children ? this.extract(children, ctx) : "";
		switch (tag) {
			case "h1":
				return `# ${content.trim()}\n\n`;
			case "h2":
				return `## ${content.trim()}\n\n`;
			case "h3":
				return `### ${content.trim()}\n\n`;
			case "h4":
				return `#### ${content.trim()}\n\n`;
			case "h5":
				return `##### ${content.trim()}\n\n`;
			case "h6":
				return `###### ${content.trim()}\n\n`;
			case "p":
				return ctx.inTable ? content : `${content.trim()}\n\n`;
			case "code": {
				const codeContent = children ? this.extract(children, { ...ctx, inCode: true }) : "";
				return ctx.inCode ? codeContent : `\`${codeContent}\``;
			}
			case "pre": {
				const preContent = children ? this.extract(children, { ...ctx, inCode: true }) : "";
				return `\`\`\`\n${preContent}\n\`\`\`\n\n`;
			}
			case "strong":
			case "b":
				return `**${content}**`;
			case "em":
			case "i":
				return `*${content}*`;
			case "li":
				return `- ${content.trim()}\n`;
			case "ul":
			case "ol":
				return `${content}\n`;
			case "blockquote":
				return `> ${content.trim()}\n\n`;
			case "table":
				return `${this.extractTable(node)}\n`;
			case "thead":
			case "tbody":
			case "tr":
			case "th":
			case "td":
				return content;
			case "div":
				return props["role"] === "alert" || props["data-slot"] === "alert" ? `> ${content.trim()}\n\n` : content;
			case "a": {
				const href = isRuntimeString(props["href"]) ? props["href"] : undefined;
				return href && !href.startsWith("#") ? `[${content}](${href})` : content;
			}
			default:
				return content;
		}
	}

	private extractTable(tableNode: JsonInputValue[]): string {
		const props = isJsonInputObject(tableNode[3]) ? tableNode[3] : {};
		const state: TableState = { headerRowCount: 0, rows: [] };
		this.walkTable(props["children"], state);
		if (state.rows.length === 0) return "";
		const colCount = Math.max(...state.rows.map((row) => row.length));
		let md = "";
		for (const [index, sourceRow] of state.rows.entries()) {
			const row = sourceRow.concat(Array(colCount - sourceRow.length).fill(""));
			md += `| ${row.join(" | ")} |\n`;
			if (index === state.headerRowCount - 1 || (state.headerRowCount === 0 && index === 0)) {
				md += `| ${Array(colCount).fill("---").join(" | ")} |\n`;
			}
		}
		return md;
	}

	private walkTable(node: JsonInputValue, state: TableState, isHeader = false): void {
		if (node === null || node === undefined) return;
		if (isRuntimeString(node)) {
			const refId = referenceId(node);
			if (refId) this.visitReference(refId, (resolved) => this.walkTable(resolved, state, isHeader));
			return;
		}
		if (!Array.isArray(node)) return;
		if (node[0] !== "$" || !isRuntimeString(node[1])) {
			for (const child of node) this.walkTable(child, state, isHeader);
			return;
		}
		const tag = node[1];
		const props = isJsonInputObject(node[3]) ? node[3] : {};
		if (tag.startsWith("$L")) {
			this.visitReference(tag.slice(2), (resolved) => this.walkTable(resolved, state, isHeader));
		} else if (tag === "thead") this.walkTable(props.children, state, true);
		else if (tag === "tbody") this.walkTable(props.children, state, false);
		else if (tag === "tr") {
			const cells: string[] = [];
			this.walkCells(props.children, cells);
			if (cells.length > 0) {
				state.rows.push(cells);
				if (isHeader) state.headerRowCount += 1;
			}
		} else this.walkTable(props.children, state, isHeader);
	}

	private walkCells(node: JsonInputValue, cells: string[]): void {
		if (node === null || node === undefined) return;
		if (isRuntimeString(node)) {
			const refId = referenceId(node);
			if (refId) this.visitReference(refId, (resolved) => this.walkCells(resolved, cells));
			return;
		}
		if (!Array.isArray(node)) return;
		if (node[0] === "$" && (node[1] === "td" || node[1] === "th")) {
			const props = isJsonInputObject(node[3]) ? node[3] : {};
			const text = this.extract(props.children, { inTable: true, inCode: false })
				.trim()
				.replace(/\n/g, " ")
				.replace(/\\/g, "\\\\")
				.replace(/\|/g, "\\|");
			cells.push(text);
		} else if (node[0] === "$" && isRuntimeString(node[1]) && node[1].startsWith("$L")) {
			this.visitReference(node[1].slice(2), (resolved) => this.walkCells(resolved, cells));
		} else {
			for (const child of node) this.walkCells(child, cells);
		}
	}
}

function fallbackContent(
	chunkMap: ReadonlyMap<string, string>,
	getParsedChunk: ParsedChunk,
	extractor: RSCNodeExtractor,
): string | null {
	const contentParts: { order: number; text: string }[] = [];
	for (const [id] of chunkMap) {
		if (id === "23") continue;
		const parsed = getParsedChunk(id);
		if (!parsed) continue;
		extractor.clearReferences();
		const text = extractor.extract(parsed);
		if (text.trim().length > 50 && !text.includes("page was not found") && !text.includes("404")) {
			contentParts.push({ order: parseInt(id, 16), text: text.trim() });
		}
	}
	if (contentParts.length === 0) return null;
	contentParts.sort((a, b) => a.order - b.order);
	const seen = new Set<string>();
	const uniqueParts: string[] = [];
	for (const part of contentParts) {
		const key = part.text.slice(0, 150);
		if (seen.has(key)) continue;
		seen.add(key);
		uniqueParts.push(part.text);
	}
	const content = uniqueParts
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return content.length > 100 ? content : null;
}

export function extractRSCContent(html: string): RSCExtractResult | null {
	if (!html.includes("self.__next_f.push")) return null;
	const chunkMap = parseRSCChunks(html);
	if (chunkMap.size === 0) return null;
	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
	const title = titleMatch?.[1]?.split("|")[0]?.trim() || "";
	const getParsedChunk = createChunkReader(chunkMap);
	const extractor = new RSCNodeExtractor(getParsedChunk);
	const mainChunk = getParsedChunk("23");
	if (mainChunk) {
		const content = extractor.extract(mainChunk);
		if (content.trim().length > 100) return { title, content: content.replace(/\n{3,}/g, "\n\n").trim() };
	}
	const content = fallbackContent(chunkMap, getParsedChunk, extractor);
	return content ? { title, content } : null;
}
