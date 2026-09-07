import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { getCommandDialogCoordinator } from "../conversation-ui/index.ts";
import type { SuiteAgentMessageHost } from "../conversation-ui/suite-agent-message.ts";
import type { EffectFoundation } from "../shared/effect-foundation.ts";
import {
	type SuiteToolDefinitionRegistry,
	type SuiteToolRegistrationHost,
	type SuiteToolSurfaceController,
	sendSuiteAgentMessage,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../tool-display/contract.ts";
import { stringifyForStorage } from "./cloudflare/codec.ts";
import type { SuiteCodeModeConnector } from "./connector.ts";
import { type CodeModeEffectiveSource, createCodeModeDialogView } from "./dialog.ts";
import type { CodeModeSessionLedger } from "./ledger.ts";
import type { CodeModeRuntime, PiStuffCodeModeDetails } from "./runtime.ts";
import {
	readCodeModeGlobalEnabled,
	readCodeModeProjectEnabled,
	writeCodeModeGlobalEnabled,
	writeCodeModeProjectEnabled,
} from "./settings.ts";

export const CODE_MODE_TOOL_NAME = "codemode";
const CODE_MODE_DECISION_MESSAGE_TYPE = "pi-stuff-code-mode-decision";
const CODE_MODE_FROZEN_ENV = "PI_STUFF_CODE_MODE_FROZEN";
const COMMAND_ACTIONS =
	"on off global history pending approve reject snippets save delete abandon rollback compensate expire".split(" ");
const USAGE =
	"Usage: /codemode [on|off|global on|global off|history|pending|approve <execution-id>|reject <execution-id> <seq>|snippets|save <execution-id> <name> [description]|delete <name>|abandon <execution-id>|rollback <execution-id>|expire]";

export interface PiStuffCodeModeOptions {
	readonly effects: EffectFoundation;
	readonly registry: SuiteToolDefinitionRegistry;
	readonly surface: SuiteToolSurfaceController;
}

export type CodeModeHost = SuiteToolRegistrationHost &
	SuiteAgentMessageHost &
	Pick<ExtensionAPI, "appendEntry" | "registerCommand">;

function environmentMode(name: string): boolean | undefined {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "on" ? true : value === "off" ? false : undefined;
}

function actionCompletions(prefix: string): Array<{ readonly label: string; readonly value: string }> | null {
	if (/\s/u.test(prefix.trim())) return null;
	const normalized = prefix.trim().toLowerCase();
	return COMMAND_ACTIONS.filter((value) => value.startsWith(normalized)).map((value) => ({ label: value, value }));
}

export async function compensateCodeModeExecution(
	registry: SuiteToolDefinitionRegistry,
	ledger: CodeModeSessionLedger,
	context: Parameters<CodeModeSessionLedger["history"]>[0],
	executionId: string,
	signal?: AbortSignal,
): Promise<{ readonly complete: boolean; readonly compensated: number; readonly failures: readonly string[] }> {
	let compensated = 0;
	const failures: string[] = [];
	for (const target of ledger.compensationTargets(context, executionId)) {
		try {
			const invocation: Parameters<SuiteToolDefinitionRegistry["compensate"]>[0] = {
				context,
				executionId,
				input: target.input,
				name: target.name,
				result: target.value,
				sequence: target.sequence,
			};
			if (signal) Object.assign(invocation, { signal });
			if (!(await registry.compensate(invocation))) throw new Error("no compensating operation accepted the call");
			ledger.markCompensated(context, executionId, target.callId);
			compensated += 1;
		} catch (error) {
			failures.push(`${target.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const complete = failures.length === 0 && ledger.markCompensationComplete(context, executionId);
	return { complete, compensated, failures };
}

async function deliverDecision(
	pi: SuiteAgentMessageHost,
	action: "approved" | "rejected",
	executionId: string,
	result?: AgentToolResult<PiStuffCodeModeDetails>,
): Promise<void> {
	const status = result?.details.status ?? "rejected";
	const message = withDirectUserActivation(
		withAgentWorkOrigin(
			{
				content: [
					{
						text: `Code Mode execution ${executionId} was ${action}; current status: ${status}.`,
						type: "text" as const,
					},
					...(result?.content ?? []),
				],
				customType: CODE_MODE_DECISION_MESSAGE_TYPE,
				details: result?.details ?? { executionId, status },
				display: true,
			},
			"user",
		),
	);
	await sendSuiteAgentMessage(pi, message, { deliverAs: "followUp", triggerTurn: true });
}

export class CodeModeControls {
	private readonly connector: SuiteCodeModeConnector;
	private readonly defaultEnabled: boolean;
	private readonly environmentDefault: boolean | undefined;
	private readonly frozenEnabled: boolean | undefined;
	private readonly ledger: CodeModeSessionLedger;
	private readonly options: PiStuffCodeModeOptions;
	private readonly pi: CodeModeHost;
	private readonly runtime: CodeModeRuntime;
	private effectiveSource: CodeModeEffectiveSource;
	private enabled: boolean;
	private globalEnabled: boolean | undefined;
	private projectBinding: string | undefined;
	private projectEnabled: boolean | undefined;
	private readonly settingsGate = Semaphore.makeUnsafe(1);

	constructor(
		pi: CodeModeHost,
		options: PiStuffCodeModeOptions,
		connector: SuiteCodeModeConnector,
		ledger: CodeModeSessionLedger,
		runtime: CodeModeRuntime,
	) {
		this.pi = pi;
		this.options = options;
		this.connector = connector;
		this.ledger = ledger;
		this.runtime = runtime;
		this.environmentDefault = environmentMode("PI_STUFF_CODE_MODE_DEFAULT");
		this.defaultEnabled = this.environmentDefault ?? false;
		this.frozenEnabled = environmentMode(CODE_MODE_FROZEN_ENV);
		this.enabled = this.frozenEnabled ?? this.defaultEnabled;
		this.effectiveSource =
			this.frozenEnabled !== undefined
				? "frozen"
				: this.environmentDefault !== undefined
					? "environment"
					: "default";
	}

	register(): void {
		this.pi.registerCommand("codemode", {
			description: "Open Code Mode controls or manage its Session ledger",
			getArgumentCompletions: actionCompletions,
			handler: (args, context) => this.handle(args, context),
		});
	}

	apply(): void {
		if (this.enabled) this.options.surface.enableEnvelope(CODE_MODE_TOOL_NAME);
		else this.options.surface.disableEnvelope(CODE_MODE_TOOL_NAME);
	}

	bindProject(context: ExtensionContext, force = false): Promise<void> {
		return this.runSettings(this.settingsGate.withPermit(this.loadProject(context, force)));
	}

	private applySettings(): void {
		this.enabled = this.frozenEnabled ?? this.projectEnabled ?? this.globalEnabled ?? this.defaultEnabled;
		this.effectiveSource =
			this.frozenEnabled !== undefined
				? "frozen"
				: this.projectEnabled !== undefined
					? "project"
					: this.globalEnabled !== undefined
						? "global"
						: this.environmentDefault !== undefined
							? "environment"
							: "default";
		this.apply();
	}

	private loadProject(context: ExtensionContext, force: boolean): Effect.Effect<void, Error> {
		const key = `${context.isProjectTrusted() ? "trusted" : "untrusted"}\0${context.cwd}`;
		if (!force && this.projectBinding === key) return Effect.void;
		const previousBinding = this.projectBinding;
		return Effect.catch(
			Effect.gen({ self: this }, function* () {
				const projectEnabled =
					this.frozenEnabled === undefined && context.isProjectTrusted()
						? yield* readCodeModeProjectEnabled(context.cwd)
						: undefined;
				const globalEnabled = this.frozenEnabled === undefined ? yield* readCodeModeGlobalEnabled() : undefined;
				this.projectBinding = key;
				this.projectEnabled = projectEnabled;
				this.globalEnabled = globalEnabled;
				this.applySettings();
			}),
			(error) => {
				if (previousBinding !== key) {
					this.projectBinding = undefined;
					this.projectEnabled = undefined;
					this.globalEnabled = undefined;
					this.applySettings();
				}
				return Effect.fail(error);
			},
		);
	}

	private persistProject(context: ExtensionContext, value: boolean | undefined): Promise<void> {
		return this.runSettings(
			this.settingsGate.withPermit(
				Effect.gen({ self: this }, function* () {
					if (!context.isProjectTrusted()) {
						return yield* Effect.fail(new Error("Code Mode cannot persist settings for an untrusted project."));
					}
					yield* this.loadProject(context, false);
					yield* writeCodeModeProjectEnabled(context.cwd, value);
					this.projectEnabled = value;
					this.applySettings();
				}),
			),
		);
	}

	private persistGlobal(context: ExtensionContext, value: boolean): Promise<void> {
		return this.runSettings(
			this.settingsGate.withPermit(
				Effect.gen({ self: this }, function* () {
					yield* this.loadProject(context, false);
					yield* writeCodeModeGlobalEnabled(value);
					this.globalEnabled = value;
					this.applySettings();
				}),
			),
		);
	}

	private async runSettings<Value>(program: Effect.Effect<Value, Error>): Promise<Value> {
		const foundation = this.options.effects;
		const session = foundation.currentSession();
		if (!session) throw new Error("Code Mode settings are unavailable before Session start.");
		const operation = foundation.forkOperation(session);
		const exit = await foundation.run(operation, program);
		await foundation.close(operation, exit);
		if (Exit.isFailure(exit)) {
			if (Cause.hasInterrupts(exit.cause)) throw new Error("Code Mode settings operation was cancelled.");
			throw Cause.squash(exit.cause);
		}
		if (!foundation.isCurrent(session)) throw new Error("Code Mode settings operation was cancelled.");
		return exit.value;
	}

	private async showDialog(context: ExtensionCommandContext): Promise<void> {
		if (!context.hasUI) {
			context.ui.notify("/codemode requires interactive TUI mode; use /codemode on or /codemode off.", "warning");
			return;
		}
		try {
			await this.bindProject(context);
			await getCommandDialogCoordinator(this.pi).show(
				context,
				createCodeModeDialogView({
					getSnapshot: () => ({
						effectiveSource: this.effectiveSource,
						enabled: this.enabled,
						fallbackEnabled: this.defaultEnabled,
						frozen: this.frozenEnabled !== undefined,
						globalEnabled: this.globalEnabled,
						history: this.ledger.historyPage(context),
						pendingCount: this.runtime.pending(context).length,
						projectEnabled: this.projectEnabled,
						projectTrusted: context.isProjectTrusted(),
						snippetCount: this.ledger.snippets(context).length,
						toolCount: this.connector.catalog().length,
					}),
					setGlobalEnabled: (value) => this.persistGlobal(context, value),
					setProjectEnabled: (value) => this.persistProject(context, value),
				}),
			);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	private showHistory(context: ExtensionCommandContext): void {
		const history = this.ledger.historyPage(context);
		context.ui.notify(
			history.totalCount === 0
				? "No Code Mode executions in this Session."
				: [
						`${String(history.displayedCount)} displayed · ${String(history.retainedCount)} retained · ${String(history.totalCount)} total${history.truncated ? " · history truncated" : ""}`,
						...history.items.map(
							(item) =>
								`${new Date(item.updatedAt).toISOString()} · ${item.executionId} · ${item.tools.length > 0 ? item.tools.map((tool) => `tools.${tool}`).join(", ") : "JavaScript only"} · ${item.status} · ${String(item.toolCalls)} Tool call(s)${item.error ? ` · ${item.error}` : ""}`,
						),
					].join("\n"),
			"info",
		);
	}

	private showPending(context: ExtensionCommandContext): void {
		const pending = this.runtime.pending(context);
		context.ui.notify(
			pending.length === 0
				? "No Code Mode action is awaiting approval."
				: pending
						.map(
							(action) =>
								`${action.executionId} · ${String(action.seq)} · tools.${action.method} · ${stringifyForStorage(action.args) ?? "undefined"}`,
						)
						.join("\n"),
			"info",
		);
	}

	private showSnippets(context: ExtensionCommandContext): void {
		const snippets = this.ledger.snippets(context);
		context.ui.notify(
			snippets.length === 0
				? "No saved Code Mode snippets."
				: snippets
						.map(
							(snippet) =>
								`${JSON.stringify(snippet.name)}${snippet.description ? ` · ${snippet.description}` : ""}`,
						)
						.join("\n"),
			"info",
		);
	}

	private async approve(executionId: string, context: ExtensionCommandContext): Promise<void> {
		await context.waitForIdle();
		const result = await this.runtime.approve(executionId, context, context.signal);
		if (
			result.details.status === "error" &&
			result.details.operations.length === 0 &&
			result.details.error?.includes("is not paused")
		) {
			context.ui.notify(result.details.error, "warning");
			return;
		}
		await deliverDecision(this.pi, "approved", executionId, result);
		context.ui.notify(`Code Mode execution ${executionId} resumed: ${result.details.status}.`, "info");
	}

	private async reject(executionId: string, rawSequence: string, context: ExtensionCommandContext): Promise<void> {
		const sequence = Number(rawSequence);
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			throw new Error("Code Mode rejection sequence must be a non-negative integer");
		}
		await context.waitForIdle();
		if (!(await this.runtime.reject(executionId, sequence, context))) {
			context.ui.notify("That Code Mode action is no longer pending; refresh the approval list.", "warning");
			return;
		}
		await deliverDecision(this.pi, "rejected", executionId);
		context.ui.notify(`Rejected Code Mode execution ${executionId} at step ${String(sequence)}.`, "info");
	}

	private async expire(context: ExtensionCommandContext): Promise<void> {
		const expired = this.ledger.expire(context);
		for (const executionId of expired) {
			const status = this.ledger.history(context, 100).find((item) => item.executionId === executionId)?.status;
			await this.connector.disposeExecution(executionId, status === "rejected" ? "rejected" : "error");
		}
		context.ui.notify(
			expired.length > 0
				? `Expired ${String(expired.length)} stale Code Mode execution(s).`
				: "No Code Mode execution is old enough to expire.",
			"info",
		);
	}

	private async rollback(executionId: string, context: ExtensionCommandContext): Promise<void> {
		const outcome = await compensateCodeModeExecution(
			this.options.registry,
			this.ledger,
			context,
			executionId,
			context.signal,
		);
		if (outcome.failures.length > 0) {
			context.ui.notify(
				`Compensated ${String(outcome.compensated)} call(s); ${String(outcome.failures.length)} failed: ${outcome.failures.join("; ")}`,
				"error",
			);
			return;
		}
		if (outcome.complete) await this.connector.disposeExecution(executionId, "rolled_back");
		context.ui.notify(
			outcome.complete
				? `Compensated ${String(outcome.compensated)} call(s) in reverse order.`
				: "No applied Tool in that execution declares a compensating operation.",
			"info",
		);
	}

	private async handle(args: string, context: ExtensionCommandContext): Promise<void> {
		const [rawAction, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
		if (!rawAction) return this.showDialog(context);
		const action = rawAction.toLowerCase();
		try {
			if (action === "on" || action === "off") {
				await this.persistProject(context, action === "on");
				context.ui.notify(`Code Mode ${this.enabled ? "on" : "off"}`, "info");
				return;
			}
			if (action === "global" && (rest[0] === "on" || rest[0] === "off")) {
				await this.persistGlobal(context, rest[0] === "on");
				context.ui.notify(`Code Mode global default ${rest[0]}`, "info");
				return;
			}
			if (action === "history") return this.showHistory(context);
			if (action === "pending") return this.showPending(context);
			if (action === "approve" && rest[0]) return this.approve(rest[0], context);
			if (action === "reject" && rest[0] && rest[1]) return this.reject(rest[0], rest[1], context);
			if (action === "snippets") return this.showSnippets(context);
			if (action === "save" && rest[0] && rest[1]) {
				const snippet = this.ledger.saveSnippet(context, rest[0], rest[1], rest.slice(2).join(" "));
				context.ui.notify(`Saved Code Mode snippet ${JSON.stringify(snippet.name)}.`, "info");
				return;
			}
			if (action === "delete" && rest[0]) {
				context.ui.notify(
					this.ledger.deleteSnippet(context, rest[0])
						? `Deleted Code Mode snippet ${JSON.stringify(rest[0])}.`
						: `No Code Mode snippet ${JSON.stringify(rest[0])} exists.`,
					"info",
				);
				return;
			}
			if (action === "abandon" && rest[0]) {
				context.ui.notify(
					this.ledger.abandon(context, rest[0])
						? `Abandoned Code Mode execution ${rest[0]}. No Tool was repeated.`
						: `Execution ${rest[0]} is missing or no longer incomplete.`,
					"info",
				);
				return;
			}
			if (action === "expire") return this.expire(context);
			if ((action === "rollback" || action === "compensate") && rest[0]) return this.rollback(rest[0], context);
			context.ui.notify(USAGE, "warning");
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}
