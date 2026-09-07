import { sanitizeTerminalText } from "../shared/terminal-text.ts";

const MAX_DYNAMIC_TEXT_CODE_UNITS = 16 * 1024;

export function sanitizeOneLine(value: string): string {
	return sanitizeTerminalText(value.slice(0, MAX_DYNAMIC_TEXT_CODE_UNITS)).replace(/\s+/gu, " ").trim();
}
