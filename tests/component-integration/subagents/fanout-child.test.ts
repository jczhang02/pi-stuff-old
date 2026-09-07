import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeFunction } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import type { PiStuffAgentsConfig } from "../../../packages/pi-stuff/src/subagents/src/extension/config.js";
import registerFanoutChild, {
	type FanoutChildDependencies,
} from "../../../packages/pi-stuff/src/subagents/src/extension/fanout-child.js";
import {
	deriveLaunchRunId,
	type SubagentParamsLike,
} from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.js";
import {
	PI_STUFF_AGENT_PATH_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.js";
import type { AgentExecutionInvocation } from "../../../packages/pi-stuff/src/subagents/src/runtime/agent-execution-coordinator.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { captureExtensionHandlers, createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";

interface FanoutLifecycleEvent {
	readonly reason: string;
}
type Handler = (event: FanoutLifecycleEvent, ctx: ExtensionContext) => object | undefined;
type EventListener = Parameters<ReturnType<typeof createEventBus>["on"]>[1];
const TOOL_PARAMETERS_SCHEMA = Type.Object(
	{ properties: Type.Object({ foreground: Type.Optional(Type.Unknown()) }, { additionalProperties: true }) },
	{ additionalProperties: true },
);

class ApiHarness {
	readonly events = createEventBus();
	readonly handlers = new Map<string, Handler[]>();
	tool:
		| {
				label: string;
				description: string;
				parameters?: TSchema;
				renderCall?: ToolDefinition["renderCall"];
				renderResult?: ToolDefinition["renderResult"];
				renderShell?: ToolDefinition["renderShell"];
				execute(
					id: string,
					params: SubagentParamsLike,
					signal: AbortSignal,
					onUpdate: undefined,
					ctx: ExtensionContext,
				): Promise<{ content: Array<{ type: string; text: string }> }>;
		  }
		| undefined;
	toolRegistrations = 0;
	failToolRegistrations = 0;

	readonly api = createExtensionApi({
		events: this.events,
		on: captureExtensionHandlers(this.handlers),
		registerTool: (tool) => {
			this.toolRegistrations += 1;
			if (this.failToolRegistrations > 0) {
				this.failToolRegistrations -= 1;
				throw new Error("injected tool registration failure");
			}
			// SAFETY: this test registry invokes the original Host-validated Tool definition unchanged.
			this.tool = tool as NonNullable<ApiHarness["tool"]>;
		},
	});

	async fire(event: string, value: FanoutLifecycleEvent): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(value, context());
	}
}

function config(): PiStuffAgentsConfig {
	return {
		maxSubagentDepth: 3,
		maxRunningAgents: 20,
	};
}

function context(): ExtensionContext {
	return createExtensionContext({
		cwd: "/project",
		hasUI: false,
		sessionManager: {
			getSessionFile: () => "/sessions/child.jsonl",
			getSessionId: () => "child-session-id",
		},
	});
}

const priorEnvironment = new Map<string, string | undefined>();
const temporaryDirectories = new Set<string>();

function setEnvironment(name: string, value: string): void {
	if (!priorEnvironment.has(name)) priorEnvironment.set(name, process.env[name]);
	process.env[name] = value;
}

afterEach(() => {
	for (const [name, value] of priorEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	priorEnvironment.clear();
	for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

test("isolates throwing event unsubscriptions and still disposes the governor", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	const subscribe = api.events.on.bind(api.events);
	let unsubscribeCalls = 0;
	let subscriptionIndex = 0;
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	api.events.on = ((event: string, listener: EventListener) => {
		const unsubscribe = subscribe(event, listener);
		const index = subscriptionIndex++;
		return () => {
			unsubscribeCalls += 1;
			unsubscribe();
			if (index === 0) throw new Error("injected unsubscribe failure");
		};
	}) as typeof api.events.on;
	let disposed = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			execute: async () => ({ content: [], details: { mode: "single", results: [] } }) as never,
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async () => ({ ok: true }),
			observeAsyncStarted: async () => {},
			settle: async () => {},
			fail: async () => {},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {
				disposed += 1;
			},
		}),
	});

	await api.fire("session_shutdown", { reason: "quit" });
	expect(unsubscribeCalls).toBe(subscriptionIndex);
	expect(disposed).toBe(1);
});

function fanoutLifecycleHarness() {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0 › nested-run:2");
	const api = new ApiHarness();
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-fanout-binding-"));
	temporaryDirectories.add(runtimeDir);
	const engineParams: SubagentParamsLike[] = [];
	const governor = {
		// SAFETY: this test controls the value and supplies every Array member exercised by this case.
		binds: [] as Array<{ sessionId: string; ownerAgentPath: readonly string[] }>,
		// SAFETY: this test controls the value and supplies every Array member exercised by this case.
		prepares: [] as Array<{ launchRunId: string; params: unknown }>,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		starts: [] as unknown[],
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		completions: [] as unknown[],
		settled: 0,
		disposed: 0,
	};
	let projectorProvided = false;
	const dependencies: Partial<FanoutChildDependencies> = {
		loadConfiguration: config,
		createExecutor: (input) => {
			projectorProvided = isRuntimeFunction(input.projectContext);
			return {
				execute: async (_id, params, _signal, _onUpdate, _ctx, hooks) => {
					engineParams.push(params);
					const launchRunId = params.launchRunId;
					if (!launchRunId) throw new Error("Expected a nested foreground launch run id");
					await hooks?.beforeForegroundStart?.({
						runId: launchRunId,
						asyncDir: runtimeDir,
						writerCount: 1,
						abortStart: () => true,
					});
					// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
					return {
						content: [{ type: "text", text: "private engine receipt" }],
						details: {
							mode: "single",
							runId: "nested-actual",
							results: [{ agent: "worker", success: true, exitCode: 0, finalOutput: "done" }],
						},
					} as never;
				},
			};
		},
		createGovernorCoordinator: () => ({
			bindSession: (identity) => governor.binds.push(identity),
			prepare: async (input) => {
				governor.prepares.push({ launchRunId: input.launchRunId, params: input.params });
				// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
				return { ok: true, invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation };
			},
			observeAsyncStarted: async (event) => {
				governor.starts.push(event);
			},
			settle: async () => {
				governor.settled += 1;
			},
			fail: async () => {},
			complete: async (event) => {
				governor.completions.push(event);
			},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {
				governor.disposed += 1;
			},
		}),
	};

	registerFanoutChild(api.api, dependencies);
	return { api, engineParams, governor, projectorProvided: () => projectorProvided };
}

test("uses the same public contract and parent-session governor lifecycle as the root", async () => {
	const { api, engineParams, governor, projectorProvided } = fanoutLifecycleHarness();
	expect(projectorProvided()).toBeTrue();
	expect(api.tool?.label).toBe("Agent");
	expect(api.tool?.description).not.toContain("Allowed management/control actions");
	expect(api.tool?.description).toContain("Pi Stuff does not provide built-in Agent definitions");
	expect(api.tool?.description).toContain("Package, user, or project Agent");
	expect(api.tool?.description).toContain("always owner-blocking");
	if (!api.tool) throw new Error("Expected nested Agent tool");
	if (!Check(TOOL_PARAMETERS_SCHEMA, api.tool.parameters)) throw new Error("Expected Agent Tool parameters");
	expect(api.tool.parameters.properties.foreground).toBeUndefined();
	expect(api.tool.renderShell).toBe("self");
	expect(api.tool.renderCall).toBeFunction();
	expect(api.tool.renderResult).toBeFunction();

	const result = await api.tool?.execute(
		"fanout-call",
		{ agent: "worker", task: "Inspect nested state" },
		new AbortController().signal,
		undefined,
		context(),
	);
	const launchRunId = deriveLaunchRunId("fanout-call", {
		sessionId: "parent-physical-session-id",
		ownerAgentPath: ["root-run:0", "nested-run:2"],
	});
	expect(engineParams).toEqual([
		{
			agent: "worker",
			description: "Inspect nested state",
			task: "Inspect nested state",
			async: false,
			context: "fresh",
			launchRunId,
		},
	]);
	expect(governor.binds).toEqual([{ sessionId: "parent-session-id", ownerAgentPath: ["root-run:0", "nested-run:2"] }]);
	expect(governor.prepares).toEqual([
		{
			launchRunId,
			params: { agent: "worker", task: "Inspect nested state", foreground: true },
		},
	]);
	expect(governor.settled).toBe(1);
	expect(result?.content[0]?.text).toBe("Agent worker completed.\ndone");
	expect(
		deriveLaunchRunId("fanout-call", {
			sessionId: "parent-physical-session-id",
			ownerAgentPath: ["root-run:0", "other-child:1"],
		}),
	).not.toBe(launchRunId);

	api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "nested-actual" });
	expect(governor.starts).toHaveLength(1);
	expect(governor.completions).toHaveLength(1);

	await api.fire("session_shutdown", { reason: "quit" });
	expect(governor.disposed).toBe(1);
});

test("fails closed when the child owner path is missing or malformed", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");

	for (const ownerPath of ["", "root-run:0 › ", "root-without-index"]) {
		setEnvironment(PI_STUFF_AGENT_PATH_ENV, ownerPath);
		const api = new ApiHarness();
		let binds = 0;
		let prepares = 0;
		registerFanoutChild(api.api, {
			loadConfiguration: config,
			createExecutor: () => ({
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				execute: async () => ({ content: [], details: { mode: "single", results: [] } }) as never,
			}),
			createGovernorCoordinator: () => ({
				bindSession: () => {
					binds += 1;
				},
				prepare: async () => {
					prepares += 1;
					return { ok: true };
				},
				observeAsyncStarted: async () => {},
				settle: async () => {},
				fail: async () => {},
				complete: async () => {},
				reconcileDead: async () => {},
				reconcileExisting: async () => {},
				dispose: () => {},
			}),
		});

		const result = await api.tool?.execute(
			"fanout-invalid-path",
			{ agent: "worker", task: "must not launch" },
			new AbortController().signal,
			undefined,
			context(),
		);
		expect(result?.content[0]?.text).toContain("PI_STUFF_AGENT_PATH");
		expect(binds).toBe(0);
		expect(prepares).toBe(0);
	}
});

test("retains a launched nested lease when settlement persistence fails", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	let launches = 0;
	let failures = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			execute: async () => {
				launches += 1;
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				return {
					content: [{ type: "text", text: "launched" }],
					details: { mode: "single", results: [], asyncId: "nested-live" },
				} as never;
			},
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async (input) => ({
				ok: true,
				// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
				invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation,
			}),
			observeAsyncStarted: async () => {},
			settle: async () => {
				throw Object.assign(new Error("injected nested settle EIO"), { code: "EIO" });
			},
			fail: async () => {
				failures += 1;
			},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	});
	const result = await api.tool?.execute(
		"nested-settle-failure",
		{ agent: "worker", task: "Continue in background" },
		new AbortController().signal,
		undefined,
		context(),
	);
	expect(result?.content[0]?.text).toContain("launched");
	expect(launches).toBe(1);
	expect(failures).toBe(0);
	await api.fire("session_shutdown", { reason: "quit" });
});

test("does not dispatch a nested Agent after shutdown wins the prepare race", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	const gate = Promise.withResolvers<void>();
	let prepared = false;
	let launches = 0;
	let failures = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			execute: async () => {
				launches += 1;
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				return { content: [], details: { mode: "single", results: [] } } as never;
			},
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async (input) => {
				prepared = true;
				await gate.promise;
				return {
					ok: true,
					// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
					invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation,
				};
			},
			observeAsyncStarted: async () => {},
			settle: async () => {},
			fail: async () => {
				failures += 1;
			},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	});
	const executing = api.tool?.execute(
		"nested-shutdown-race",
		{ agent: "worker", task: "Must not launch" },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (!prepared) await Bun.sleep(1);
	await api.fire("session_shutdown", { reason: "quit" });
	gate.resolve();
	const result = await executing;
	expect(result?.content[0]?.text).toContain("parent session ended");
	expect(launches).toBe(0);
	expect(failures).toBe(1);
});

test("retains nested ledger authority when a launched runner cannot be aborted after shutdown", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	const gate = Promise.withResolvers<void>();
	let launched = false;
	let settlements = 0;
	let failures = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			execute: async () => {
				launched = true;
				await gate.promise;
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				return {
					content: [{ type: "text", text: "runner retained" }],
					details: {
						mode: "single",
						results: [],
						asyncId: "nested-retained",
						lifecycleBinding: { abortStart: () => false },
					},
				} as never;
			},
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async (input) => ({
				ok: true,
				// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
				invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation,
			}),
			observeAsyncStarted: async () => {},
			settle: async () => {
				settlements += 1;
			},
			fail: async () => {
				failures += 1;
			},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	});
	const executing = api.tool?.execute(
		"nested-retained-after-shutdown",
		{ agent: "worker", task: "Retain physical recovery authority" },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (!launched) await Bun.sleep(1);
	await api.fire("session_shutdown", { reason: "quit" });
	gate.resolve();
	const result = await executing;

	expect(settlements).toBe(1);
	expect(failures).toBe(0);
	expect(result?.content[0]?.text).toContain("parent session ended");
});

test("retains nested ledger authority when aborting a launched runner throws after shutdown", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	const gate = Promise.withResolvers<void>();
	let launched = false;
	let settlements = 0;
	let failures = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			execute: async () => {
				launched = true;
				await gate.promise;
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				return {
					content: [{ type: "text", text: "runner retained" }],
					details: {
						mode: "single",
						results: [],
						asyncId: "nested-retained-after-abort-error",
						lifecycleBinding: {
							abortStart: () => {
								throw Object.assign(new Error("injected abort EIO"), { code: "EIO" });
							},
						},
					},
				} as never;
			},
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async (input) => ({
				ok: true,
				// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
				invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation,
			}),
			observeAsyncStarted: async () => {},
			settle: async () => {
				settlements += 1;
			},
			fail: async () => {
				failures += 1;
			},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	});
	const executing = api.tool?.execute(
		"nested-retained-after-abort-error",
		{ agent: "worker", task: "Retain authority when abort transport fails" },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (!launched) await Bun.sleep(1);
	await api.fire("session_shutdown", { reason: "quit" });
	gate.resolve();
	const result = await executing;

	expect(settlements).toBe(1);
	expect(failures).toBe(0);
	expect(result?.content[0]?.text).toContain("parent session ended");
});

test("settles a nested foreground result after the owning Host shuts down", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const api = new ApiHarness();
	const gate = Promise.withResolvers<void>();
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-fanout-foreground-race-"));
	temporaryDirectories.add(runtimeDir);
	let starts = 0;
	let settlements = 0;
	let failures = 0;
	registerFanoutChild(api.api, {
		loadConfiguration: config,
		createExecutor: () => ({
			execute: async (_id, params, _signal, _onUpdate, _ctx, hooks) => {
				const launchRunId = params.launchRunId;
				if (!launchRunId) throw new Error("Expected a nested foreground launch run id");
				await hooks?.beforeForegroundStart?.({
					runId: launchRunId,
					asyncDir: runtimeDir,
					writerCount: 2,
					abortStart: () => true,
				});
				await gate.promise;
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				return {
					content: [{ type: "text", text: "finished" }],
					details: {
						mode: "parallel",
						runId: params.launchRunId,
						results: [
							{ agent: "reviewer", success: true, exitCode: 0 },
							{ agent: "writer", success: true, exitCode: 0, detached: true },
						],
					},
				} as never;
			},
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async (input) => ({
				ok: true,
				// SAFETY: this test controls the value and supplies every AgentExecutionInvocation member exercised by this case.
				invocation: { launchRunId: input.launchRunId } as AgentExecutionInvocation,
			}),
			observeAsyncStarted: async () => {
				starts += 1;
			},
			settle: async () => {
				settlements += 1;
			},
			fail: async () => {
				failures += 1;
			},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	});
	const executing = api.tool?.execute(
		"nested-foreground-shutdown-race",
		{ agent: "worker", task: "Finish nested work" },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (starts === 0) await Bun.sleep(1);
	await api.fire("session_shutdown", { reason: "quit" });
	gate.resolve();
	const result = await executing;

	expect(settlements).toBe(1);
	expect(failures).toBe(0);
	expect(result?.content[0]?.text).toContain("parent session ended");
});

test("allows the same ExtensionAPI to reload after shutdown and after failed initialization", async () => {
	setEnvironment(SUBAGENT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_FANOUT_CHILD_ENV, "1");
	setEnvironment(SUBAGENT_PARENT_SESSION_ENV, "parent-session-id");
	setEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, "parent-physical-session-id");
	setEnvironment(PI_STUFF_AGENT_PATH_ENV, "root-run:0");
	const dependencies: Partial<FanoutChildDependencies> = {
		loadConfiguration: config,
		createExecutor: () => ({
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			execute: async () => ({ content: [], details: { mode: "single", results: [] } }) as never,
		}),
		createGovernorCoordinator: () => ({
			bindSession: () => {},
			prepare: async () => ({ ok: true }),
			observeAsyncStarted: async () => {},
			settle: async () => {},
			fail: async () => {},
			complete: async () => {},
			reconcileDead: async () => {},
			reconcileExisting: async () => {},
			dispose: () => {},
		}),
	};

	const reloaded = new ApiHarness();
	registerFanoutChild(reloaded.api, dependencies);
	await reloaded.fire("session_shutdown", { reason: "reload" });
	registerFanoutChild(reloaded.api, dependencies);
	expect(reloaded.toolRegistrations).toBe(2);
	await reloaded.fire("session_shutdown", { reason: "done" });

	const retried = new ApiHarness();
	retried.failToolRegistrations = 1;
	expect(() => registerFanoutChild(retried.api, dependencies)).toThrow("injected tool registration failure");
	registerFanoutChild(retried.api, dependencies);
	expect(retried.toolRegistrations).toBe(2);
	await retried.fire("session_shutdown", { reason: "done" });
});
