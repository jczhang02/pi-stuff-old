import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { terminalControlEnd } from "../shared/terminal-text.ts";

// pi-dynamic-workflows, 56489683, src/workflow-editor.ts. Freeze the violet phase for transcript text.
const RAINBOW = [
	196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45, 39, 33, 27, 21, 57,
	93, 129, 165, 201, 198, 197,
];

function rainbowCharacter(character: string, index: number): string {
	return `\u001b[38;5;${RAINBOW[(index + 26) % RAINBOW.length]}m${character}`;
}

export function rainbowSkillCommand(text: string, restore = "\u001b[39m"): string {
	return Array.from(text, rainbowCharacter).join("") + restore;
}

function foregroundAfter(control: string, previous: string): string {
	if (!control.startsWith("\u001b[") || !control.endsWith("m")) return previous;
	const codes = control.slice(2, -1).split(";");
	let foreground = previous;
	for (let index = 0; index < codes.length; index += 1) {
		const code = Number(codes[index]);
		if (code === 0 || code === 39) foreground = "\u001b[39m";
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = `\u001b[${code}m`;
		else if (code === 38 || code === 48 || code === 58) {
			const mode = codes[index + 1];
			const count = mode === "2" ? 4 : mode === "5" ? 2 : 0;
			if (count === 0 || index + count >= codes.length) break;
			if (code === 38) foreground = `\u001b[${codes.slice(index, index + count + 1).join(";")}m`;
			index += count;
		}
	}
	return foreground;
}

/** Decorate visible command text without editing OSC hyperlinks or native foreground restoration. */
export function highlightSkillCommands(text: string): string {
	const plain = stripTerminalSequences(text);
	const pattern = /(^|[^A-Za-z0-9_./:@-])(\/skill:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)(?![A-Za-z0-9_./:@-])/gu;
	const ranges = Array.from(plain.matchAll(pattern), (match) => ({
		start: match.index + (match[1]?.length ?? 0),
		end: match.index + match[0].length,
	}));
	if (ranges.length === 0) return text;
	let output = "";
	let foreground = "\u001b[39m";
	let visible = 0;
	let rangeIndex = 0;
	for (let index = 0; index < text.length; ) {
		if (text.charCodeAt(index) === 0x1b) {
			const end = terminalControlEnd(text, index);
			const control = text.slice(index, end);
			foreground = foregroundAfter(control, foreground);
			output += control;
			index = end;
			continue;
		}
		while (ranges[rangeIndex] && visible >= (ranges[rangeIndex]?.end ?? 0)) rangeIndex += 1;
		const range = ranges[rangeIndex];
		const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
		output +=
			range && visible >= range.start ? rainbowCharacter(character, visible - range.start) + foreground : character;
		visible += character.length;
		index += character.length;
	}
	return output;
}
