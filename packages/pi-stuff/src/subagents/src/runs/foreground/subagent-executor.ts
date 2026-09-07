import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { Details } from "../../shared/types.ts";
import { deferredModule } from "../shared/deferred-module.ts";
import { retireUnusedNestedRoute } from "../shared/nested-events.ts";
import type {
	AgentToolResult,
	ExecutorDeps,
	ExecutorEngines,
	PreparedLaunch,
	SubagentExecutionHooks,
	SubagentParamsLike,
} from "./executor-contract.ts";
import { errorResult } from "./executor-contract.ts";

export type {
	ForegroundStartBinding,
	LaunchIdentityScope,
	SubagentExecutionHooks,
	SubagentParamsLike,
} from "./executor-contract.ts";
export { deriveLaunchRunId } from "./executor-contract.ts";

const loadPreparation = deferredModule(() => import("./launch-preparation.ts"));
const loadLaunchBuilders = deferredModule(() => import("./launch-builders.ts"));
const loadForegroundEngine = deferredModule(() => import("./execution.ts"));
const loadBackgroundEngine = deferredModule(() => import("../background/async-execution.ts"));

const DEFAULT_ENGINES: ExecutorEngines = {
	backgroundSingle: async (...args) => (await loadBackgroundEngine()).executeAsyncSingle(...args),
	backgroundParallel: async (...args) => (await loadBackgroundEngine()).executeAsyncParallel(...args),
	foreground: (...args) =>
		Effect.tryPromise({
			try: loadForegroundEngine,
			catch: (error) => error,
		}).pipe(Effect.flatMap(({ runForegroundConfig }) => runForegroundConfig(...args))),
};

let controlsModulePromise: Promise<typeof import("./executor-control.ts")> | undefined;

/** Load management and recovery only when an Agent control operation needs them. */
export function loadAgentControls(): Promise<typeof import("./executor-control.ts")> {
	if (!controlsModulePromise) {
		controlsModulePromise = import("./executor-control.ts").catch((error) => {
			controlsModulePromise = undefined;
			throw error;
		});
	}
	return controlsModulePromise;
}

export function createSubagentExecutor(deps: ExecutorDeps) {
	const engines: ExecutorEngines = { ...DEFAULT_ENGINES, ...deps.engines };
	const execute = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		hooks?: SubagentExecutionHooks,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		if (params.action && deps.allowMutatingManagementActions === false) {
			return errorResult("management", "Agent management actions are unavailable inside a nested Agent owner.");
		}
		if (params.action) return (await loadAgentControls()).controlAction(params, ctx, deps, engines, signal, hooks);

		const foreground = (params.async ?? deps.asyncByDefault) !== true;
		let ownedNestedRoute: PreparedLaunch["nestedRoute"] | undefined;
		let backgroundOwnsRoute = false;
		let foregroundLifecycleOwnsRoute = false;
		try {
			const { attachContextProjection, prepareLaunch } = await loadPreparation();
			const prepared = await prepareLaunch(id, params, ctx, deps);
			if ("content" in prepared) return prepared;
			if (!prepared.inheritedNestedRoute) ownedNestedRoute = prepared.nestedRoute;
			const { launchBackground, launchForeground } = await loadLaunchBuilders();
			let result: AgentToolResult<Details>;
			if (foreground) {
				result = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							yield* attachContextProjection(prepared, ctx, deps.projectContext);
							return yield* launchForeground(prepared, deps, engines, signal, onUpdate, hooks, () => {
								foregroundLifecycleOwnsRoute = true;
							});
						}),
					),
				);
				// A foreground adapter may return detached children after losing its
				// owner while their writer liveness is still unknown. Their durable
				// runtime remains authoritative until the tracker terminalizes it.
				foregroundLifecycleOwnsRoute = result.details.results.some((child) => child.detached === true);
			} else {
				await Effect.runPromise(attachContextProjection(prepared, ctx, deps.projectContext));
				result = await launchBackground(prepared, deps, engines, hooks);
			}
			backgroundOwnsRoute = !foreground && Boolean(result.details.asyncId);
			return result;
		} catch (error) {
			return errorResult(
				params.tasks?.length ? "parallel" : "single",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (ownedNestedRoute && !backgroundOwnsRoute && !foregroundLifecycleOwnsRoute) {
				try {
					await retireUnusedNestedRoute(ownedNestedRoute);
				} catch {
					// A committed runner retires its route after durable terminalization.
				}
			}
		}
	};
	return { execute };
}
