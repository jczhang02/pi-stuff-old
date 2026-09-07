import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCommandDialogCoordinator, requestUiRender } from "../conversation-ui/index.ts";
import { isJsonInputObject, type JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeString } from "../shared/runtime-type.ts";
import { boundTerminalLine } from "../tool-display/terminal.ts";
import {
	CONTEXT_ACTIVITY_ENTRY_TYPE,
	type ContextActivityData,
	ContextActivityRegistry,
	type ContextOperation,
	contextActivityUpdateFromMagic,
	failedContextActivity,
	isContextActivityRunning,
	isContextActivitySettled,
	isContextOperation,
} from "./activity.ts";
import {
	type ContextDialogCommand,
	type ContextDialogSnapshot,
	createContextDialogView,
	type MagicStatusMessage,
	statusSnapshotFromMagic,
} from "./dialog.ts";

const CONTEXT_COMMAND_USAGE = "/ctx [status|flush|wrapup [N]|recomp [start-end]|upgrade]";

function subcommand<const Name extends string>(value: Name, description: string) {
	return { description, label: value, value };
}

const CONTEXT_SUBCOMMANDS = [
	subcommand("status", "Open Context status and actions"),
	subcommand("flush", "Apply queued drops on the next message"),
	subcommand("wrapup", "Compact older history; keep 20 messages by default"),
	subcommand("recomp", "Rebuild compartments from raw history"),
	subcommand("upgrade", "Upgrade legacy session history and memories"),
] as const;
const CONTEXT_COMMAND_NAMES = {
	flush: "ctx-flush",
	recomp: "ctx-recomp",
	status: "ctx-status",
	upgrade: "ctx-session-upgrade",
	wrapup: "ctx-wrapup",
} as const;
export const MAGIC_COMMAND_NAMES: ReadonlySet<string> = new Set(Object.values(CONTEXT_COMMAND_NAMES));
const BACKGROUND_OPERATIONS = new Set<ContextOperation>(["recomp", "upgrade"]);
const OPERATION_BY_MAGIC_TITLE = new Map<string, ContextOperation>([
	["/ctx-flush", "flush"],
	["/ctx-recomp", "recomp"],
	["/ctx-session-upgrade", "upgrade"],
	["/ctx-wrapup", "wrapup"],
]);

export interface MagicCommandDefinition {
	readonly handler?: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface ContextCommandRuntimeOptions {
	readonly activate: (ctx: ExtensionContext) => Promise<void>;
	readonly commands: ReadonlyMap<string, MagicCommandDefinition>;
	readonly currentContext: () => ExtensionContext | undefined;
	readonly continuityDetail: () => string | undefined;
	readonly error: () => string | undefined;
	readonly quietContext: (name: string, ctx: ExtensionContext) => ExtensionContext;
}

interface ContextActivityTarget {
	detached?: boolean;
	readonly id: string;
	readonly operation: ContextOperation;
	readonly sessionId: string;
}

function isMagicStatusMessage(value: JsonInputValue): value is JsonInputValue & MagicStatusMessage {
	if (!isJsonInputObject(value)) return false;
	return [value["level"], value["text"], value["title"]].every(
		(property) => property === undefined || isRuntimeString(property),
	);
}

export class ContextCommandRuntime {
	private active: ContextActivityTarget | undefined;
	private readonly activities: ContextActivityRegistry;
	private readonly background = new Map<ContextOperation, ContextActivityTarget>();
	private capturedStatus: MagicStatusMessage | undefined;
	private readonly options: ContextCommandRuntimeOptions;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI, options: ContextCommandRuntimeOptions) {
		this.pi = pi;
		this.options = options;
		this.activities = new ContextActivityRegistry(() => requestUiRender(pi));
		pi.registerEntryRenderer(CONTEXT_ACTIVITY_ENTRY_TYPE, this.activities.render);
		pi.registerCommand("ctx", {
			description: "Inspect and maintain Context · status | flush | wrapup [N] | recomp [start-end] | upgrade",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trimStart().toLowerCase();
				if (/\s/u.test(normalized)) return null;
				return CONTEXT_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized)).map((item) => ({ ...item }));
			},
			handler: (args, ctx) => this.dispatch(args, ctx),
		});
		pi.on("session_before_switch", (_event, ctx) => this.detachBackground(ctx));
		pi.on("session_before_fork", (_event, ctx) => this.detachBackground(ctx));
	}

	async dispatch(raw: string, ctx: ExtensionContext): Promise<void> {
		const input = raw.trim();
		const separator = input.search(/\s/u);
		const requested = (separator < 0 ? input : input.slice(0, separator)).toLowerCase() || "status";
		const args = separator < 0 ? "" : input.slice(separator).trim();
		if (requested !== "status" && !isContextOperation(requested)) {
			ctx.ui.notify(`Usage: ${CONTEXT_COMMAND_USAGE}`, "warning");
			return;
		}
		await this.options.activate(ctx);
		if (requested === "status") await this.showStatusDialog(ctx);
		else await this.runMaintenance(requested, args, ctx);
	}

	clearActive(): void {
		this.active = undefined;
	}

	detachBackground(ctx: ExtensionContext): void {
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		for (const target of this.background.values()) {
			if (target.sessionId !== sessionId || target.detached) continue;
			const current = this.activities.get(target.id);
			if (!current || isContextActivitySettled(current)) continue;
			target.detached = true;
			const update = this.activities.update(target.id, {
				detail:
					"The operation continues in the background, but Pi Stuff cannot attach later display updates after leaving this Session. Open /ctx when you return to inspect the current state.",
				state: "warning",
				summary: "continuing after Session switch",
			});
			this.pi.appendEntry(CONTEXT_ACTIVITY_ENTRY_TYPE, update);
		}
	}

	captureStatus(value: JsonInputValue): void {
		if (!isMagicStatusMessage(value)) return;
		if (value.title === "/ctx-status") {
			this.capturedStatus = value;
			return;
		}
		const operation = value.title ? OPERATION_BY_MAGIC_TITLE.get(value.title) : undefined;
		if (!operation) return;
		const activity = this.active?.operation === operation ? this.active : this.background.get(operation);
		if (!activity) return;
		const update = this.updateActivity(activity, contextActivityUpdateFromMagic(activity.operation, value));
		if (BACKGROUND_OPERATIONS.has(operation)) {
			if (!isContextActivitySettled(update)) this.background.set(operation, activity);
			else if (this.background.get(operation)?.id === activity.id) {
				this.background.delete(operation);
			}
		}
	}

	private async runMaintenance(
		operation: ContextOperation,
		args: string,
		ctx: ExtensionContext,
		options: { readonly confirmed?: boolean } = {},
	): Promise<void> {
		const name = CONTEXT_COMMAND_NAMES[operation];
		const target = this.startActivity(operation, args, ctx);
		const handler = this.options.commands.get(name)?.handler;
		if (!handler) {
			this.updateActivity(target, {
				detail: this.options.error() ?? "Magic Context is unavailable; Pi native context remains active.",
				state: "error",
				summary: "unavailable",
			});
			return;
		}
		const running = this.background.get(operation);
		if (running) {
			const elsewhere = running.sessionId === target.sessionId ? "" : " in another Session";
			this.updateActivity(target, {
				detail: `A Context ${operation} operation is already running${elsewhere}. Wait for it to finish before starting another.`,
				state: "warning",
				summary: `already running${elsewhere.toLowerCase()}`,
			});
			return;
		}
		this.active = target;
		if (BACKGROUND_OPERATIONS.has(operation)) this.background.set(operation, target);
		try {
			await handler(args, this.options.quietContext(name, ctx));
			const firstResult = this.activities.get(target.id);
			if (
				operation === "recomp" &&
				options.confirmed === true &&
				firstResult?.state === "warning" &&
				firstResult.summary === "confirmation required"
			) {
				await handler(args, this.options.quietContext(name, ctx));
			}
			const current = this.activities.get(target.id);
			if (current && isContextActivityRunning(current) && !BACKGROUND_OPERATIONS.has(operation)) {
				this.updateActivity(target, { detail: current.detail, state: "success", summary: "complete" });
			}
		} catch (error) {
			this.updateActivity(target, failedContextActivity(error));
			if (this.background.get(operation)?.id === target.id) this.background.delete(operation);
		} finally {
			if (this.active?.id === target.id) this.active = undefined;
			if (
				BACKGROUND_OPERATIONS.has(operation) &&
				isContextActivitySettled(this.activities.get(target.id)) &&
				!target.detached &&
				this.background.get(operation)?.id === target.id
			) {
				this.background.delete(operation);
			}
		}
	}

	private startActivity(operation: ContextOperation, args: string, ctx: ExtensionContext): ContextActivityTarget {
		const activity = this.activities.create(operation, initialContextActivitySummary(operation, args));
		const target = { id: activity.id, operation, sessionId: ctx.sessionManager.getSessionId() };
		this.appendActivity(target, activity);
		return target;
	}

	private updateActivity(
		target: ContextActivityTarget,
		patch: Parameters<ContextActivityRegistry["update"]>[1],
	): ContextActivityData {
		const update = this.activities.update(target.id, patch);
		this.appendActivity(target, update);
		return update;
	}

	private appendActivity(target: ContextActivityTarget, data: ContextActivityData): void {
		let currentSessionId: string | undefined;
		try {
			currentSessionId = this.options.currentContext()?.sessionManager.getSessionId();
		} catch {
			// A stale Host context must not route an Activity into an unknown Session.
		}
		if (currentSessionId === target.sessionId) this.pi.appendEntry(CONTEXT_ACTIVITY_ENTRY_TYPE, data);
	}

	private async showStatusDialog(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("The Context dialog is available in interactive TUI sessions.", "warning");
			return;
		}
		const snapshot = await this.readStatusSnapshot(ctx);
		const command = await getCommandDialogCoordinator(this.pi).show<ContextDialogCommand>(
			ctx,
			createContextDialogView(snapshot, { refresh: () => this.readStatusSnapshot(ctx) }),
			{ restoreDraft: false },
		);
		if (command) {
			await this.runMaintenance(command.operation, command.args, ctx, { confirmed: command.confirmed === true });
		}
	}

	private async readStatusSnapshot(ctx: ExtensionContext): Promise<ContextDialogSnapshot> {
		const handler = this.options.commands.get(CONTEXT_COMMAND_NAMES.status)?.handler;
		const usage = this.contextUsage(ctx);
		const continuityDetail = this.options.continuityDetail();
		if (!handler) {
			return statusSnapshotFromMagic(
				undefined,
				usage,
				this.options.error() ?? "Magic Context is unavailable; Pi native context remains active.",
				continuityDetail,
			);
		}
		this.capturedStatus = undefined;
		try {
			await handler("", this.options.quietContext(CONTEXT_COMMAND_NAMES.status, ctx));
			return statusSnapshotFromMagic(this.capturedStatus, usage, undefined, continuityDetail);
		} catch (error) {
			return statusSnapshotFromMagic(
				this.capturedStatus,
				usage,
				error instanceof Error ? error.message : String(error),
				continuityDetail,
			);
		} finally {
			this.capturedStatus = undefined;
		}
	}

	private contextUsage(ctx: ExtensionContext) {
		try {
			return ctx.getContextUsage?.();
		} catch {
			return undefined;
		}
	}
}

export function initialContextActivitySummary(operation: ContextOperation, args: string): string {
	const target = boundTerminalLine(args, 120);
	if (operation === "wrapup") return target ? `keeping ${target} recent messages` : "keeping 20 recent messages";
	if (operation === "recomp") return target ? `rebuilding range ${target}` : "preparing full rebuild";
	if (operation === "upgrade") return "checking legacy history";
	return "applying queued drops";
}
