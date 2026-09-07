import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_BODY_LIMIT_BYTES = 64 * 1024;

export interface McpProbeResult {
	isMcp: boolean;
	classification: string;
}

interface ClassifiedResponse {
	readonly classification: McpProbeResult | null;
	readonly fallbackAllowed: boolean;
	readonly negative: McpProbeResult;
}

const INITIALIZE_REQUEST = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "pi-mcp-probe", version: "2.1.2" },
	},
};

function isJsonRpcEnvelope(value: JsonInputValue): boolean {
	return isJsonInputObject(value) && value["jsonrpc"] === "2.0" && ("result" in value || "error" in value);
}

function isBearerChallenge(response: Response): boolean {
	return /(?:^|,)\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}

function responseKind(response: Response): string {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType === "text/html") return "HTML";
	if (contentType) return contentType;
	return "an untyped response";
}

function cancelReader(reader: Pick<ReadableStreamDefaultReader, "cancel" | "releaseLock">): Effect.Effect<void> {
	return Effect.promise(async () => {
		try {
			await reader.cancel();
		} catch {
			// Probe cleanup is best-effort and must not replace the classification.
		} finally {
			reader.releaseLock();
		}
	});
}

function hasJsonRpcEnvelope(response: Response): Effect.Effect<boolean> {
	const reader = response.body?.getReader();
	if (!reader) return Effect.succeed(false);
	return Effect.gen(function* () {
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		while (true) {
			const { done, value } = yield* Effect.tryPromise({
				try: () => reader.read(),
				catch: (error) => error,
			});
			if (done) break;
			bytes += value.byteLength;
			if (bytes > PROBE_BODY_LIMIT_BYTES) return false;
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		try {
			return isJsonRpcEnvelope(JSON.parse(text));
		} catch {
			return false;
		}
	}).pipe(
		Effect.catch(() => Effect.succeed(false)),
		Effect.ensuring(cancelReader(reader)),
	);
}

function classifyResponse(response: Response, allowJson: boolean): Effect.Effect<McpProbeResult | null> {
	return Effect.gen(function* () {
		const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
		if (response.ok && isSse) {
			return { isMcp: true, classification: "endpoint responded with an MCP event stream" };
		}

		const isJsonRpc = (allowJson || response.status === 401) && (yield* hasJsonRpcEnvelope(response));
		if (response.ok && allowJson && isJsonRpc) {
			return { isMcp: true, classification: "endpoint responded with a JSON-RPC 2.0 envelope" };
		}
		if (response.status === 401 && isBearerChallenge(response) && isJsonRpc) {
			return {
				isMcp: true,
				classification: "endpoint requires Bearer authentication and responded with a JSON-RPC 2.0 error",
			};
		}

		return null;
	});
}

function notMcp(response: Response): McpProbeResult {
	return {
		isMcp: false,
		classification: `endpoint returned ${responseKind(response)} (${response.status}) — this URL does not appear to speak MCP`,
	};
}

function cancelResponse(response: Response): Effect.Effect<void> {
	return Effect.promise(async () => {
		if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
	});
}

function inspectEndpoint(
	url: string | URL,
	init: RequestInit,
	allowJson: boolean,
): Effect.Effect<ClassifiedResponse, unknown> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const response = yield* restore(
				Effect.tryPromise({
					try: (signal) => fetch(url, { ...init, signal }),
					catch: (error) => error,
				}),
			);
			return yield* restore(
				classifyResponse(response, allowJson).pipe(
					Effect.map((classification) => ({
						classification,
						fallbackAllowed: [404, 405, 406, 415].includes(response.status),
						negative: notMcp(response),
					})),
				),
			).pipe(Effect.ensuring(cancelResponse(response)));
		}),
	).pipe(Effect.timeout(PROBE_TIMEOUT_MS));
}

/** Makes one unauthenticated metadata-only request to identify an HTTP endpoint's protocol shape. */
export function probeMcpEndpoint(url: string | URL): Effect.Effect<McpProbeResult, unknown> {
	return Effect.gen(function* () {
		const post = yield* inspectEndpoint(
			url,
			{
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(INITIALIZE_REQUEST),
				redirect: "manual",
			},
			true,
		);
		if (post.classification) return post.classification;
		if (!post.fallbackAllowed) return post.negative;

		const get = yield* inspectEndpoint(url, { headers: { Accept: "text/event-stream" }, redirect: "manual" }, false);
		return get.classification ?? get.negative;
	});
}
