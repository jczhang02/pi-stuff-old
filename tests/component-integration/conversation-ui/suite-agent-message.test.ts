import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hasDirectUserActivation,
	readAgentWorkOrigin,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";
import {
	beginSuiteNativeCompactionPreflight,
	isSuiteNativeCompactionPreflight,
	registerSuiteAgentMessagePreparation,
	type SuiteAgentMessageHost,
	sendSuiteAgentMessage,
} from "../../../packages/pi-stuff/src/conversation-ui/suite-agent-message.js";

type SuiteAgentMessageEventHost = SuiteAgentMessageHost & Pick<ExtensionAPI, "events">;
type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];

function hostApis(
	sendMessage: SuiteAgentMessageHost["sendMessage"],
): [SuiteAgentMessageEventHost, SuiteAgentMessageEventHost] {
	const listeners = new Map<string, Set<ExtensionEventListener>>();
	const facade = (): ExtensionAPI["events"] => ({
		emit(name, value): void {
			for (const listener of listeners.get(name) ?? []) listener(value);
		},
		on(name, listener): () => void {
			const current = listeners.get(name) ?? new Set();
			current.add(listener);
			listeners.set(name, current);
			return () => current.delete(listener);
		},
	});
	return [
		{ events: facade(), sendMessage },
		{ events: facade(), sendMessage },
	];
}

test("Suite Agent message preparation crosses Pi event facades and awaits thenables", async () => {
	const order: string[] = [];
	const then: PromiseLike<void>["then"] = (onfulfilled, onrejected) =>
		Promise.resolve()
			.then(() => {
				order.push("accepted");
			})
			.then(onfulfilled, onrejected);
	// SAFETY: the proxy exposes the bound Promise-compatible method for `then` and no conflicting properties.
	const thenable = new Proxy(
		{},
		{ get: (_target, property): PromiseLike<void>["then"] | undefined => (property === "then" ? then : undefined) },
	) as PromiseLike<void>;
	const [owner, sender] = hostApis(() => {
		order.push("send");
		return thenable;
	});
	const unregister = registerSuiteAgentMessagePreparation(owner, {
		prepare: async (origin) => {
			order.push(`prepare:${origin}`);
		},
		stage: () => {
			order.push("stage");
			return () => order.push("rollback");
		},
	});

	await sendSuiteAgentMessage(
		sender,
		{ customType: "test", content: "continue", display: false },
		{ triggerTurn: true },
		() => true,
		() => order.push("callback"),
	);

	expect(order).toEqual(["prepare:automatic", "stage", "send", "accepted", "callback"]);
	unregister();
});

test("direct activation authority stays separate from historical user attribution", async () => {
	const activations: string[] = [];
	const delivered: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
	// SAFETY: this test controls the value and supplies every SuiteAgentMessageHost member exercised by this case.
	const [owner, sender] = hostApis(((message) => {
		delivered.push(message);
	}) as SuiteAgentMessageHost["sendMessage"]);
	registerSuiteAgentMessagePreparation(owner, {
		prepare: async (activation) => {
			activations.push(activation);
		},
	});

	const historicalUserWork = withAgentWorkOrigin(
		{ customType: "background-result", content: "done", display: true },
		"user",
	);
	await sendSuiteAgentMessage(sender, historicalUserWork, { triggerTurn: true });
	const directUserAction = withAgentWorkOrigin(
		withDirectUserActivation({ customType: "command", content: "run", display: true }),
		"user",
	);
	await sendSuiteAgentMessage(sender, directUserAction, { triggerTurn: true });

	expect(activations).toEqual(["automatic", "direct-user"]);
	expect(delivered.map((message) => readAgentWorkOrigin(message))).toEqual(["user", "user"]);
	expect(hasDirectUserActivation(directUserAction)).toBe(true);
	expect(JSON.stringify(directUserAction)).not.toContain("direct-user-activation");
});

test("Suite Agent message delivery rolls staged state back only when Host delivery fails", async () => {
	const order: string[] = [];
	// SAFETY: this test controls the value and supplies every SuiteAgentMessageHost member exercised by this case.
	const [owner, sender] = hostApis((() =>
		Promise.reject(new Error("delivery failed"))) as SuiteAgentMessageHost["sendMessage"]);
	registerSuiteAgentMessagePreparation(owner, {
		prepare: async () => {},
		stage: () => () => order.push("rollback"),
	});

	await expect(
		sendSuiteAgentMessage(sender, { customType: "test", content: "continue", display: false }, { triggerTurn: true }),
	).rejects.toThrow("delivery failed");
	expect(order).toEqual(["rollback"]);
});

test("Suite Agent message delivery rechecks session ownership after asynchronous preparation", async () => {
	const preparation = Promise.withResolvers<void>();
	let current = true;
	let deliveries = 0;
	// SAFETY: this test controls the value and supplies every SuiteAgentMessageHost member exercised by this case.
	const [owner, sender] = hostApis((() => {
		deliveries += 1;
	}) as SuiteAgentMessageHost["sendMessage"]);
	registerSuiteAgentMessagePreparation(owner, {
		prepare: () => preparation.promise,
	});

	const pending = sendSuiteAgentMessage(
		sender,
		{ customType: "test", content: "continue", display: false },
		{ triggerTurn: true },
		() => current,
	);
	current = false;
	preparation.resolve();

	await expect(pending).resolves.toBe(false);
	expect(deliveries).toBe(0);
});

test("Suite Agent message delivery cannot accept into a session replaced during Host delivery", async () => {
	const delivery = Promise.withResolvers<void>();
	let current = true;
	let accepted = 0;
	// SAFETY: this test controls the value and supplies every SuiteAgentMessageHost member exercised by this case.
	const [, sender] = hostApis((() => delivery.promise) as SuiteAgentMessageHost["sendMessage"]);

	const pending = sendSuiteAgentMessage(
		sender,
		{ customType: "test", content: "continue", display: false },
		{ triggerTurn: true },
		() => current,
		() => {
			accepted += 1;
		},
	);
	current = false;
	delivery.resolve();

	await expect(pending).resolves.toBe(false);
	expect(accepted).toBe(0);
});

test("automatic delivery rechecks idle after preparation without rejecting the run it starts", async () => {
	const preparation = Promise.withResolvers<void>();
	let idle = true;
	let deliveries = 0;
	const [owner, sender] = hostApis(() => {
		deliveries++;
		idle = false;
	});
	const unregister = registerSuiteAgentMessagePreparation(owner, { prepare: () => preparation.promise });
	const send = () =>
		sendSuiteAgentMessage(
			sender,
			{ customType: "result", content: "retained evidence", display: false },
			{ triggerTurn: true },
			() => true,
			undefined,
			() => idle,
		);
	const pending = send();
	idle = false;
	preparation.resolve();
	expect(await pending).toBe(false);
	expect(deliveries).toBe(0);
	idle = true;
	expect(await send()).toBe(true);
	expect(deliveries).toBe(1);
	unregister();
});

test("Suite Agent messages fail open through a partial standalone API without an event bus", async () => {
	let delivered = false;
	const api = {
		sendMessage: () => {
			delivered = true;
		},
	};

	await sendSuiteAgentMessage(api, { customType: "test", content: "continue", display: false });
	expect(delivered).toBe(true);
});

test("native custom-turn preflight markers are reference-counted by session", () => {
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	const ctx = { sessionManager: {} } as Pick<ExtensionContext, "sessionManager">;
	const finishFirst = beginSuiteNativeCompactionPreflight(ctx);
	const finishSecond = beginSuiteNativeCompactionPreflight(ctx);
	expect(isSuiteNativeCompactionPreflight(ctx)).toBe(true);
	finishFirst();
	expect(isSuiteNativeCompactionPreflight(ctx)).toBe(true);
	finishFirst();
	finishSecond();
	expect(isSuiteNativeCompactionPreflight(ctx)).toBe(false);
});
