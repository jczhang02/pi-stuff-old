import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deliverStopRequest } from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.ts";
import { runForegroundConfig } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/execution.ts";
import { createSubagentExecutor } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.ts";
import type { AsyncStatus } from "../../../packages/pi-stuff/src/subagents/src/shared/types.ts";
import { readStatus } from "../../../packages/pi-stuff/src/subagents/src/shared/utils.ts";
import {
	agent,
	cleanupForegroundEngineFixtures,
	context,
	deriveLaunchRunId,
	extensionApiWithoutToolIntrospection,
	fs,
	os,
	path,
	setupForegroundEngineFixtures,
	state,
	temporaryDirectories,
} from "../../agents/foreground-engine-fixtures.ts";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("foreground startup publishes its initial artifacts once and still notifies the real runner observer", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-initialization-"));
	temporaryDirectories.push(cwd);
	const runId = deriveLaunchRunId("initialization", { sessionId: cwd, ownerAgentPath: [] });
	const writes = { registry: 0, initialStatus: 0 };
	let firstNotification: AsyncStatus | undefined;
	const rename = fs.renameSync;
	const publication = spyOn(fs, "renameSync").mockImplementation((from, to) => {
		rename(from, to);
		const target = to.toString();
		if (path.basename(path.dirname(target)) !== runId) return;
		if (path.basename(target) === "writer-processes-live.json") writes.registry++;
		if (path.basename(target) !== "status.json") return;
		const status = readStatus(path.dirname(target));
		if (status?.state === "running" && status.steps?.every((step) => step.status === "pending")) {
			writes.initialStatus++;
		}
	});
	try {
		const runState = state();
		const delegate = createSubagentExecutor({
			pi: extensionApiWithoutToolIntrospection(),
			state: runState,
			asyncByDefault: true,
			getSubagentSessionRoot: () => path.join(cwd, "sessions"),
			discoverAgents: () => ({ agents: [agent()] }),
			engines: {
				foreground: (config, signal, dependencies, committedStatus) =>
					runForegroundConfig(
						config,
						signal,
						{
							...dependencies,
							onStatus(status) {
								firstNotification ??= structuredClone(status);
								dependencies?.onStatus?.(status);
							},
						},
						committedStatus,
					),
			},
		});
		const result = await delegate.execute(
			"initialization",
			{ agent: "general-purpose", task: "Inspect", async: false, context: "fresh", launchRunId: runId },
			new AbortController().signal,
			undefined,
			context(cwd),
			{
				beforeForegroundStart({ asyncDir }) {
					temporaryDirectories.push(asyncDir);
					// Stop before child dispatch, after exercising both real startup stages.
					deliverStopRequest({ asyncDir, source: "initialization-test" });
				},
			},
		);
		expect(result.details.results).toHaveLength(1);
		expect(result.details.results[0]?.stopped).toBe(true);
		expect(firstNotification).toMatchObject({
			state: "running",
			turnCount: 0,
			toolCount: 0,
			steps: [{ status: "pending" }],
		});
		expect(runState.foregroundControls.size).toBe(0);
		expect(writes).toEqual({ registry: 1, initialStatus: 1 });
	} finally {
		publication.mockRestore();
	}
});
