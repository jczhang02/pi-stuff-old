import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	MouseRegion,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject } from "../shared/runtime-type.ts";
import { TRANSCRIPT_MARKER } from "./transcript.ts";

export const HIDDEN_THINKING_LABEL = `${TRANSCRIPT_MARKER} thoughts`;
const VISIBLE_THINKING_PREFIX = `${HIDDEN_THINKING_LABEL}: `;
const VISIBLE_THINKING_PREFIX_WIDTH = visibleWidth(VISIBLE_THINKING_PREFIX);
const THINKING_LINE_PATCH = Symbol.for("@jczhang02/pi-stuff:thinking-line-patch/v1");
// Force the Host truncator to close active ANSI and OSC 8 styles without adding a visible cell.
const TWO_CELL_TRUNCATION_SENTINEL = "🧪";

type UpdateContent = (this: AssistantMessageComponent, message: AssistantMessage, isStreaming?: boolean) => void;

interface ThinkingLinePatchState {
	original: UpdateContent;
	owners: number;
	patched: UpdateContent;
}

interface AssistantMessageInternals {
	contentContainer: Container;
	outputPad: number;
}

interface ThinkingStyle {
	color: (text: string) => string;
	italic: (text: string) => string;
}

function isTextTransform<Value>(value: Value): value is Value & ((text: string) => string) {
	return isRuntimeFunction(value);
}

function assistantInternals(component: AssistantMessageComponent): AssistantMessageInternals {
	const contentContainer: unknown = Object.getOwnPropertyDescriptor(component, "contentContainer")?.value;
	const outputPad: unknown = Object.getOwnPropertyDescriptor(component, "outputPad")?.value;
	if (
		!(contentContainer instanceof Container) ||
		!isRuntimeNumber(outputPad) ||
		!Number.isSafeInteger(outputPad) ||
		outputPad < 0
	) {
		throw new Error("Pi Stuff Thinking line requires the certified Pi Host AssistantMessageComponent layout");
	}
	return { contentContainer, outputPad };
}

function thinkingStyle(component: Markdown): ThinkingStyle | undefined {
	if (!Object.hasOwn(component, "defaultTextStyle") || !Object.hasOwn(component, "theme")) {
		throw new Error("Pi Stuff Thinking line requires the certified Pi Host Markdown layout");
	}
	const style: unknown = Object.getOwnPropertyDescriptor(component, "defaultTextStyle")?.value;
	if (style === undefined) return undefined;
	const theme: unknown = Object.getOwnPropertyDescriptor(component, "theme")?.value;
	if (
		style !== null &&
		isRuntimeObject(style) &&
		"color" in style &&
		isTextTransform(style.color) &&
		"italic" in style &&
		style.italic === true &&
		theme !== null &&
		isRuntimeObject(theme) &&
		"italic" in theme &&
		isTextTransform(theme.italic)
	) {
		return { color: style.color, italic: theme.italic };
	}
	throw new Error("Pi Stuff Thinking line requires the certified Pi Host Markdown style contract");
}

function isThinkingLinePatchState<Value>(value: Value): value is Value & ThinkingLinePatchState {
	return (
		value !== null &&
		isRuntimeObject(value) &&
		"original" in value &&
		isRuntimeFunction(value.original) &&
		"owners" in value &&
		isRuntimeNumber(value.owners) &&
		Number.isSafeInteger(value.owners) &&
		value.owners >= 0 &&
		"patched" in value &&
		isRuntimeFunction(value.patched)
	);
}

function patchState(): ThinkingLinePatchState | undefined {
	const value: unknown = Object.getOwnPropertyDescriptor(
		AssistantMessageComponent.prototype,
		THINKING_LINE_PATCH,
	)?.value;
	if (value === undefined || isThinkingLinePatchState(value)) return value;
	throw new Error("Pi Stuff Thinking line found an incompatible Host adapter");
}

class ThinkingLine implements Component {
	private cachedLine: string | undefined;
	private cachedWidth: number | undefined;
	private readonly label: string;
	private readonly markdown: Markdown;
	private readonly outputPad: number;

	constructor(markdown: Markdown, outputPad: number, style: ThinkingStyle) {
		this.label = style.italic(style.color(VISIBLE_THINKING_PREFIX));
		this.markdown = markdown;
		this.outputPad = outputPad;
	}

	invalidate(): void {
		this.cachedLine = undefined;
		this.cachedWidth = undefined;
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.cachedLine !== undefined && this.cachedWidth === width) return [this.cachedLine];

		const leftPad = " ".repeat(Math.min(this.outputPad, width));
		let line: string;
		const availableContentWidth = width - VISIBLE_THINKING_PREFIX_WIDTH - this.outputPad * 2;
		if (availableContentWidth <= 0) {
			line = truncateToWidth(leftPad + this.label, width, "");
		} else {
			const rows = this.markdown.render(width);
			let latestLine = "";
			for (let index = rows.length - 1; index >= 0; index -= 1) {
				const row = rows[index];
				if (row !== undefined && visibleWidth(row.trim()) > 0) {
					latestLine = row;
					break;
				}
			}
			const nativeContent = sliceByColumn(latestLine, this.outputPad, width - this.outputPad * 2, true).trimEnd();
			const nativeWidth = visibleWidth(nativeContent);
			const overflow = nativeWidth - availableContentWidth;
			const content =
				overflow > 0
					? truncateToWidth(
							sliceByColumn(nativeContent, overflow, availableContentWidth, true) + TWO_CELL_TRUNCATION_SENTINEL,
							availableContentWidth,
							"",
						)
					: nativeContent;
			line = truncateToWidth(leftPad + this.label + content, width, "");
		}
		this.cachedLine = line;
		this.cachedWidth = width;
		return [line];
	}
}

function projectThinkingRegion(region: MouseRegion, outputPad: number): void {
	const child: unknown = Object.getOwnPropertyDescriptor(region, "child")?.value;
	if (child instanceof Text) return;
	if (!(child instanceof Markdown)) {
		throw new Error("Pi Stuff Thinking line requires the certified Pi Host MouseRegion layout");
	}
	const style = thinkingStyle(child);
	if (!style || !Reflect.set(region, "child", new ThinkingLine(child, outputPad, style))) {
		throw new Error("Pi Stuff Thinking line requires a writable Host Thinking region");
	}
}

function projectThinkingLines(component: AssistantMessageComponent): void {
	const internals = assistantInternals(component);
	const children = internals.contentContainer.children;
	for (let index = children.length - 1; index >= 0; index -= 1) {
		const child = children[index];
		if (!child) continue;
		// Keep the Host's mouse region and visibility callback; project only its visible child.
		const thinkingLine = child instanceof MouseRegion || child instanceof Text;
		if (child instanceof MouseRegion) projectThinkingRegion(child, internals.outputPad);
		if (!thinkingLine || index === 0 || children[index - 1] instanceof Spacer) continue;
		// Pi 0.85.1 separates Thinking from following prose, but omits the reverse text-to-Thinking boundary.
		children.splice(index, 0, new Spacer(1));
	}
}

/** Install the certified Host adapter and return its idempotent release function. */
export function installThinkingLineDisplay(): () => void {
	// ponytail: Pi 0.85.1 has no public Thinking renderer; replace this patch when the Host exposes one.
	const prototype = AssistantMessageComponent.prototype;
	let state = patchState();
	if (!state) {
		if (!isRuntimeFunction(prototype.updateContent)) {
			throw new Error("Pi Stuff Thinking line requires AssistantMessageComponent.updateContent()");
		}
		const original = prototype.updateContent;
		const patched: UpdateContent = function (message, isStreaming): void {
			original.call(this, message, isStreaming);
			if (message.content.some((block) => block.type === "thinking")) projectThinkingLines(this);
		};
		state = { original, owners: 0, patched };
		prototype.updateContent = patched;
		Object.defineProperty(prototype, THINKING_LINE_PATCH, { configurable: true, value: state });
	}
	state.owners += 1;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (patchState() !== state) return;
		state.owners -= 1;
		if (state.owners > 0) return;
		if (prototype.updateContent === state.patched) prototype.updateContent = state.original;
		Reflect.deleteProperty(prototype, THINKING_LINE_PATCH);
	};
}
