import type { JsonSourceObject, JsonSourceValue } from "../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { boundTerminalLine } from "../tool-display/index.ts";
import type { McpServerRuntimeStatus, McpServerStatusSnapshot, McpStatusSnapshot } from "./runtime/index.js";

type Listener = (snapshot: McpStatusSnapshot | undefined) => void;

const STATUSES = new Set<McpServerRuntimeStatus>([
	"cached",
	"connected",
	"disabled",
	"failed",
	"needs-auth",
	"not-connected",
]);
const MAX_SERVERS = 500;
const MAX_SERVER_NAME = 200;
const MAX_FAILURE_DETAIL = 400;

interface McpServerOptionalSnapshot {
	autoConnect?: boolean;
	failedAgoSeconds?: number;
	failureDetail?: string;
	oauth?: boolean;
	resourceCount?: number;
}

function isJsonSourceObject(value: JsonSourceValue | undefined): value is JsonSourceObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function record(value: JsonSourceValue | undefined): JsonSourceObject | undefined {
	return isJsonSourceObject(value) ? value : undefined;
}

function count(value: JsonSourceValue | undefined): number {
	return isRuntimeNumber(value) && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function serverName(value: JsonSourceValue | undefined): string {
	return boundTerminalLine(value, MAX_SERVER_NAME);
}

function runtimeStatus(value: JsonSourceValue | undefined): McpServerRuntimeStatus | undefined {
	if (!isRuntimeString(value)) return undefined;
	for (const status of STATUSES) {
		if (value === status) return status;
	}
	return undefined;
}

function serverSnapshot(value: JsonSourceValue): McpServerStatusSnapshot | undefined {
	const candidate = record(value);
	if (!candidate) return undefined;
	const name = serverName(candidate["name"]);
	const status = runtimeStatus(candidate["status"]);
	if (!name || !status) return undefined;
	const resources = candidate["resourceCount"];
	const failedAge = candidate["failedAgoSeconds"];
	const failureDetail = boundTerminalLine(candidate["failureDetail"], MAX_FAILURE_DETAIL);
	const optional: McpServerOptionalSnapshot = {};
	if (isRuntimeNumber(resources)) optional.resourceCount = count(resources);
	if (isRuntimeNumber(failedAge)) optional.failedAgoSeconds = count(failedAge);
	if (status === "failed" && failureDetail) optional.failureDetail = failureDetail;
	if (candidate["oauth"] === true) optional.oauth = true;
	if (candidate["autoConnect"] === true) optional.autoConnect = true;
	return {
		disabled: candidate["disabled"] === true,
		name,
		...optional,
		status,
		toolCount: count(candidate["toolCount"]),
	};
}

/** Accept only the versioned, bounded snapshot shape published by the fork. */
export function parseMcpStatusSnapshot(value: JsonSourceValue): McpStatusSnapshot | undefined {
	const candidate = record(value);
	if (candidate?.["version"] !== 1 || !Array.isArray(candidate["servers"])) return undefined;
	const servers = candidate["servers"].slice(0, MAX_SERVERS).flatMap((server) => {
		const parsed = serverSnapshot(server);
		return parsed ? [parsed] : [];
	});
	return {
		connectedCount: count(candidate["connectedCount"]),
		disabledCount: count(candidate["disabledCount"]),
		servers,
		totalResources: count(candidate["totalResources"]),
		totalTools: count(candidate["totalTools"]),
		version: 1,
	};
}

export class McpStatusStore {
	private readonly listeners = new Set<Listener>();
	private value: McpStatusSnapshot | undefined;

	get(): McpStatusSnapshot | undefined {
		return this.value;
	}

	set(value: JsonSourceValue): void {
		const snapshot = parseMcpStatusSnapshot(value);
		if (!snapshot) return;
		this.value = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}

	clear(): void {
		this.value = undefined;
		for (const listener of this.listeners) listener(undefined);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
