import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Guard } from "typebox/guard";
import { Check } from "typebox/value";
import { isRuntimeFunction, isRuntimeObject } from "../shared/runtime-type.ts";

const ACTIVE_AGENT_WORK_USER_EVENT = "@jczhang02/pi-stuff-ui/active-agent-work-user/v1";
const AGENT_WORK_ORIGIN_QUERY_EVENT = "@jczhang02/pi-stuff-ui/agent-work-origin-query/v1";
const AGENT_WORK_ORIGIN_DETAIL = Symbol.for("@jczhang02/pi-stuff/agent-work-origin/v1");
const DIRECT_USER_ACTIVATION_DETAIL = Symbol.for("@jczhang02/pi-stuff/direct-user-activation/v1");
const TEXT_MESSAGE_PART_SCHEMA = Type.Object(
	{ text: Type.Optional(Type.String()), type: Type.Literal("text") },
	{ additionalProperties: true },
);

export type AgentWorkOrigin = "automatic" | "user";

interface AgentWorkOriginQuery {
	handled: boolean;
	origin: AgentWorkOrigin;
}

interface PendingInput {
	behavior: "followUp" | "idle" | "steer";
	origin: AgentWorkOrigin;
	text: string;
}

interface AgentMessageLike {
	content?: unknown;
	details?: unknown;
	role?: unknown;
}

/**
 * Track the origin of work that is actually executing, independently from
 * follow-ups that Pi has accepted but not delivered yet.
 */
export class AgentRunOriginTracker {
	private activeOrigin: AgentWorkOrigin = "automatic";
	private deliveredOriginThisTurn: AgentWorkOrigin | undefined;
	private pendingInputs: PendingInput[] = [];
	private runIncludesUserWork = false;
	private turnActive = false;

	noteInput(event: InputEvent): void {
		const origin = event.source === "extension" ? "automatic" : "user";
		const behavior = event.streamingBehavior ?? "idle";

		if (behavior === "idle") {
			// An idle input defines a new Agent run. Any older undelivered input
			// belongs to a handled/failed attempt and must not leak into this run.
			this.pendingInputs = [];
			this.activeOrigin = "automatic";
			// A later input handler may still consume or reject this prompt. Count
			// it only at Pi's real message_start boundary.
			this.runIncludesUserWork = false;
			this.deliveredOriginThisTurn = undefined;
		}

		this.pendingInputs.push({ behavior, origin, text: event.text });
	}

	noteTurnStart(): void {
		this.deliveredOriginThisTurn = undefined;
		this.turnActive = true;
	}

	noteTurnEnd(): void {
		this.turnActive = false;
	}

	noteMessageStart(message: AgentMessageLike): void {
		// Pi also emits message_start for idle, non-triggering custom entries.
		// Provenance changes only inside a real Agent turn.
		if (!this.turnActive) return;
		if (message.role === "custom") {
			// Unmarked custom work belongs to another Extension. Treat it as automatic
			// rather than inheriting stale provenance from a handled input attempt.
			this.noteDeliveredWork(readAgentWorkOrigin(message) ?? "automatic");
			return;
		}
		if (message.role !== "user") return;
		const pending = this.consumePendingInput(extractMessageText(message.content));
		this.noteDeliveredWork(pending?.origin ?? "automatic");
	}

	promoteActiveWorkToUser(): void {
		this.activeOrigin = "user";
		this.runIncludesUserWork = true;
		if (this.deliveredOriginThisTurn !== undefined) this.deliveredOriginThisTurn = "user";
	}

	current(): AgentWorkOrigin {
		return this.activeOrigin;
	}

	hasUserWork(): boolean {
		return this.runIncludesUserWork;
	}

	consumeRunIncludesUserWork(): boolean {
		const includesUserWork = this.runIncludesUserWork;
		this.reset();
		return includesUserWork;
	}

	reset(): void {
		this.activeOrigin = "automatic";
		this.deliveredOriginThisTurn = undefined;
		this.pendingInputs = [];
		this.runIncludesUserWork = false;
		this.turnActive = false;
	}

	private consumePendingInput(text: string): PendingInput | undefined {
		// Pi drains steers before follow-ups. Select the active delivery class
		// first, then use text only to disambiguate within that FIFO class. Text
		// may have changed through a Skill, template, or later input handler.
		if (new Set(this.pendingInputs.map((pending) => pending.origin)).size > 1) {
			// Pi exposes no post-input result hook across separately loaded Extensions.
			// A handled steer can therefore sit before a transformed follow-up (or vice
			// versa), so checking only one delivery class is unsafe. Clear the complete
			// mirror and fail closed for this delivery.
			const behavior = (["steer", "followUp", "idle"] as const).find((candidate) =>
				this.pendingInputs.some((pending) => pending.behavior === candidate),
			);
			this.pendingInputs = [];
			return behavior ? { behavior, origin: "automatic", text } : undefined;
		}
		for (const behavior of ["steer", "followUp", "idle"] as const) {
			const candidates = this.pendingInputs
				.map((pending, index) => ({ index, pending }))
				.filter(({ pending }) => pending.behavior === behavior);
			const firstIndex = candidates[0]?.index ?? -1;
			if (firstIndex < 0) continue;
			const exactIndex = this.pendingInputs.findIndex(
				(pending) => pending.behavior === behavior && pending.text === text,
			);
			return this.pendingInputs.splice(exactIndex >= 0 ? exactIndex : firstIndex, 1)[0];
		}
		return undefined;
	}

	private noteDeliveredWork(origin: AgentWorkOrigin): void {
		if (this.deliveredOriginThisTurn === undefined) {
			this.deliveredOriginThisTurn = origin;
			this.activeOrigin = origin;
		} else if (origin === "user") {
			// Pi may deliver several queued messages in one turn. Such a batch is
			// user-driven if any constituent message came from the user.
			this.deliveredOriginThisTurn = "user";
			this.activeOrigin = "user";
		}
		if (origin === "user") this.runIncludesUserWork = true;
	}
}

/** Mark a Suite custom message without exposing provenance in persisted JSON. */
export function withAgentWorkOrigin<Message extends object>(
	message: Message,
	origin: AgentWorkOrigin,
): Message & { details: object } {
	const details = cloneMessageDetails(Object.getOwnPropertyDescriptor(message, "details")?.value);
	Object.defineProperty(details, AGENT_WORK_ORIGIN_DETAIL, { value: origin });
	return { ...message, details };
}

export function readAgentWorkOrigin<Message extends object>(message: Message): AgentWorkOrigin | undefined {
	const details = Object.getOwnPropertyDescriptor(message, "details")?.value;
	if (!Guard.IsObject(details)) return undefined;
	const origin = Object.getOwnPropertyDescriptor(details, AGENT_WORK_ORIGIN_DETAIL)?.value;
	return origin === "user" || origin === "automatic" ? origin : undefined;
}

/**
 * Authorize first-use state changes for one message that came from a direct
 * user action. This is deliberately separate from historical work origin:
 * delayed background results may remain user-attributed without gaining the
 * authority of a current command, prompt, or UI/RPC action.
 */
export function withDirectUserActivation<Message extends object>(message: Message): Message & { details: object } {
	const details = cloneMessageDetails(Object.getOwnPropertyDescriptor(message, "details")?.value);
	Object.defineProperty(details, DIRECT_USER_ACTIVATION_DETAIL, { value: true });
	return { ...message, details };
}

export function hasDirectUserActivation<Message extends object>(message: Message): boolean {
	const details = Object.getOwnPropertyDescriptor(message, "details")?.value;
	return (
		Guard.IsObject(details) && Object.getOwnPropertyDescriptor(details, DIRECT_USER_ACTIVATION_DETAIL)?.value === true
	);
}

/** Observe explicit user steers that affect work already in flight. */
export function listenForActiveAgentWorkUserPromotions(
	pi: Pick<ExtensionAPI, "events">,
	listener: () => void,
): () => void {
	const unsubscribe = pi.events.on(ACTIVE_AGENT_WORK_USER_EVENT, listener);
	return isRuntimeFunction(unsubscribe) ? unsubscribe : () => {};
}

/** Publish the current parent Agent run's origin to independently loaded Capabilities. */
export function listenForAgentWorkOriginQueries(
	pi: Pick<ExtensionAPI, "events">,
	readOrigin: () => AgentWorkOrigin,
): () => void {
	const unsubscribe = pi.events.on(AGENT_WORK_ORIGIN_QUERY_EVENT, (value) => {
		if (!value || !isRuntimeObject(value)) return;
		// SAFETY: this private event is emitted only below with the mutable query object owned by this module.
		const query = value as AgentWorkOriginQuery;
		query.origin = readOrigin();
		query.handled = true;
	});
	return isRuntimeFunction(unsubscribe) ? unsubscribe : () => {};
}

/**
 * Read the active Agent run's origin without consuming it. Missing or failed UI
 * attribution is treated as automatic so observation-only policy fails closed.
 */
export function readCurrentAgentWorkOrigin(pi: { readonly events?: ExtensionAPI["events"] }): AgentWorkOrigin {
	const query: AgentWorkOriginQuery = { handled: false, origin: "automatic" };
	try {
		pi.events?.emit(AGENT_WORK_ORIGIN_QUERY_EVENT, query);
	} catch {
		return "automatic";
	}
	return query.handled && query.origin === "user" ? "user" : "automatic";
}

/** Attribute a direct user steer to the Agent work already in flight. */
export function promoteActiveAgentWorkToUser(pi: Pick<ExtensionAPI, "events">): void {
	try {
		pi.events.emit(ACTIVE_AGENT_WORK_USER_EVENT, undefined);
	} catch {
		// Attribution is observational and must never block the user action.
	}
}

function extractMessageText<Content>(content: Content): string {
	if (Guard.IsString(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => Check(TEXT_MESSAGE_PART_SCHEMA, part))
		.flatMap((part) => (part.text === undefined ? [] : [part.text]))
		.join("\n");
}

function cloneMessageDetails<Value>(value: Value): object {
	if (Guard.IsObject(value) && !Array.isArray(value)) {
		return Object.defineProperties({}, Object.getOwnPropertyDescriptors(value));
	}
	return value === undefined ? {} : { value };
}
