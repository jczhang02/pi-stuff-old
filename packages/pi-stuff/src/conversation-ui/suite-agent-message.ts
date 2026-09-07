import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHostSharedResource } from "../shared/host-resource.js";
import { hasDirectUserActivation } from "./agent-run-origin.js";

const SUITE_AGENT_MESSAGE_BROKER_DISCOVERY = "@jczhang02/pi-stuff-ui/suite-agent-message-broker/v1";
const SUITE_AGENT_MESSAGE_BROKERS = Symbol.for("@jczhang02/pi-stuff-ui/suite-agent-message-brokers/v1");
const NATIVE_COMPACTION_PREFLIGHTS = Symbol.for("@jczhang02/pi-stuff-ui/native-compaction-preflights/v1");

export type SuiteAgentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export type SuiteAgentMessageOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

export interface SuiteAgentMessageHost {
	readonly events?: ExtensionAPI["events"];
	sendMessage(message: SuiteAgentMessage, options?: SuiteAgentMessageOptions): void | PromiseLike<void>;
}

export interface SuiteAgentMessagePreparation {
	prepare(activation: "automatic" | "direct-user", options: SuiteAgentMessageOptions): Promise<void>;
	/** Stage provider-only state immediately before the Host accepts the message. */
	stage?(options: SuiteAgentMessageOptions): (() => void) | undefined;
}

interface SuiteAgentMessageBroker {
	preparation: SuiteAgentMessagePreparation | undefined;
}

function brokerRegistry(): WeakMap<object, SuiteAgentMessageBroker> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, SUITE_AGENT_MESSAGE_BROKERS)?.value;
	if (existing instanceof WeakMap) return existing;
	const created = new WeakMap<object, SuiteAgentMessageBroker>();
	Object.defineProperty(globalThis, SUITE_AGENT_MESSAGE_BROKERS, {
		configurable: true,
		value: created,
		writable: true,
	});
	return created;
}

function brokerFor(pi: { readonly events?: ExtensionAPI["events"] }): SuiteAgentMessageBroker {
	const registry = brokerRegistry();
	const events = pi.events;
	if (events) {
		return getHostSharedResource(events, registry, SUITE_AGENT_MESSAGE_BROKER_DISCOVERY, () => ({
			preparation: undefined,
		}));
	}
	const key = pi;
	let broker = registry.get(key);
	if (!broker) {
		broker = { preparation: undefined };
		registry.set(key, broker);
	}
	return broker;
}

/** Install the optional Context preparation hook on the shared Host delivery seam. */
export function registerSuiteAgentMessagePreparation(
	pi: Pick<ExtensionAPI, "events">,
	preparation: SuiteAgentMessagePreparation,
): () => void {
	const broker = brokerFor(pi);
	if (broker.preparation && broker.preparation !== preparation) {
		throw new Error("Suite Agent message preparation is already registered for this Pi Host");
	}
	broker.preparation = preparation;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (broker.preparation === preparation) broker.preparation = undefined;
	};
}

/**
 * Send Suite-owned custom Agent work only after every installed preparation
 * hook has settled. The seam stays in the shared layer so Capability Modules do
 * not depend on Context; Context contributes behavior by registration instead.
 */
export async function sendSuiteAgentMessage(
	pi: SuiteAgentMessageHost,
	message: SuiteAgentMessage,
	options?: SuiteAgentMessageOptions,
	isCurrent: () => boolean = () => true,
	onAccepted?: () => void,
	canSubmit: () => boolean = () => true,
): Promise<boolean> {
	if (!isCurrent()) return false;
	const preparation = brokerFor(pi).preparation;
	if (preparation) {
		await preparation.prepare(hasDirectUserActivation(message) ? "direct-user" : "automatic", options);
	}
	if (!isCurrent() || !canSubmit()) return false;
	const rollback = preparation?.stage?.(options);
	try {
		await pi.sendMessage(message, options);
	} catch (error) {
		rollback?.();
		throw error;
	}
	if (!isCurrent()) return false;
	onAccepted?.();
	return true;
}

function nativeCompactionPreflights(): WeakMap<object, number> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_PREFLIGHTS)?.value;
	if (existing instanceof WeakMap) return existing;
	const created = new WeakMap<object, number>();
	Object.defineProperty(globalThis, NATIVE_COMPACTION_PREFLIGHTS, {
		configurable: true,
		value: created,
		writable: true,
	});
	return created;
}

/** Mark a public Pi compaction as the Suite's custom-turn safety preflight. */
export function beginSuiteNativeCompactionPreflight(ctx: Pick<ExtensionContext, "sessionManager">): () => void {
	const preflights = nativeCompactionPreflights();
	const key = ctx.sessionManager;
	preflights.set(key, (preflights.get(key) ?? 0) + 1);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const remaining = (preflights.get(key) ?? 1) - 1;
		if (remaining > 0) preflights.set(key, remaining);
		else preflights.delete(key);
	};
}

export function isSuiteNativeCompactionPreflight(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	return (nativeCompactionPreflights().get(ctx.sessionManager) ?? 0) > 0;
}
