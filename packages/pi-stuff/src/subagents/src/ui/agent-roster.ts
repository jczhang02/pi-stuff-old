import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type EditorComponent,
	isKeyRelease,
	Key,
	matchesKey,
	parseKey,
	type TUI,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import type { FooterTailComponent } from "../../../conversation-ui/index.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject } from "../../../shared/runtime-type.ts";
import type { AgentEffectOwner, AgentEffectTask } from "../runtime/agent-effect-owner.ts";
import type { AgentRow, AgentSessionSnapshot, CurrentAgentsView } from "../session/current-agents.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { isTerminalAgentRow, renderAgentRoster } from "./agent-roster-render.ts";

export { fitAgentDescription } from "./agent-roster-render.ts";

const WIDGET_KEY = "pi-stuff-agent-roster";
const ELAPSED_REFRESH_MS = 1_000;
const TERMINAL_LINGER_MS = 30_000;

type RosterUi = Pick<ExtensionUIContext, "getEditorText" | "notify" | "onTerminalInput" | "setWidget">;

export interface AgentRosterContext {
	readonly hasUI: boolean;
	readonly ui: RosterUi;
}

export interface AgentRosterOptions {
	readonly effects: Pick<AgentEffectOwner, "start">;
	readonly onOpen: (key: string) => Promise<void> | void;
	readonly now?: () => number;
	readonly sleep?: (delayMs: number) => Effect.Effect<void>;
}

interface IndexedRow {
	readonly index: number;
	readonly row: AgentRow;
}

/** Claude-style projection of the current session's direct children. */
export class AgentRoster {
	private readonly current: CurrentAgentsView;
	private readonly dismissedTerminalKeys = new Set<string>();
	private readonly effects: AgentRosterOptions["effects"];
	private readonly now: () => number;
	private readonly onOpen: AgentRosterOptions["onOpen"];
	private readonly sleep: NonNullable<AgentRosterOptions["sleep"]>;
	private readonly terminalStartedAt = new Map<string, number>();
	private readonly unsubscribeCurrent: () => void;
	private context: AgentRosterContext | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private refreshTask: AgentEffectTask<void, never> | undefined;
	private lingerTask: AgentEffectTask<void, never> | undefined;
	private snapshotValue: AgentSessionSnapshot;
	private suppressed = false;
	private navigationActive = false;
	private selectedKey = "main";
	private footerAttachment: { readonly tui: TUI } | undefined;
	private footerHosted = false;
	private widgetTui: TUI | undefined;
	private widgetRegistered = false;

	constructor(current: CurrentAgentsView, options: AgentRosterOptions) {
		this.current = current;
		this.effects = options.effects;
		this.onOpen = options.onOpen;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? Effect.sleep;
		this.snapshotValue = current.snapshot();
		this.reconcileTerminalStarts();
		this.unsubscribeCurrent = current.subscribe((snapshot) => {
			if (snapshot.sessionId !== this.snapshotValue.sessionId) {
				this.terminalStartedAt.clear();
				this.dismissedTerminalKeys.clear();
			}
			this.snapshotValue = snapshot;
			this.reconcileTerminalStarts();
			this.reconcileSelection();
			this.syncRegistration();
		});
	}

	setContext(context: AgentRosterContext): void {
		if (!context.hasUI) {
			this.clearRegistration();
			this.context = undefined;
			return;
		}
		if (this.context?.ui === context.ui) {
			this.context = context;
			this.syncRegistration();
			return;
		}

		this.clearRegistration();
		this.context = context;
		this.syncRegistration();
	}

	setSuppressed(suppressed: boolean): void {
		if (this.suppressed === suppressed) return;
		this.suppressed = suppressed;
		this.syncRegistration();
	}

	/** Use the shared Suite Footer, retaining belowEditor as a defensive fallback. */
	setFooterHosted(hosted: boolean): void {
		if (this.footerHosted === hosted) return;
		this.footerHosted = hosted;
		if (hosted) this.clearWidget();
		this.syncRegistration();
		this.requestRender();
	}

	/** Create the Fleetview tail rendered after the shared Statusline. */
	createFooterTail(tui: TUI, theme: Theme): FooterTailComponent & { dispose(): void } {
		const attachment = { tui };
		const navigationActive = () => this.navigationActive;
		this.footerAttachment = attachment;
		this.syncRegistration();
		return {
			get replacesBaseRow2() {
				return navigationActive();
			},
			dispose: () => {
				if (this.footerAttachment === attachment) this.footerAttachment = undefined;
			},
			invalidate: () => {},
			render: (width: number) => (this.footerHosted ? this.render(theme, width) : []),
		};
	}

	dispose(): void {
		this.unsubscribeCurrent();
		this.clearRegistration();
		this.context = undefined;
		this.navigationActive = false;
		this.selectedKey = "main";
		this.footerAttachment = undefined;
	}

	private rows(): readonly AgentRow[] {
		const now = this.now();
		return this.snapshotValue.rows.filter((row) => {
			if (!isTerminalAgentRow(row)) return true;
			if (this.dismissedTerminalKeys.has(row.key)) return false;
			const startedAt = this.terminalStartedAt.get(row.key) ?? now;
			return now - startedAt < TERMINAL_LINGER_MS;
		});
	}

	private reconcileTerminalStarts(): void {
		const present = new Set(this.snapshotValue.rows.map((row) => row.key));
		for (const key of this.terminalStartedAt.keys()) {
			if (!present.has(key)) {
				this.terminalStartedAt.delete(key);
				this.dismissedTerminalKeys.delete(key);
			}
		}
		for (const row of this.snapshotValue.rows) {
			if (!isTerminalAgentRow(row)) {
				this.terminalStartedAt.delete(row.key);
				this.dismissedTerminalKeys.delete(row.key);
				continue;
			}
			if (!this.terminalStartedAt.has(row.key)) {
				this.terminalStartedAt.set(row.key, row.endedAt ?? this.now());
			}
		}
	}

	private orderedRows(): readonly AgentRow[] {
		return this.rows()
			.map((row, index): IndexedRow => ({ index, row }))
			.sort(
				(left, right) =>
					Number(isTerminalAgentRow(left.row)) - Number(isTerminalAgentRow(right.row)) || left.index - right.index,
			)
			.map(({ row }) => row);
	}

	private reconcileSelection(): void {
		if (this.selectedKey === "main") return;
		if (this.rows().some((row) => row.key === this.selectedKey)) return;
		this.selectedKey = "main";
	}

	private syncRegistration(): void {
		const context = this.context;
		const shouldRegister = context !== undefined && !this.suppressed && this.rows().length > 0;
		if (!shouldRegister) {
			if (this.rows().length === 0) {
				this.navigationActive = false;
				this.selectedKey = "main";
			}
			this.clearRegistration();
			return;
		}

		if (!this.inputUnsubscribe) {
			this.inputUnsubscribe = context.ui.onTerminalInput((data) => this.handleInput(data));
		}
		if (!this.footerHosted && !this.widgetRegistered) {
			context.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.widgetTui = tui;
					return {
						invalidate: () => {},
						render: (width: number) => this.render(theme, width),
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		}
		if (this.footerHosted) this.clearWidget();
		this.syncRefreshTask();
		this.syncLingerTask();
		this.requestRender();
	}

	private clearRegistration(): void {
		if (this.refreshTask) void this.refreshTask.interrupt();
		this.refreshTask = undefined;
		if (this.lingerTask) void this.lingerTask.interrupt();
		this.lingerTask = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		this.clearWidget();
	}

	private clearWidget(): void {
		if (this.widgetRegistered) this.context?.ui.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.widgetTui = undefined;
	}

	private requestRender(): void {
		this.activeTui()?.requestRender();
	}

	private activeTui(): TUI | undefined {
		return this.footerAttachment?.tui ?? this.widgetTui;
	}

	private syncLingerTask(): void {
		if (this.lingerTask) void this.lingerTask.interrupt();
		this.lingerTask = undefined;
		const now = this.now();
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const row of this.snapshotValue.rows) {
			if (!isTerminalAgentRow(row)) continue;
			const startedAt = this.terminalStartedAt.get(row.key);
			if (startedAt === undefined) continue;
			const expiresAt = startedAt + TERMINAL_LINGER_MS;
			if (expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt);
		}
		if (!Number.isFinite(nextExpiry)) return;
		let task: AgentEffectTask<void, never> | undefined;
		task = this.startTask(
			this.sleep(Math.max(0, nextExpiry - now)).pipe(
				Effect.andThen(
					Effect.sync(() => {
						if (this.lingerTask !== task) return;
						this.lingerTask = undefined;
						this.reconcileSelection();
						this.syncRegistration();
					}),
				),
			),
		);
		if (task) this.lingerTask = task;
	}

	private syncRefreshTask(): void {
		const hasRunningElapsed = this.rows().some(
			(row) => row.status === "running" && isRuntimeNumber(row.startedAt) && Number.isFinite(row.startedAt),
		);
		if (!hasRunningElapsed) {
			if (this.refreshTask) void this.refreshTask.interrupt();
			this.refreshTask = undefined;
			return;
		}
		if (this.refreshTask) return;
		this.refreshTask = this.startTask(
			Effect.forever(this.sleep(ELAPSED_REFRESH_MS).pipe(Effect.andThen(Effect.sync(() => this.requestRender())))),
		);
	}

	private startTask(program: Effect.Effect<void>): AgentEffectTask<void, never> | undefined {
		try {
			return this.effects.start(program);
		} catch (error) {
			reportAgentDiagnostic("Failed to schedule Agent roster refresh:", error);
			return undefined;
		}
	}

	private handleInput(data: string): { consume?: boolean } | undefined {
		if (isKeyRelease(data)) return undefined;
		const context = this.context;
		if (!context || !this.editorHasFocus() || context.ui.getEditorText() !== "") {
			this.leaveNavigation();
			return undefined;
		}

		if (!this.navigationActive) {
			if (!matchesKey(data, Key.down)) return undefined;
			this.navigationActive = true;
			this.selectedKey = "main";
			this.requestRender();
			return { consume: true };
		}

		if (matchesKey(data, Key.escape)) {
			this.leaveNavigation();
			return { consume: true };
		}

		const keys = ["main", ...this.orderedRows().map((row) => row.key)];
		const currentIndex = Math.max(0, keys.indexOf(this.selectedKey));
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			const nextIndex = Math.min(keys.length - 1, Math.max(0, currentIndex + delta));
			this.selectedKey = keys[nextIndex] ?? "main";
			this.requestRender();
			return { consume: true };
		}

		if (matchesKey(data, Key.enter)) {
			if (this.selectedKey === "main") {
				this.leaveNavigation();
			} else {
				this.openSelected();
			}
			return { consume: true };
		}

		const printable = decodePrintable(data);
		if (printable?.toLowerCase() === "x" && this.selectedKey !== "main") {
			this.controlSelected();
			return { consume: true };
		}
		if (printable !== undefined) this.leaveNavigation();
		return undefined;
	}

	private leaveNavigation(): void {
		if (!this.navigationActive && this.selectedKey === "main") return;
		this.navigationActive = false;
		this.selectedKey = "main";
		this.requestRender();
	}

	private openSelected(): void {
		const key = this.selectedKey;
		try {
			void Promise.resolve(this.onOpen(key)).catch((error) => {
				this.context?.ui.notify(`Unable to open Agent: ${errorMessage(error)}`, "error");
			});
		} catch (error) {
			this.context?.ui.notify(`Unable to open Agent: ${errorMessage(error)}`, "error");
		}
	}

	private controlSelected(): void {
		const row = this.rows().find((candidate) => candidate.key === this.selectedKey);
		if (!row) return;
		if (isTerminalAgentRow(row)) {
			this.dismissedTerminalKeys.add(row.key);
			this.reconcileSelection();
			this.syncRegistration();
			return;
		}
		void this.current.control({ type: "stop", key: row.key }).catch((error) => {
			this.context?.ui.notify(`Unable to stop Agent: ${errorMessage(error)}`, "error");
		});
	}

	private editorHasFocus(): boolean {
		const tui = this.activeTui();
		if (!tui || !("getFocusedComponent" in tui) || !isRuntimeFunction(tui.getFocusedComponent)) return false;
		return isEditorComponent(tui.getFocusedComponent());
	}

	private render(theme: Theme, width: number): string[] {
		return renderAgentRoster(this.orderedRows(), this.navigationActive, this.selectedKey, theme, width, this.now());
	}
}

function isEditorComponent<Value>(
	value: Value,
): value is Value & Pick<EditorComponent, "getText" | "handleInput" | "invalidate" | "render" | "setText"> {
	if (
		!isRuntimeObject(value) ||
		value === null ||
		!("getText" in value) ||
		!("setText" in value) ||
		!("handleInput" in value) ||
		!("invalidate" in value) ||
		!("render" in value)
	) {
		return false;
	}
	return (
		isRuntimeFunction(value.getText) &&
		isRuntimeFunction(value.setText) &&
		isRuntimeFunction(value.handleInput) &&
		isRuntimeFunction(value.invalidate) &&
		isRuntimeFunction(value.render)
	);
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

function errorMessage<ErrorValue>(error: ErrorValue): string {
	return error instanceof Error ? error.message : String(error);
}
