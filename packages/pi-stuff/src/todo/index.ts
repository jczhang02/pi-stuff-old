import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { getCommandDialogCoordinator } from "../conversation-ui/index.ts";
import { getToolUiRuntime } from "../tool-display/contract.ts";
import { replayFromBranch } from "./state/replay.ts";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getState,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.ts";
import { registerTaskTools } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";

export const TODO_TOGGLE_KEY = Key.ctrlShift("t");
export type TodoHost = import("../tool-display/contract.ts").SuiteToolRegistrationHost &
	Pick<ExtensionAPI, "registerShortcut">;

function isStaleContext(cause: unknown): boolean {
	return /stale after session replacement/.test(String(cause));
}

export default function piStuffTodo(pi: TodoHost): void {
	const overlay = new TodoOverlay();
	const toolUi = getToolUiRuntime(pi);
	getCommandDialogCoordinator(pi).registerChrome("todo", {
		setSuppressed: (suppressed) => overlay.setSuppressed(suppressed),
	});

	function refreshAfterMutation(sessionId: string): void {
		if (sessionId !== getActiveRenderSession()) return;
		const current = getState(sessionId).tasks.filter((task) => task.status !== "deleted");
		const allCompleted = current.length > 0 && current.every((task) => task.status === "completed");
		overlay.refresh({ forceExpanded: true, lingerCompleted: allCompleted });
	}

	registerTaskTools(pi, ({ sessionId }) => refreshAfterMutation(sessionId));

	pi.registerShortcut(TODO_TOGGLE_KEY, {
		description: "Collapse or expand the current task list",
		handler: (ctx) => {
			if (!ctx.hasUI || !overlay.isRegistered()) return;
			overlay.toggle();
		},
	});

	function replaySession(ctx: Parameters<typeof replayFromBranch>[0] & Parameters<typeof sid>[0]): string | undefined {
		try {
			const sessionId = sid(ctx);
			replaceState(
				sessionId,
				replayFromBranch(ctx, (messages) => toolUi.projectMessages(messages)),
			);
			return sessionId;
		} catch (error) {
			if (!isStaleContext(error)) throw error;
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = replaySession(ctx);
		if (sessionId === undefined || !ctx.hasUI) return;

		if (getActiveRenderSession() === "") setActiveRenderSession(sessionId);
		if (getActiveRenderSession() !== sessionId) return;

		overlay.setUICtx(ctx.ui);
		overlay.refresh();
	});

	const replayAndRefresh = (ctx: Parameters<typeof replayFromBranch>[0] & Parameters<typeof sid>[0]): void => {
		const sessionId = replaySession(ctx);
		if (sessionId === getActiveRenderSession()) overlay.refresh();
	};

	pi.on("session_compact", async (_event, ctx) => replayAndRefresh(ctx));
	pi.on("session_tree", async (_event, ctx) => replayAndRefresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		let sessionId: string | undefined;
		try {
			sessionId = sid(ctx);
		} catch (error) {
			if (!isStaleContext(error)) throw error;
		}

		if (sessionId !== undefined) evictSession(sessionId);
		if (sessionId === undefined || sessionId === getActiveRenderSession()) {
			try {
				overlay.dispose();
			} catch (error) {
				if (!isStaleContext(error)) throw error;
			} finally {
				clearActiveRenderSession();
			}
		}
	});
}
