// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript enforces bracket access for untrusted index-signature data.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexAccount {
	readonly accountId: string;
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly token: string;
}

type CodexModel = NonNullable<ExtensionContext["model"]>;

export interface CodexAccountContext {
	readonly model: ExtensionContext["model"];
	readonly modelRegistry: {
		getApiKeyAndHeaders(
			model: CodexModel,
		): Promise<
			| { readonly apiKey?: string; readonly headers?: unknown; readonly ok: true }
			| { readonly error: string; readonly ok: false }
		>;
	};
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === normalized && value.trim()) return value.trim();
	}
	return undefined;
}

function bearerToken(headers: Readonly<Record<string, string>> | undefined): string | undefined {
	return headerValue(headers, "authorization")
		?.match(/^Bearer\s+(.+)$/iu)?.[1]
		?.trim();
}

function mergeResolvedHeaders(...sources: unknown[]): Record<string, string> {
	const headers = new Map<string, { name: string; value: string }>();
	for (const source of sources) {
		if (!isRuntimeObject(source) || source === null || Array.isArray(source)) continue;
		for (const [name, value] of Object.entries(source)) {
			const key = name.toLowerCase();
			if (value === null) {
				headers.delete(key);
				continue;
			}
			if (isRuntimeString(value)) headers.set(key, { name, value });
		}
	}
	return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!isRuntimeObject(payload) || payload === null) return undefined;
		if (!(JWT_AUTH_CLAIM in payload)) return undefined;
		const claims = payload[JWT_AUTH_CLAIM];
		if (!isRuntimeObject(claims) || claims === null) return undefined;
		if (!("chatgpt_account_id" in claims)) return undefined;
		const accountId = claims["chatgpt_account_id"];
		return isRuntimeString(accountId) && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function isOpenAICodexResponsesModel(model: ExtensionContext["model"]): model is CodexModel {
	return model?.provider.toLowerCase() === "openai-codex" && Boolean(model.api?.includes("responses"));
}

export function supportsCodexImages(model: ExtensionContext["model"]): boolean {
	return isOpenAICodexResponsesModel(model) && Array.isArray(model?.input) && model.input.includes("image");
}

export async function resolveCodexAccount(ctx: CodexAccountContext): Promise<CodexAccount> {
	const model = ctx.model;
	if (!isOpenAICodexResponsesModel(model)) {
		throw new Error("Select an OpenAI Codex subscription model first.");
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	// Pi preserves null header-deletion markers at runtime, while the public
	// type surface narrows header values to strings. Normalize the runtime value and
	// never turn a deletion marker into the literal HTTP header value "null".
	const headers = mergeResolvedHeaders(model.headers, auth.headers);
	const token = auth.apiKey?.trim() || bearerToken(headers);
	if (!token) throw new Error("OpenAI Codex is not authenticated; run /login openai-codex.");
	const accountId = headerValue(headers, "chatgpt-account-id") ?? accountIdFromToken(token);
	if (!accountId) throw new Error("OpenAI Codex authentication has no account id; run /login openai-codex again.");
	return {
		accountId,
		baseUrl: model.baseUrl?.trim() || DEFAULT_CODEX_BASE_URL,
		headers,
		token,
	};
}
