import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isRuntimeString } from "../shared/runtime-type.ts";
import { sanitizeMultilineTerminalText, sanitizeTerminalText, wellFormedText } from "../shared/terminal-text.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Keep fold ink inside its terminal cells instead of relying on a font's ellipsis bearing.
const PATH_FOLD = "...";

/** Strip terminal control protocols while retaining printable, well-formed Unicode text. */
export { sanitizeTerminalText };

/** Sanitize, flatten, and fit one display line by terminal cells without splitting a grapheme. */
export function boundTerminalLine<Value>(value: Value, maximumWidth: number, ellipsis = "…"): string {
	if (!isRuntimeString(value)) return "";
	const width = Math.max(0, Math.floor(maximumWidth));
	const line = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
	return sanitizeTerminalText(truncateToWidth(line, width, sanitizeTerminalText(ellipsis)));
}

/** Sanitize and fit a possibly multiline preview by total terminal cells. */
export function boundTerminalText(value: string, maximumWidth: number, ellipsis = "…"): string {
	const width = Math.max(0, Math.floor(maximumWidth));
	return sanitizeMultilineTerminalText(
		truncateToWidth(sanitizeMultilineTerminalText(value), width, sanitizeTerminalText(ellipsis)),
	);
}

/** Preserve the largest complete-grapheme prefix within a separate UTF-16 cap. */
export function graphemePrefix(value: string, maximumCodeUnits: number): string {
	const source = wellFormedText(value);
	const limit = Math.max(0, Math.floor(maximumCodeUnits));
	if (source.length <= limit) return source;
	let output = "";
	for (const { segment } of graphemes.segment(source)) {
		if (output.length + segment.length > limit) break;
		output += segment;
	}
	return output;
}

/** Preserve the largest complete-grapheme suffix within a separate UTF-16 cap. */
export function graphemeSuffix(value: string, maximumCodeUnits: number): string {
	const source = wellFormedText(value);
	const limit = Math.max(0, Math.floor(maximumCodeUnits));
	if (source.length <= limit) return source;
	let kept: string[] = [];
	let head = 0;
	let units = 0;
	for (const { segment } of graphemes.segment(source)) {
		kept.push(segment);
		units += segment.length;
		while (units > limit && head < kept.length) {
			units -= kept[head]?.length ?? 0;
			head += 1;
		}
		if (head >= 1_024) {
			kept = kept.slice(head);
			head = 0;
		}
	}
	return kept.slice(head).join("");
}

/** Preserve complete graphemes within a separate UTF-8 byte cap. */
export function truncateUtf8Graphemes(value: string, maximumBytes: number): string {
	const source = wellFormedText(value);
	const limit = Math.max(0, Math.floor(maximumBytes));
	let output = "";
	let bytes = 0;
	for (const { segment } of graphemes.segment(source)) {
		const segmentBytes = Buffer.byteLength(segment);
		if (bytes + segmentBytes > limit) break;
		output += segment;
		bytes += segmentBytes;
	}
	return output;
}

function pathParts(value: string) {
	const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
	const allSegments = value.split(/[\\/]+/u).filter(Boolean);
	if (value.startsWith("\\\\") || value.startsWith("//")) {
		const fixed = allSegments.slice(0, 2);
		return {
			origin:
				fixed.length === 2 ? `${separator}${separator}${fixed.join(separator)}${separator}` : separator.repeat(2),
			segments: allSegments.slice(fixed.length),
			separator,
		};
	}
	const drive = value.match(/^[A-Za-z]:[\\/]/u)?.[0];
	if (drive) return { origin: `${drive.slice(0, 2)}${separator}`, segments: allSegments.slice(1), separator };
	const relative = value.match(/^(?:(?:\.{1,2})[\\/])+/u)?.[0];
	if (relative) {
		const relativeSegments = relative.split(/[\\/]+/u).filter(Boolean).length;
		return {
			origin: relative.replaceAll(/[\\/]/gu, separator),
			segments: allSegments.slice(relativeSegments),
			separator,
		};
	}
	if (value.startsWith(`~${separator}`)) return { origin: `~${separator}`, segments: allSegments.slice(1), separator };
	if (value.startsWith("/") || value.startsWith("\\")) return { origin: separator, segments: allSegments, separator };
	return { origin: "", segments: allSegments, separator };
}

/** Collapse a path with one shared, cell-aware grammar while retaining its nearest directory and basename. */
export function compactTerminalPath(value: string, maximumWidth: number, collapseDirectories = false): string {
	const width = Math.max(0, Math.floor(maximumWidth));
	const clean = boundTerminalLine(value, Number.MAX_SAFE_INTEGER).replace(
		/(?:[⋯…](?=[\\/])|(?<=[\\/])[⋯…])/gu,
		PATH_FOLD,
	);
	if (!clean || width === 0) return "";
	const { origin, segments, separator } = pathParts(clean);
	const needsCollapse = collapseDirectories && segments.length > 2;
	if (!needsCollapse && visibleWidth(clean) <= width) return clean;

	const basename = segments.at(-1) ?? clean;
	const nearest = segments.at(-2);
	const suffix = nearest ? `${nearest}${separator}${basename}` : basename;
	const foldedSuffix = `${PATH_FOLD}${separator}${suffix}`;
	const foldedBasename = `${PATH_FOLD}${separator}${basename}`;
	const candidates = [`${origin}${foldedSuffix}`, foldedSuffix];
	if (nearest) {
		const prefix = `${PATH_FOLD}${separator}${nearest}${separator}`;
		const fittedBasename = boundTerminalLine(basename, width - visibleWidth(prefix), "…");
		if (fittedBasename) candidates.push(`${prefix}${fittedBasename}`);
	}
	candidates.push(`${origin}${foldedBasename}`, foldedBasename);
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return boundTerminalLine(basename, width, "…");
}
