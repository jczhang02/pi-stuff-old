import {
	type MarkdownTransformer,
	type parseSkillBlock,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	type Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { highlightSkillCommands, rainbowSkillCommand } from "./skill-command-style.ts";
import { sanitizeOneLine } from "./terminal-text.ts";
import { TRANSCRIPT_CONTINUATION } from "./transcript.ts";

type SkillBlock = NonNullable<ReturnType<typeof parseSkillBlock>>;

export interface UserMessageCardOptions {
	readonly markdownTheme: MarkdownTheme;
	readonly outputPad: number;
	readonly transformers: readonly MarkdownTransformer[];
	readonly skill: SkillBlock | null;
	readonly fallback: Container;
	readonly fail: (error: Error) => void;
}

function nativeBody(message: UserMessageComponent) {
	const box = message.children[0];
	const markdown = box instanceof Box ? box.children[0] : undefined;
	if (
		message.children.length !== 1 ||
		!(box instanceof Box) ||
		box.children.length !== 1 ||
		!(markdown instanceof Markdown)
	) {
		throw new Error("User Message presentation requires the certified Pi UserMessageComponent layout");
	}
	return { box, markdown };
}

interface NativeMarkdownBlock {
	readonly type: string;
}

// Observe Pi's parsed first block on this card's Markdown instance; no parallel Markdown grammar or global patch.
function observeBlocks(markdown: Markdown, decorate: (type: string, rows: string[]) => string[]): void {
	const method: unknown = Object.getOwnPropertyDescriptor(Markdown.prototype, "renderToken")?.value;
	if (!isRuntimeFunction(method))
		throw new Error("User Message presentation requires the certified Pi token renderer");
	let depth = 0;
	// SAFETY: this validated callable has Pi 0.85.1's token-render signature and receives native parser output unchanged.
	const renderToken = method as (
		this: Markdown,
		token: NativeMarkdownBlock,
		width: number,
		...args: unknown[]
	) => string[];
	Object.defineProperty(markdown, "renderToken", {
		configurable: true,
		value: function (this: Markdown, token: NativeMarkdownBlock, width: number, ...args: unknown[]): string[] {
			if (!isRuntimeObject(token) || token === null || !("type" in token) || !isRuntimeString(token.type)) {
				throw new Error("User Message presentation requires the certified Pi Markdown token");
			}
			depth += 1;
			try {
				const rows = renderToken.call(this, token, width, ...args);
				return depth === 1 ? decorate(token.type, rows) : rows;
			} finally {
				depth -= 1;
			}
		},
	});
}

// Color native inline output before Pi wraps it; Markdown syntax and hyperlink targets stay native.
function highlightInlineSkills(markdown: Markdown): void {
	const method: unknown = Object.getOwnPropertyDescriptor(Markdown.prototype, "renderInlineTokens")?.value;
	if (!isRuntimeFunction(method))
		throw new Error("User Message presentation requires the certified Pi inline renderer");
	let depth = 0;
	// SAFETY: forward the certified method's opaque arguments unchanged, and validate its rendered string.
	const render = method as (this: Markdown, ...args: unknown[]) => string;
	Object.defineProperty(markdown, "renderInlineTokens", {
		configurable: true,
		value: function (this: Markdown, ...args: unknown[]): string {
			depth += 1;
			try {
				const text: unknown = render.apply(this, args);
				if (!isRuntimeString(text)) throw new Error("User Message inline rendering returned non-text");
				return depth === 1 ? highlightSkillCommands(text) : text;
			} finally {
				depth -= 1;
			}
		},
	});
}

class PromptContent implements Component {
	private readonly markdown: Markdown;
	private readonly skill: SkillBlock | null;
	private readonly style: MarkdownTheme;
	private readonly marker: boolean;
	private prefixPending = true;
	private cachedWidth: number | undefined;
	private cachedRows: string[] | undefined;

	constructor(markdown: Markdown, skill: SkillBlock | null, style: MarkdownTheme, marker = true) {
		this.markdown = markdown;
		this.skill = skill;
		this.style = style;
		this.marker = marker;
		highlightInlineSkills(markdown);
		if (skill)
			observeBlocks(markdown, (type, rows) => {
				if (!this.prefixPending || type === "space") return rows;
				this.prefixPending = false;
				const label = rainbowSkillCommand(`/skill:${sanitizeOneLine(skill.name)}`);
				return type === "paragraph" ? [`${label} ${rows[0] ?? ""}`, ...rows.slice(1)] : [label, ...rows];
			});
	}

	invalidate(): void {
		this.cachedRows = undefined;
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedRows && this.cachedWidth === width) return this.cachedRows;
		if (width <= 2) return width > 0 && this.marker ? [""] : [];
		this.prefixPending = true;
		const rows = [...this.markdown.render(width - 2)];
		if (this.skill && rows.length === 0) {
			rows.push(...wrapTextWithAnsi(rainbowSkillCommand(`/skill:${sanitizeOneLine(this.skill.name)}`), width - 2));
		}
		this.cachedWidth = width;
		this.cachedRows = rows.map(
			(row, index) => `${index === 0 && this.marker ? `${this.style.quote("")} ` : TRANSCRIPT_CONTINUATION}${row}`,
		);
		return this.cachedRows;
	}
}

/** Native card and terminal markers, with one prompt gutter and optional inline Skill detail. */
export class UserMessageCard extends UserMessageComponent {
	private expanded = false;
	private padding: number;
	private failed = false;
	private readonly options: UserMessageCardOptions;

	constructor(prompt: string, options: UserMessageCardOptions) {
		super(prompt, options.markdownTheme, options.outputPad, options.transformers);
		this.options = options;
		this.padding = options.outputPad;
		this.compose();
	}

	private compose(): void {
		const { box, markdown } = nativeBody(this);
		box.clear();
		box.addChild(new PromptContent(markdown, this.options.skill, this.options.markdownTheme));
		if (this.expanded && this.options.skill) {
			box.addChild(new Spacer(1));
			box.addChild(
				new Markdown("Skill instructions", 2, 0, this.options.markdownTheme, {
					color: this.options.markdownTheme.quote,
				}),
			);
			const instructions = new UserMessageComponent(this.options.skill.content, this.options.markdownTheme, 0);
			box.addChild(new PromptContent(nativeBody(instructions).markdown, null, this.options.markdownTheme, false));
		}
	}

	setExpanded(expanded: boolean): void {
		if (!this.options.skill || this.expanded === expanded) return;
		this.expanded = expanded;
		for (const child of this.options.fallback.children) {
			if (child instanceof SkillInvocationMessageComponent) child.setExpanded(expanded);
		}
		this.setOutputPad(this.padding);
	}

	override setOutputPad(padding: number): void {
		this.padding = padding;
		for (const child of this.options.fallback.children) {
			if (child instanceof UserMessageComponent) child.setOutputPad(padding);
		}
		if (this.failed) return;
		try {
			super.setOutputPad(padding);
			this.compose();
		} catch (error) {
			this.recover(error instanceof Error ? error : new Error("User Message layout failed"));
		}
	}

	private recover(error: Error): void {
		if (this.failed) return;
		this.failed = true;
		this.options.fail(error);
	}

	override invalidate(): void {
		super.invalidate();
		this.options.fallback.invalidate();
	}

	override render(width: number): string[] {
		if (!this.failed) {
			try {
				return super.render(width);
			} catch (error) {
				this.recover(error instanceof Error ? error : new Error("User Message rendering failed"));
			}
		}
		return this.options.fallback.render(width);
	}
}
