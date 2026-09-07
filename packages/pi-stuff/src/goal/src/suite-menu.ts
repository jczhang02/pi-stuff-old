import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import {
	type CommandDialogComponent,
	type CommandDialogViewContext,
	commandDialogRows,
	fitCommandDialogRows,
	getCommandDialogCoordinator,
} from "../../conversation-ui/index.ts";

type MenuTransition<ScreenId extends string> =
	| { kind: "stay" }
	| { kind: "back" }
	| { kind: "close" }
	| { kind: "to"; screen: ScreenId };

type MenuActionResult<ScreenId extends string> =
	| MenuTransition<ScreenId>
	| { kind: "rejected"; error?: unknown }
	| undefined;

type MenuActionValue<ScreenId extends string> =
	| MenuActionResult<ScreenId>
	| Effect.Effect<MenuActionResult<ScreenId>, unknown>;

interface MenuActionContext<State> {
	readonly ctx: ExtensionCommandContext;
	readonly itemId: string;
	readonly signal: AbortSignal;
	readonly state: State;
	readonly value?: string;
}

interface MenuItemBase {
	readonly description?: string;
	readonly disabled?: boolean;
	readonly id: string;
	readonly label: string;
}

export type ActionMenuItem<ScreenId extends string, ActionId extends string> =
	| (MenuItemBase & { readonly action: ActionId; readonly close?: never; readonly to?: never })
	| (MenuItemBase & { readonly action?: never; readonly close: true; readonly to?: never })
	| (MenuItemBase & { readonly action?: never; readonly close?: never; readonly to: ScreenId });

interface ActionsScreen<ScreenId extends string, ActionId extends string> {
	readonly hint?: "back" | "close";
	readonly items: readonly ActionMenuItem<ScreenId, ActionId>[];
	readonly kind: "actions";
	readonly lines?: readonly string[];
	readonly title: string;
}

interface DetailScreen {
	readonly hint?: "back" | "close";
	readonly kind: "detail";
	readonly lines: readonly string[];
	readonly title: string;
}

interface MenuSettingItem<ActionId extends string> extends MenuItemBase {
	readonly action: ActionId;
	readonly currentValue: string;
	readonly values?: readonly string[];
}

interface SettingsScreen<ActionId extends string> {
	readonly hint?: "back" | "close";
	readonly items: readonly MenuSettingItem<ActionId>[];
	readonly kind: "settings";
	readonly lines?: readonly string[];
	readonly title: string;
}

type MenuScreen<ScreenId extends string, ActionId extends string> =
	| ActionsScreen<ScreenId, ActionId>
	| DetailScreen
	| SettingsScreen<ActionId>;

export interface MenuDefinition<State, ScreenId extends string, ActionId extends string> {
	readonly actions: Record<ActionId, (context: MenuActionContext<State>) => MenuActionValue<ScreenId>>;
	readonly screens: Record<ScreenId, (context: { readonly state: State }) => MenuScreen<ScreenId, ActionId>>;
	readonly start: ScreenId;
}

export interface RunMenuOptions<State> {
	readonly getState: (context: { readonly ctx: ExtensionCommandContext; readonly signal: AbortSignal }) => State;
	readonly isCurrent?: () => boolean;
	readonly pi?: ExtensionAPI | undefined;
}

export type RunMenuResult =
	| { readonly kind: "closed"; readonly reason: "back" | "close" }
	| { readonly kind: "error"; readonly error: unknown }
	| { readonly kind: "stale" }
	| { readonly kind: "unsupported"; readonly mode: ExtensionCommandContext["mode"] };

type DialogEvent =
	| { readonly kind: "activate"; readonly itemId: string }
	| { readonly kind: "cancel" }
	| { readonly kind: "setting"; readonly itemId: string; readonly value: string };

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;

export function defineMenu<
	State,
	ScreenId extends string,
	ActionId extends string,
	_Context extends ExtensionCommandContext = ExtensionCommandContext,
>(definition: MenuDefinition<State, ScreenId, ActionId>): MenuDefinition<State, ScreenId, ActionId> {
	if (!Object.hasOwn(definition.screens, definition.start)) {
		throw new Error(`Menu starts at unknown screen: ${definition.start}`);
	}
	return definition;
}

export function runMenu<State, ScreenId extends string, ActionId extends string>(
	ctx: ExtensionCommandContext,
	definition: MenuDefinition<State, ScreenId, ActionId>,
	options: RunMenuOptions<State>,
): Effect.Effect<RunMenuResult> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return Effect.succeed({ kind: "unsupported", mode: ctx.mode });
	return Effect.scoped(
		Effect.gen(function* () {
			const signal = yield* Effect.abortSignal;
			const stack: ScreenId[] = [definition.start];
			let closeReason: "back" | "close" = "close";

			while (stack.length > 0) {
				if (!isCurrent(options)) return { kind: "stale" } as const;
				const current = stack.at(-1);
				if (current === undefined) break;
				const state = yield* Effect.try({
					try: () => options.getState({ ctx, signal }),
					catch: (error) => error,
				});
				if (!isCurrent(options)) return { kind: "stale" } as const;
				const factory = definition.screens[current];
				if (!factory) return yield* Effect.fail(new Error(`Menu requested unknown screen: ${current}`));
				const screen = yield* Effect.try({
					try: () => factory({ state }),
					catch: (error) => error,
				});
				const event = yield* menuWait(() =>
					options.pi ? showSuiteScreen(options.pi, ctx, screen, signal) : showLegacyScreen(ctx, screen, signal),
				);
				if (!isCurrent(options)) return { kind: "stale" } as const;

				if (!event || event.kind === "cancel") {
					const transition = screen.hint ?? "back";
					if (transition === "close" || stack.length === 1) {
						closeReason = transition;
						break;
					}
					stack.pop();
					continue;
				}

				if (screen.kind === "detail") continue;
				if (screen.kind === "actions" && event.kind === "activate") {
					const item = screen.items.find((candidate) => candidate.id === event.itemId);
					if (!item || item.disabled) continue;
					if ("close" in item) {
						closeReason = "close";
						break;
					}
					if ("to" in item && item.to !== undefined) {
						stack.push(item.to);
						continue;
					}
					const action = "action" in item ? item.action : undefined;
					if (action !== undefined) {
						const result = yield* menuAction(() =>
							definition.actions[action]({ ctx, itemId: item.id, signal, state }),
						);
						if (applyTransition(stack, result)) break;
					}
					continue;
				}

				if (screen.kind === "settings" && event.kind === "setting") {
					const item = screen.items.find((candidate) => candidate.id === event.itemId);
					if (!item || item.disabled) continue;
					const result = yield* menuAction(() =>
						definition.actions[item.action]({
							ctx,
							itemId: item.id,
							signal,
							state,
							value: event.value,
						}),
					);
					if (applyTransition(stack, result)) break;
				}
			}
			return { kind: "closed", reason: closeReason } as const;
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					if (!isCurrent(options)) return { kind: "stale" } as const;
					ctx.ui.notify(`Goal dialog failed: ${formatError(error)}`, "error");
					return { kind: "error", error } as const;
				}),
			),
		),
	);
}

export function menuWait<Value>(operation: () => Value | PromiseLike<Value>): Effect.Effect<Value, unknown> {
	return Effect.tryPromise({ try: () => Promise.resolve(operation()), catch: (error) => error });
}

function menuAction<ScreenId extends string>(
	operation: () => MenuActionValue<ScreenId>,
): Effect.Effect<MenuActionResult<ScreenId>, unknown> {
	return Effect.try({ try: operation, catch: (error) => error }).pipe(
		Effect.flatMap((value) => (Effect.isEffect(value) ? value : Effect.succeed(value))),
	);
}

function applyTransition<ScreenId extends string>(stack: ScreenId[], result: MenuActionResult<ScreenId>): boolean {
	if (!result || result.kind === "stay" || result.kind === "rejected") return false;
	if (result.kind === "close") return true;
	if (result.kind === "back") {
		if (stack.length <= 1) return true;
		stack.pop();
		return false;
	}
	stack.push(result.screen);
	return false;
}

function isCurrent<State>(options: RunMenuOptions<State>): boolean {
	return options.isCurrent?.() ?? true;
}

async function showSuiteScreen<ScreenId extends string, ActionId extends string>(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	screen: MenuScreen<ScreenId, ActionId>,
	ownerSignal: AbortSignal,
): Promise<DialogEvent | undefined> {
	const coordinator = getCommandDialogCoordinator(pi);
	return coordinator.show<DialogEvent>(ctx, {
		priority: "normal",
		create: (context) => new SuiteMenuDialog(context, screen, ownerSignal),
	});
}

class SuiteMenuDialog<ScreenId extends string, ActionId extends string> implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<DialogEvent>;
	private disposed = false;
	private readonly list: SelectList | SettingsList | undefined;
	private readonly ownerSignal: AbortSignal;
	private readonly removeOwnerAbort: () => void;
	private readonly screen: MenuScreen<ScreenId, ActionId>;

	constructor(
		context: CommandDialogViewContext<DialogEvent>,
		screen: MenuScreen<ScreenId, ActionId>,
		ownerSignal: AbortSignal,
	) {
		this.context = context;
		this.screen = screen;
		this.ownerSignal = ownerSignal;
		const abort = () => context.close({ kind: "cancel" });
		ownerSignal.addEventListener("abort", abort, { once: true });
		this.removeOwnerAbort = () => ownerSignal.removeEventListener("abort", abort);

		if (screen.kind === "actions") {
			const items = screen.items.map<SelectItem>((item) =>
				item.description === undefined
					? { label: item.label, value: item.id }
					: { description: item.description, label: item.label, value: item.id },
			);
			const list = new SelectList(items, Math.max(1, Math.min(items.length, 10)), getSelectListTheme());
			list.onSelect = (item) => context.close({ kind: "activate", itemId: item.value });
			list.onCancel = () => context.close({ kind: "cancel" });
			this.list = list;
		} else if (screen.kind === "settings") {
			const items = screen.items.map<SettingItem>((item) => {
				const setting = {
					currentValue: item.currentValue,
					id: item.id,
					label: item.label,
					values: [...(item.values ?? [item.currentValue])],
				};
				return item.description === undefined ? setting : { ...setting, description: item.description };
			});
			this.list = new SettingsList(
				items,
				Math.max(1, Math.min(items.length, 10)),
				getSettingsListTheme(),
				(itemId, value) => context.close({ kind: "setting", itemId, value }),
				() => context.close({ kind: "cancel" }),
				{ enableSearch: true },
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeOwnerAbort();
	}

	handleInput(data: string): void {
		if (this.disposed || this.ownerSignal.aborted) return;
		if (this.list) this.list.handleInput?.(data);
		else if (this.context.keybindings.matches(data, "tui.select.cancel")) {
			this.context.close({ kind: "cancel" });
		}
		this.context.requestRender();
	}

	invalidate(): void {
		this.list?.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const maximumRows = commandDialogRows(this.context);
		if (maximumRows === 0) return [];
		const bodyWidth = Math.max(MIN_RENDER_WIDTH, renderWidth);
		const introductoryLines = (this.screen.lines ?? []).flatMap((line) =>
			wrapTextWithAnsi(this.context.theme.fg("muted", `${GUTTER}${oneLine(line)}`), bodyWidth),
		);
		const nativeLines = this.list?.render(bodyWidth) ?? [];
		const nativeBody = nativeLines.filter(
			(line) => !line.includes("Esc") && !line.includes("Type to search") && !line.includes("Enter/Space"),
		);
		const body = [...introductoryLines, ...(introductoryLines.length ? [""] : []), ...nativeBody];
		const selected = nativeBody.find((line) => line.includes("→") || line.includes("›"));
		const closeWord = this.screen.hint === "close" ? "close" : "back";
		const footerText =
			this.screen.kind === "actions"
				? `↑/↓ select · Enter choose · Esc ${closeWord}`
				: this.screen.kind === "settings"
					? `Type search · Enter/Space change · Esc ${closeWord}`
					: `Esc ${closeWord}`;
		const footer = wrapTextWithAnsi(footerText, Math.max(1, renderWidth - GUTTER.length)).map(
			(line) => `${GUTTER}${this.context.theme.fg("dim", line)}`,
		);
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "━".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold(oneLine(this.screen.title))}`,
				],
				body,
				footer,
				priority: [selected ?? introductoryLines[0] ?? `${GUTTER}${this.context.theme.fg("muted", "No options")}`],
			},
			maximumRows,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, this.context.theme.fg("dim", "…")));
	}
}

async function showLegacyScreen<ScreenId extends string, ActionId extends string>(
	ctx: ExtensionCommandContext,
	screen: MenuScreen<ScreenId, ActionId>,
	signal: AbortSignal,
): Promise<DialogEvent | undefined> {
	const title = [screen.title, ...(screen.lines ?? [])].join("\n");
	if (screen.kind === "detail") {
		await ctx.ui.select(title, [screen.hint === "close" ? "Close" : "Back"], { signal });
		return { kind: "cancel" };
	}
	const selected = await ctx.ui.select(
		title,
		screen.items.map((item) => item.label),
		{ signal },
	);
	if (selected === undefined) return { kind: "cancel" };
	if (screen.kind === "actions") {
		const item = screen.items.find((candidate) => candidate.label === selected);
		return item ? { kind: "activate", itemId: item.id } : { kind: "cancel" };
	}
	const item = screen.items.find((candidate) => candidate.label === selected);
	if (!item) return { kind: "cancel" };
	const values = item.values ?? [item.currentValue];
	const index = values.indexOf(item.currentValue);
	return {
		kind: "setting",
		itemId: item.id,
		value: values[(index + 1) % values.length] ?? item.currentValue,
	};
}

function oneLine(value: string): string {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
		})
		.join("")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function formatError<Failure>(error: Failure): string {
	return error instanceof Error ? error.message : String(error);
}
