import { type Component, type Focusable, isFocusable, type TUI } from "@earendil-works/pi-tui";
import type { CommandDialogComponent } from "./command-dialog-types.ts";

export interface CommandDialogHostLifecycle {
	dismiss(): void;
	mount(host: CommandDialogHost): CommandDialogComponent;
}

export class CommandDialogHost implements Component, Focusable {
	private _focused = false;
	private readonly lifecycle: CommandDialogHostLifecycle;
	private readonly tui: TUI;

	constructor(lifecycle: CommandDialogHostLifecycle, tui: TUI) {
		this.lifecycle = lifecycle;
		this.tui = tui;
	}

	get wantsKeyRelease(): boolean {
		return this.activeComponent().wantsKeyRelease ?? false;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		const component = this.activeComponent();
		if (isFocusable(component)) component.focused = value;
	}

	activate(): void {
		this.activeComponent();
		this.tui.requestRender();
	}

	dispose(): void {
		this.lifecycle.dismiss();
	}

	handleInput(data: string): void {
		this.activeComponent().handleInput?.(data);
	}

	invalidate(): void {
		this.activeComponent().invalidate();
	}

	render(width: number): string[] {
		return this.activeComponent().render(width);
	}

	requestRender(force?: boolean): void {
		this.tui.requestRender(force);
	}

	private activeComponent(): CommandDialogComponent {
		const component = this.lifecycle.mount(this);
		if (isFocusable(component)) component.focused = this._focused;
		return component;
	}
}
