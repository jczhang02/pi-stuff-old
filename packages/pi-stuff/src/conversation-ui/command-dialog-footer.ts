import type { Component } from "@earendil-works/pi-tui";
import { isRuntimeFunction } from "../shared/runtime-type.ts";
import type { FooterFactory, FooterTailFactory } from "./command-dialog-types.ts";

export class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

class FooterStackComponent implements Component {
	private disposed = false;
	private readonly components: readonly Component[];

	constructor(components: readonly Component[]) {
		this.components = components;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const component of [...this.components].reverse()) disposeComponent(component);
	}

	invalidate(): void {
		if (this.disposed) return;
		for (const component of this.components) callComponent(() => component.invalidate());
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		const lines: string[] = [];
		let baseRow2Available = false;
		for (const [index, component] of this.components.entries()) {
			const section: string[] = [];
			let rendered = false;
			let replacesBaseRow2 = false;
			callComponent(() => {
				replacesBaseRow2 = "replacesBaseRow2" in component && component.replacesBaseRow2 === true;
				section.push(...component.render(width));
				rendered = true;
			});
			if (!rendered) continue;
			if (index === 0) baseRow2Available = section.length > 1;
			else if (replacesBaseRow2 && baseRow2Available) {
				lines.splice(1, 1);
				baseRow2Available = false;
			}
			lines.push(...section);
		}
		return lines;
	}
}

export function composeFooter(base: FooterFactory, tails: readonly FooterTailFactory[]): FooterFactory {
	return (tui, theme, footerData) => {
		const components: Component[] = [];
		callComponentFactory(() => base(tui, theme, footerData), components);
		for (const tail of tails) callComponentFactory(() => tail(tui, theme), components);
		return new FooterStackComponent(components);
	};
}

export function disposeComponent(component: Component | undefined): void {
	try {
		if (component && "dispose" in component && isRuntimeFunction(component.dispose)) component.dispose();
	} catch {
		// A child cannot prevent the coordinator from advancing or restoring Pi UI.
	}
}

function callComponentFactory(factory: () => Component, output: Component[]): void {
	try {
		output.push(factory());
	} catch {
		// One optional Footer tail must not take down the primary Statusline.
	}
}

function callComponent(callback: () => void): void {
	try {
		callback();
	} catch {
		// Footer sections are independent presentation adapters.
	}
}
