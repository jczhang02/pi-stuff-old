import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { withAgentWorkOrigin } from "../../conversation-ui/agent-run-origin.js";
import { sendSuiteAgentMessage, withDirectUserActivation } from "../../conversation-ui/index.js";
import { isRuntimeString } from "../../shared/runtime-type.js";
import { formatError } from "./errors.js";
import { appendGoalPromptMarker, extractContinuationMarker, extractGoalPromptMarker } from "./markers.js";
import type { ActiveGoal } from "./persistence.js";
import type { StatusContext } from "./policy.js";
import { buildContinuePrompt } from "./prompts.js";

export interface ContinuationTicket {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

export type GoalRunOrigin = "manual" | "automatic";

export interface GoalPromptDeliveryOptions {
	readonly isCurrent?: () => boolean;
	readonly resetSafetyEpoch?: boolean;
	readonly userDriven?: boolean;
}

export interface GoalPromptOwnershipSnapshot {
	continuationIntent?: ContinuationTicket | undefined;
	continuationDelivery?: ContinuationTicket | undefined;
	cancelledContinuationMarkers: string[];
}

interface PendingGoalPrompt {
	goalId: string;
	origin: GoalRunOrigin;
	resetSafetyEpoch: boolean;
}

interface PendingNonGoalInput {
	behavior: "idle" | "steer" | "followUp";
	fingerprint: string;
	origin: GoalRunOrigin;
	resetSafetyEpoch: boolean;
}

export const GOAL_PROMPT_MESSAGE_TYPE = "pi-stuff-goal-prompt";

/** Owns correlation between queued Pi prompts and the Goal run that may claim them. */
export class GoalPromptOwnership {
	continuationIntent: ContinuationTicket | undefined;
	continuationDelivery: ContinuationTicket | undefined;
	private readonly pi: ExtensionAPI;
	// Pi's delivery queues are not capped. These mirrors must retain every
	// unresolved marker until delivery or an explicit lifecycle clear; evicting an
	// older entry can silently transfer Goal ownership or safety policy.
	private pendingGoalPromptMarkers = new Map<string, PendingGoalPrompt>();
	private claimedGoalPromptMarkers = new Map<string, PendingGoalPrompt>();
	private cancelledContinuationMarkers = new Set<string>();
	private claimedContinuationMarkers = new Set<string>();
	private pendingNonGoalInputs: PendingNonGoalInput[] = [];

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	requestContinuation(goal: ActiveGoal) {
		if (this.hasContinuationWorkForGoal(goal.id)) return false;
		const marker = `${goal.id}:${goal.iteration}:${randomUUID()}`;
		this.continuationIntent = {
			goalId: goal.id,
			iteration: goal.iteration,
			marker,
			prompt: buildContinuePrompt(goal, marker),
		};
		return true;
	}

	hasContinuationWorkForGoal(goalId: string) {
		return this.continuationIntent?.goalId === goalId || this.continuationDelivery?.goalId === goalId;
	}

	clearSettledClaims() {
		this.pendingNonGoalInputs = [];
		this.claimedGoalPromptMarkers.clear();
		this.claimedContinuationMarkers.clear();
	}

	clearContinuationTracking() {
		this.continuationIntent = undefined;
		this.continuationDelivery = undefined;
		this.cancelledContinuationMarkers.clear();
		this.claimedContinuationMarkers.clear();
	}

	clearPendingGoalPrompts() {
		this.pendingGoalPromptMarkers.clear();
		this.claimedGoalPromptMarkers.clear();
		this.pendingNonGoalInputs = [];
	}

	sendOwnedGoalPrompt(
		ctx: StatusContext,
		goalId: string,
		prompt: string,
		options: GoalPromptDeliveryOptions,
		isGoalActive: () => boolean,
	): Effect.Effect<boolean> {
		return Effect.gen({ self: this }, function* () {
			const { isCurrent, resetSafetyEpoch = true, userDriven = false } = options;
			const ownsPrompt = () => isGoalActive() && (isCurrent?.() ?? true);
			const pending = this.rememberPendingGoalPrompt(
				goalId,
				prompt,
				resetSafetyEpoch,
				userDriven ? "manual" : "automatic",
			);
			const sent = yield* sendPrompt(this.pi, ctx, pending.prompt, userDriven, ownsPrompt);
			if (!sent || !ownsPrompt()) {
				this.pendingGoalPromptMarkers.delete(pending.marker);
				return false;
			}
			return true;
		});
	}

	private rememberPendingGoalPrompt(goalId: string, prompt: string, resetSafetyEpoch: boolean, origin: GoalRunOrigin) {
		const marker = randomUUID();
		this.pendingGoalPromptMarkers.set(marker, { goalId, origin, resetSafetyEpoch });
		return { marker, prompt: appendGoalPromptMarker(prompt, marker) };
	}

	cancelContinuationWork() {
		if (this.continuationDelivery) {
			this.cancelledContinuationMarkers.add(this.continuationDelivery.marker);
		}
		this.continuationIntent = undefined;
		this.continuationDelivery = undefined;
	}

	consumeCancelledContinuationPrompt(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		return marker ? this.cancelledContinuationMarkers.delete(marker) : false;
	}

	hasPendingOwnedGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		return marker ? this.pendingGoalPromptMarkers.has(marker) : false;
	}

	hasOwnedPromptBoundary(prompt: string) {
		const goalMarker = extractGoalPromptMarker(prompt);
		if (
			goalMarker &&
			(this.pendingGoalPromptMarkers.has(goalMarker) || this.claimedGoalPromptMarkers.has(goalMarker))
		) {
			return true;
		}
		const continuationMarker = extractContinuationMarker(prompt);
		return Boolean(
			continuationMarker &&
				(this.continuationDelivery?.marker === continuationMarker ||
					this.claimedContinuationMarkers.has(continuationMarker)),
		);
	}

	consumeStaleOwnedGoalPrompt(prompt: string, isGoalActive: (goalId: string) => boolean) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return false;
		const pending = this.pendingGoalPromptMarkers.get(marker);
		if (!pending) return false;
		if (isGoalActive(pending.goalId)) return false;
		this.pendingGoalPromptMarkers.delete(marker);
		return true;
	}

	noteQueuedNonGoalInput(
		prompt: string,
		behavior: "idle" | "steer" | "followUp",
		origin: GoalRunOrigin,
		resetSafetyEpoch = origin === "manual",
	) {
		// A new idle prompt starts a new Host run. Any older mirror belongs to an
		// input attempt that was handled or rejected before delivery.
		if (behavior === "idle") this.pendingNonGoalInputs = [];
		this.pendingNonGoalInputs.push({
			behavior,
			fingerprint: inputFingerprint(prompt),
			origin,
			resetSafetyEpoch,
		});
	}

	discardQueuedNonGoalInputs(behaviors: readonly ("idle" | "steer" | "followUp")[]) {
		this.pendingNonGoalInputs = this.pendingNonGoalInputs.filter((pending) => !behaviors.includes(pending.behavior));
	}

	consumeQueuedNonGoalInput(
		prompt: string,
		allowDeliveryFallback = true,
		behaviors: readonly ("idle" | "steer" | "followUp")[] = ["steer", "followUp"],
	) {
		if (!isRuntimeString(prompt)) return undefined;
		const fingerprint = inputFingerprint(prompt);
		const candidates = this.pendingNonGoalInputs.filter((pending) => behaviors.includes(pending.behavior));
		if (
			new Set(candidates.map((pending) => pending.origin)).size > 1 ||
			new Set(candidates.map((pending) => pending.resetSafetyEpoch)).size > 1
		) {
			// A separately loaded Extension can handle or transform after this Package's
			// input handler. Mixed user/automatic mirrors cannot be correlated safely,
			// even across steer/follow-up classes or an exact-text collision.
			const behavior = (["steer", "followUp", "idle"] as const).find((candidate) =>
				candidates.some((pending) => pending.behavior === candidate),
			);
			this.pendingNonGoalInputs = [];
			return behavior ? { behavior, fingerprint, origin: "automatic" as const, resetSafetyEpoch: false } : undefined;
		}
		// Pi drains steers before follow-ups. Select that delivery class before
		// comparing text: a Skill may expand one queued prompt into text that happens
		// to equal a later prompt in the other class.
		for (const behavior of ["steer", "followUp", "idle"] as const) {
			if (!behaviors.includes(behavior)) continue;
			const firstIndex = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === behavior);
			if (firstIndex < 0) continue;
			const exactIndex = this.pendingNonGoalInputs.findIndex(
				(pending) => pending.behavior === behavior && pending.fingerprint === fingerprint,
			);
			if (exactIndex >= 0) return this.pendingNonGoalInputs.splice(exactIndex, 1)[0];
			// An owned Goal/recovery boundary must not consume a transformed non-Goal
			// input. It also must not skip a higher-priority steer to claim a follow-up.
			if (!allowDeliveryFallback) return undefined;
			return this.pendingNonGoalInputs.splice(firstIndex, 1)[0];
		}
		return undefined;
	}

	markContinuationStarted(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		if (!marker) {
			// A user, retry, or another extension started newer work. Cancel both an
			// unsent intent and a delivery that may have lost the non-atomic idle race;
			// the newer work's agent_end will record a fresh intent.
			this.cancelContinuationWork();
			return undefined;
		}
		if (this.continuationDelivery?.marker === marker) {
			const goalId = this.continuationDelivery.goalId;
			this.continuationDelivery = undefined;
			this.claimedContinuationMarkers.add(marker);
			return goalId;
		}
		if (this.claimedContinuationMarkers.has(marker)) return marker.split(":", 1)[0];
		// Marker syntax is not authority. User text or another Extension may contain
		// a lookalike comment; only an exact outstanding or already-claimed ticket
		// belongs to this Goal runtime.
		this.cancelContinuationWork();
		return undefined;
	}

	consumeOwnedGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return undefined;
		const pending = this.pendingGoalPromptMarkers.get(marker);
		this.pendingGoalPromptMarkers.delete(marker);
		if (pending) {
			this.claimedGoalPromptMarkers.set(marker, pending);
			return pending;
		}
		return this.claimedGoalPromptMarkers.get(marker);
	}

	snapshot(): GoalPromptOwnershipSnapshot {
		return {
			continuationIntent: this.continuationIntent ? structuredClone(this.continuationIntent) : undefined,
			continuationDelivery: this.continuationDelivery ? structuredClone(this.continuationDelivery) : undefined,
			cancelledContinuationMarkers: [...this.cancelledContinuationMarkers],
		};
	}

	restore(snapshot: GoalPromptOwnershipSnapshot) {
		this.continuationIntent = snapshot.continuationIntent ? structuredClone(snapshot.continuationIntent) : undefined;
		this.continuationDelivery = snapshot.continuationDelivery
			? structuredClone(snapshot.continuationDelivery)
			: undefined;
		this.cancelledContinuationMarkers = new Set(snapshot.cancelledContinuationMarkers);
	}
}

function inputFingerprint(prompt: string) {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function sendPrompt(
	pi: ExtensionAPI,
	ctx: StatusContext,
	prompt: string,
	userDriven: boolean,
	isCurrent?: () => boolean,
): Effect.Effect<boolean> {
	return sendHiddenGoalPrompt(pi, prompt, userDriven, isCurrent).pipe(
		Effect.catch((error) =>
			Effect.sync(() => {
				if (!isCurrent || isCurrent()) {
					ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
				}
				return false;
			}),
		),
	);
}

export function sendHiddenGoalPrompt(
	pi: ExtensionAPI,
	prompt: string,
	userDriven = false,
	isCurrent: () => boolean = () => true,
	canSubmit: () => boolean = () => true,
) {
	const message = withAgentWorkOrigin(
		{
			customType: GOAL_PROMPT_MESSAGE_TYPE,
			content: prompt,
			display: false,
		},
		userDriven ? "user" : "automatic",
	);
	return Effect.tryPromise({
		try: () =>
			sendSuiteAgentMessage(
				pi,
				userDriven ? withDirectUserActivation(message) : message,
				{ deliverAs: "followUp", triggerTurn: true },
				isCurrent,
				undefined,
				canSubmit,
			),
		catch: (error) => error,
	});
}
