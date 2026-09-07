import { type ExtensionAPI, type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";

export {
	readAgentWorkOrigin,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";
export { reportDiagnostic } from "../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
export { commandDialogRows, fitCommandDialogRows } from "../../packages/pi-stuff/src/conversation-ui/dialog-layout.js";
export {
	listenForGoalCoordinationQueries,
	readGoalCoordination,
} from "../../packages/pi-stuff/src/conversation-ui/goal-coordination.js";
export { getGoalStatusChannel } from "../../packages/pi-stuff/src/conversation-ui/statusline.js";
export {
	isSuiteNativeCompactionPreflight,
	sendSuiteAgentMessage,
} from "../../packages/pi-stuff/src/conversation-ui/suite-agent-message.js";
export { whenSuiteSessionReady } from "../../packages/pi-stuff/src/conversation-ui/suite-lifecycle.js";
export { getHostSharedResource } from "../../packages/pi-stuff/src/shared/host-resource.js";

export function requestUiRender(): boolean {
	return false;
}

interface DialogComponent {
	dispose?(): void;
	handleInput?(data: string): void;
	invalidate(): void;
	render(width: number): string[];
}

interface DialogView<Result> {
	create(context: {
		keybindings: unknown;
		signal: AbortSignal;
		theme: unknown;
		tui: { requestRender(force?: boolean): void };
		close(result?: Result): void;
		requestRender(force?: boolean): void;
	}): DialogComponent;
}

interface TestCoordinator {
	registerChrome(): () => void;
	setWorkingVisible(ctx: ExtensionCommandContext, visible: boolean): void;
	show<Result>(ctx: ExtensionCommandContext, view: DialogView<Result>): Promise<Result | undefined>;
	whenIdle(): Promise<void>;
}

const coordinators = new WeakMap<object, TestCoordinator>();

export function ensureUiSettingsCommand() {
	return { register: () => () => undefined };
}

export function getCommandDialogCoordinator(pi: ExtensionAPI): TestCoordinator {
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const key = pi.events as object;
	const existing = coordinators.get(key);
	if (existing) return existing;

	const coordinator: TestCoordinator = {
		registerChrome: () => () => undefined,
		setWorkingVisible: (ctx, visible) => ctx.ui.setWorkingVisible(visible),
		async show<Result>(ctx: ExtensionCommandContext, view: DialogView<Result>) {
			return ctx.ui.custom<Result | undefined>(
				(tui, theme, keybindings, done) => {
					initTheme("dark");
					setKeybindings(keybindings);
					const controller = new AbortController();
					let component: DialogComponent | undefined;
					component = view.create({
						keybindings,
						signal: controller.signal,
						theme,
						tui,
						close: (result) => {
							controller.abort();
							component?.dispose?.();
							done(result);
						},
						requestRender: (force) => tui.requestRender(force),
					});
					return component;
				},
				{ overlay: false },
			);
		},
		whenIdle: async () => undefined,
	};
	coordinators.set(key, coordinator);
	return coordinator;
}
