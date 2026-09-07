import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { resolveWatchPath } from "../../shared/utils.ts";
import {
	processSteerRequestsFromDir,
	readSteerAckAt,
	type SteerRequest,
	steerAckPathFromDir,
	writeSteerAckAt,
	writeSteerCapabilityAt,
} from "../background/control-channel.ts";
import {
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_CAPABILITY_ENV,
	SUBAGENT_STEER_INBOX_ENV,
} from "./pi-args.ts";

export function formatSteerMessage(request: SteerRequest): string {
	const marker = Buffer.from(request.id, "utf-8").toString("base64url");
	return [
		`<pi-stuff-steer request="${marker}">`,
		"Mid-run steering from the parent orchestrator:",
		"",
		request.message,
		"",
		"Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
		"</pi-stuff-steer>",
	].join("\n");
}

function steerRequestIdFromInput(text: string): string | undefined {
	const encoded = /<pi-stuff-steer request="([A-Za-z0-9_-]{1,342})">/u.exec(text)?.[1];
	if (!encoded) return undefined;
	try {
		const requestId = Buffer.from(encoded, "base64url").toString("utf-8");
		return /^\S{1,256}$/u.test(requestId) ? requestId : undefined;
	} catch {
		return undefined;
	}
}

type SteeringInboxDependencies = {
	watch?: typeof fs.watch;
	nativeRealpath?: (filePath: string) => string;
	timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
};

type SteeringSendUserMessage = (content: string, options: { deliverAs: "steer" }) => PromiseLike<void> | void;

type PendingSteeringDelivery = { request: SteerRequest; complete: () => boolean };
type PendingSteeringAck = {
	request: SteerRequest;
	state: "delivered" | "failed";
	message: string;
	complete: () => boolean;
};

class SteeringInboxController {
	private readonly pi: ExtensionAPI;
	private readonly steerInbox: string;
	private readonly capabilityPath: string | undefined;
	private readonly ackDir: string | undefined;
	private readonly childIndex: number;
	private readonly sendUserMessage: SteeringSendUserMessage | undefined;
	private readonly canSteer: boolean;
	private readonly watchDirectory: typeof fs.watch;
	private readonly nativeRealpath: ((filePath: string) => string) | undefined;
	private readonly timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
	private readonly pendingById = new Map<string, PendingSteeringDelivery>();
	private readonly pendingAcks = new Map<string, PendingSteeringAck>();
	private disposed = false;
	private flushing = false;
	private started = false;
	private ready = false;
	private watcher: fs.FSWatcher | undefined;
	private interval: ReturnType<typeof setInterval> | undefined;
	private lastRuntimeError = "";
	private lastRuntimeErrorAt = 0;

	constructor(pi: ExtensionAPI, steerInbox: string, deps: SteeringInboxDependencies) {
		this.pi = pi;
		this.steerInbox = steerInbox;
		this.capabilityPath = process.env[SUBAGENT_STEER_CAPABILITY_ENV]?.trim();
		this.ackDir = process.env[SUBAGENT_STEER_ACK_DIR_ENV]?.trim();
		this.childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
		// SAFETY: Pi exposes sendUserMessage at runtime; canSteer and isRuntimeFunction gate every call.
		this.sendUserMessage = (
			pi as {
				sendUserMessage?: SteeringSendUserMessage;
			}
		).sendUserMessage;
		this.canSteer = isRuntimeFunction(this.sendUserMessage);
		this.watchDirectory = deps.watch ?? fs.watch;
		this.nativeRealpath = deps.nativeRealpath;
		this.timers = deps.timers ?? { setInterval, clearInterval };
	}

	private reportRuntimeError<Cause>(context: string, cause: Cause): void {
		const message = `${context}: ${cause instanceof Error ? cause.message : String(cause)}`;
		const now = Date.now();
		if (message === this.lastRuntimeError && now - this.lastRuntimeErrorAt < 30_000) return;
		this.lastRuntimeError = message;
		this.lastRuntimeErrorAt = now;
		reportAgentDiagnostic(`[pi-stuff-agents] ${message}`);
	}

	private acknowledge(
		request: SteerRequest,
		state: "delivered" | "failed",
		message: string,
		complete: () => boolean,
	): boolean {
		if (!this.ackDir || !Number.isInteger(this.childIndex) || this.childIndex < 0) {
			this.pendingAcks.delete(request.id);
			complete();
			return true;
		}
		try {
			writeSteerAckAt(steerAckPathFromDir(this.ackDir, request.id), {
				requestId: request.id,
				index: this.childIndex,
				ts: Date.now(),
				state,
				message,
			});
			this.pendingAcks.delete(request.id);
			complete();
			return true;
		} catch (error) {
			this.pendingAcks.set(request.id, { request, state, message, complete });
			this.reportRuntimeError(`Failed to persist steering acknowledgement '${request.id}'`, error);
			return false;
		}
	}

	private retryAcknowledgements(): void {
		for (const { request, state, message, complete } of Array.from(this.pendingAcks.values()))
			this.acknowledge(request, state, message, complete);
	}

	private existingAcknowledgement(request: SteerRequest): boolean {
		if (!this.ackDir || !Number.isInteger(this.childIndex) || this.childIndex < 0) return false;
		const ack = readSteerAckAt(steerAckPathFromDir(this.ackDir, request.id));
		return ack?.requestId === request.id && ack.index === this.childIndex;
	}

	private publishCapability(): void {
		if (!this.capabilityPath || !Number.isInteger(this.childIndex) || this.childIndex < 0) return;
		writeSteerCapabilityAt(this.capabilityPath, {
			index: this.childIndex,
			pid: process.pid,
			readyAt: Date.now(),
			supported: this.canSteer,
		});
	}

	private flush(): void {
		if (this.disposed || this.flushing || !this.ready) return;
		this.flushing = true;
		try {
			this.retryAcknowledgements();
			processSteerRequestsFromDir(this.steerInbox, (request, complete) => {
				if (this.existingAcknowledgement(request)) {
					complete();
					return "retain";
				}
				if (this.pendingById.has(request.id) || this.pendingAcks.has(request.id)) return "retain";
				const sendUserMessage = this.sendUserMessage;
				if (!this.canSteer || !isRuntimeFunction(sendUserMessage)) {
					this.acknowledge(
						request,
						"failed",
						"Child Pi session does not support sendUserMessage steering.",
						complete,
					);
					return "retain";
				}
				const delivery: PendingSteeringDelivery = { request, complete };
				this.pendingById.set(request.id, delivery);
				try {
					const dispatched = sendUserMessage(formatSteerMessage(request), { deliverAs: "steer" });
					if (dispatched) {
						void Promise.resolve(dispatched).catch((error) => {
							if (this.pendingById.get(request.id) !== delivery) return;
							this.pendingById.delete(request.id);
							this.acknowledge(
								request,
								"failed",
								error instanceof Error ? error.message : String(error),
								complete,
							);
						});
					}
				} catch (error) {
					this.pendingById.delete(request.id);
					this.acknowledge(request, "failed", error instanceof Error ? error.message : String(error), complete);
				}
				return "retain";
			});
		} finally {
			this.flushing = false;
		}
	}

	private readonly safeFlush = (): void => {
		try {
			this.flush();
		} catch (error) {
			this.reportRuntimeError("Failed to process child steering inbox", error);
		}
	};

	private readonly onInput = <Event>(event: Event): undefined => {
		if (this.disposed || !event || !isRuntimeObject(event)) return undefined;
		const source = "source" in event ? event.source : undefined;
		const streamingBehavior = "streamingBehavior" in event ? event.streamingBehavior : undefined;
		const eventText = "text" in event ? event.text : undefined;
		const content = "content" in event ? event.content : undefined;
		// Exact pending-text correlation accepts both streaming steer and the same input just after streaming ends.
		if (source !== "extension" || (streamingBehavior !== undefined && streamingBehavior !== "steer"))
			return undefined;
		const text = isRuntimeString(eventText) ? eventText : isRuntimeString(content) ? content : undefined;
		if (!text) return undefined;
		const requestId = steerRequestIdFromInput(text);
		const delivery = requestId ? this.pendingById.get(requestId) : undefined;
		if (!delivery) return undefined;
		this.pendingById.delete(delivery.request.id);
		this.acknowledge(delivery.request, "delivered", "Pi accepted the correlated steering input.", delivery.complete);
		return undefined;
	};

	private start(): void {
		if (this.started || this.disposed) return;
		try {
			fs.mkdirSync(this.steerInbox, { recursive: true });
		} catch {
			return;
		}
		this.started = true;
		try {
			this.watcher = this.watchDirectory(resolveWatchPath(this.steerInbox, this.nativeRealpath), this.safeFlush);
			this.watcher.on("error", () => {});
		} catch {
			this.watcher = undefined;
		}
		this.interval = this.timers.setInterval(this.safeFlush, 250);
		this.interval.unref?.();
	}

	private readonly activate = (): undefined => {
		this.start();
		this.safeFlush();
		return undefined;
	};

	private readonly markReady = (): undefined => {
		this.start();
		if (!this.ready) {
			this.ready = true;
			this.publishCapability();
		}
		this.safeFlush();
		return undefined;
	};

	private readonly shutdown = (): void => {
		// Retry a correlated acknowledgement once before disabling the inbox timer.
		this.retryAcknowledgements();
		this.disposed = true;
		try {
			this.watcher?.close();
		} catch {}
		if (this.interval) this.timers.clearInterval(this.interval);
	};

	register(): void {
		// SAFETY: these literal event names are Pi lifecycle events; each handler validates fields before use.
		const onRuntimeEvent = this.pi.on as <Event>(event: string, handler: (event: Event) => void) => void;
		// Register input before the watcher so an accepted extension input cannot race request dispatch.
		onRuntimeEvent("input", this.onInput);
		onRuntimeEvent("session_start", this.activate);
		onRuntimeEvent("agent_start", this.markReady);
		for (const eventName of [
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"turn_end",
		] as const) {
			onRuntimeEvent(eventName, this.activate);
		}
		onRuntimeEvent("session_shutdown", this.shutdown);
	}
}

export function registerSteeringInbox(pi: ExtensionAPI, deps: SteeringInboxDependencies = {}): void {
	const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
	if (!steerInbox) return;
	new SteeringInboxController(pi, steerInbox, deps).register();
}
