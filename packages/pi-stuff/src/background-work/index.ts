import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { getCommandDialogCoordinator } from "../conversation-ui/index.ts";
import { installEffectFoundation } from "../shared/effect-foundation.ts";
import { CachedToolRow } from "../tool-display/index.ts";
import { reportWorkDiagnostic } from "./src/diagnostics.ts";
import { BackgroundWorkEffectOwner } from "./src/effect-owner.ts";
import { type BackgroundWorkOutcome, BackgroundWorkRuntime } from "./src/runtime.ts";
import { createTasksDialogView } from "./src/tasks-dialog.ts";
import { registerWorkTools, type WorkToolRuntimeRef } from "./src/tools.ts";

export {
	type BackgroundWorkKind,
	type BackgroundWorkOutcome,
	BackgroundWorkRuntime,
	type BackgroundWorkSnapshot,
	type BackgroundWorkStatus,
	type BackgroundWorkTerminalStatus,
} from "./src/runtime.ts";
export { type ReconciliationResult, reconcileStaleRuns, WorkRunStorage } from "./src/storage.ts";

const COMPLETION_MESSAGE_TYPE = "pi-stuff-background-work-result";

export interface CompletionDetails {
	readonly outcomes?: readonly BackgroundWorkOutcome[];
}

interface BackgroundHostSettings {
	readonly commandPrefix?: string;
	readonly shellPath?: string;
}

function registerCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CompletionDetails>(COMPLETION_MESSAGE_TYPE, (message, _options, theme) => {
		const outcomes = message.details?.outcomes ?? [];
		if (outcomes.length === 0) return new Text(theme.fg("dim", "Background work updated."), 0, 0);
		const rows = new Container();
		for (const outcome of outcomes) {
			rows.addChild(
				new CachedToolRow(theme, {
					active: false,
					expandable: false,
					hint: "",
					kind: "activity",
					outcome: outcome.status === "completed" ? "success" : outcome.status === "stopped" ? "stopped" : "error",
					summary: outcome.summary,
				}),
			);
		}
		return rows;
	});
}

function hostSettings(ctx: ExtensionContext): BackgroundHostSettings {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const commandPrefix = settings.getShellCommandPrefix();
	const shellPath = settings.getShellPath();
	const result: BackgroundHostSettings = {};
	if (commandPrefix !== undefined) Object.assign(result, { commandPrefix });
	if (shellPath !== undefined) Object.assign(result, { shellPath });
	return result;
}

export default async function piStuffWork(
	pi: ExtensionAPI,
	options: {
		createRuntime?: (input: ConstructorParameters<typeof BackgroundWorkRuntime>[0]) => BackgroundWorkRuntime;
	} = {},
): Promise<void> {
	let runtime: BackgroundWorkRuntime | undefined;
	let removeTerminalInput: (() => void) | undefined;
	const shutdowns = new Set<Promise<void>>();
	const createRuntime = options.createRuntime ?? ((input) => new BackgroundWorkRuntime(input));
	const runtimeRef: WorkToolRuntimeRef = { current: () => runtime };
	const dialogs = getCommandDialogCoordinator(pi);
	const foundation = installEffectFoundation(pi, { deferShutdown: true });

	// Install renderers before session replay. The session_start registration runs
	// after Pi Stuff Tools and reclaims Bash execution for the live session.
	registerCompletionRenderer(pi);
	registerWorkTools(pi, runtimeRef, { includeBash: false });

	pi.registerCommand("tasks", {
		description: "Inspect and control current-session Background Work",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive TUI mode.", "warning");
				return;
			}
			if (!runtime) {
				ctx.ui.notify("Background Work is not available during session transition.", "warning");
				return;
			}
			await runtime.prepare();
			await dialogs.show(ctx, createTasksDialogView(runtime));
		},
	});

	const releaseRuntime = (owned: BackgroundWorkRuntime): Promise<void> => {
		const shutdown = owned
			.shutdown()
			.catch((error) => reportWorkDiagnostic("Background Work runtime shutdown failed", error))
			.finally(() => shutdowns.delete(shutdown));
		shutdowns.add(shutdown);
		return shutdown;
	};

	pi.on("session_start", (_event, ctx) => {
		removeTerminalInput?.();
		removeTerminalInput = undefined;
		const previous = runtime;
		runtime = undefined;
		if (previous) void releaseRuntime(previous);
		const settings = hostSettings(ctx);
		const session = foundation.sessionFor(ctx.sessionManager);
		if (!session) throw new Error("Background Work Session Scope was not initialized.");
		const created = createRuntime({
			...settings,
			cwd: ctx.cwd,
			effects: new BackgroundWorkEffectOwner(foundation, session),
			pi,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		runtime = created;
		registerWorkTools(pi, runtimeRef);
		if (ctx.mode === "tui") {
			removeTerminalInput = ctx.ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.ctrl("b"))) return undefined;
				return runtime === created && created.detachActiveForeground() ? { consume: true } : undefined;
			});
		}
	});

	pi.on("session_shutdown", async () => {
		removeTerminalInput?.();
		removeTerminalInput = undefined;
		const active = runtime;
		runtime = undefined;
		if (active) void releaseRuntime(active);
		await Promise.allSettled(shutdowns);
	});
}
