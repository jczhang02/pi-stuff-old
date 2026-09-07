import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { registerContextPromptContributor } from "../context-management/index.ts";
import {
	createPonytailDialogView,
	getCommandDialogCoordinator,
	type PonytailDialogAction,
	type PonytailDialogSnapshot,
	reportDiagnostic,
} from "../conversation-ui/index.ts";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { type EffectFoundation, type EffectScopeOwner, installEffectFoundation } from "../shared/effect-foundation.ts";
import { isJsonInputObject } from "../shared/json-value.ts";
import { type PonytailSettingsPatch, PonytailSettingsStore } from "./config.ts";
import { preparePonytailInstructions } from "./instructions.ts";
import { PonytailPromptRenderer } from "./prompt.ts";
import { type PonytailRuntimeRegistry, ponytailRuntimeRegistry } from "./state.ts";
import {
	inheritedPonytailMode,
	isPonytailDeactivationCommand,
	normalizePonytailMode,
	PONYTAIL_DEFAULT_MODE,
	PONYTAIL_ICON,
	PONYTAIL_MODES,
	PONYTAIL_SESSION_ENTRY_TYPE,
	PONYTAIL_SPECIALIZED_SKILLS,
	type PonytailMode,
	type PonytailSpecializedSkill,
} from "./types.ts";

const PONYTAIL_STATUS_KEY = "ponytail";

export { getPonytailMode } from "./state.ts";

function entryMode(entry: SessionEntry): PonytailMode | undefined {
	if (entry.type !== "custom" || entry.customType !== PONYTAIL_SESSION_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (!isJsonInputObject(data)) return undefined;
	return normalizePonytailMode(data["mode"]);
}

export function newestPonytailBranchMode(entries: readonly SessionEntry[]): PonytailMode | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		const mode = entryMode(entry);
		if (mode) return mode;
	}
	return undefined;
}

async function runPonytailOperation<Value, ErrorType>(
	foundation: EffectFoundation,
	ctx: ExtensionContext,
	program: (session: EffectScopeOwner) => Effect.Effect<Value, ErrorType>,
): Promise<Value | undefined> {
	const session = foundation.sessionFor(ctx.sessionManager);
	if (!session || !foundation.isCurrent(session)) return undefined;
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program(session));
	await foundation.close(operation, exit);
	if (Exit.isSuccess(exit)) return foundation.isCurrent(session) ? exit.value : undefined;
	if (Cause.hasInterrupts(exit.cause)) return undefined;
	throw Cause.squash(exit.cause);
}

class PonytailRuntime {
	private readonly foundation: EffectFoundation;
	private readonly pi: ExtensionAPI;
	private readonly prompt: PonytailPromptRenderer;
	private readonly registry: PonytailRuntimeRegistry;
	private readonly releasePrompt: () => void;
	private mode: PonytailMode = PONYTAIL_DEFAULT_MODE;
	private settingsStore = PonytailSettingsStore.memory();
	private settings = this.settingsStore.get();
	private lastSettingsError: string | undefined;
	private disposed = false;

	constructor(pi: ExtensionAPI, registry: PonytailRuntimeRegistry, foundation: EffectFoundation) {
		this.foundation = foundation;
		this.pi = pi;
		this.registry = registry;
		this.prompt = new PonytailPromptRenderer();
		this.releasePrompt = registerContextPromptContributor(pi, {
			id: "ponytail",
			order: 300,
			renderAgent: (event) => this.prompt.renderAgent(event, this.mode),
			renderProvider: () => this.prompt.renderProvider(this.mode),
		});
	}

	install(): void {
		this.pi.on("session_start", (_event, ctx) =>
			runPonytailOperation(this.foundation, ctx, (session) => this.startSession(ctx, session)).then(() => undefined),
		);
		this.pi.on("session_tree", (_event, ctx) =>
			runPonytailOperation(this.foundation, ctx, (session) => this.restoreBranchMode(ctx, session)).then(
				() => undefined,
			),
		);
		this.pi.on("input", async (event, ctx) => {
			if (event.source !== "extension" && isPonytailDeactivationCommand(event.text)) {
				await runPonytailOperation(this.foundation, ctx, (session) => this.setMode("off", ctx, false, session));
			}
			return { action: "continue" };
		});
		this.pi.on("session_shutdown", (_event, ctx) => Effect.runPromise(this.shutdown(ctx)));
		this.pi.registerCommand("ponytail", {
			description: "Configure Ponytail's KISS mode and open its control dialog",
			getArgumentCompletions: (prefix) => this.completions(prefix),
			handler: async (args, ctx) => {
				await runPonytailOperation(this.foundation, ctx, (session) => this.handleCommand(args, ctx, session));
			},
		});
		for (const skill of PONYTAIL_SPECIALIZED_SKILLS) {
			this.pi.registerCommand(skill, {
				description: `Run the ${skill} Skill`,
				handler: async (args, ctx) => {
					await runPonytailOperation(this.foundation, ctx, (session) =>
						this.launchSkill(skill, ctx, session, args),
					);
				},
			});
		}
	}

	currentMode(): PonytailMode {
		return this.mode;
	}

	private startSession(ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const settingsStore = yield* PonytailSettingsStore.load(getAgentDir());
			if (!this.isLive(session)) return;
			this.settingsStore = settingsStore;
			this.settings = settingsStore.get();
			yield* this.reportSettingsError(session);
			yield* this.restoreBranchMode(ctx, session);
			if (!this.isLive(session)) return;
			const identity = ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionFile() ?? undefined;
			if (
				ctx.hasUI &&
				this.mode !== "off" &&
				!this.settings.quietStartup &&
				identity &&
				!this.registry.startupNotified.has(identity)
			) {
				yield* Effect.sync(() => {
					if (!this.isLive(session)) return;
					this.registry.startupNotified.add(identity);
					ctx.ui.notify(`Ponytail active · ${this.mode} mode`, "info");
				});
			}
		});
	}

	private restoreBranchMode(ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (!this.isLive(session)) return;
			const restored = newestPonytailBranchMode(ctx.sessionManager.getBranch());
			this.mode = restored ?? inheritedPonytailMode() ?? this.settings.defaultMode;
			yield* this.syncStatus(ctx, session);
		});
	}

	private setMode(
		mode: PonytailMode,
		ctx: ExtensionContext,
		notify: boolean,
		session: EffectScopeOwner,
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (!this.isLive(session)) return;
			this.mode = mode;
			yield* Effect.sync(() => {
				if (this.isLive(session)) this.pi.appendEntry(PONYTAIL_SESSION_ENTRY_TYPE, { mode });
			});
			yield* this.syncStatus(ctx, session);
			if (notify) yield* this.notify(ctx, session, () => `Ponytail mode: ${mode}`, "info");
		});
	}

	private updateSettings(
		patch: PonytailSettingsPatch,
		ctx: ExtensionContext,
		session: EffectScopeOwner,
	): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const settings = yield* this.settingsStore.update(patch);
			if (!this.isLive(session)) return;
			this.settings = settings;
			yield* this.reportSettingsError(session);
			yield* this.syncStatus(ctx, session);
		});
	}

	private syncStatus(ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void> {
		return Effect.sync(() => {
			if (!this.isLive(session)) return;
			ctx.ui.setStatus(
				PONYTAIL_STATUS_KEY,
				this.settings.hideStatus || this.mode === "off" ? undefined : `${PONYTAIL_ICON} ${this.mode}`,
			);
		});
	}

	private reportSettingsError(session: EffectScopeOwner): Effect.Effect<void> {
		return Effect.sync(() => {
			if (!this.isLive(session)) return;
			if (!this.settings.error || this.settings.error === this.lastSettingsError) return;
			this.lastSettingsError = this.settings.error;
			reportDiagnostic({
				capability: "Ponytail",
				key: "settings",
				severity: "warning",
				summary: "Ponytail configuration is invalid; safe defaults are active.",
				details: this.settings.error,
				visibility: "silent",
			});
		});
	}

	private handleCommand(args: string, ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void, Error> {
		return Effect.suspend(() => {
			const tokens = args.trim().toLowerCase().split(/\s+/u).filter(Boolean);
			if (tokens.length === 0) return this.showDialog(ctx, session);
			const head = tokens[0];
			const directMode = normalizePonytailMode(head);
			if (directMode && tokens.length === 1) return this.setMode(directMode, ctx, true, session);
			if (head === "on" && tokens.length === 1) {
				return this.setMode(
					this.settings.defaultMode === "off" ? PONYTAIL_DEFAULT_MODE : this.settings.defaultMode,
					ctx,
					true,
					session,
				);
			}
			if (head === "status" && tokens.length === 1) {
				return this.notify(ctx, session, () => this.statusText(), "info");
			}
			if (head === "default" && tokens.length === 2) {
				const mode = normalizePonytailMode(tokens[1]);
				return mode
					? this.persistSetting(
							{ defaultMode: mode },
							ctx,
							() =>
								this.settings.defaultModeOverridden
									? `Saved default ${mode}; PONYTAIL_DEFAULT_MODE keeps ${this.settings.defaultMode} effective.`
									: `Ponytail default: ${mode}`,
							session,
						)
					: this.usage(ctx, session);
			}
			if (head === "status" && tokens.length === 2 && (tokens[1] === "show" || tokens[1] === "hide")) {
				const hidden = tokens[1] === "hide";
				return this.persistSetting(
					{ hideStatus: hidden },
					ctx,
					() =>
						this.settings.hideStatusOverridden
							? "Saved Statusline preference; PONYTAIL_HIDE_STATUS remains effective."
							: `Ponytail Statusline: ${hidden ? "hidden" : "shown"}`,
					session,
				);
			}
			if (head === "startup" && tokens.length === 2 && (tokens[1] === "show" || tokens[1] === "quiet")) {
				const quiet = tokens[1] === "quiet";
				return this.persistSetting(
					{ quietStartup: quiet },
					ctx,
					() =>
						this.settings.quietStartupOverridden
							? "Saved startup preference; PONYTAIL_QUIET_STARTUP remains effective."
							: `Ponytail startup notification: ${quiet ? "quiet" : "show"}`,
					session,
				);
			}
			return this.usage(ctx, session);
		});
	}

	private persistSetting(
		patch: PonytailSettingsPatch,
		ctx: ExtensionContext,
		message: () => string,
		session: EffectScopeOwner,
	): Effect.Effect<void> {
		return this.updateSettings(patch, ctx, session).pipe(
			Effect.andThen(this.notify(ctx, session, message, "info")),
			Effect.catch((error) => this.writeError(ctx, session, error)),
		);
	}

	private showDialog(ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void, Error> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			return this.notify(
				ctx,
				session,
				() => "The Ponytail dialog is available in interactive TUI sessions.",
				"warning",
			);
		}
		return Effect.tryPromise({
			try: () => {
				if (!this.isLive(session)) return Promise.resolve(undefined);
				return getCommandDialogCoordinator(this.pi).show<PonytailSpecializedSkill>(
					ctx,
					createPonytailDialogView(this.dialogSnapshot(), {
						apply: async (action) => {
							if (!this.isLive(session)) throw new Error("Ponytail settings action was cancelled.");
							const snapshot = await runPonytailOperation(this.foundation, ctx, (actionSession) =>
								this.applyDialogAction(action, ctx, actionSession),
							);
							if (!snapshot) throw new Error("Ponytail settings action was cancelled.");
							return snapshot;
						},
					}),
				);
			},
			catch: normalizeError,
		}).pipe(Effect.flatMap((skill) => (skill ? this.launchSkill(skill, ctx, session) : Effect.void)));
	}

	private applyDialogAction(
		action: PonytailDialogAction,
		ctx: ExtensionContext,
		session: EffectScopeOwner,
	): Effect.Effect<PonytailDialogSnapshot, Error> {
		const update =
			action.type === "set-mode"
				? this.setMode(action.mode, ctx, false, session)
				: action.type === "set-default"
					? this.updateSettings({ defaultMode: action.mode }, ctx, session)
					: action.type === "set-status"
						? this.updateSettings({ hideStatus: action.hide }, ctx, session)
						: this.updateSettings({ quietStartup: action.quiet }, ctx, session);
		return Effect.map(update, () => this.dialogSnapshot());
	}

	private launchSkill(
		skill: PonytailSpecializedSkill,
		ctx: ExtensionContext,
		session: EffectScopeOwner,
		args = "",
	): Effect.Effect<void> {
		return Effect.sync(() => {
			if (!this.isLive(session)) return;
			const suffix = args.trim();
			const content = `/skill:${skill}${suffix ? ` ${suffix}` : ""}`;
			if (ctx.isIdle()) this.pi.sendUserMessage(content, { expandPromptTemplates: true });
			else this.pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: true });
		});
	}

	private dialogSnapshot(): PonytailDialogSnapshot {
		const snapshot = {
			mode: this.mode,
			defaultMode: this.settings.defaultMode,
			savedDefaultMode: this.settings.saved.defaultMode,
			hideStatus: this.settings.hideStatus,
			savedHideStatus: this.settings.saved.hideStatus,
			quietStartup: this.settings.quietStartup,
			savedQuietStartup: this.settings.saved.quietStartup,
			defaultModeOverridden: this.settings.defaultModeOverridden,
			hideStatusOverridden: this.settings.hideStatusOverridden,
			quietStartupOverridden: this.settings.quietStartupOverridden,
			source: this.settings.source,
		};
		return this.settings.error ? { ...snapshot, error: this.settings.error } : snapshot;
	}

	private statusText(): string {
		return `Ponytail · mode ${this.mode} · default ${this.settings.defaultMode} · Statusline ${this.settings.hideStatus ? "hidden" : "shown"} · startup ${this.settings.quietStartup ? "quiet" : "shown"}`;
	}

	private notify(
		ctx: ExtensionContext,
		session: EffectScopeOwner,
		message: () => string,
		level: "error" | "info" | "warning",
	): Effect.Effect<void> {
		return Effect.sync(() => {
			if (this.isLive(session)) ctx.ui.notify(message(), level);
		});
	}

	private writeError<ErrorValue>(
		ctx: ExtensionContext,
		session: EffectScopeOwner,
		error: ErrorValue,
	): Effect.Effect<void> {
		return this.notify(ctx, session, () => (error instanceof Error ? error.message : String(error)), "error");
	}

	private usage(ctx: ExtensionContext, session: EffectScopeOwner): Effect.Effect<void> {
		return this.notify(
			ctx,
			session,
			() => "Usage: /ponytail [on|off|lite|full|ultra|status [show|hide]|startup [show|quiet]|default <mode>]",
			"warning",
		);
	}

	private isLive(session: EffectScopeOwner): boolean {
		return !this.disposed && this.foundation.isCurrent(session);
	}

	private completions(prefix: string): AutocompleteItem[] | null {
		const normalized = prefix.trimStart().toLowerCase();
		const all = [
			...PONYTAIL_MODES.map((mode) => ({ value: mode, description: `Use ${mode} mode in this Session` })),
			{ value: "on", description: "Activate the configured default mode" },
			{ value: "status", description: "Show Ponytail status" },
			{ value: "status show", description: "Show Ponytail in the Statusline" },
			{ value: "status hide", description: "Hide Ponytail from the Statusline" },
			{ value: "startup show", description: "Show the startup notification" },
			{ value: "startup quiet", description: "Suppress the startup notification" },
			...PONYTAIL_MODES.map((mode) => ({ value: `default ${mode}`, description: `Use ${mode} for new Sessions` })),
		];
		const matches = all.filter((item) => item.value.startsWith(normalized));
		return matches.length > 0 ? matches.map((item) => ({ ...item, label: item.value })) : null;
	}

	private shutdown(ctx: ExtensionContext): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			const disposed = yield* Effect.sync(() => {
				if (this.disposed) return true;
				this.disposed = true;
				this.releasePrompt();
				ctx.ui.setStatus(PONYTAIL_STATUS_KEY, undefined);
				// SAFETY: Pi's events surface is the stable object identity shared by duplicate ExtensionAPI wrappers.
				const owner = this.pi.events as object;
				if (this.registry.owners.get(owner) === this) this.registry.owners.delete(owner);
				return false;
			});
			if (disposed) return;
			yield* this.settingsStore.whenIdle().pipe(Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS), Effect.asVoid);
		});
	}
}

export default async function ponytailCapability(pi: ExtensionAPI): Promise<void> {
	const registry = ponytailRuntimeRegistry();
	// SAFETY: Pi's events surface is the stable object identity shared by duplicate ExtensionAPI wrappers.
	const owner = pi.events as object;
	if (registry.owners.has(owner)) return;
	await Effect.runPromise(preparePonytailInstructions());
	if (registry.owners.has(owner)) return;
	const runtime = new PonytailRuntime(pi, registry, installEffectFoundation(pi));
	registry.owners.set(owner, runtime);
	runtime.install();
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
