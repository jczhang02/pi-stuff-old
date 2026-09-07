import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { withAgentWorkOrigin } from "../../../conversation-ui/agent-run-origin.ts";
import { sendSuiteAgentMessage } from "../../../conversation-ui/index.ts";
import { parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../../shared/runtime-type.ts";
import type { AgentEffectOwner, AgentEffectTask } from "../runtime/agent-effect-owner.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { type DurableClaim, type tryAcquireDurableClaim, tryAcquireKernelClaim } from "../shared/durable-claim.ts";
import { sessionArtifactMatches } from "../shared/session-identity.ts";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	type IntercomEventBus,
	POLL_INTERVAL_MS,
	type SubagentState,
} from "../shared/types.ts";
import {
	hasLiveTool,
	type IntercomParams,
	IntercomParamsSchema,
	registerCommunicationTool,
} from "./native-supervisor-client.ts";
import {
	askTimeoutMs,
	collectSupervisorChannel,
	errorCode,
	type PendingSupervisorRequest,
	parseRequestFile,
	publishSupervisorReply,
	readRequestDeliveryState,
	removeRequestFile,
	replyPath,
	requestDeliveryClaimName,
	requestFilesInChannelAsync,
	SUPERVISOR_CHANNEL_ROOT,
	type SupervisorChannelMetadata,
	type SupervisorRequest,
	supervisorChannelDirsAsync,
	supervisorChannelRecord,
	writeRequestDeliveryState,
} from "./native-supervisor-storage.ts";

export { registerNativeSupervisorClient } from "./native-supervisor-client.ts";
export {
	ensureSupervisorChannelDir,
	resolveSupervisorChannelDir,
} from "./native-supervisor-storage.ts";

export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
const MAX_REQUEST_FILES_PER_POLL = 256;
const MAX_CHANNEL_DIRS_PER_POLL = 128;
const DELIVERY_RETRY_GRACE_MS = 5_000;
const MAX_SESSION_DELIVERY_SCAN_BYTES = 32 * 1024 * 1024;

function requestMatchesContext(
	request: SupervisorRequest,
	state: Pick<SubagentState, "currentSessionId" | "currentSessionScope">,
	ctx: ExtensionContext,
): boolean {
	const scope = state.currentSessionScope;
	if (!scope || !state.currentSessionId) return false;
	if (request.physicalSessionId) {
		const matches = sessionArtifactMatches(scope, request.physicalSessionId, request.runId);
		if (!matches) return false;
		return (
			request.physicalSessionId === scope.sessionId ||
			scope.startedAtMs === undefined ||
			request.createdAt >= scope.startedAtMs
		);
	}
	let logicalSessionId: string | null | undefined;
	try {
		logicalSessionId = ctx.sessionManager.getSessionId();
	} catch {
		return false;
	}
	return (
		Boolean(logicalSessionId) &&
		request.orchestratorSessionId === logicalSessionId &&
		scope.legacyRunIds.has(request.runId) &&
		(scope.startedAtMs === undefined || request.createdAt >= scope.startedAtMs)
	);
}

function addPersistedSupervisorRequestId<Entry>(entry: Entry, requestIds: Set<string>): void {
	const candidate = supervisorChannelRecord(entry);
	if (candidate.type !== "custom_message" || candidate.customType !== "subagent_supervisor_request") return;
	const id = supervisorChannelRecord(candidate.details).id;
	if (isRuntimeString(id) && id) requestIds.add(id);
}

/** Build one delivery index for the whole poll instead of rescanning the session per request. */
async function persistedSupervisorRequestIds(ctx: ExtensionContext): Promise<ReadonlySet<string>> {
	const requestIds = new Set<string>();
	try {
		for (const entry of ctx.sessionManager.getEntries()) addPersistedSupervisorRequestId(entry, requestIds);
	} catch {
		// The canonical JSONL tail below remains available after SessionManager failures.
	}

	let sessionFile: string | null | undefined;
	try {
		sessionFile = ctx.sessionManager.getSessionFile();
	} catch {
		return requestIds;
	}
	if (!sessionFile || !path.isAbsolute(sessionFile)) return requestIds;
	let handle: fs.promises.FileHandle | undefined;
	try {
		const noFollow =
			"O_NOFOLLOW" in fs.constants && isRuntimeNumber(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
		handle = await fs.promises.open(sessionFile, fs.constants.O_RDONLY | noFollow);
		const stat = await handle.stat();
		const currentUid = process.getuid?.();
		if (!stat.isFile() || (currentUid !== undefined && stat.uid !== currentUid)) return requestIds;
		const length = Math.min(stat.size, MAX_SESSION_DELIVERY_SCAN_BYTES);
		if (length <= 0) return requestIds;
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
		let text = buffer.subarray(0, bytesRead).toString("utf-8");
		if (stat.size > length) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
		for (const line of text.split("\n")) {
			if (!line.includes("subagent_supervisor_request")) continue;
			try {
				addPersistedSupervisorRequestId(parseJsonValue(line), requestIds);
			} catch {
				// Ignore unrelated or partially written JSONL records.
			}
		}
		return requestIds;
	} catch {
		return requestIds;
	} finally {
		await handle?.close();
	}
}

type SupervisorRunIdentity = Pick<SupervisorRequest, "runId" | "agent" | "childIndex">;

function rememberedForegroundChild(request: SupervisorRunIdentity, state: SubagentState) {
	const run = state.foregroundRuns?.get(request.runId);
	const child =
		run?.children.find((candidate) => candidate.index === request.childIndex && candidate.agent === request.agent) ??
		run?.children[request.childIndex];
	return run && child ? { run, child } : undefined;
}

function requestRunInactive(request: SupervisorRunIdentity, state: SubagentState): boolean {
	if (state.foregroundControls.has(request.runId)) return false;
	const foreground = rememberedForegroundChild(request, state);
	if (foreground) return foreground.child.status !== "detached";

	const asyncJob = state.asyncJobs.get(request.runId) ?? state.recentAgentJobs?.get(request.runId);
	if (!asyncJob) return false;
	if (
		asyncJob.status === "complete" ||
		asyncJob.status === "failed" ||
		asyncJob.status === "paused" ||
		asyncJob.status === "stopped"
	)
		return true;
	const stepStatus = asyncJob.steps?.[request.childIndex]?.status;
	return (
		stepStatus === "complete" ||
		stepStatus === "completed" ||
		stepStatus === "failed" ||
		stepStatus === "paused" ||
		stepStatus === "stopped"
	);
}

export function garbageCollectSupervisorChannel(
	channelDir: string,
	state: SubagentState,
	now = Date.now(),
): Promise<boolean> {
	return collectSupervisorChannel(
		channelDir,
		(metadata: SupervisorChannelMetadata) => requestRunInactive(metadata, state),
		now,
	);
}

function markForegroundSupervisorAttention(request: SupervisorRequest, state: SubagentState): void {
	const remembered = rememberedForegroundChild(request, state);
	if (remembered?.child.status !== "detached") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = "needs_attention";
	remembered.child.lastActivityAt = request.createdAt;
	remembered.child.currentTool = "contact_supervisor";
	remembered.child.currentToolStartedAt = request.createdAt;
	remembered.child.updatedAt = updatedAt;
}

function clearForegroundSupervisorAttention(
	request: SupervisorRequest,
	pending: Map<string, PendingSupervisorRequest>,
	state: SubagentState,
): void {
	if (
		[...pending.values()].some(
			(candidate) =>
				candidate.expectsReply &&
				candidate.runId === request.runId &&
				candidate.agent === request.agent &&
				candidate.childIndex === request.childIndex,
		)
	)
		return;
	const remembered = rememberedForegroundChild(request, state);
	if (remembered?.child.status !== "detached" || remembered.child.currentTool !== "contact_supervisor") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = undefined;
	remembered.child.lastActivityAt = updatedAt;
	remembered.child.currentTool = undefined;
	remembered.child.currentToolStartedAt = undefined;
	remembered.child.updatedAt = updatedAt;
}

type SupervisorRequestLifecycle = "pending" | "resolved" | "expired" | "inactive" | "missing" | "wrong-session";

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = request.expiresAt;
	if (isRuntimeNumber(expiresAt) && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + askTimeoutMs() : now;
}

function requestLifecycle(
	request: PendingSupervisorRequest,
	state: SubagentState,
	ctx: ExtensionContext | undefined,
	now: number,
): SupervisorRequestLifecycle {
	if (!fs.existsSync(request.requestFile)) return "missing";
	if (request.expectsReply && fs.existsSync(replyPath(request.channelDir, request.id))) return "resolved";
	if (now > requestExpiresAt(request, now)) return "expired";
	if (ctx && !requestMatchesContext(request, state, ctx)) return "wrong-session";
	if (request.expectsReply && requestRunInactive(request, state)) return "inactive";
	return "pending";
}

function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "resolved" || lifecycle === "expired" || lifecycle === "inactive")
		removeRequestFile(request.requestFile, request.requestSnapshot);
}

function refreshPendingRequests(
	pending: Map<string, PendingSupervisorRequest>,
	state: SubagentState,
	ctx: ExtensionContext | undefined,
): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, ctx, now);
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		cleanupRequestLifecycle(request, lifecycle);
		clearForegroundSupervisorAttention(request, pending, state);
	}
}

function formatPendingLine(request: PendingSupervisorRequest): string {
	const replyHint = request.expectsReply
		? ` Reply: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })`
		: "";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.${replyHint}`;
}

function requestVisibleText(request: PendingSupervisorRequest): string {
	const lines = [request.message];
	if (request.expectsReply) {
		lines.push(
			"",
			`Reply with: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })`,
		);
	}
	return lines.join("\n");
}

function resolvePendingRequest(
	pending: Map<string, PendingSupervisorRequest>,
	params: IntercomParams,
): PendingSupervisorRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		return request;
	}
	const requests = [...pending.values()].filter((request) => request.expectsReply);
	if (params.to) {
		const normalizedTo = params.to.toLowerCase();
		const matches = requests.filter(
			(request) =>
				request.id.toLowerCase().startsWith(normalizedTo) ||
				request.agent.toLowerCase() === normalizedTo ||
				request.childTarget?.toLowerCase() === normalizedTo,
		);
		const match = matches.at(0);
		if (matches.length === 1 && match) return match;
		if (matches.length > 1)
			throw new Error(`Multiple pending supervisor requests match '${params.to}'. Use replyTo.`);
	}
	const request = requests.at(0);
	if (requests.length === 1 && request) return request;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

type PublicPendingSupervisorRequest = Pick<
	PendingSupervisorRequest,
	"agent" | "childIndex" | "expectsReply" | "id" | "reason" | "runId"
>;

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): PublicPendingSupervisorRequest[] {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

type ParentIntercomDetails =
	| { readonly active: true; readonly pending: number; readonly root: string }
	| { readonly pending: PublicPendingSupervisorRequest[] }
	| { readonly agent: string; readonly replyTo: string; readonly runId: string };

function buildParentIntercomTool(
	pending: Map<string, PendingSupervisorRequest>,
	state: SubagentState,
	name = "intercom",
	afterReplyPublish?: (replyPath: string) => void,
): ToolDefinition<typeof IntercomParamsSchema, ParentIntercomDetails> {
	return {
		name,
		label: name === "intercom" ? "Intercom" : "Subagent Supervisor",
		description:
			name === "intercom"
				? "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests."
				: "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests without overriding pi-intercom.",
		parameters: IntercomParamsSchema,
		async execute(_id, params) {
			refreshPendingRequests(pending, state, state.lastUiContext ?? undefined);
			// SAFETY: Pi validates Tool arguments against IntercomParamsSchema before execute.
			const input = params as IntercomParams;
			if (input.action === "status") {
				return {
					content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }],
					details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT },
				};
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()].filter((request) => request.expectsReply).map(formatPendingLine);
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }],
					details: { pending: publicPendingRequests(pending) },
				};
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input);
				publishSupervisorReply(request, input.message ?? "", afterReplyPublish);
				pending.delete(request.id);
				clearForegroundSupervisorAttention(request, pending, state);
				return {
					content: [{ type: "text", text: `Replied to supervisor request ${request.id}.` }],
					details: { replyTo: request.id, runId: request.runId, agent: request.agent },
				};
			}
			if (input.action === "send" || input.action === "ask") {
				throw new Error(
					"Native pi-subagents intercom currently handles supervisor replies. Child agents initiate asks with contact_supervisor.",
				);
			}
			throw new Error(`Unsupported intercom action: ${input.action}`);
		},
	};
}

interface NativeSupervisorChannelOptions {
	readonly acquireDeliveryClaim?: typeof tryAcquireDurableClaim;
	readonly afterReplyPublish?: (replyPath: string) => void;
}

class NativeSupervisorParent {
	readonly pending = new Map<string, PendingSupervisorRequest>();
	private pollTask: AgentEffectTask<void, never> | undefined;
	private channelScanEntries: string[] = [];
	private channelScanOffset = 0;
	private lifecycleGeneration = 0;
	private persistedIndexGeneration = -1;
	private readonly persistedRequestIds = new Set<string>();
	private readonly deliveryClaims = new Map<string, DurableClaim>();
	private readonly deliveryClaimFiles = new Map<string, string>();
	private readonly deliveryDispatches = new Map<string, object>();
	private readonly acquireDeliveryClaim: typeof tryAcquireDurableClaim;
	private readonly afterReplyPublish: ((replyPath: string) => void) | undefined;
	private readonly effects: AgentEffectOwner;
	private readonly pi: ExtensionAPI;
	private readonly state: SubagentState;

	constructor(
		pi: ExtensionAPI,
		state: SubagentState,
		effects: AgentEffectOwner,
		options: NativeSupervisorChannelOptions,
	) {
		this.pi = pi;
		this.state = state;
		this.effects = effects;
		this.acquireDeliveryClaim = options.acquireDeliveryClaim ?? tryAcquireKernelClaim;
		this.afterReplyPublish = options.afterReplyPublish;
		pi.on("before_agent_start", () => {
			if (this.pollTask) this.registerParentIntercomFallback();
		});
	}

	private releaseDeliveryClaim(requestId: string): void {
		try {
			this.deliveryClaims.get(requestId)?.release();
		} catch (error) {
			reportAgentDiagnostic(`Failed to release supervisor delivery claim '${requestId}':`, error);
		} finally {
			this.deliveryClaims.delete(requestId);
			this.deliveryClaimFiles.delete(requestId);
		}
	}

	private releaseIdleDeliveryClaims(): void {
		for (const requestId of Array.from(this.deliveryClaims.keys())) {
			if (!this.deliveryDispatches.has(requestId)) this.releaseDeliveryClaim(requestId);
		}
	}

	private registerPrimaryParentTool(): void {
		if (!hasLiveTool(this.pi, NATIVE_SUPERVISOR_TOOL_NAME))
			registerCommunicationTool(
				this.pi,
				buildParentIntercomTool(this.pending, this.state, NATIVE_SUPERVISOR_TOOL_NAME, this.afterReplyPublish),
				"checking",
			);
	}

	private registerParentIntercomFallback(): void {
		if (!hasLiveTool(this.pi, "intercom"))
			registerCommunicationTool(
				this.pi,
				buildParentIntercomTool(this.pending, this.state, "intercom", this.afterReplyPublish),
				"checking",
			);
	}

	private resetChannelScan(): void {
		this.channelScanEntries = [];
		this.channelScanOffset = 0;
	}

	private async scanRequestFiles(): Promise<Array<{ channelDir: string; file: string }>> {
		const files: Array<{ channelDir: string; file: string }> = [];
		let scannedChannels = 0;
		try {
			if (this.channelScanOffset >= this.channelScanEntries.length) {
				this.channelScanEntries = await supervisorChannelDirsAsync();
				this.channelScanOffset = 0;
			}
			while (scannedChannels < MAX_CHANNEL_DIRS_PER_POLL && files.length < MAX_REQUEST_FILES_PER_POLL) {
				const channelDir = this.channelScanEntries[this.channelScanOffset++];
				if (!channelDir) break;
				scannedChannels += 1;
				const requestFiles = await requestFilesInChannelAsync(
					channelDir,
					MAX_REQUEST_FILES_PER_POLL - files.length,
				);
				if (requestFiles.length === 0) await garbageCollectSupervisorChannel(channelDir, this.state);
				else files.push(...requestFiles.map((file) => ({ channelDir, file })));
			}
			if (this.channelScanOffset >= this.channelScanEntries.length) this.resetChannelScan();
		} catch (error) {
			this.resetChannelScan();
			if (errorCode(error) !== "ENOENT") throw error;
		}
		return files;
	}

	private isPollCurrent(ctx: ExtensionContext, generation: number): boolean {
		return this.pollTask !== undefined && this.lifecycleGeneration === generation && this.state.lastUiContext === ctx;
	}

	private releaseMissingDeliveryClaims(): void {
		for (const requestId of this.deliveryClaims.keys()) {
			const requestFile = this.deliveryClaimFiles.get(requestId);
			if (requestFile && fs.existsSync(requestFile)) continue;
			this.releaseDeliveryClaim(requestId);
		}
	}

	private ensureDeliveryClaim(file: string, requestId: string): DurableClaim | undefined {
		let claim = this.deliveryClaims.get(requestId);
		if (claim) return claim;
		claim = this.acquireDeliveryClaim(path.dirname(file), requestDeliveryClaimName(requestId));
		if (!claim) return undefined;
		this.deliveryClaims.set(requestId, claim);
		this.deliveryClaimFiles.set(requestId, file);
		return claim;
	}

	private async restorePersistedRequestIds(ctx: ExtensionContext, pollGeneration: number): Promise<boolean> {
		if (this.persistedIndexGeneration === pollGeneration) return true;
		const restored = await persistedSupervisorRequestIds(ctx);
		if (!this.isPollCurrent(ctx, pollGeneration)) return false;
		this.persistedRequestIds.clear();
		for (const requestId of restored) this.persistedRequestIds.add(requestId);
		this.persistedIndexGeneration = pollGeneration;
		return true;
	}

	private retainAcceptedRequest(request: PendingSupervisorRequest): void {
		if (request.expectsReply) {
			// The delivery claim remains the durable reply-owner claim until reply, expiry, or disposal.
			this.pending.set(request.id, request);
			markForegroundSupervisorAttention(request, this.state);
		} else {
			removeRequestFile(request.requestFile, request.requestSnapshot);
			this.releaseDeliveryClaim(request.id);
		}
	}

	private dispatchRequest(ctx: ExtensionContext, request: PendingSupervisorRequest, file: string, now: number): void {
		writeRequestDeliveryState(request.requestFile, {
			version: 2,
			requestId: request.id,
			lastAttemptAt: now,
		});
		const dispatchGeneration = this.lifecycleGeneration;
		const dispatchToken = {};
		this.deliveryDispatches.set(request.id, dispatchToken);
		const dispatchIsCurrent = (): boolean =>
			this.lifecycleGeneration === dispatchGeneration &&
			this.state.lastUiContext === ctx &&
			this.deliveryDispatches.get(request.id) === dispatchToken &&
			this.deliveryClaims.has(request.id);
		const acceptDelivery = (): void => {
			if (!dispatchIsCurrent()) return;
			this.persistedRequestIds.add(request.id);
			writeRequestDeliveryState(request.requestFile, {
				version: 2,
				requestId: request.id,
				lastAttemptAt: now,
				acceptedAt: Date.now(),
			});
			if (!request.expectsReply) return;
			this.pending.set(request.id, request);
			markForegroundSupervisorAttention(request, this.state);
			try {
				// SAFETY: ExtensionAPI owns the optional typed event bus used by this Suite integration.
				(this.pi as { events?: IntercomEventBus }).events?.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: request.id,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				});
			} catch (error) {
				reportAgentDiagnostic(`Supervisor detach observer failed for request '${request.id}':`, error);
			}
		};
		void sendSuiteAgentMessage(
			this.pi,
			withAgentWorkOrigin(
				{
					customType: "subagent_supervisor_request",
					content: requestVisibleText(request),
					display: true,
					details: {
						id: request.id,
						reason: request.reason,
						expectsReply: request.expectsReply,
						runId: request.runId,
						agent: request.agent,
						childIndex: request.childIndex,
					},
				},
				"automatic",
			),
			{ triggerTurn: true },
			dispatchIsCurrent,
			acceptDelivery,
		)
			.catch((error) => {
				reportAgentDiagnostic(`Failed to deliver supervisor request '${file}'; retaining it for retry:`, error);
			})
			.finally(() => {
				if (this.deliveryDispatches.get(request.id) !== dispatchToken) return;
				this.deliveryDispatches.delete(request.id);
				if (this.lifecycleGeneration !== dispatchGeneration) this.releaseDeliveryClaim(request.id);
			});
	}

	private async processRequestFile(
		ctx: ExtensionContext,
		pollGeneration: number,
		now: number,
		channelDir: string,
		file: string,
	): Promise<boolean> {
		let parsedRequest = parseRequestFile(file, channelDir);
		if (!parsedRequest) return true;
		let request = parsedRequest.request;
		if (!request) {
			removeRequestFile(file, parsedRequest.snapshot);
			return true;
		}
		const requestId = request.id;
		if (this.deliveryDispatches.has(requestId) || !this.ensureDeliveryClaim(file, requestId)) return true;
		// Re-read under the cross-process claim. The request may have changed since the directory scan.
		parsedRequest = parseRequestFile(file, channelDir);
		request = parsedRequest?.request;
		if (!request) {
			if (parsedRequest) removeRequestFile(file, parsedRequest.snapshot);
			this.releaseDeliveryClaim(requestId);
			return true;
		}
		const lifecycle = requestLifecycle(request, this.state, ctx, now);
		if (lifecycle === "wrong-session") {
			this.releaseDeliveryClaim(request.id);
			return true;
		}
		if (lifecycle !== "pending") {
			cleanupRequestLifecycle(request, lifecycle);
			this.releaseDeliveryClaim(request.id);
			return true;
		}
		let deliveryState = readRequestDeliveryState(request.requestFile, request.id);
		if (
			deliveryState &&
			deliveryState.acceptedAt === undefined &&
			now - deliveryState.lastAttemptAt < DELIVERY_RETRY_GRACE_MS
		) {
			return true;
		}
		if (deliveryState?.acceptedAt === undefined && !(await this.restorePersistedRequestIds(ctx, pollGeneration))) {
			return false;
		}
		if (this.persistedRequestIds.has(request.id) && deliveryState?.acceptedAt === undefined) {
			deliveryState = {
				version: 2,
				requestId: request.id,
				lastAttemptAt: deliveryState?.lastAttemptAt ?? now,
				acceptedAt: now,
			};
			writeRequestDeliveryState(request.requestFile, deliveryState);
		}
		if (deliveryState?.acceptedAt !== undefined) this.retainAcceptedRequest(request);
		else this.dispatchRequest(ctx, request, file, now);
		return true;
	}

	private async poll(): Promise<void> {
		const ctx = this.state.lastUiContext;
		if (!ctx) return;
		const pollGeneration = this.lifecycleGeneration;
		refreshPendingRequests(this.pending, this.state, ctx);
		this.releaseMissingDeliveryClaims();
		const now = Date.now();
		const requestFiles = await this.scanRequestFiles();
		if (!this.isPollCurrent(ctx, pollGeneration)) {
			this.resetChannelScan();
			return;
		}
		for (const { channelDir, file } of requestFiles) {
			if (!this.isPollCurrent(ctx, pollGeneration)) return;
			try {
				if (!(await this.processRequestFile(ctx, pollGeneration, now, channelDir, file))) return;
			} catch (error) {
				reportAgentDiagnostic(`Failed to deliver supervisor request '${file}'; retaining it for retry:`, error);
			}
		}
	}

	private pollEffect(): Effect.Effect<void, never> {
		return Effect.tryPromise({ try: () => this.poll(), catch: (error) => error }).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					reportAgentDiagnostic("Native supervisor channel poll failed; the next interval will retry:", error);
				}),
			),
		);
	}

	async start(): Promise<void> {
		if (this.pollTask) return;
		this.lifecycleGeneration += 1;
		this.registerPrimaryParentTool();
		const initial = this.effects.start(this.pollEffect());
		this.pollTask = initial;
		await initial.result;
		if (this.pollTask !== initial) return;
		this.pollTask = this.effects.start(
			Effect.forever(Effect.sleep(CHANNEL_POLL_MS).pipe(Effect.andThen(this.pollEffect()))),
		);
	}

	private stop(): void {
		this.lifecycleGeneration += 1;
		this.persistedIndexGeneration = -1;
		this.persistedRequestIds.clear();
		if (this.pollTask) void this.pollTask.interrupt();
		this.pollTask = undefined;
		this.resetChannelScan();
		this.pending.clear();
		// In-flight dispatches retain their claims until their stale completion; idle claims are released now.
		this.releaseIdleDeliveryClaims();
	}

	pause(): void {
		this.stop();
	}

	dispose(): void {
		this.stop();
	}
}

export function createNativeSupervisorChannel(
	pi: ExtensionAPI,
	state: SubagentState,
	effects: AgentEffectOwner,
	options: NativeSupervisorChannelOptions = {},
) {
	const parent = new NativeSupervisorParent(pi, state, effects, options);
	return {
		start: () => parent.start(),
		pause: () => parent.pause(),
		dispose: () => parent.dispose(),
		pending: parent.pending,
	};
}
