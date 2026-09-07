import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentToolResult,
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import type { JsonInputObject } from "../packages/pi-stuff/src/shared/json-value.js";
import type { WebCapabilityHost } from "../packages/pi-stuff/src/web/adapter.js";
import { createExtensionContext } from "../tests/fixtures/extension-context.js";

const root = resolve(import.meta.dir, "..");

export interface WebIntegrationVerificationOptions {
	readonly packagePath?: string;
	readonly publicNetwork?: boolean;
}

type EventHandler = (event: ExtensionEvent, context: ExtensionContext) => object | undefined;

const SEARCH_SUCCESS_DETAILS_SCHEMA = Type.Object(
	{
		error: Type.Optional(Type.String()),
		successfulQueries: Type.Number(),
		totalResults: Type.Number(),
	},
	{ additionalProperties: true },
);
const SEARCH_FAILURE_DETAILS_SCHEMA = Type.Object(
	{
		queryCount: Type.Number(),
		successfulQueries: Type.Number(),
	},
	{ additionalProperties: true },
);
const FETCH_DETAILS_SCHEMA = Type.Object(
	{
		error: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const LONG_DOCUMENT_DETAILS_SCHEMA = Type.Object(
	{
		error: Type.Optional(Type.String()),
		responseId: Type.String(),
	},
	{ additionalProperties: true },
);
const CONTINUATION_DETAILS_SCHEMA = Type.Object(
	{
		error: Type.Optional(Type.String()),
		returnedChars: Type.Number(),
	},
	{ additionalProperties: true },
);
const NETWORK_FAILURE_DETAILS_SCHEMA = Type.Object(
	{
		error: Type.Optional(Type.String()),
		successful: Type.Optional(Type.Number()),
		urlCount: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);

function fail(message: string): never {
	throw new Error(`Web integration verification failed: ${message}`);
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function checkedDetails<Schema extends TSchema>(
	result: AgentToolResult<unknown>,
	schema: Schema,
	label: string,
): Static<Schema> {
	if (!Check(schema, result.details)) fail(`${label} returned malformed details`);
	return result.details;
}

function harness() {
	const handlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools: string[] = [];
	// SAFETY: this verification adapter records Host callbacks without changing their arguments or result.
	const on = ((event: string, handler: EventHandler) => {
		const listeners = handlers.get(event) ?? [];
		listeners.push(handler);
		handlers.set(event, listeners);
	}) as ExtensionAPI["on"];
	const pi: WebCapabilityHost = {
		appendEntry: () => undefined,
		events: createEventBus(),
		getActiveTools: () => [...activeTools],
		on,
		registerTool: (tool) => {
			// SAFETY: this verification registry erases only generic renderer state and retains the original Tool object.
			tools.set(tool.name, tool as ToolDefinition);
		},
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};
	const context = createExtensionContext({
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getBranch: () => [] },
	});
	return { context, handlers, pi, tools };
}

async function execute(
	tool: ToolDefinition,
	callId: string,
	parameters: JsonInputObject,
	context: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	return tool.execute(callId, parameters, AbortSignal.timeout(45_000), undefined, context);
}

async function verifyPublicSearch(searchTool: ToolDefinition, context: ExtensionContext): Promise<void> {
	const search = await execute(
		searchTool,
		"public-search",
		{ numResults: 3, provider: "anysearch", query: "IETF HTTP Semantics RFC 9110 official" },
		context,
	);
	const details = checkedDetails(search, SEARCH_SUCCESS_DETAILS_SCHEMA, "public search");
	if (
		details.error ||
		details.successfulQueries !== 1 ||
		details.totalResults < 1 ||
		!resultText(search).includes("http")
	) {
		fail("real anonymous public search did not return a cited result");
	}
}

async function verifyPublicFetches(
	fetchTool: ToolDefinition,
	continuationTool: ToolDefinition,
	context: ExtensionContext,
	recordPdfPath: (path: string) => void,
): Promise<void> {
	const page = await execute(fetchTool, "public-page", { url: "https://example.com" }, context);
	if (
		checkedDetails(page, FETCH_DETAILS_SCHEMA, "public page").error ||
		!resultText(page).includes("documentation examples")
	) {
		fail("real public HTML extraction did not return the Example Domain body");
	}
	const redirect = await execute(
		fetchTool,
		"public-redirect",
		{ mode: "raw", url: "http://www.rfc-editor.org/rfc/rfc9110.txt" },
		context,
	);
	if (
		checkedDetails(redirect, FETCH_DETAILS_SCHEMA, "public redirect").error ||
		!resultText(redirect).includes("HTTP Semantics")
	) {
		fail("real HTTP-to-HTTPS redirect did not reach its validated RFC Editor destination");
	}

	const pdf = await execute(
		fetchTool,
		"public-pdf",
		{ url: "https://enterprise.github.com/downloads/en/markdown-cheatsheet.pdf" },
		context,
	);
	const pdfText = resultText(pdf);
	const pdfPathMatch = /^PDF extracted and saved to: (.+)$/mu.exec(pdfText);
	if (checkedDetails(pdf, FETCH_DETAILS_SCHEMA, "public PDF").error || !pdfPathMatch?.[1]) {
		fail("real public PDF extraction did not return its Markdown artifact path");
	}
	const pdfOutputPath = resolve(pdfPathMatch[1].trim());
	recordPdfPath(pdfOutputPath);
	if (!pdfOutputPath.startsWith(`${resolve(tmpdir())}${sep}`)) {
		fail("PDF extraction returned an artifact outside the temporary directory");
	}
	const pdfMarkdown = await readFile(pdfOutputPath, "utf8");
	if (pdfMarkdown.length < 500 || !/markdown|heading|header/iu.test(pdfMarkdown)) {
		fail("real public PDF artifact did not contain extracted document text");
	}

	const longDocument = await execute(
		fetchTool,
		"public-long-document",
		{ url: "https://www.rfc-editor.org/rfc/rfc9110.txt" },
		context,
	);
	const longDetails = checkedDetails(longDocument, LONG_DOCUMENT_DETAILS_SCHEMA, "long document");
	if (longDetails.error) fail("real long-document extraction did not create a continuation id");
	if (resultText(longDocument).length > 55_000) fail("long-document inline result exceeded its bounded budget");
	const continuation = await execute(
		continuationTool,
		"public-long-document-slice",
		{ limit: 2_000, offset: 10_000, responseId: longDetails.responseId, urlIndex: 0 },
		context,
	);
	const continuationDetails = checkedDetails(continuation, CONTINUATION_DETAILS_SCHEMA, "document continuation");
	if (continuationDetails.error || continuationDetails.returnedChars !== 2_000) {
		fail("stored public content could not be retrieved as a bounded continuation slice");
	}
}

export async function verifyWebIntegration(options: WebIntegrationVerificationOptions = {}): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-web-integration-"));
	const priorAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
	const priorKagiApiKey = process.env["KAGI_API_KEY"];
	let pdfOutputPath: string | undefined;
	process.env["PI_CODING_AGENT_DIR"] = join(temporaryDirectory, "agent");
	delete process.env["KAGI_API_KEY"];
	await mkdir(process.env["PI_CODING_AGENT_DIR"]);

	try {
		const packageDirectory = resolve(options.packagePath ?? join(root, "packages/pi-stuff"));
		const { installWebCapability } = await import(pathToFileURL(join(packageDirectory, "src/web/adapter.ts")).href);
		const fixture = harness();
		await installWebCapability(fixture.pi);
		for (const handler of fixture.handlers.get("session_start") ?? []) {
			await handler({ reason: "startup", type: "session_start" }, fixture.context);
		}
		const searchTool = fixture.tools.get("web_search");
		const fetchTool = fixture.tools.get("fetch_content");
		const continuationTool = fixture.tools.get("get_search_content");
		if (!searchTool || !fetchTool || !continuationTool) fail("the three bounded Web Tools were not registered");

		if (options.publicNetwork) await verifyPublicSearch(searchTool, fixture.context);
		const missingCredential = await execute(
			searchTool,
			"missing-credential",
			{ numResults: 1, provider: "kagi", query: "Pi Stuff credential failure fixture" },
			fixture.context,
		);
		const missingCredentialDetails = checkedDetails(
			missingCredential,
			SEARCH_FAILURE_DETAILS_SCHEMA,
			"missing-credential search",
		);
		if (
			missingCredentialDetails.queryCount !== 1 ||
			missingCredentialDetails.successfulQueries !== 0 ||
			!/Kagi|credential|API key/iu.test(resultText(missingCredential))
		) {
			fail("missing provider credentials were not returned as a visible bounded search failure");
		}
		if (options.publicNetwork) {
			await verifyPublicFetches(fetchTool, continuationTool, fixture.context, (path) => {
				pdfOutputPath = path;
			});
		}

		const local = await execute(fetchTool, "blocked-local", { url: "http://127.0.0.1/private" }, fixture.context);
		if (!checkedDetails(local, FETCH_DETAILS_SCHEMA, "blocked local fetch").error?.includes("Local and private")) {
			fail("local-network input was not rejected at the Suite boundary");
		}
		const networkFailure = await execute(
			fetchTool,
			"network-failure",
			{ url: "https://pi-stuff-network-failure.invalid" },
			fixture.context,
		);
		const failureDetails = checkedDetails(networkFailure, NETWORK_FAILURE_DETAILS_SCHEMA, "network failure");
		if (!failureDetails.error && !(failureDetails.urlCount === 1 && failureDetails.successful === 0)) {
			fail("network failure was not returned as a bounded Tool error");
		}
		if ((await readdir(process.env["PI_CODING_AGENT_DIR"])).includes("web-search.json")) {
			fail("Web compatibility wrote a user settings file");
		}
	} finally {
		if (pdfOutputPath) await rm(pdfOutputPath, { force: true });
		if (priorAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = priorAgentDirectory;
		if (priorKagiApiKey === undefined) delete process.env["KAGI_API_KEY"];
		else process.env["KAGI_API_KEY"] = priorKagiApiKey;
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	await verifyWebIntegration({ publicNetwork: true });
	console.log(
		"Certified zero-config public search, HTML, redirect/PDF, continuation, SSRF, and failure paths without settings writes",
	);
}
