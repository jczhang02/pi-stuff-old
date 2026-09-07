import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	decodeKittyPrintable,
	Key,
	Loader,
	type Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CommandDialogKeybindings,
	commandDialogNavigation,
	commandDialogPrimaryKey,
	commandDialogReadKeyHelp,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogScrollOffset,
	createMarkdownRenderer,
	fitCommandDialogRows,
	matchesCommandDialogCancel,
	matchesCommandDialogHelp,
	renderCommandDialogKeyHelp,
} from "../conversation-ui/index.ts";
import { sanitizeTerminalProse as stripTerminalControls } from "../shared/terminal-text.ts";
import { BTW_VISIBLE_HISTORY_LIMIT, type BtwExchange } from "./btw-history.ts";

const GUTTER = "  ";
const COPY_FEEDBACK_MS = 2_000;
const SCROLL_STEP = 3;
const EMPTY_GUIDANCE = "Ask a question with /btw <question>.";

type DisplayState = "empty" | "pending" | "success" | "error";

interface DisplayExchange {
	id: string | undefined;
	question: string;
	answer: string;
	state: DisplayState;
	error: string | undefined;
	timestamp: number;
	contextTrimmed: boolean;
	response: BtwExchange["response"];
}

export interface BtwDialogOptions {
	readonly question?: string;
	readonly history: readonly BtwExchange[];
	readonly error?: string;
	readonly onClose: () => void;
	readonly onClearEarlier: (currentId: string | undefined) => void;
	readonly onFork: (exchange: BtwExchange, signal: AbortSignal) => Promise<void>;
	readonly copyText?: (text: string) => Promise<void>;
}

function successfulDisplay(exchange: BtwExchange): DisplayExchange {
	return {
		id: exchange.id,
		question: exchange.question,
		answer: exchange.answer,
		state: "success",
		error: undefined,
		timestamp: exchange.timestamp,
		contextTrimmed: exchange.contextTrimmed,
		response: exchange.response,
	};
}

function oneLine(text: string): string {
	return stripTerminalControls(text).replace(/\s+/g, " ").trim();
}

function bounded(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…");
}

function divider(theme: Theme, width: number): string {
	return theme.fg("border", "━".repeat(Math.max(1, width)));
}

function hintLines(theme: Theme, width: number, hints: readonly string[]): string[] {
	const available = Math.max(1, width - GUTTER.length);
	const lines: string[] = [];
	let current = "";
	for (const hint of hints) {
		const candidate = current.length === 0 ? hint : `${current} · ${hint}`;
		if (current.length > 0 && visibleWidth(candidate) > available) {
			lines.push(`${GUTTER}${theme.fg("dim", current)}`);
			current = hint;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) lines.push(`${GUTTER}${theme.fg("dim", current)}`);
	return lines.length > 0 ? lines : [`${GUTTER}${theme.fg("dim", "Esc close")}`];
}

function questionLine(theme: Theme, exchange: DisplayExchange, selected: boolean, width: number): string {
	const command = theme.fg(selected ? "accent" : "dim", "/btw");
	const question = oneLine(exchange.question);
	const text = selected ? theme.fg("text", question) : theme.fg("muted", question);
	return bounded(`${GUTTER}${command}${question.length > 0 ? ` ${text}` : ""}`, width);
}

export class BtwDialogController implements Component {
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly loader: Loader;
	private readonly markdown: Markdown;
	private readonly keybindings: CommandDialogKeybindings;
	private readonly promotionController = new AbortController();
	private readonly closeDialog: () => void;
	private readonly clearEarlier: (currentId: string | undefined) => void;
	private readonly forkExchange: (exchange: BtwExchange, signal: AbortSignal) => Promise<void>;
	private readonly copyText: (text: string) => Promise<void>;
	private exchanges: DisplayExchange[];
	private currentIndex: number;
	private selectedIndex: number;
	private scrollTop = 0;
	private lastViewportHeight = 1;
	private lastMaximumScroll = 0;
	private followTail = true;
	private feedback: { kind: "success" | "error" | "dim"; text: string } | undefined;
	private copyTimer: ReturnType<typeof setTimeout> | undefined;
	private promoting = false;
	private clearConfirmation = false;
	private disposed = false;
	private showKeyHelp = false;

	constructor(theme: Theme, tui: TUI, keybindings: CommandDialogKeybindings, options: BtwDialogOptions) {
		this.theme = theme;
		this.tui = tui;
		this.keybindings = keybindings;
		this.closeDialog = options.onClose;
		this.clearEarlier = options.onClearEarlier;
		this.forkExchange = options.onFork;
		this.copyText = options.copyText ?? copyToClipboard;
		this.exchanges = options.history.map(successfulDisplay);
		if (options.question !== undefined) {
			this.exchanges.push({
				id: undefined,
				question: options.question,
				answer: "",
				state: options.error === undefined ? "pending" : "error",
				error: options.error,
				timestamp: Date.now(),
				contextTrimmed: false,
				response: undefined,
			});
		}
		if (this.exchanges.length === 0) {
			this.exchanges.push({
				id: undefined,
				question: "",
				answer: "",
				state: options.error === undefined ? "empty" : "error",
				error: options.error ?? EMPTY_GUIDANCE,
				timestamp: Date.now(),
				contextTrimmed: false,
				response: undefined,
			});
		}
		this.currentIndex = this.exchanges.length - 1;
		this.selectedIndex = this.currentIndex;
		this.markdown = createMarkdownRenderer(theme);
		this.loader = new Loader(
			tui,
			(frame) => theme.fg("accent", frame),
			(message) => theme.fg("muted", message),
			"Answering…",
		);
		if (this.exchangeAt(this.currentIndex).state !== "pending") this.loader.stop();
	}

	appendText(delta: string): void {
		const current = this.exchanges[this.currentIndex];
		if (this.disposed || current?.state !== "pending") return;
		current.answer += delta;
		this.requestRender();
	}

	resetForRetry(): void {
		const current = this.exchanges[this.currentIndex];
		if (this.disposed || !current) return;
		current.answer = "";
		current.error = undefined;
		current.state = "pending";
		this.scrollTop = 0;
		this.followTail = true;
		this.feedback = undefined;
		this.clearConfirmation = false;
		this.requestRender();
	}

	setSuccess(exchange: BtwExchange): void {
		const current = this.exchanges[this.currentIndex];
		if (this.disposed || !current) return;
		current.id = exchange.id;
		current.answer = exchange.answer;
		current.state = "success";
		current.error = undefined;
		current.contextTrimmed = exchange.contextTrimmed;
		current.timestamp = exchange.timestamp;
		current.response = exchange.response;
		this.selectedIndex = this.currentIndex;
		this.followTail = true;
		this.loader.stop();
		this.requestRender();
	}

	setError(message: string, partial: string): void {
		const current = this.exchanges[this.currentIndex];
		if (this.disposed || !current) return;
		current.answer = partial;
		current.error = message;
		current.state = "error";
		this.selectedIndex = this.currentIndex;
		this.followTail = true;
		this.loader.stop();
		this.requestRender();
	}

	handleInput(data: string): void {
		const printable = decodeKittyPrintable(data) ?? data;
		if (this.clearConfirmation) {
			if (matchesKey(data, Key.escape) || printable === "n") {
				this.clearConfirmation = false;
				this.requestRender();
			} else if (printable === "y") {
				this.clearConfirmation = false;
				this.clearEarlierHistory();
			}
			return;
		}
		if (this.showKeyHelp) {
			if (matchesCommandDialogCancel(data, this.keybindings)) {
				this.showKeyHelp = false;
				this.requestRender();
			}
			return;
		}
		if (matchesCommandDialogHelp(data)) {
			this.showKeyHelp = true;
			this.requestRender();
			return;
		}
		if (matchesCommandDialogCancel(data, this.keybindings)) {
			this.closeDialog();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.select(Math.max(0, this.selectedIndex - 1));
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.select(Math.min(this.exchanges.length - 1, this.selectedIndex + 1));
			return;
		}
		const navigation = commandDialogNavigation(data, this.keybindings);
		if (navigation) {
			this.scrollTop = commandDialogScrollOffset(
				this.scrollTop,
				this.lastMaximumScroll,
				this.lastViewportHeight,
				navigation,
				SCROLL_STEP,
			);
			this.followTail = navigation === "end" || this.scrollTop >= this.lastMaximumScroll;
			this.requestRender();
			return;
		}
		if (printable === "c") {
			void this.copySelected();
			return;
		}
		if (printable === "f") {
			void this.promoteSelected();
			return;
		}
		if (printable === "x" && this.hasEarlier()) {
			this.clearConfirmation = true;
			this.feedback = undefined;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.showKeyHelp) {
			return renderCommandDialogKeyHelp(
				{ keybindings: this.keybindings, theme: this.theme, tui: this.tui },
				width,
				"BTW",
				commandDialogReadKeyHelp(this.keybindings, "scroll step", [
					...(this.exchanges.length > 1 ? [{ keys: "←/→", description: "Switch retained answers" }] : []),
					{ keys: "c", description: "Copy answer" },
					{ keys: "f", description: "Fork answer into a session" },
					...(this.hasEarlier() ? [{ keys: "x", description: "Clear earlier history" }] : []),
				]),
			);
		}
		const selected = this.exchangeAt(this.selectedIndex);
		const historyLines = this.renderHistory(width);
		const answerWidth = Math.max(1, width - GUTTER.length);
		const answerLines = this.renderAnswer(selected, answerWidth);
		const maximumRows = commandDialogRows({ tui: this.tui });
		if (maximumRows === 0) return [];
		let viewportHeight = Math.max(0, maximumRows - historyLines.length - 3);
		let maxScroll = Math.max(0, answerLines.length - viewportHeight);
		let footer = this.renderFooter(selected, width, maxScroll);
		viewportHeight = Math.max(0, maximumRows - historyLines.length - footer.length - 3);
		maxScroll = Math.max(0, answerLines.length - viewportHeight);
		this.lastMaximumScroll = maxScroll;
		footer = this.renderFooter(selected, width, maxScroll);
		this.lastViewportHeight = Math.max(1, viewportHeight);
		if (this.followTail) this.scrollTop = maxScroll;
		this.scrollTop = Math.min(maxScroll, Math.max(0, this.scrollTop));
		if (this.scrollTop === maxScroll) this.followTail = true;

		const visibleAnswer = answerLines
			.slice(this.scrollTop, this.scrollTop + viewportHeight)
			.map((line) => bounded(`${GUTTER}${line}`, width));
		const selectedQuestion = questionLine(this.theme, selected, true, width);
		const priorityAnswer =
			selected.state === "error"
				? answerLines.at(-1)
					? bounded(`${GUTTER}${answerLines.at(-1)}`, width)
					: undefined
				: visibleAnswer.find((line) => line.trim().length > 0);
		return fitCommandDialogRows(
			{
				header: [divider(this.theme, width)],
				overflowTitle: selectedQuestion,
				priority: [selectedQuestion, ...(priorityAnswer ? [priorityAnswer] : [])],
				body: [...historyLines, "", ...visibleAnswer, ""],
				footer,
			},
			maximumRows,
		);
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.loader.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.promotionController.abort();
		this.loader.stop();
		if (this.copyTimer) clearTimeout(this.copyTimer);
		this.copyTimer = undefined;
	}

	private requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	private select(index: number): void {
		if (index === this.selectedIndex) return;
		this.selectedIndex = index;
		this.scrollTop = 0;
		this.followTail = false;
		this.feedback = undefined;
		this.clearConfirmation = false;
		this.requestRender();
	}

	private hasEarlier(): boolean {
		return this.exchanges.length > 1;
	}

	private clearEarlierHistory(): void {
		const selected = this.exchangeAt(this.selectedIndex);
		const active = this.exchangeAt(this.currentIndex);
		const retained = active.state === "pending" ? active : selected;
		this.clearEarlier(retained.state === "success" ? retained.id : undefined);
		this.exchanges = [retained];
		this.currentIndex = 0;
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.followTail = true;
		this.feedback = { kind: "success", text: "Cleared BTW history" };
		this.requestRender();
	}

	private async copySelected(): Promise<void> {
		const selected = this.exchangeAt(this.selectedIndex);
		if (selected.state !== "success" || selected.answer.length === 0) return;
		try {
			await this.copyText(stripTerminalControls(selected.answer));
			this.feedback = { kind: "success", text: "Copied answer" };
		} catch {
			this.feedback = { kind: "error", text: "Could not copy answer" };
		}
		if (this.copyTimer) clearTimeout(this.copyTimer);
		this.copyTimer = setTimeout(() => {
			this.feedback = undefined;
			this.copyTimer = undefined;
			this.requestRender();
		}, COPY_FEEDBACK_MS);
		this.copyTimer.unref();
		this.requestRender();
	}

	private async promoteSelected(): Promise<void> {
		const selected = this.exchangeAt(this.selectedIndex);
		if (this.promoting || selected.state !== "success" || !selected.id) return;
		this.promoting = true;
		this.feedback = { kind: "dim", text: "Waiting for the main Agent to finish…" };
		this.requestRender();
		try {
			const exchange = {
				id: selected.id,
				question: selected.question,
				answer: selected.answer,
				timestamp: selected.timestamp,
				contextTrimmed: selected.contextTrimmed,
			};
			await this.forkExchange(
				selected.response === undefined ? exchange : { ...exchange, response: selected.response },
				this.promotionController.signal,
			);
		} catch (error) {
			if (this.disposed || this.promotionController.signal.aborted) return;
			this.promoting = false;
			this.feedback = {
				kind: "error",
				text: error instanceof Error ? error.message : "Could not fork this BTW exchange",
			};
			this.requestRender();
		}
	}

	private renderHistory(width: number): string[] {
		const maximumStart = Math.max(0, this.exchanges.length - BTW_VISIBLE_HISTORY_LIMIT);
		const start = Math.min(maximumStart, Math.max(0, this.selectedIndex - BTW_VISIBLE_HISTORY_LIMIT + 1));
		const end = Math.min(this.exchanges.length, start + BTW_VISIBLE_HISTORY_LIMIT);
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const exchange = this.exchanges[index];
			if (exchange) lines.push(questionLine(this.theme, exchange, index === this.selectedIndex, width));
		}
		return lines;
	}

	private exchangeAt(index: number): DisplayExchange {
		const exchange = this.exchanges[index];
		if (!exchange) throw new Error(`Missing /btw display exchange at index ${index}`);
		return exchange;
	}

	private renderAnswer(exchange: DisplayExchange, width: number): string[] {
		const safeAnswer = stripTerminalControls(exchange.answer);
		this.markdown.setText(safeAnswer);
		const lines = safeAnswer.length > 0 ? this.markdown.render(Math.max(1, width)) : [];
		if (exchange.state === "pending") {
			lines.push(...this.loader.render(Math.max(1, width)));
		} else if (exchange.state === "empty") {
			const empty = stripTerminalControls(exchange.error ?? EMPTY_GUIDANCE);
			lines.push(...wrapTextWithAnsi(this.theme.fg("muted", empty), Math.max(1, width)));
		} else if (exchange.state === "error") {
			const error = stripTerminalControls(exchange.error ?? "Unknown /btw error");
			lines.push(...wrapTextWithAnsi(this.theme.fg("error", error), Math.max(1, width)));
		}
		return lines.length > 0 ? lines : [this.theme.fg("dim", "(empty answer)")];
	}

	private renderFooter(exchange: DisplayExchange, width: number, maxScroll: number): string[] {
		if (this.clearConfirmation) {
			return hintLines(this.theme, width, ["Clear BTW history?", "y to confirm", "Esc to cancel"]);
		}
		const cancel = commandDialogPrimaryKey(this.keybindings, "tui.select.cancel", "Esc");
		if (this.feedback) {
			return [
				bounded(`${GUTTER}${this.theme.fg(this.feedback.kind, oneLine(this.feedback.text))}`, width),
				...hintLines(this.theme, width, ["? keys", `${cancel} close`]),
			];
		}
		const hints: string[] = [];
		if (this.exchanges.length > 1) hints.push("←/→ to switch");
		const page = commandDialogReadOnlyPageHint(maxScroll > 0);
		if (page) hints.push(page);
		if (exchange.state === "success") hints.push("c to copy", "f to fork");
		if (this.hasEarlier()) hints.push("x to clear history");
		hints.push("? keys", `${cancel} close`);
		return hintLines(this.theme, width, hints);
	}
}
