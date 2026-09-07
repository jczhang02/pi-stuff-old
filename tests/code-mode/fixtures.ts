import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CodeModeSessionLedger } from "../../packages/pi-stuff/src/code-mode/ledger.js";
import type {
	SuiteToolCodeModeLifecycle,
	SuiteToolDefinitionRegistry,
	SuiteToolInvocation,
	SuiteToolInvocationResult,
} from "../../packages/pi-stuff/src/tool-display/contract.js";

export function registryFixture(
	lifecycle?: SuiteToolCodeModeLifecycle,
): SuiteToolDefinitionRegistry & { readonly invocations: SuiteToolInvocation[] } {
	const invocations: SuiteToolInvocation[] = [];
	const definitions = new Map<string, ToolDefinition>([
		[
			"read",
			{
				description: "Read a file",
				execute: async () => ({ content: [], details: {} }),
				label: "Read",
				name: "read",
				parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
			},
		],
		[
			"hidden",
			{
				description: "Inactive fixture",
				execute: async () => ({ content: [], details: {} }),
				label: "Hidden",
				name: "hidden",
				parameters: Type.Object({}),
			},
		],
		[
			"write",
			{
				description: "Write a file",
				execute: async () => ({ content: [], details: {} }),
				label: "Write",
				name: "write",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			},
		],
	]);
	return {
		catalog: () =>
			[...definitions.values()].map((definition) =>
				definition.name === "read"
					? {
							codeMode: {
								replay: "record" as const,
							},
							definition,
						}
					: definition.name === "write"
						? {
								codeMode: Object.assign(
									{
										replay: "never" as const,
										requiresApproval: true,
									},
									lifecycle ? { lifecycle } : undefined,
								),
								definition,
							}
						: { definition },
			),
		compensate: async () => false,
		get: (name) => definitions.get(name),
		async invoke(invocation): Promise<SuiteToolInvocationResult> {
			invocations.push(invocation);
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "first line" }],
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				details: { path: (invocation.input as { path?: string }).path },
			};
			invocation.onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
			return { isError: false, result };
		},
		invocations,
		isActive: (name) => name === "read" || name === "write",
		list: () => [...definitions.values()],
	};
}

export function sessionLedgerFixture() {
	const branch: Array<{ customType: string; data: unknown; type: "custom" }> = [];
	return {
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		context: {
			cwd: "/project",
			sessionManager: {
				getBranch: () => branch,
				getEntries: () => branch,
				getSessionId: () => "runtime-recovery-session",
			},
		} as ExtensionContext,
		ledger: new CodeModeSessionLedger({
			appendEntry(customType, data) {
				branch.push({ customType, data, type: "custom" });
			},
		}),
	};
}
