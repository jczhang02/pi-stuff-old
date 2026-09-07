import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import ts from "typescript";

const PRODUCTION_SOURCE_PATTERN = /^packages\/pi-stuff\/src\/.*\.[cm]?[jt]sx?$/u;
const EFFECT_MODULE_PATTERN = /^effect(?:\/|$)/u;
const EFFECT_NAMESPACE_EXPORTS = new Set(["Effect", "Runtime"]);
const EFFECT_RUNNERS = new Set(["runCallback", "runFork", "runPromise", "runPromiseExit", "runSync", "runSyncExit"]);
const CHILD_PROCESS_FUNCTIONS = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
const TIMER_FUNCTIONS = new Set(["setImmediate", "setInterval", "setTimeout"]);
const ASYNC_FILESYSTEM_FUNCTIONS = new Set([
	"access",
	"appendFile",
	"chmod",
	"chown",
	"copyFile",
	"cp",
	"lchmod",
	"lchown",
	"link",
	"lstat",
	"lutimes",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"readFile",
	"readdir",
	"readlink",
	"realpath",
	"rename",
	"rm",
	"rmdir",
	"stat",
	"statfs",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"watch",
	"writeFile",
]);

export interface EffectBoundaryInventory {
	readonly governedSources: readonly string[];
	readonly nativeAdapters: readonly string[];
	readonly runnerAdapters: readonly string[];
}

export interface EffectBoundaryFinding {
	readonly path: string;
	readonly rule: string;
}

export const EFFECT_BOUNDARY_INVENTORY = {
	governedSources: [
		"packages/pi-stuff/src/background-work/src/effect-owner.ts",
		"packages/pi-stuff/src/background-work/src/monitor.ts",
		"packages/pi-stuff/src/background-work/src/runtime.ts",
		"packages/pi-stuff/src/background-work/src/shell-activity-presentation.ts",
		"packages/pi-stuff/src/background-work/src/shell-activity.ts",
		"packages/pi-stuff/src/btw/btw.ts",
		"packages/pi-stuff/src/btw/index.ts",
		"packages/pi-stuff/src/btw/pi-compat.ts",
		"packages/pi-stuff/src/code-mode/controls.ts",
		"packages/pi-stuff/src/code-mode/host/delegate-runtime.ts",
		"packages/pi-stuff/src/code-mode/host/effect-owner.ts",
		"packages/pi-stuff/src/code-mode/host/host-client.ts",
		"packages/pi-stuff/src/code-mode/settings.ts",
		"packages/pi-stuff/src/code-mode/v8-executor.ts",
		"packages/pi-stuff/src/codex/index.ts",
		"packages/pi-stuff/src/codex/settings.ts",
		"packages/pi-stuff/src/codex/usage.ts",
		"packages/pi-stuff/src/context-management/index.ts",
		"packages/pi-stuff/src/context-management/magic-worker-client.ts",
		"packages/pi-stuff/src/context-management/magic-worker-entry.ts",
		"packages/pi-stuff/src/context-management/magic-worker-host.ts",
		"packages/pi-stuff/src/context-management/magic-worker-transport.ts",
		"packages/pi-stuff/src/context-management/native-preflight.ts",
		"packages/pi-stuff/src/context-management/projection.ts",
		"packages/pi-stuff/src/context-management/recovery.ts",
		"packages/pi-stuff/src/context-management/runtime.ts",
		"packages/pi-stuff/src/conversation-ui/effect-owner.ts",
		"packages/pi-stuff/src/conversation-ui/index.ts",
		"packages/pi-stuff/src/conversation-ui/settings.ts",
		"packages/pi-stuff/src/conversation-ui/suite-lifecycle.ts",
		"packages/pi-stuff/src/goal/src/command-registration.ts",
		"packages/pi-stuff/src/goal/src/commands.ts",
		"packages/pi-stuff/src/goal/src/compaction.ts",
		"packages/pi-stuff/src/goal/src/goal.ts",
		"packages/pi-stuff/src/goal/src/menu.ts",
		"packages/pi-stuff/src/goal/src/persistence.ts",
		"packages/pi-stuff/src/goal/src/prompt-ownership.ts",
		"packages/pi-stuff/src/goal/src/run-protocol.ts",
		"packages/pi-stuff/src/goal/src/runtime.ts",
		"packages/pi-stuff/src/goal/src/session.ts",
		"packages/pi-stuff/src/goal/src/settings.ts",
		"packages/pi-stuff/src/goal/src/settings-ui.ts",
		"packages/pi-stuff/src/goal/src/suite-menu.ts",
		"packages/pi-stuff/src/goal/src/terminal-tools.ts",
		"packages/pi-stuff/src/mcp/config-persistence.ts",
		"packages/pi-stuff/src/mcp/runtime/commands.ts",
		"packages/pi-stuff/src/mcp/runtime/config-codecs.ts",
		"packages/pi-stuff/src/mcp/runtime/config-sources.ts",
		"packages/pi-stuff/src/mcp/runtime/config.ts",
		"packages/pi-stuff/src/mcp/runtime/implementation.ts",
		"packages/pi-stuff/src/mcp/runtime/init.ts",
		"packages/pi-stuff/src/mcp/runtime/lifecycle.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-auth-flow.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-http-transport.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-probe.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-setup-panel.ts",
		"packages/pi-stuff/src/mcp/runtime/metadata-discovery.ts",
		"packages/pi-stuff/src/mcp/runtime/onboarding-state.ts",
		"packages/pi-stuff/src/mcp/runtime/proxy-call.ts",
		"packages/pi-stuff/src/mcp/runtime/proxy-modes.ts",
		"packages/pi-stuff/src/mcp/runtime/runtime-owner.ts",
		"packages/pi-stuff/src/mcp/runtime/server-manager.ts",
		"packages/pi-stuff/src/mcp/runtime/session-recovery.ts",
		"packages/pi-stuff/src/mcp/runtime/tool-approval.ts",
		"packages/pi-stuff/src/notification/index.ts",
		"packages/pi-stuff/src/notification/settings.ts",
		"packages/pi-stuff/src/ponytail/config.ts",
		"packages/pi-stuff/src/ponytail/index.ts",
		"packages/pi-stuff/src/ponytail/instructions.ts",
		"packages/pi-stuff/src/rtk/index.ts",
		"packages/pi-stuff/src/rtk/runtime.ts",
		"packages/pi-stuff/src/rtk/settings.ts",
		"packages/pi-stuff/src/session-naming/controller.ts",
		"packages/pi-stuff/src/session-naming/index.ts",
		"packages/pi-stuff/src/session-naming/model.ts",
		"packages/pi-stuff/src/session-naming/settings.ts",
		"packages/pi-stuff/src/shared/effect-foundation.ts",
		"packages/pi-stuff/src/shared/settings-io/file.ts",
		"packages/pi-stuff/src/shared/settings-io/lock.ts",
		"packages/pi-stuff/src/shared/settings-io/store.ts",
		"packages/pi-stuff/src/subagents/src/extension/index.ts",
		"packages/pi-stuff/src/subagents/src/extension/nested-control-router.ts",
		"packages/pi-stuff/src/subagents/src/extension/root-session-runtime.ts",
		"packages/pi-stuff/src/subagents/src/intercom/native-supervisor-channel.ts",
		"packages/pi-stuff/src/subagents/src/intercom/result-intercom.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-execution.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-control-events.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-observer.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-recovery.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-tracker.ts",
		"packages/pi-stuff/src/subagents/src/runtime/agent-execution-coordinator.ts",
		"packages/pi-stuff/src/subagents/src/runtime/agent-effect-owner.ts",
		"packages/pi-stuff/src/subagents/src/runtime/durable-agent-operation.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/child-process-engine.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/child-task-runner.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/completion-dedupe.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/control-channel.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/notify.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/result-processing.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/result-watcher.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-control.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-finalization.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-process.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-state.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/steering.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-lifecycle.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-supervisor.mjs",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-protocol-forwarder.mjs",
		"packages/pi-stuff/src/subagents/src/runs/foreground/execution.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/executor-control.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/foreground-lifecycle.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/launch-builders.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/launch-preparation.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/worker.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/worker-entry.ts",
		"packages/pi-stuff/src/subagents/src/ui/agent-roster.ts",
		"packages/pi-stuff/src/tool-display/index.ts",
		"packages/pi-stuff/src/tool-display/registration.ts",
		"packages/pi-stuff/src/tool-display/settings.ts",
		"packages/pi-stuff/src/tool-display/tool-invocation.ts",
		"packages/pi-stuff/src/web/adapter.ts",
		"packages/pi-stuff/src/web/fake-ip.ts",
		"packages/pi-stuff/src/web/settings.ts",
		"packages/pi-stuff/src/web/runtime/anysearch.ts",
		"packages/pi-stuff/src/web/runtime/brave.ts",
		"packages/pi-stuff/src/web/runtime/brightdata.ts",
		"packages/pi-stuff/src/web/runtime/brightdata-unlocker.ts",
		"packages/pi-stuff/src/web/runtime/chrome-cookies.ts",
		"packages/pi-stuff/src/web/runtime/exa.ts",
		"packages/pi-stuff/src/web/runtime/extract.ts",
		"packages/pi-stuff/src/web/runtime/firecrawl.ts",
		"packages/pi-stuff/src/web/runtime/gemini-api.ts",
		"packages/pi-stuff/src/web/runtime/gemini-search.ts",
		"packages/pi-stuff/src/web/runtime/gemini-pdf-extract.ts",
		"packages/pi-stuff/src/web/runtime/gemini-url-context.ts",
		"packages/pi-stuff/src/web/runtime/gemini-web.ts",
		"packages/pi-stuff/src/web/runtime/github-api.ts",
		"packages/pi-stuff/src/web/runtime/github-extract.ts",
		"packages/pi-stuff/src/web/runtime/implementation.ts",
		"packages/pi-stuff/src/web/runtime/index.d.ts",
		"packages/pi-stuff/src/web/runtime/kagi.ts",
		"packages/pi-stuff/src/web/runtime/ollama.ts",
		"packages/pi-stuff/src/web/runtime/openai-search.ts",
		"packages/pi-stuff/src/web/runtime/parallel.ts",
		"packages/pi-stuff/src/web/runtime/pdf-extract.ts",
		"packages/pi-stuff/src/web/runtime/perplexity.ts",
		"packages/pi-stuff/src/web/runtime/querit.ts",
		"packages/pi-stuff/src/web/runtime/search1api.ts",
		"packages/pi-stuff/src/web/runtime/searchinfinity.ts",
		"packages/pi-stuff/src/web/runtime/searxng.ts",
		"packages/pi-stuff/src/web/runtime/serpbase.ts",
		"packages/pi-stuff/src/web/runtime/serpdive.ts",
		"packages/pi-stuff/src/web/runtime/tavily.ts",
		"packages/pi-stuff/src/web/runtime/tinyfish.ts",
		"packages/pi-stuff/src/web/runtime/utils.ts",
		"packages/pi-stuff/src/web/runtime/xai-search.ts",
	],
	nativeAdapters: [
		"packages/pi-stuff/src/subagents/src/runs/foreground/worker.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/worker-entry.ts",
		"packages/pi-stuff/src/background-work/src/monitor-native.ts",
		"packages/pi-stuff/src/background-work/src/process-supervisor.mjs",
		"packages/pi-stuff/src/background-work/src/process.ts",
		"packages/pi-stuff/src/btw/btw-ui.ts",
		"packages/pi-stuff/src/btw/index.ts",
		"packages/pi-stuff/src/btw/pi-compat.ts",
		"packages/pi-stuff/src/code-mode/host/install-host.ts",
		"packages/pi-stuff/src/code-mode/host/process-start-identity.ts",
		"packages/pi-stuff/src/code-mode/host/host-client.ts",
		"packages/pi-stuff/src/code-mode/settings.ts",
		"packages/pi-stuff/src/codex/native-runner.ts",
		"packages/pi-stuff/src/codex/tools.ts",
		"packages/pi-stuff/src/codex/usage.ts",
		"packages/pi-stuff/src/context-management/config.ts",
		"packages/pi-stuff/src/context-management/dialog.ts",
		"packages/pi-stuff/src/context-management/magic-worker-client.ts",
		"packages/pi-stuff/src/context-management/magic-worker-entry.ts",
		"packages/pi-stuff/src/context-management/magic-worker-host.ts",
		"packages/pi-stuff/src/context-management/magic-worker-transport.ts",
		"packages/pi-stuff/src/context-management/projection.ts",
		"packages/pi-stuff/src/context-management/runtime.ts",
		"packages/pi-stuff/src/conversation-ui/command-dialog.ts",
		"packages/pi-stuff/src/conversation-ui/input-enhancement.ts",
		"packages/pi-stuff/src/goal/src/suite-menu.ts",
		"packages/pi-stuff/src/lifecycle-deadline.ts",
		"packages/pi-stuff/src/mcp/config-persistence.ts",
		"packages/pi-stuff/src/mcp/runtime/abort.ts",
		"packages/pi-stuff/src/mcp/runtime/config-codecs.ts",
		"packages/pi-stuff/src/mcp/runtime/config-sources.ts",
		"packages/pi-stuff/src/mcp/runtime/config.ts",
		"packages/pi-stuff/src/mcp/runtime/implementation.ts",
		"packages/pi-stuff/src/mcp/runtime/init.ts",
		"packages/pi-stuff/src/mcp/runtime/lifecycle.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-auth-discovery.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-auth-keyring.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-callback-server.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-auth-flow.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-http-transport.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-keyring-helper.cjs",
		"packages/pi-stuff/src/mcp/runtime/mcp-output-guard.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-probe.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-setup-panel.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-trace.ts",
		"packages/pi-stuff/src/mcp/runtime/metadata-discovery.ts",
		"packages/pi-stuff/src/mcp/runtime/onboarding-state.ts",
		"packages/pi-stuff/src/mcp/runtime/npx-resolver.ts",
		"packages/pi-stuff/src/mcp/runtime/proxy-call.ts",
		"packages/pi-stuff/src/mcp/runtime/runtime-owner.ts",
		"packages/pi-stuff/src/mcp/runtime/server-manager.ts",
		"packages/pi-stuff/src/mcp/runtime/tool-approval.ts",
		"packages/pi-stuff/src/mcp/runtime/unix-socket-transport.ts",
		"packages/pi-stuff/src/ponytail/config.ts",
		"packages/pi-stuff/src/ponytail/index.ts",
		"packages/pi-stuff/src/rtk/runtime.ts",
		"packages/pi-stuff/src/session-naming/model.ts",
		"packages/pi-stuff/src/shared/settings-io/file.ts",
		"packages/pi-stuff/src/shared/settings-io/lock.ts",
		"packages/pi-stuff/src/subagents/src/agents/agents.ts",
		"packages/pi-stuff/src/subagents/src/agents/skills.ts",
		"packages/pi-stuff/src/subagents/src/extension/completion-handling.ts",
		"packages/pi-stuff/src/subagents/src/extension/fanout-child.ts",
		"packages/pi-stuff/src/subagents/src/extension/index.ts",
		"packages/pi-stuff/src/subagents/src/intercom/native-supervisor-storage.ts",
		"packages/pi-stuff/src/subagents/src/intercom/native-supervisor-channel.ts",
		"packages/pi-stuff/src/subagents/src/runs/shared/deferred-module.ts",
		"packages/pi-stuff/src/subagents/src/runs/shared/nested-registry-projection.ts",
		"packages/pi-stuff/src/subagents/src/runs/shared/session-lease.ts",
		"packages/pi-stuff/src/subagents/src/runs/shared/worktree.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-control-events.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-observer.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-recovery.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-job-tracker.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/child-process-engine.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/completion-dedupe.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/control-channel.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/notify.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/result-processing.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/result-watcher.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-control.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-finalization.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-process.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/runner-state.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/steering.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-lifecycle.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-supervisor.mjs",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-protocol-forwarder.mjs",
		"packages/pi-stuff/src/subagents/src/runtime/runtime-maintenance.ts",
		"packages/pi-stuff/src/subagents/src/runtime/session-governor-compatibility.ts",
		"packages/pi-stuff/src/subagents/src/runtime/session-governor-ledger.ts",
		"packages/pi-stuff/src/subagents/src/session/foreground-replay.ts",
		"packages/pi-stuff/src/subagents/src/shared/artifact-maintenance.ts",
		"packages/pi-stuff/src/subagents/src/shared/artifact-snapshot.ts",
		"packages/pi-stuff/src/subagents/src/shared/atomic-json.ts",
		"packages/pi-stuff/src/subagents/src/shared/durable-claim.ts",
		"packages/pi-stuff/src/subagents/src/shared/file-system-retry.ts",
		"packages/pi-stuff/src/subagents/src/shared/private-directory.ts",
		"packages/pi-stuff/src/subagents/src/shared/process-identity.ts",
		"packages/pi-stuff/src/subagents/src/shared/utils.ts",
		"packages/pi-stuff/src/subagents/src/ui/agent-transcript.ts",
		"packages/pi-stuff/src/suite-loader.ts",
		"packages/pi-stuff/src/todo/todo-overlay.ts",
		"packages/pi-stuff/src/tool-display/registration.ts",
		"packages/pi-stuff/src/tool-display/tool-invocation.ts",
		"packages/pi-stuff/src/web/fake-ip.ts",
		"packages/pi-stuff/src/web/settings.ts",
		"packages/pi-stuff/src/web/runtime/anysearch.ts",
		"packages/pi-stuff/src/web/runtime/brave.ts",
		"packages/pi-stuff/src/web/runtime/brightdata.ts",
		"packages/pi-stuff/src/web/runtime/brightdata-unlocker.ts",
		"packages/pi-stuff/src/web/runtime/chrome-cookies.ts",
		"packages/pi-stuff/src/web/runtime/exa.ts",
		"packages/pi-stuff/src/web/runtime/extract.ts",
		"packages/pi-stuff/src/web/runtime/firecrawl.ts",
		"packages/pi-stuff/src/web/runtime/gemini-api.ts",
		"packages/pi-stuff/src/web/runtime/gemini-pdf-extract.ts",
		"packages/pi-stuff/src/web/runtime/gemini-url-context.ts",
		"packages/pi-stuff/src/web/runtime/gemini-web.ts",
		"packages/pi-stuff/src/web/runtime/github-api.ts",
		"packages/pi-stuff/src/web/runtime/kagi.ts",
		"packages/pi-stuff/src/web/runtime/ollama.ts",
		"packages/pi-stuff/src/web/runtime/openai-search.ts",
		"packages/pi-stuff/src/web/runtime/parallel.ts",
		"packages/pi-stuff/src/web/runtime/pdf-extract.ts",
		"packages/pi-stuff/src/web/runtime/perplexity.ts",
		"packages/pi-stuff/src/web/runtime/querit.ts",
		"packages/pi-stuff/src/web/runtime/search1api.ts",
		"packages/pi-stuff/src/web/runtime/searchinfinity.ts",
		"packages/pi-stuff/src/web/runtime/searxng.ts",
		"packages/pi-stuff/src/web/runtime/serpbase.ts",
		"packages/pi-stuff/src/web/runtime/serpdive.ts",
		"packages/pi-stuff/src/web/runtime/tavily.ts",
		"packages/pi-stuff/src/web/runtime/tinyfish.ts",
		"packages/pi-stuff/src/web/runtime/xai-search.ts",
	],
	runnerAdapters: [
		"packages/pi-stuff/src/codex/index.ts",
		"packages/pi-stuff/src/context-management/index.ts",
		"packages/pi-stuff/src/context-management/magic-worker-client.ts",
		"packages/pi-stuff/src/conversation-ui/effect-owner.ts",
		"packages/pi-stuff/src/conversation-ui/index.ts",
		"packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.ts",
		"packages/pi-stuff/src/notification/index.ts",
		"packages/pi-stuff/src/ponytail/index.ts",
		"packages/pi-stuff/src/rtk/index.ts",
		"packages/pi-stuff/src/session-naming/index.ts",
		"packages/pi-stuff/src/shared/effect-foundation.ts",
		"packages/pi-stuff/src/subagents/src/extension/index.ts",
		"packages/pi-stuff/src/subagents/src/extension/nested-control-router.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/async-execution.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/child-task-runner.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts",
		"packages/pi-stuff/src/subagents/src/runs/background/writer-process-supervisor.mjs",
		"packages/pi-stuff/src/subagents/src/runs/foreground/executor-control.ts",
		"packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.ts",
		"packages/pi-stuff/src/tool-display/index.ts",
		"packages/pi-stuff/src/tool-display/registration.ts",
		"packages/pi-stuff/src/web/adapter.ts",
	],
} as const satisfies EffectBoundaryInventory;

type NativeNamespace = "child-process" | "filesystem" | "filesystem-promises" | "timers" | "worker";

interface SourceBindings {
	effectImportLine: number | undefined;
	effectRootImportLine: number | undefined;
	readonly effectNamespaces: Set<string>;
	readonly effectPackageNamespaces: Set<string>;
	readonly runnerFunctions: Map<string, string>;
	readonly nativeConstructors: Map<string, string>;
	readonly nativeFunctions: Map<string, string>;
	readonly nativeNamespaces: Map<string, NativeNamespace>;
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function moduleSpecifier(statement: ts.ImportDeclaration): string | undefined {
	return ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
}

function importedName(element: ts.ImportSpecifier): string {
	return element.propertyName?.text ?? element.name.text;
}

function nativeNamespace(moduleName: string): NativeNamespace | undefined {
	if (moduleName === "child_process" || moduleName === "node:child_process") return "child-process";
	if (moduleName === "fs" || moduleName === "node:fs") return "filesystem";
	if (moduleName === "fs/promises" || moduleName === "node:fs/promises") return "filesystem-promises";
	if (
		moduleName === "timers" ||
		moduleName === "node:timers" ||
		moduleName === "timers/promises" ||
		moduleName === "node:timers/promises"
	) {
		return "timers";
	}
	if (moduleName === "worker_threads" || moduleName === "node:worker_threads") return "worker";
	return undefined;
}

function addNativeImport(bindings: SourceBindings, namespace: NativeNamespace, original: string, local: string): void {
	if (namespace === "child-process" && CHILD_PROCESS_FUNCTIONS.has(original)) {
		bindings.nativeFunctions.set(local, `process.${original}`);
	} else if (namespace === "timers" && TIMER_FUNCTIONS.has(original)) {
		bindings.nativeFunctions.set(local, `timer.${original}`);
	} else if (
		(namespace === "filesystem" || namespace === "filesystem-promises") &&
		ASYNC_FILESYSTEM_FUNCTIONS.has(original)
	) {
		bindings.nativeFunctions.set(local, `filesystem.${original}`);
	} else if (namespace === "worker" && original === "Worker") {
		bindings.nativeConstructors.set(local, "Worker");
	}
}

function collectImports(sourceFile: ts.SourceFile): SourceBindings {
	const bindings: SourceBindings = {
		effectImportLine: undefined,
		effectRootImportLine: undefined,
		effectNamespaces: new Set(),
		effectPackageNamespaces: new Set(),
		runnerFunctions: new Map(),
		nativeConstructors: new Map(),
		nativeFunctions: new Map(),
		nativeNamespaces: new Map(),
	};
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const moduleName = moduleSpecifier(statement);
		const clause = statement.importClause;
		if (!moduleName || !clause) continue;
		if (EFFECT_MODULE_PATTERN.test(moduleName)) {
			bindings.effectImportLine ??= sourceLine(sourceFile, statement);
			if (moduleName === "effect") bindings.effectRootImportLine ??= sourceLine(sourceFile, statement);
			if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
				const local = clause.namedBindings.name.text;
				(moduleName === "effect" ? bindings.effectPackageNamespaces : bindings.effectNamespaces).add(local);
			}
			if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					const original = importedName(element);
					if (EFFECT_NAMESPACE_EXPORTS.has(original)) bindings.effectNamespaces.add(element.name.text);
					if (EFFECT_RUNNERS.has(original)) bindings.runnerFunctions.set(element.name.text, original);
				}
			}
		}
		const namespace = nativeNamespace(moduleName);
		if (!namespace || !clause.namedBindings) continue;
		if (ts.isNamespaceImport(clause.namedBindings)) {
			bindings.nativeNamespaces.set(clause.namedBindings.name.text, namespace);
		} else {
			for (const element of clause.namedBindings.elements) {
				addNativeImport(bindings, namespace, importedName(element), element.name.text);
			}
		}
	}
	return bindings;
}

function staticMember(
	expression: ts.Expression,
): { readonly object: ts.Expression; readonly property: string } | undefined {
	if (ts.isPropertyAccessExpression(expression)) {
		return { object: expression.expression, property: expression.name.text };
	}
	if (
		ts.isElementAccessExpression(expression) &&
		expression.argumentExpression &&
		(ts.isStringLiteral(expression.argumentExpression) ||
			ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
	) {
		return { object: expression.expression, property: expression.argumentExpression.text };
	}
	return undefined;
}

function effectRunner(expression: ts.Expression, bindings: SourceBindings): string | undefined {
	if (ts.isIdentifier(expression)) return bindings.runnerFunctions.get(expression.text);
	const member = staticMember(expression);
	if (!member || !EFFECT_RUNNERS.has(member.property)) return undefined;
	if (ts.isIdentifier(member.object) && bindings.effectNamespaces.has(member.object.text)) return member.property;
	const parent = staticMember(member.object);
	if (
		parent &&
		ts.isIdentifier(parent.object) &&
		bindings.effectPackageNamespaces.has(parent.object.text) &&
		EFFECT_NAMESPACE_EXPORTS.has(parent.property)
	) {
		return member.property;
	}
	return undefined;
}

function nativeNamespaceFunction(namespace: NativeNamespace, property: string): string | undefined {
	if (namespace === "child-process" && CHILD_PROCESS_FUNCTIONS.has(property)) return `process.${property}`;
	if (namespace === "timers" && TIMER_FUNCTIONS.has(property)) return `timer.${property}`;
	if (
		(namespace === "filesystem" || namespace === "filesystem-promises") &&
		ASYNC_FILESYSTEM_FUNCTIONS.has(property)
	) {
		return `filesystem.${property}`;
	}
	return undefined;
}

function nativeFunction(expression: ts.Expression, bindings: SourceBindings): string | undefined {
	if (ts.isIdentifier(expression)) {
		if (expression.text === "fetch") return "network.fetch";
		if (TIMER_FUNCTIONS.has(expression.text)) return `timer.${expression.text}`;
		return bindings.nativeFunctions.get(expression.text);
	}
	const member = staticMember(expression);
	if (!member) return undefined;
	if (ts.isIdentifier(member.object)) {
		if (member.object.text === "Bun" && (member.property === "spawn" || member.property === "spawnSync")) {
			return `process.Bun.${member.property}`;
		}
		const namespace = bindings.nativeNamespaces.get(member.object.text);
		if (namespace) return nativeNamespaceFunction(namespace, member.property);
	}
	const parent = staticMember(member.object);
	if (
		parent?.property === "promises" &&
		ts.isIdentifier(parent.object) &&
		bindings.nativeNamespaces.get(parent.object.text) === "filesystem" &&
		ASYNC_FILESYSTEM_FUNCTIONS.has(member.property)
	) {
		return `filesystem.${member.property}`;
	}
	return undefined;
}

function nativeConstructor(expression: ts.Expression, bindings: SourceBindings): string | undefined {
	if (ts.isIdentifier(expression)) {
		if (expression.text === "Promise" || expression.text === "AbortController" || expression.text === "Worker") {
			return expression.text;
		}
		return bindings.nativeConstructors.get(expression.text);
	}
	const member = staticMember(expression);
	if (
		member?.property === "Worker" &&
		ts.isIdentifier(member.object) &&
		bindings.nativeNamespaces.get(member.object.text) === "worker"
	) {
		return "Worker";
	}
	return undefined;
}

function destructuredBinding(
	element: ts.BindingElement,
): { readonly local: string; readonly original: string } | undefined {
	if (!ts.isIdentifier(element.name)) return undefined;
	const property = element.propertyName;
	if (property && !ts.isIdentifier(property) && !ts.isStringLiteral(property)) return undefined;
	return { local: element.name.text, original: property?.text ?? element.name.text };
}

function collectAliases(sourceFile: ts.SourceFile, bindings: SourceBindings): void {
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			if (ts.isIdentifier(node.name)) {
				const runner = effectRunner(node.initializer, bindings);
				const native = nativeFunction(node.initializer, bindings);
				if (runner) bindings.runnerFunctions.set(node.name.text, runner);
				if (native) bindings.nativeFunctions.set(node.name.text, native);
			} else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer)) {
				for (const element of node.name.elements) {
					const binding = destructuredBinding(element);
					if (!binding) continue;
					if (bindings.effectNamespaces.has(node.initializer.text) && EFFECT_RUNNERS.has(binding.original)) {
						bindings.runnerFunctions.set(binding.local, binding.original);
					}
					if (
						node.initializer.text === "Bun" &&
						(binding.original === "spawn" || binding.original === "spawnSync")
					) {
						bindings.nativeFunctions.set(binding.local, `process.Bun.${binding.original}`);
					}
					const namespace = bindings.nativeNamespaces.get(node.initializer.text);
					const native = namespace && nativeNamespaceFunction(namespace, binding.original);
					if (native) bindings.nativeFunctions.set(binding.local, native);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

export function auditEffectBoundarySource(
	path: string,
	source: string,
	inventory: EffectBoundaryInventory = EFFECT_BOUNDARY_INVENTORY,
): EffectBoundaryFinding[] {
	if (!PRODUCTION_SOURCE_PATTERN.test(path)) return [];
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const bindings = collectImports(sourceFile);
	const governed = inventory.governedSources.includes(path);
	collectAliases(sourceFile, bindings);
	const findings: EffectBoundaryFinding[] = [];
	if (bindings.effectRootImportLine !== undefined) {
		findings.push({ path, rule: `effect-root-import:${String(bindings.effectRootImportLine)}` });
	}
	if (!governed && bindings.effectImportLine !== undefined) {
		findings.push({ path, rule: `effect-source-not-governed:${String(bindings.effectImportLine)}` });
	}
	const allowRunners = inventory.runnerAdapters.includes(path);
	const allowNative = inventory.nativeAdapters.includes(path);
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const runner = effectRunner(node.expression, bindings);
			if (runner && !allowRunners) {
				findings.push({
					path,
					rule: `effect-runner-outside-adapter:${runner}:${String(sourceLine(sourceFile, node))}`,
				});
			}
			const native = nativeFunction(node.expression, bindings);
			if (native && !allowNative) {
				findings.push({
					path,
					rule: `native-effect-outside-adapter:${native}:${String(sourceLine(sourceFile, node))}`,
				});
			}
		} else if (ts.isNewExpression(node) && node.expression) {
			const native = nativeConstructor(node.expression, bindings);
			if (native && !allowNative) {
				findings.push({
					path,
					rule: `native-effect-outside-adapter:${native}:${String(sourceLine(sourceFile, node))}`,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return findings;
}

function validInventoryPath(path: string): boolean {
	return PRODUCTION_SOURCE_PATTERN.test(path) && posix.normalize(path) === path && !path.includes("\\");
}

export async function auditEffectBoundaryInventory(
	root: string,
	publicPaths: readonly string[],
	inventory: EffectBoundaryInventory = EFFECT_BOUNDARY_INVENTORY,
): Promise<EffectBoundaryFinding[]> {
	const findings: EffectBoundaryFinding[] = [];
	const publicPathSet = new Set(publicPaths);
	const governed = new Set(inventory.governedSources);
	const lists = [
		["governed-sources", inventory.governedSources],
		["native-adapters", inventory.nativeAdapters],
		["runner-adapters", inventory.runnerAdapters],
	] as const;
	for (const [name, paths] of lists) {
		const seen = new Set<string>();
		for (const path of paths) {
			if (seen.has(path)) findings.push({ path, rule: `effect-boundary-inventory-duplicate:${name}` });
			seen.add(path);
			if (!validInventoryPath(path)) {
				findings.push({ path, rule: `effect-boundary-inventory-invalid:${name}` });
				continue;
			}
			let exists = publicPathSet.has(path);
			if (exists) {
				try {
					exists = (await stat(join(root, path))).isFile();
				} catch {
					exists = false;
				}
			}
			if (!exists) findings.push({ path, rule: `effect-boundary-inventory-path-missing:${name}` });
			if (name === "runner-adapters" && !governed.has(path)) {
				findings.push({ path, rule: `effect-boundary-adapter-not-governed:${name}` });
			}
		}
	}
	return findings;
}
