import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	type CommandDialogCoordinatorHost,
	type CommandDialogView,
	getCommandDialogCoordinator,
} from "../conversation-ui/index.ts";
import { type EffectFoundation, installEffectFoundation } from "../shared/effect-foundation.ts";
import { BTW_COMMAND_NAME, type BtwExecResult, executeBtw } from "./btw.ts";
import {
	type BtwExchange,
	btwSessionKey,
	clearBtwHistory,
	clearEarlierBtwHistory,
	evictBtwHistory,
	hydrateBtwHistory,
	readBtwHistory,
	recordBtwExchange,
} from "./btw-history.ts";
import { BtwDialogController, type BtwDialogOptions } from "./btw-ui.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type BtwHost = CommandDialogCoordinatorHost & Pick<ExtensionAPI, "appendEntry" | "registerCommand">;

async function runBtwOperation(
	foundation: EffectFoundation,
	program: Effect.Effect<BtwExecResult>,
): Promise<BtwExecResult | undefined> {
	const session = foundation.currentSession();
	if (!session) return undefined;
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program);
	await foundation.close(operation, exit);
	if (Exit.isFailure(exit)) {
		if (Cause.hasInterrupts(exit.cause)) return undefined;
		throw Cause.squash(exit.cause);
	}
	return foundation.isCurrent(session) ? exit.value : undefined;
}

function waitForMainIdle(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = (): void => finish(false);
		signal.addEventListener("abort", abort, { once: true });
		void ctx.waitForIdle().then(
			() => finish(true),
			(cause: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				reject(cause);
			},
		);
	});
}

function promotedAssistant(exchange: BtwExchange, ctx: ExtensionCommandContext): AssistantMessage {
	const response = exchange.response;
	const model = ctx.model;
	if (!response && !model) throw new Error("Could not fork BTW without model metadata");
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: exchange.answer }],
		api: response?.api ?? model?.api ?? "openai-completions",
		provider: response?.provider ?? model?.provider ?? "unknown",
		model: response?.model ?? model?.id ?? "unknown",
		usage: response?.usage ?? ZERO_USAGE,
		stopReason: response?.stopReason ?? "stop",
		timestamp: response?.timestamp ?? exchange.timestamp,
	};
	if (response?.errorMessage !== undefined) assistant.errorMessage = response.errorMessage;
	return assistant;
}

async function promoteBtwExchange(
	exchange: BtwExchange,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
): Promise<void> {
	if (!(await waitForMainIdle(ctx, signal)) || signal.aborted) return;
	const parentSession = ctx.sessionManager.getSessionFile();
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: exchange.question }],
		timestamp: exchange.timestamp,
	};
	const assistantMessage = promotedAssistant(exchange, ctx);
	const options: NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]> = {
		setup: async (sessionManager) => {
			sessionManager.appendMessage(userMessage);
			sessionManager.appendMessage(assistantMessage);
		},
	};
	if (parentSession !== undefined) options.parentSession = parentSession;
	const result = await ctx.newSession(options);
	if (result.cancelled) throw new Error("Could not fork BTW because the session switch was cancelled");
}

function runBtw(
	question: string | undefined,
	ctx: ExtensionCommandContext,
	pi: BtwHost,
	foundation: EffectFoundation,
): Promise<void> {
	if (ctx.mode !== "tui") return Promise.resolve();

	const coordinator = getCommandDialogCoordinator(pi);
	const sessionKey = btwSessionKey(ctx);
	hydrateBtwHistory(sessionKey, ctx.sessionManager.getEntries());
	const history = readBtwHistory(sessionKey);
	const appendHistoryEntry: NonNullable<Parameters<typeof clearBtwHistory>[1]> = (customType, data) =>
		pi.appendEntry(customType, data);
	let resolveController: ((value: { controller: BtwDialogController; signal: AbortSignal }) => void) | undefined;
	const controllerReady = new Promise<{ controller: BtwDialogController; signal: AbortSignal }>((resolve) => {
		resolveController = resolve;
	});

	const view: CommandDialogView = {
		priority: "normal",
		create: ({ signal, tui, theme, keybindings, close }) => {
			const options: BtwDialogOptions = {
				history,
				onClose: () => close(),
				onClearEarlier: (currentId) => {
					if (currentId === undefined) clearBtwHistory(sessionKey, appendHistoryEntry);
					else clearEarlierBtwHistory(sessionKey, currentId, appendHistoryEntry);
				},
				onFork: (exchange, promotionSignal) => promoteBtwExchange(exchange, ctx, promotionSignal),
			};
			if (question !== undefined) Object.assign(options, { question });
			const controller = new BtwDialogController(theme, tui, keybindings, options);
			resolveController?.({ controller, signal });
			resolveController = undefined;
			return controller;
		},
	};

	const surface = coordinator.show(ctx, view);
	if (question !== undefined) {
		void controllerReady.then(async ({ controller, signal }) => {
			const result = await runBtwOperation(
				foundation,
				executeBtw(question, ctx, signal, {
					onTextDelta: (delta) => controller.appendText(delta),
					onRetry: () => controller.resetForRetry(),
				}),
			);
			if (!result) return;
			if (result.kind === "success") {
				const response = result.assistantMessage;
				const responseMetadata = {
					api: response.api,
					provider: response.provider,
					model: response.model,
					usage: response.usage,
					stopReason: response.stopReason,
					timestamp: response.timestamp,
				};
				if (response.errorMessage !== undefined)
					Object.assign(responseMetadata, { errorMessage: response.errorMessage });
				const exchange = recordBtwExchange(
					sessionKey,
					{
						question,
						answer: result.answer,
						timestamp: result.userMessage.timestamp,
						contextTrimmed: result.contextTrimmed,
						response: responseMetadata,
					},
					appendHistoryEntry,
				);
				controller.setSuccess(exchange);
			} else if (result.kind === "error") {
				controller.setError(result.error, result.partial);
			}
		});
	}
	return surface.then(() => undefined);
}

export default function piStuffBtw(pi: BtwHost): void {
	const foundation = installEffectFoundation(pi);
	pi.registerCommand(BTW_COMMAND_NAME, {
		description: "Ask one side question without changing the main conversation",
		handler: (args, ctx) => runBtw(args.trim() || undefined, ctx, pi, foundation),
	});
	pi.on("session_shutdown", (_event, ctx) => {
		evictBtwHistory(btwSessionKey(ctx));
	});
}
