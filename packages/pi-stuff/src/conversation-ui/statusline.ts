import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
	CodexStatusSnapshot,
	CodexStatusSource,
	ContextStatusSnapshot,
	ContextStatusSource,
	GoalStatusSnapshot,
	GoalStatusSource,
} from "./statusline-channels.ts";
import type { GitChangeCountsSource } from "./statusline-git.ts";
import { renderStatusline, type StatuslineDensity } from "./statusline-render.ts";
import { readSkillAliases, SessionStatusSource, type StatuslineSessionManager } from "./statusline-session.ts";
import { sanitizeOneLine } from "./terminal-text.ts";

export * from "./statusline-channels.ts";
export type { GitChangeCounts } from "./statusline-git.ts";
export { GitStatusSource, parseGitStatusPorcelain } from "./statusline-git.ts";
export type { StatuslineDensity } from "./statusline-render.ts";

const DEFAULT_EXTENSION_STATUS_KEYS: readonly string[] = [];
const GOAL_CLOCK_REFRESH_MS = 1_000;

export interface BooleanValueSource {
	get(): boolean;
	subscribe(listener: () => void): () => void;
}

export interface StatuslinePreferences {
	readonly density: StatuslineDensity;
	readonly enabled: boolean;
	readonly latestPrompt: boolean;
}

export interface StatuslinePreferencesSource {
	get(): StatuslinePreferences;
	subscribe(listener: () => void): () => void;
}

export type StatuslineClock = (callback: () => void, intervalMs: number) => () => void;

interface SharedStatuslineControllerOptions {
	readonly autocompleteVisible?: BooleanValueSource;
	readonly codexStatus?: CodexStatusSource;
	readonly contextStatus?: ContextStatusSource;
	readonly extensionStatusKeys?: readonly string[];
	readonly gitChanges?: GitChangeCountsSource;
	readonly goalStatus?: GoalStatusSource;
	readonly repeat?: StatuslineClock | undefined;
}

export type StatuslineControllerOptions = SharedStatuslineControllerOptions &
	(
		| { readonly enabled: BooleanValueSource; readonly preferences?: never }
		| { readonly enabled?: never; readonly preferences: StatuslinePreferencesSource }
	);

interface RenderRegistration {
	requestRender(force?: boolean): void;
}

export type StatuslineHost = Pick<ExtensionAPI, "getCommands" | "getThinkingLevel">;

export interface StatuslineContext {
	readonly cwd: string;
	getContextUsage():
		| { readonly contextWindow: number | null; readonly percent: number | null; readonly tokens: number | null }
		| undefined;
	isIdle(): boolean;
	readonly model: ExtensionContext["model"];
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "isUsingOAuth">;
	readonly sessionManager: StatuslineSessionManager;
	readonly thinkingLevel?: ExtensionContext["thinkingLevel"];
}

/**
 * Owns Statusline suppression independently from its data and settings. The
 * controller is structurally compatible with CommandDialogChrome.
 */
export class StatuslineController {
	private cancelGoalClock: (() => void) | undefined;
	private disposed = false;
	private readonly options: StatuslineControllerOptions;
	private readonly pi: StatuslineHost;
	private readonly renderers = new Set<RenderRegistration>();
	private readonly sessionStatusSources = new WeakMap<StatuslineSessionManager, SessionStatusSource>();
	private readonly skillAliases: ReadonlyMap<string, string>;
	private suppressed = false;

	constructor(pi: StatuslineHost, options: StatuslineControllerOptions) {
		this.pi = pi;
		this.options = options;
		this.skillAliases = readSkillAliases(pi);
	}

	createFooter(
		ctx: StatuslineContext,
		tui: RenderRegistration,
		theme: Theme,
		footerData: ReadonlyFooterDataProvider,
	): Component & { dispose(): void } {
		return new StatuslineFooter(this, ctx, tui, theme, footerData);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearGoalClock();
		this.requestRender();
		this.renderers.clear();
	}

	isVisible(): boolean {
		return (
			!this.disposed &&
			!this.suppressed &&
			this.getPreferences().enabled &&
			!(this.options.autocompleteVisible?.get() ?? false)
		);
	}

	isEnabled(): boolean {
		return !this.disposed && this.getPreferences().enabled;
	}

	registerRenderer(renderer: RenderRegistration): () => void {
		if (this.disposed) return () => {};
		this.renderers.add(renderer);
		this.syncGoalClockTimer();
		return () => {
			this.renderers.delete(renderer);
			this.syncGoalClockTimer();
		};
	}

	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => {};
		const notify = () => {
			this.syncGoalClockTimer();
			callObserver(listener);
		};
		const unsubscribe: Array<() => void> = [];
		const preferencesSource = this.options.preferences ?? this.options.enabled;
		subscribeObserver(preferencesSource, notify, unsubscribe);
		if (this.options.autocompleteVisible) subscribeObserver(this.options.autocompleteVisible, notify, unsubscribe);
		if (this.options.codexStatus) subscribeObserver(this.options.codexStatus, notify, unsubscribe);
		if (this.options.contextStatus) subscribeObserver(this.options.contextStatus, notify, unsubscribe);
		if (this.options.gitChanges) subscribeObserver(this.options.gitChanges, notify, unsubscribe);
		if (this.options.goalStatus) subscribeObserver(this.options.goalStatus, notify, unsubscribe);
		return () => {
			for (const remove of unsubscribe.splice(0)) callObserver(remove);
		};
	}

	render(ctx: StatuslineContext, theme: Theme, footerData: ReadonlyFooterDataProvider, width: number): string[] {
		if (!this.isVisible()) return [];
		const renderWidth = Math.max(0, Math.floor(width));
		if (renderWidth < 1) return [];
		const sessionStatusSource = this.getSessionStatusSource(ctx);
		const sessionStatus = sessionStatusSource.get();
		const branch = sanitizeOneLine(footerData.getGitBranch() ?? "");
		const preferences = this.getPreferences();
		const cwd = readRawCwd(ctx);
		const model = ctx.model;
		const usage = sessionStatus.usage;
		return renderStatusline(theme, {
			branch,
			codexStatus: readCodexStatus(ctx, this.options.codexStatus),
			contextStatus: readContextStatus(this.options.contextStatus),
			contextUsage: sessionStatusSource.readContextUsage(ctx.model, readHostIdle(ctx), () => ctx.getContextUsage()),
			cwd,
			density: preferences.density,
			extensionStatuses: footerData.getExtensionStatuses(),
			extensionStatusKeys: this.options.extensionStatusKeys ?? DEFAULT_EXTENSION_STATUS_KEYS,
			gitChanges: this.options.gitChanges?.get(cwd, branch),
			goalStatus: readGoalStatus(this.options.goalStatus),
			latestPrompt: preferences.latestPrompt ? sessionStatus.latestPrompt : undefined,
			model,
			now: Date.now(),
			showCost: model?.provider !== "openai-codex" && usage.cost > 0 && shouldShowCost(ctx),
			thinkingLevel: model?.reasoning === false ? undefined : readThinkingLevel(this.pi, ctx),
			usage,
			width: renderWidth,
		});
	}

	setSuppressed(suppressed: boolean): void {
		if (this.disposed || this.suppressed === suppressed) return;
		this.suppressed = suppressed;
		this.syncGoalClockTimer();
		this.requestRender();
	}

	handleBranchChange(): void {
		if (this.disposed) return;
		this.requestRender();
	}

	private requestRender(): void {
		for (const renderer of this.renderers) callObserver(() => renderer.requestRender());
	}

	private syncGoalClockTimer(): void {
		const snapshot = readGoalStatus(this.options.goalStatus);
		const shouldRun =
			this.renderers.size > 0 &&
			this.isVisible() &&
			snapshot?.status === "active" &&
			snapshot.activeStartedAt !== undefined;
		if (shouldRun && !this.cancelGoalClock) {
			this.cancelGoalClock = this.options.repeat?.(() => this.requestRender(), GOAL_CLOCK_REFRESH_MS);
		} else if (!shouldRun) {
			this.clearGoalClock();
		}
	}

	private clearGoalClock(): void {
		const cancel = this.cancelGoalClock;
		this.cancelGoalClock = undefined;
		cancel?.();
	}

	private getPreferences(): StatuslinePreferences {
		if (this.options.preferences) return this.options.preferences.get();
		return {
			density: "auto",
			enabled: this.options.enabled.get(),
			latestPrompt: true,
		};
	}

	private getSessionStatusSource(ctx: StatuslineContext): SessionStatusSource {
		const sessionManager = ctx.sessionManager;
		let source = this.sessionStatusSources.get(sessionManager);
		if (!source) {
			source = new SessionStatusSource(sessionManager, this.skillAliases);
			this.sessionStatusSources.set(sessionManager, source);
		}
		return source;
	}
}

class StatuslineFooter implements Component {
	private readonly controller: StatuslineController;
	private readonly ctx: StatuslineContext;
	private disposed = false;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly theme: Theme;
	private readonly tui: RenderRegistration;
	private readonly unsubscribe: Array<() => void>;

	constructor(
		controller: StatuslineController,
		ctx: StatuslineContext,
		tui: RenderRegistration,
		theme: Theme,
		footerData: ReadonlyFooterDataProvider,
	) {
		this.controller = controller;
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.footerData = footerData;
		const render = () => callObserver(() => this.tui.requestRender());
		this.unsubscribe = [controller.registerRenderer({ requestRender: render })];
		try {
			this.unsubscribe.push(footerData.onBranchChange(() => this.controller.handleBranchChange()));
		} catch {
			// A broken branch observer must not prevent the footer from rendering.
		}
		this.unsubscribe.push(controller.subscribe(render));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribe.splice(0)) callObserver(unsubscribe);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.disposed) return [];
		return this.controller.render(this.ctx, this.theme, this.footerData, width);
	}
}

function readCodexStatus(
	ctx: StatuslineContext,
	source: CodexStatusSource | undefined,
): CodexStatusSnapshot | undefined {
	if (ctx.model?.provider !== "openai-codex" || !source) return undefined;
	try {
		return source.getSnapshot();
	} catch {
		return undefined;
	}
}

function readGoalStatus(source: GoalStatusSource | undefined): GoalStatusSnapshot | undefined {
	if (!source) return undefined;
	try {
		return source.getSnapshot();
	} catch {
		return undefined;
	}
}

function shouldShowCost(ctx: StatuslineContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return false;
	try {
		if (ctx.modelRegistry.isUsingOAuth(model)) return false;
	} catch {
		// A partial or third-party registry may not expose auth state. Fall back
		// to the model's public metering table rather than hiding real cost.
	}
	const cost = model.cost;
	if (!cost) return false;
	const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	for (const tier of cost.tiers ?? []) rates.push(tier.input, tier.output, tier.cacheRead, tier.cacheWrite);
	return rates.some((rate) => Number.isFinite(rate) && rate > 0);
}

function readThinkingLevel(pi: StatuslineHost, ctx: StatuslineContext): string {
	try {
		return pi.getThinkingLevel();
	} catch {
		return ctx.thinkingLevel ?? "off";
	}
}

function readHostIdle(ctx: StatuslineContext): boolean {
	try {
		return ctx.isIdle();
	} catch {
		return false;
	}
}

function readContextStatus(source: ContextStatusSource | undefined): ContextStatusSnapshot | undefined {
	try {
		return source?.getSnapshot();
	} catch {
		return undefined;
	}
}

function readRawCwd(ctx: StatuslineContext): string {
	try {
		return ctx.sessionManager.getCwd() || ctx.cwd || ".";
	} catch {
		return ctx.cwd || ".";
	}
}

function callObserver(observer: () => void): void {
	try {
		observer();
	} catch {
		// Presentation observers are recoverable and independent.
	}
}

function subscribeObserver(
	source: { subscribe(listener: () => void): () => void },
	listener: () => void,
	unsubscribers: Array<() => void>,
): void {
	try {
		unsubscribers.push(source.subscribe(listener));
	} catch {
		// One unavailable observer source must not disable the Statusline.
	}
}
