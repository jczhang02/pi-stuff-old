import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { HOST_SHUTDOWN_GRACE_MS, settleWithin } from "../lifecycle-deadline.ts";
import { composeFooter, disposeComponent, EmptyComponent } from "./command-dialog-footer.ts";
import { CommandDialogHost } from "./command-dialog-host.ts";
import type {
	CommandDialogChrome,
	CommandDialogComponent,
	CommandDialogCoordinator,
	CommandDialogCoordinatorHost,
	CommandDialogPriority,
	CommandDialogShowOptions,
	CommandDialogView,
	FooterFactory,
	FooterTailFactory,
} from "./command-dialog-types.ts";

type DialogRequestState = "mounted" | "mounting" | "queued" | "settled";
type HostRunState = "closed" | "closing" | "open" | "opening";

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	reject(cause: unknown): void;
	resolve(value: Value): void;
}

interface HostScope {
	readonly keybindings: KeybindingsManager;
	readonly signal: AbortSignal;
	readonly theme: Theme;
	readonly tui: TUI;
	close<Value>(value?: Value): void;
	requestRender(force?: boolean): void;
}

interface DialogRequest {
	readonly controller: AbortController;
	readonly priority: CommandDialogPriority;
	component: CommandDialogComponent | undefined;
	state: DialogRequestState;
	mount(scope: HostScope): CommandDialogComponent;
	reject(cause: unknown): void;
	resolve<Value>(value: Value): void;
}

interface HostRun {
	readonly blocking: DialogRequest[];
	readonly ctx: ExtensionContext;
	readonly finished: Deferred<void>;
	readonly normal: DialogRequest[];
	readonly pendingSettlements: Array<{ readonly outcome: RequestOutcome; readonly request: DialogRequest }>;
	readonly restoreDraft: boolean;
	readonly suppressedChrome: Set<{ readonly chrome: CommandDialogChrome }>;
	closeHost: (() => void) | undefined;
	closeHostCalled: boolean;
	draft: string;
	draftCaptured: boolean;
	host: CommandDialogHost | undefined;
	state: HostRunState;
}

interface NormalUiState {
	baseFooter: FooterFactory | undefined;
	ctx: ExtensionContext | undefined;
	footer: FooterFactory | undefined;
	workingVisible: boolean;
}

type RequestOutcome =
	| { readonly kind: "reject"; readonly reason: unknown }
	| { readonly kind: "resolve"; readonly value: unknown };

export class CommandDialogCoordinatorImplementation implements CommandDialogCoordinator {
	private readonly chrome = new Map<string, { readonly chrome: CommandDialogChrome }>();
	private readonly boundApis = new WeakSet<CommandDialogCoordinatorHost>();
	private readonly footerTails = new Map<string, FooterTailFactory>();
	private activeRun: HostRun | undefined;
	private accepting = true;
	private generation = 0;
	private generationActive = false;
	private readonly normalUiState: NormalUiState = {
		baseFooter: undefined,
		ctx: undefined,
		footer: undefined,
		workingVisible: true,
	};

	bind(pi: CommandDialogCoordinatorHost): void {
		if (this.boundApis.has(pi)) return;
		this.boundApis.add(pi);
		pi.on("session_shutdown", async () => {
			await settleWithin(this.shutdown(), HOST_SHUTDOWN_GRACE_MS);
		});
	}

	ensureGeneration(pi: CommandDialogCoordinatorHost): void {
		this.bind(pi);
		if (this.generationActive) return;

		this.generationActive = true;
		this.accepting = true;
		this.generation += 1;
		const run = this.activeRun;
		if (run) this.dismissRun(run);
		this.chrome.clear();
		this.footerTails.clear();
	}

	registerChrome(id: string, chrome: CommandDialogChrome): () => void {
		if (id.length === 0) throw new Error("Command Dialog chrome id must not be empty");
		const previous = this.chrome.get(id);
		const record = { chrome };
		this.chrome.set(id, record);
		const run = this.activeRun;
		if (run && (run.state === "opening" || run.state === "open")) {
			if (previous && run.suppressedChrome.delete(previous)) {
				this.setChromeSuppressed(previous, false);
			}
			run.suppressedChrome.add(record);
			this.setChromeSuppressed(record, true);
		}

		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			if (this.chrome.get(id) !== record) return;
			this.chrome.delete(id);

			const currentRun = this.activeRun;
			if (!currentRun?.suppressedChrome.delete(record)) return;
			this.setChromeSuppressed(record, false);
		};
	}

	registerFooterTail(id: string, factory: FooterTailFactory): () => void {
		if (id.length === 0) throw new Error("Footer tail id must not be empty");
		const record = factory;
		this.footerTails.set(id, record);
		this.rebuildFooter();

		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			if (this.footerTails.get(id) !== record) return;
			this.footerTails.delete(id);
			this.rebuildFooter();
		};
	}

	hasInstalledFooter(ctx: ExtensionContext): boolean {
		return this.normalUiState.ctx?.ui === ctx.ui && this.normalUiState.baseFooter !== undefined;
	}

	installFooter(ctx: ExtensionContext, factory: FooterFactory): void {
		if (ctx.mode !== "tui") return;
		this.normalUiState.baseFooter = factory;
		this.normalUiState.ctx = ctx;
		this.rebuildFooter();
	}

	setWorkingVisible(ctx: ExtensionContext, visible: boolean): void {
		this.normalUiState.workingVisible = visible;
		if (!this.runOwnsUi()) ctx.ui.setWorkingVisible(visible);
	}

	show<Result = void>(
		ctx: ExtensionContext,
		view: CommandDialogView<Result>,
		options: CommandDialogShowOptions = {},
	): Promise<Result | undefined> {
		if (ctx.mode !== "tui") return Promise.resolve(undefined);
		if (!this.accepting) return Promise.resolve(undefined);
		if (view.priority !== "normal" && view.priority !== "blocking") {
			return Promise.reject(new Error(`Unknown Command Dialog priority: ${String(view.priority)}`));
		}

		const generation = this.generation;
		const activeRun = this.activeRun;
		if (activeRun && (activeRun.state === "closing" || activeRun.state === "closed" || activeRun.ctx.ui !== ctx.ui)) {
			return activeRun.finished.promise.then(() => {
				if (!this.accepting || this.generation !== generation) return undefined;
				return this.show(ctx, view, options);
			});
		}

		const { promise, request } = createDialogRequest(view);
		if (activeRun) {
			this.enqueue(activeRun, request);
			activeRun.host?.activate();
			return promise;
		}

		const run = createHostRun(ctx, options);
		this.activeRun = run;
		this.enqueue(run, request);
		void this.openRun(run);
		return promise;
	}

	async whenIdle(): Promise<void> {
		while (this.activeRun) await this.activeRun.finished.promise;
	}

	private dismissRun(run: HostRun): void {
		if (run.state === "closed") return;
		run.state = "closing";
		for (const request of [...run.blocking, ...run.normal]) {
			this.finishRequest(run, request, { kind: "resolve", value: undefined }, false);
		}
		this.closeHost(run);
	}

	private mountActiveRequest(
		run: HostRun,
		host: CommandDialogHost,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
	): CommandDialogComponent {
		for (const request of [...run.blocking, ...run.normal]) {
			if (request.state !== "queued") continue;
			request.state = "mounting";
			let component: CommandDialogComponent;
			try {
				component = request.mount({
					keybindings,
					signal: request.controller.signal,
					theme,
					tui,
					close: (value) => {
						this.finishRequest(run, request, { kind: "resolve", value }, true);
					},
					requestRender: (force) => {
						if (request.state === "settled" || this.activeRun !== run || run.state === "closing") return;
						host.requestRender(force);
					},
				});
			} catch (error) {
				if (!requestIsSettled(request)) {
					this.finishRequest(run, request, { kind: "reject", reason: error }, false);
				}
				continue;
			}

			if (requestIsSettled(request)) {
				disposeComponent(component);
				continue;
			}
			request.component = component;
			request.state = "mounted";
		}

		const active = this.activeRequest(run);
		if (active?.component) return active.component;
		if (active?.state === "mounting") return new EmptyComponent();
		this.beginClosing(run);
		return new EmptyComponent();
	}

	private activeRequest(run: HostRun): DialogRequest | undefined {
		return run.blocking[0] ?? run.normal[0];
	}

	private beginClosing(run: HostRun): void {
		if (run.state === "closing" || run.state === "closed") return;
		run.state = "closing";
		this.closeHost(run);
	}

	private closeHost(run: HostRun): void {
		if (run.closeHostCalled || !run.closeHost) return;
		run.closeHostCalled = true;
		try {
			run.closeHost();
		} catch {
			// Pi owns the host callback. Cleanup still runs if its Promise settles.
		}
	}

	private enqueue(run: HostRun, request: DialogRequest): void {
		const queue = request.priority === "blocking" ? run.blocking : run.normal;
		queue.push(request);
	}

	private failRun(run: HostRun, cause: unknown): void {
		if (run.state === "closed") return;
		run.state = "closing";
		for (const request of [...run.blocking, ...run.normal]) {
			this.finishRequest(run, request, { kind: "reject", reason: cause }, false);
		}
		this.closeHost(run);
	}

	private finishRequest(run: HostRun, request: DialogRequest, outcome: RequestOutcome, refresh: boolean): void {
		if (request.state === "settled") return;
		request.state = "settled";
		removeRequest(run.blocking, request);
		removeRequest(run.normal, request);
		request.controller.abort();
		disposeComponent(request.component);
		request.component = undefined;

		if (run.state === "closing" || run.state === "closed" || !this.activeRequest(run)) {
			run.pendingSettlements.push({ outcome, request });
		} else {
			settleRequest(request, outcome);
		}

		if (!refresh || run.state === "closing" || run.state === "closed") return;
		if (this.activeRequest(run)) run.host?.activate();
		else this.beginClosing(run);
	}

	private async openRun(run: HostRun): Promise<void> {
		try {
			if (run.restoreDraft) {
				run.draft = run.ctx.ui.getEditorText();
				run.draftCaptured = true;
			}
			run.ctx.ui.setEditorText("");
			run.ctx.ui.setFooter(() => new EmptyComponent());
			run.ctx.ui.setWorkingVisible(false);
			this.suppressChrome(run);

			await run.ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					run.closeHost = () => done();
					const host = new CommandDialogHost(
						{
							dismiss: () => this.dismissRun(run),
							mount: (activeHost) => this.mountActiveRequest(run, activeHost, tui, theme, keybindings),
						},
						tui,
					);
					run.host = host;
					if (run.state === "opening") run.state = "open";
					host.activate();
					if (run.state === "closing") this.closeHost(run);
					return host;
				},
				{ overlay: false },
			);
		} catch (error) {
			this.failRun(run, error);
		} finally {
			this.dismissRun(run);
			this.restoreRun(run);
			run.state = "closed";
			run.host = undefined;
			if (this.activeRun === run) this.activeRun = undefined;
			run.finished.resolve(undefined);
			this.settlePendingRequests(run);
		}
	}

	private settlePendingRequests(run: HostRun): void {
		const settlements = run.pendingSettlements.splice(0);
		for (const { outcome, request } of settlements) settleRequest(request, outcome);
	}

	private restoreRun(run: HostRun): void {
		const restorations: Array<() => void> = [
			() => run.ctx.ui.setFooter(this.normalUiState.footer),
			() => run.ctx.ui.setWorkingVisible(this.normalUiState.workingVisible),
			() => {
				if (run.draftCaptured) run.ctx.ui.setEditorText(run.draft);
			},
			() => this.restoreChrome(run),
		];
		for (const restore of restorations) {
			try {
				restore();
			} catch {
				// Teardown is best effort, but one failing adapter must not skip the rest.
			}
		}
	}

	private runOwnsUi(): boolean {
		const run = this.activeRun;
		return run !== undefined && run.state !== "closed";
	}

	private rebuildFooter(): void {
		const base = this.normalUiState.baseFooter;
		const tails = [...this.footerTails.values()];
		const footer = base ? composeFooter(base, tails) : undefined;
		this.normalUiState.footer = footer;
		const ctx = this.normalUiState.ctx;
		if (ctx && !this.runOwnsUi()) ctx.ui.setFooter(footer);
	}

	private restoreChrome(run: HostRun): void {
		const records = [...run.suppressedChrome];
		run.suppressedChrome.clear();
		for (const record of records) this.setChromeSuppressed(record, false);
	}

	private setChromeSuppressed(record: { readonly chrome: CommandDialogChrome }, suppressed: boolean): void {
		try {
			record.chrome.setSuppressed(suppressed);
		} catch {
			// Chrome is independently owned; one adapter cannot strand the host lifecycle.
		}
	}

	private async shutdown(): Promise<void> {
		if (!this.generationActive) return;
		this.generationActive = false;
		this.accepting = false;
		this.generation += 1;
		this.normalUiState.baseFooter = undefined;
		this.normalUiState.ctx = undefined;
		this.normalUiState.footer = undefined;
		this.normalUiState.workingVisible = true;
		this.footerTails.clear();
		const run = this.activeRun;
		if (!run) return;
		this.dismissRun(run);
		await run.finished.promise;
	}

	private suppressChrome(run: HostRun): void {
		for (const record of this.chrome.values()) {
			run.suppressedChrome.add(record);
			this.setChromeSuppressed(record, true);
		}
	}
}

function createDialogRequest<Result>(view: CommandDialogView<Result>) {
	const completion = Promise.withResolvers<Result | undefined>();
	const controller = new AbortController();
	const request: DialogRequest = {
		component: undefined,
		controller,
		priority: view.priority,
		state: "queued",
		mount: (scope) =>
			view.create({
				keybindings: scope.keybindings,
				signal: scope.signal,
				theme: scope.theme,
				tui: scope.tui,
				close: (result) => scope.close(result),
				requestRender: (force) => scope.requestRender(force),
			}),
		reject: completion.reject,
		resolve: <Value>(value: Value) => {
			// SAFETY: this request is created from CommandDialogView<Result>, so its close value has that same Result contract.
			completion.resolve(value as Value & (Result | undefined));
		},
	};
	return { promise: completion.promise, request };
}

function createHostRun(ctx: ExtensionContext, options: CommandDialogShowOptions): HostRun {
	return {
		blocking: [],
		closeHost: undefined,
		closeHostCalled: false,
		ctx,
		draft: "",
		draftCaptured: false,
		finished: Promise.withResolvers<void>(),
		host: undefined,
		normal: [],
		pendingSettlements: [],
		restoreDraft: options.restoreDraft !== false,
		state: "opening",
		suppressedChrome: new Set(),
	};
}

function removeRequest(queue: DialogRequest[], request: DialogRequest): void {
	const index = queue.indexOf(request);
	if (index >= 0) queue.splice(index, 1);
}

function requestIsSettled(request: DialogRequest): boolean {
	return request.state === "settled";
}

function settleRequest(request: DialogRequest, outcome: RequestOutcome): void {
	if (outcome.kind === "reject") request.reject(outcome.reason);
	else request.resolve(outcome.value);
}
