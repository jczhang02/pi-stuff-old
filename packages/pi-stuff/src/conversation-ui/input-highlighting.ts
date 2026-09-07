import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText as sanitizeUntrustedTerminalText, terminalControlEnd } from "../shared/terminal-text.ts";

const MAX_DESCRIPTION_CODE_UNITS = 320;

type TerminalToken = { readonly control: boolean; readonly value: string };

type HighlightRange = { readonly end: number; readonly start: number };

export function sanitizeTerminalText(value: string): string {
	return sanitizeUntrustedTerminalText(value.slice(0, MAX_DESCRIPTION_CODE_UNITS)).replace(/\s+/gu, " ").trim();
}

function terminalTokens(value: string): TerminalToken[] {
	const tokens: TerminalToken[] = [];
	for (let index = 0; index < value.length; ) {
		const code = value.charCodeAt(index);
		if (code === 0x1b || (code >= 0x80 && code <= 0x9f) || code < 0x20 || code === 0x7f) {
			const end = terminalControlEnd(value, index);
			tokens.push({ control: true, value: value.slice(index, end) });
			index = end;
			continue;
		}
		const codePoint = value.codePointAt(index) ?? code;
		const length = codePoint > 0xffff ? 2 : 1;
		tokens.push({ control: false, value: value.slice(index, index + length) });
		index += length;
	}
	return tokens;
}

function invocationRanges(plain: string, names: ReadonlySet<string>): HighlightRange[] {
	const ranges: HighlightRange[] = [];
	for (const match of plain.matchAll(/(^|[^A-Za-z0-9_./:@-])\/([A-Za-z0-9][A-Za-z0-9:._-]*)(?![A-Za-z0-9:._/-])/gu)) {
		const boundary = match[1] ?? "";
		const name = match[2];
		if (!name || match.index === undefined || !names.has(name)) continue;
		const start = match.index + boundary.length;
		ranges.push({ start, end: start + name.length + 1 });
	}
	return ranges;
}

export function styleKnownInvocations(line: string, names: ReadonlySet<string>, theme: Theme): string {
	if (names.size === 0 || !line.includes("/")) return line;
	const tokens = terminalTokens(line);
	const plain = tokens
		.filter((token) => !token.control)
		.map((token) => token.value)
		.join("");
	const ranges = invocationRanges(plain, names);
	if (ranges.length === 0) return line;

	let output = "";
	let plainOffset = 0;
	let buffered = "";
	let bufferedHighlight = false;
	const flush = (): void => {
		if (!buffered) return;
		output += bufferedHighlight ? theme.fg("accent", buffered) : buffered;
		buffered = "";
	};
	for (const token of tokens) {
		if (token.control) {
			flush();
			output += token.value;
			continue;
		}
		const highlighted = ranges.some((range) => plainOffset >= range.start && plainOffset < range.end);
		if (buffered && highlighted !== bufferedHighlight) flush();
		bufferedHighlight = highlighted;
		buffered += token.value;
		plainOffset += token.value.length;
	}
	flush();
	return output;
}
