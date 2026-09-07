import { Key, type KeybindingsManager, matchesKey } from "@earendil-works/pi-tui";
import { commandDialogNavigation } from "../../conversation-ui/index.ts";

/** The `tui.select.*` keybinding ids the adapter panels resolve. */
export type PanelSelectKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm";

/** Structural subset of pi-tui's `KeybindingsManager` used by retained panels. */
export type PanelKeybindings = Pick<KeybindingsManager, "getKeys" | "matches">;

/**
 * Key matchers for list navigation: user's `tui.select.*` bindings when a
 * manager is provided, otherwise the previous hardcoded defaults.
 */
export interface PanelKeys {
	selectUp(data: string): boolean;
	selectDown(data: string): boolean;
	selectPageUp(data: string): boolean;
	selectPageDown(data: string): boolean;
	selectConfirm(data: string): boolean;
}

export function createPanelKeys(keybindings?: PanelKeybindings): PanelKeys {
	if (keybindings) {
		return {
			selectUp: (data) => commandDialogNavigation(data, keybindings) === "up",
			selectDown: (data) => commandDialogNavigation(data, keybindings) === "down",
			selectPageUp: (data) => commandDialogNavigation(data, keybindings) === "pageUp",
			selectPageDown: (data) => commandDialogNavigation(data, keybindings) === "pageDown",
			selectConfirm: (data) => keybindings.matches(data, "tui.select.confirm"),
		};
	}
	return {
		selectUp: (data) => matchesKey(data, "up") || matchesKey(data, Key.ctrl("p")),
		selectDown: (data) => matchesKey(data, "down") || matchesKey(data, Key.ctrl("n")),
		selectPageUp: (data) => matchesKey(data, "pageUp") || matchesKey(data, "b"),
		selectPageDown: (data) => matchesKey(data, "pageDown"),
		selectConfirm: (data) => matchesKey(data, "return"),
	};
}
