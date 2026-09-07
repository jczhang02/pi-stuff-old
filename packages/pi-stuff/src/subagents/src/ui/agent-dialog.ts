import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	isKeyRelease,
	Key,
	type Markdown,
	matchesKey,
	parseKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
	CommandDialogComponent,
	CommandDialogCoordinator,
	CommandDialogView,
	CommandDialogViewContext,
} from "../../../conversation-ui/index.ts";
import {
	commandDialogExitKeyHelp,
	commandDialogListIndex,
	commandDialogListKeyHelp,
	commandDialogNavigation,
	commandDialogReadKeyHelp,
	commandDialogScrollOffset,
	createMarkdownRenderer,
	matchesCommandDialogCancel,
	matchesCommandDialogConfirm,
	matchesCommandDialogHelp,
	renderCommandDialogKeyHelp,
} from "../../../conversation-ui/index.ts";
import { isRuntimeString } from "../../../shared/runtime-type.ts";
import { sanitizeTerminalInput as stripTerminalControls } from "../../../shared/terminal-text.ts";
import type {
	AgentControlAction,
	AgentControlResult,
	AgentNestedDetail,
	AgentRow,
	AgentSessionSnapshot,
	AgentTranscriptTarget,
	CurrentAgentsView,
} from "../session/current-agents.ts";
import { isTaskOnlyAgentText } from "../shared/display-description.ts";
import {
	AGENT_LIST_ROWS,
	type AgentDialogRenderMetrics,
	type AgentTranscriptItem,
	boundedTerminalText,
	type DialogMode,
	type Feedback,
	oneLine,
	RESUMABLE_STATUSES,
	renderAgentDialog,
	TERMINAL_STATUSES,
	type Transcript,
} from "./agent-dialog-renderer.ts";

export type { AgentToolOutcome, AgentTranscriptItem } from "./agent-dialog-renderer.ts";

const DEFAULT_TRANSCRIPT_CHARS = 24_000;
const MAX_TRANSCRIPT_CHARS = 64_000;
const INPUT_CHAR_LIMIT = 4_000;

export interface AgentTranscriptRequest {
	readonly maxChars: number;
	readonly row: AgentTranscriptTarget;
	readonly signal: AbortSignal;
}

export interface AgentTranscriptDocument {
	readonly items: readonly AgentTranscriptItem[];
}

/** The reader should use maxChars to bound file I/O before returning Activity. */
export type AgentTranscriptReader = (
	request: AgentTranscriptRequest,
) => Promise<AgentTranscriptDocument | string | null> | AgentTranscriptDocument | string | null;

export interface AgentDialogOptions {
	readonly initialKey?: string;
	readonly maxTranscriptChars?: number;
	readonly readTranscript: AgentTranscriptReader;
}

/** Create the normal-priority, non-overlay view used by `/agents` and roster Enter. */
export function createAgentDialogView(
	current: CurrentAgentsView,
	options: AgentDialogOptions,
): CommandDialogView<void> {
	const maxTranscriptChars = normalizeTranscriptLimit(options.maxTranscriptChars);
	return {
		priority: "normal",
		create: (context) =>
			new AgentDialogComponent(current, context, {
				initialKey: options.initialKey,
				maxTranscriptChars,
				readTranscript: options.readTranscript,
			}),
	};
}

/** Open the shared full-width surface; the coordinator owns editor/chrome restoration. */
export function openAgentDialog(
	ctx: ExtensionContext,
	coordinator: CommandDialogCoordinator,
	current: CurrentAgentsView,
	options: AgentDialogOptions,
): Promise<void> {
	return coordinator.show(ctx, createAgentDialogView(current, options)).then(() => undefined);
}

interface NormalizedOptions {
	readonly initialKey: string | undefined;
	readonly maxTranscriptChars: number;
	readonly readTranscript: AgentTranscriptReader;
}

class AgentDialogComponent implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private readonly current: CurrentAgentsView;
	private disposed = false;
	private feedback: Feedback | undefined;
	private input = "";
	private listSelectedKey: string | undefined;
	private readonly markdown: Markdown;
	private mode: DialogMode = "list";
	private nestedSelectedKey: string | undefined;
	private operationGeneration = 0;
	private operationPending = false;
	private followActivity = true;
	private readonly renderMetrics: AgentDialogRenderMetrics = {
		lastDetailMaxOffset: 0,
		lastDetailViewportRows: 1,
		listPageRows: AGENT_LIST_ROWS,
		nestedListPageRows: AGENT_LIST_ROWS,
		scrollOffset: 0,
	};
	private selectedKey: string | undefined;
	private showKeyHelp = false;
	private showToolDetails = false;
	private snapshotValue: AgentSessionSnapshot;
	private transcript: Transcript = { items: [], state: "unavailable", text: "" };
	private transcriptGeneration = 0;
	private readonly options: NormalizedOptions;
	private readonly unsubscribe: () => void;

	constructor(current: CurrentAgentsView, context: CommandDialogViewContext<void>, options: NormalizedOptions) {
		this.context = context;
		this.current = current;
		this.markdown = createMarkdownRenderer(context.theme);
		this.options = options;
		this.snapshotValue = current.snapshot();
		this.listSelectedKey = this.snapshotValue.rows[0]?.key;
		const initial = options.initialKey
			? this.snapshotValue.rows.find((row) => row.key === options.initialKey)
			: undefined;
		if (initial) {
			this.mode = "detail";
			this.selectedKey = initial.key;
			this.listSelectedKey = initial.key;
		}

		this.unsubscribe = current.subscribe((snapshot) => this.updateSnapshot(snapshot));
		if (initial) this.loadTranscript(initial, initial.key);
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (this.mode === "resume-input" || this.mode === "steer-input") {
			this.handleComposerInput(data);
			return;
		}
		if (this.showKeyHelp) {
			if (matchesCommandDialogCancel(data, this.context.keybindings)) {
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
		if (matchesCommandDialogCancel(data, this.context.keybindings)) {
			if (this.mode === "nested-detail") this.showNestedList();
			else if (this.mode === "nested-list") this.returnToDetail();
			else if (this.mode === "detail") this.showList();
			else this.context.close();
			return;
		}

		if (this.mode === "list") this.handleListInput(data);
		else if (this.mode === "nested-list") this.handleNestedListInput(data);
		else if (this.mode === "nested-detail") this.handleNestedDetailInput(data);
		else this.handleDetailInput(data);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (this.showKeyHelp) {
			const row = this.detailRow();
			const listRow = this.listRow();
			const canStop =
				(this.mode === "list" && listRow !== undefined && !TERMINAL_STATUSES.has(listRow.status)) ||
				(this.mode === "detail" && row !== undefined && !TERMINAL_STATUSES.has(row.status));
			const extras = [
				...(this.mode === "detail" && row?.nestedAgents.length
					? [{ keys: "n", description: "Inspect nested Agents" }]
					: []),
				...(this.mode === "detail" && row && !TERMINAL_STATUSES.has(row.status) && row.status !== "stopping"
					? [{ keys: "s", description: "Steer Agent" }]
					: []),
				...(this.mode === "detail" && row && RESUMABLE_STATUSES.has(row.status)
					? [{ keys: "r", description: "Resume Agent" }]
					: []),
				...(canStop ? [{ keys: "x", description: "Stop Agent" }] : []),
				...((this.mode === "detail" || this.mode === "nested-detail") && this.hasToolActivity()
					? [{ keys: "t", description: this.showToolDetails ? "Hide Tool results" : "Show Tool results" }]
					: []),
			];
			const list = this.mode === "list" || this.mode === "nested-list";
			const hasListRows =
				this.mode === "list" ? this.snapshotValue.rows.length > 0 : (row?.nestedAgents.length ?? 0) > 0;
			let keyHelp = commandDialogReadKeyHelp(this.context.keybindings, "line", extras);
			if (list) {
				keyHelp = hasListRows
					? commandDialogListKeyHelp(this.context.keybindings, "Agent", extras)
					: commandDialogExitKeyHelp(this.context.keybindings);
			}
			return renderCommandDialogKeyHelp(this.context, renderWidth, "Agents", keyHelp);
		}
		const lines = renderAgentDialog(
			this.context,
			this.markdown,
			{
				feedback: this.feedback,
				followActivity: this.followActivity,
				input: this.input,
				listSelectedKey: this.listSelectedKey,
				maxTranscriptChars: this.options.maxTranscriptChars,
				metrics: this.renderMetrics,
				mode: this.mode,
				nestedSelectedKey: this.nestedSelectedKey,
				selectedKey: this.selectedKey,
				showToolDetails: this.showToolDetails,
				snapshotValue: this.snapshotValue,
				transcript: this.transcript,
			},
			renderWidth,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.operationGeneration += 1;
		this.transcriptGeneration += 1;
		this.unsubscribe();
	}

	private updateSnapshot(snapshot: AgentSessionSnapshot): void {
		if (this.disposed) return;
		this.snapshotValue = snapshot;
		this.reconcileListSelection();
		if (this.selectedKey && !snapshot.rows.some((row) => row.key === this.selectedKey)) {
			this.mode = "list";
			this.selectedKey = undefined;
			this.input = "";
			this.renderMetrics.scrollOffset = 0;
			this.transcriptGeneration += 1;
			this.transcript = { items: [], state: "unavailable", text: "" };
			this.nestedSelectedKey = undefined;
			if (!this.operationPending) {
				this.feedback = { kind: "success", message: "Agent left the current-session list." };
			}
		}
		if (this.selectedKey && (this.mode === "nested-list" || this.mode === "nested-detail")) {
			const nested = this.detailRow()?.nestedAgents ?? [];
			if (!nested.some((row) => row.key === this.nestedSelectedKey)) {
				this.nestedSelectedKey = nested[0]?.key;
				if (this.mode === "nested-detail") this.showNestedList();
			}
		}
		this.requestRender();
	}

	private reconcileListSelection(): void {
		const rows = this.snapshotValue.rows;
		if (this.listSelectedKey && rows.some((row) => row.key === this.listSelectedKey)) return;
		this.listSelectedKey = rows[0]?.key;
	}

	private handleListInput(data: string): void {
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (navigation) {
			const rows = this.snapshotValue.rows;
			if (rows.length === 0) return;
			const currentIndex = Math.max(
				0,
				rows.findIndex((row) => row.key === this.listSelectedKey),
			);
			const nextIndex = commandDialogListIndex(
				currentIndex,
				rows.length,
				this.renderMetrics.listPageRows,
				navigation,
			);
			this.listSelectedKey = rows[nextIndex]?.key;
			if (!this.operationPending) this.feedback = undefined;
			this.requestRender();
			return;
		}
		if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			const row = this.listRow();
			if (row) this.showDetail(row);
			return;
		}
		if (decodePrintable(data)?.toLowerCase() === "x") {
			const row = this.listRow();
			if (row && !TERMINAL_STATUSES.has(row.status)) this.stop(row);
		}
	}

	private handleNestedListInput(data: string): void {
		const rows = this.detailRow()?.nestedAgents ?? [];
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (navigation) {
			if (rows.length === 0) return;
			const currentIndex = Math.max(
				0,
				rows.findIndex((row) => row.key === this.nestedSelectedKey),
			);
			const nextIndex = commandDialogListIndex(
				currentIndex,
				rows.length,
				this.renderMetrics.nestedListPageRows,
				navigation,
			);
			this.nestedSelectedKey = rows[nextIndex]?.key;
			this.requestRender();
			return;
		}
		if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			const row = this.nestedDetailRow();
			if (row) this.showNestedDetail(row);
		}
	}

	private handleNestedDetailInput(data: string): void {
		if (decodePrintable(data)?.toLowerCase() === "t" && this.hasToolActivity()) {
			this.showToolDetails = !this.showToolDetails;
			this.requestRender();
			return;
		}
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (!navigation) return;
		this.scrollDetail(navigation);
	}

	private handleDetailInput(data: string): void {
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (navigation) {
			this.scrollDetail(navigation);
			return;
		}

		const row = this.detailRow();
		if (!row) {
			this.showList();
			return;
		}
		const printable = decodePrintable(data)?.toLowerCase();
		if (printable === "t" && this.hasToolActivity()) {
			this.showToolDetails = !this.showToolDetails;
			this.requestRender();
			return;
		}
		if (this.operationPending) return;
		if (printable === "x" && !TERMINAL_STATUSES.has(row.status)) {
			this.stop(row);
			return;
		}
		if (printable === "s" && !TERMINAL_STATUSES.has(row.status) && row.status !== "stopping") {
			this.mode = "steer-input";
			this.input = "";
			this.feedback = undefined;
			this.requestRender();
			return;
		}
		if (printable === "r" && RESUMABLE_STATUSES.has(row.status)) {
			this.mode = "resume-input";
			this.input = "";
			this.feedback = undefined;
			this.requestRender();
			return;
		}
		if (printable === "n" && row.nestedAgents.length > 0) this.showNestedList();
	}

	private handleComposerInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.mode = "detail";
			this.input = "";
			this.feedback = undefined;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const row = this.detailRow();
			if (!row) {
				this.showList();
				return;
			}
			const message = this.input.trim();
			if (this.mode === "steer-input" && message.length === 0) {
				this.feedback = { kind: "error", message: "Enter a steering message." };
				this.requestRender();
				return;
			}
			const action: AgentControlAction =
				this.mode === "steer-input"
					? { type: "steer", key: row.key, message }
					: message
						? { type: "resume", key: row.key, message }
						: { type: "resume", key: row.key };
			this.mode = "detail";
			this.input = "";
			this.runControl(action);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.input = Array.from(this.input).slice(0, -1).join("");
			this.feedback = undefined;
			this.requestRender();
			return;
		}
		const printable = decodePrintable(data);
		if (printable === undefined || this.input.length >= INPUT_CHAR_LIMIT) return;
		const safeInput = stripTerminalControls(printable);
		if (!safeInput) return;
		this.input = `${this.input}${safeInput}`.slice(0, INPUT_CHAR_LIMIT);
		this.feedback = undefined;
		this.requestRender();
	}

	private stop(row: AgentRow): void {
		this.runControl({ type: "stop", key: row.key });
	}

	private runControl(action: Exclude<AgentControlAction, { type: "inspect" }>): void {
		if (this.operationPending || this.disposed) return;
		this.operationPending = true;
		const generation = ++this.operationGeneration;
		this.feedback = { kind: "pending", message: pendingMessage(action.type) };
		this.requestRender();

		void Promise.resolve()
			.then(() => this.current.control(action))
			.then((result) => this.finishControl(generation, result))
			.catch((error) => {
				if (!this.canFinishOperation(generation)) return;
				this.operationPending = false;
				this.feedback = {
					kind: "error",
					message: `Request failed: ${oneLine(errorMessage(error)) || "unknown error"}`,
				};
				this.requestRender();
			});
	}

	private finishControl(generation: number, result: AgentControlResult): void {
		if (!this.canFinishOperation(generation)) return;
		this.operationPending = false;
		this.feedback = {
			kind: result.acknowledged ? "success" : "error",
			message: result.acknowledged
				? `Acknowledged: ${oneLine(result.message) || "request accepted"}`
				: `Not acknowledged: ${oneLine(result.message) || "request rejected"}`,
		};
		this.requestRender();
	}

	private canFinishOperation(generation: number): boolean {
		return !this.disposed && generation === this.operationGeneration;
	}

	private showList(): void {
		if (this.selectedKey) this.listSelectedKey = this.selectedKey;
		this.mode = "list";
		this.selectedKey = undefined;
		this.nestedSelectedKey = undefined;
		this.input = "";
		this.resetDetailViewport();
		this.transcriptGeneration += 1;
		this.transcript = { items: [], state: "unavailable", text: "" };
		this.showToolDetails = false;
		if (!this.operationPending) this.feedback = undefined;
		this.reconcileListSelection();
		this.requestRender();
	}

	private showDetail(row: AgentRow): void {
		this.mode = "detail";
		this.selectedKey = row.key;
		this.nestedSelectedKey = row.nestedAgents[0]?.key;
		this.listSelectedKey = row.key;
		this.resetDetailViewport();
		this.showToolDetails = false;
		if (!this.operationPending) this.feedback = undefined;
		this.loadTranscript(row, row.key);
		this.requestRender();
	}

	private returnToDetail(): void {
		const row = this.detailRow();
		if (!row) {
			this.showList();
			return;
		}
		this.mode = "detail";
		this.resetDetailViewport();
		this.showToolDetails = false;
		this.loadTranscript(row, row.key);
		this.requestRender();
	}

	private showNestedList(): void {
		const row = this.detailRow();
		if (!row?.nestedAgents.length) {
			this.returnToDetail();
			return;
		}
		this.mode = "nested-list";
		if (!row.nestedAgents.some((nested) => nested.key === this.nestedSelectedKey)) {
			this.nestedSelectedKey = row.nestedAgents[0]?.key;
		}
		this.resetDetailViewport();
		this.transcriptGeneration += 1;
		this.transcript = { items: [], state: "unavailable", text: "" };
		this.showToolDetails = false;
		this.requestRender();
	}

	private showNestedDetail(row: AgentNestedDetail): void {
		this.mode = "nested-detail";
		this.nestedSelectedKey = row.key;
		this.renderMetrics.scrollOffset = 0;
		this.followActivity = true;
		this.renderMetrics.lastDetailMaxOffset = 0;
		this.renderMetrics.lastDetailViewportRows = 1;
		this.showToolDetails = false;
		this.loadTranscript(row, row.key);
		this.requestRender();
	}

	private loadTranscript(row: AgentTranscriptTarget, selectionKey: string): void {
		const generation = ++this.transcriptGeneration;
		this.transcript = { items: [], state: "loading", text: "" };
		void Promise.resolve()
			.then(() =>
				this.options.readTranscript({
					maxChars: this.options.maxTranscriptChars,
					row,
					signal: this.context.signal,
				}),
			)
			.then((value) => {
				if (!this.canFinishTranscript(generation, selectionKey)) return;
				const rawText = isRuntimeString(value) ? boundedTerminalText(value, this.options.maxTranscriptChars) : "";
				const text = isTaskOnlyAgentText(rawText, row.task) ? "" : rawText;
				const partial = row.partialResult
					? isTaskOnlyAgentText(row.partialResult, row.task)
						? ""
						: boundedTerminalText(row.partialResult, Math.min(this.options.maxTranscriptChars, 4_000))
					: "";
				const items = isRuntimeString(value)
					? text
						? [{ kind: "message", speaker: null, text } satisfies AgentTranscriptItem]
						: []
					: (value?.items ?? []);
				const onlyPartial =
					items.length === 1 && items[0]?.kind === "message" && items[0].text.trim() === partial.trim();
				this.transcript =
					items.length > 0 && !onlyPartial
						? { items, state: "ready", text: "" }
						: { items: [], state: "unavailable", text: "" };
				this.renderMetrics.scrollOffset = 0;
				this.requestRender();
			})
			.catch((error) => {
				if (!this.canFinishTranscript(generation, selectionKey)) return;
				this.transcript = {
					items: [],
					state: "error",
					text: `Unable to read Activity: ${oneLine(errorMessage(error))}`,
				};
				this.renderMetrics.scrollOffset = 0;
				this.requestRender();
			});
	}

	private canFinishTranscript(generation: number, key: string): boolean {
		const selected = this.mode === "nested-detail" ? this.nestedSelectedKey : this.selectedKey;
		return !this.disposed && generation === this.transcriptGeneration && selected === key;
	}

	private listRow(): AgentRow | undefined {
		return this.snapshotValue.rows.find((row) => row.key === this.listSelectedKey);
	}

	private detailRow(): AgentRow | undefined {
		return this.snapshotValue.rows.find((row) => row.key === this.selectedKey);
	}

	private nestedDetailRow(): AgentNestedDetail | undefined {
		return this.detailRow()?.nestedAgents.find((row) => row.key === this.nestedSelectedKey);
	}

	private hasToolActivity(): boolean {
		return this.transcript.items.some((item) => item.kind === "tool");
	}

	private resetDetailViewport(): void {
		this.renderMetrics.scrollOffset = 0;
		this.renderMetrics.lastDetailMaxOffset = 0;
		this.renderMetrics.lastDetailViewportRows = 1;
		this.followActivity = true;
	}

	private scrollDetail(navigation: NonNullable<ReturnType<typeof commandDialogNavigation>>): void {
		this.renderMetrics.scrollOffset = commandDialogScrollOffset(
			this.renderMetrics.scrollOffset,
			this.renderMetrics.lastDetailMaxOffset,
			this.detailViewportRows(),
			navigation,
		);
		this.followActivity =
			navigation === "end" || this.renderMetrics.scrollOffset >= this.renderMetrics.lastDetailMaxOffset;
		this.requestRender();
	}

	private detailViewportRows(): number {
		return this.renderMetrics.lastDetailViewportRows;
	}

	private requestRender(): void {
		if (!this.disposed) this.context.requestRender();
	}
}

function normalizeTranscriptLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TRANSCRIPT_CHARS;
	if (!Number.isFinite(value) || value <= 0) throw new Error("maxTranscriptChars must be a positive finite number");
	return Math.min(MAX_TRANSCRIPT_CHARS, Math.max(1, Math.floor(value)));
}

function pendingMessage(type: Exclude<AgentControlAction, { type: "inspect" }>["type"]): string {
	switch (type) {
		case "resume":
			return "Resuming… waiting for acknowledgement.";
		case "steer":
			return "Sending guidance… waiting for acknowledgement.";
		case "stop":
			return "Stopping… waiting for acknowledgement.";
	}
}

function decodePrintable(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable !== undefined) return kittyPrintable;
	const parsed = parseKey(data);
	if (parsed !== undefined && [...parsed].length === 1) return parsed;
	if ([...data].length !== 1) return undefined;
	const codePoint = data.codePointAt(0);
	return codePoint !== undefined && codePoint >= 32 && codePoint !== 127 ? data : undefined;
}

function errorMessage<Failure>(error: Failure): string {
	return error instanceof Error ? error.message : String(error);
}
