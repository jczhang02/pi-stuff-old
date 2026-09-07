# Agents

[Simplified Chinese](../../../../docs/i18n/zh-CN/packages/pi-stuff/src/subagents/README.md)

Bounded delegation to named child Agents, with background-by-default execution and one lifecycle view.

<p align="center">
  <a href="../../../../docs/assets/readme/capabilities/subagents.png">
    <img src="../../../../docs/assets/readme/capabilities/subagents.png" alt="Delegated Agents dialog in Pi" width="100%">
  </a>
  <br>
  <em>The Agents dialog keeps delegated work scoped to the current Session.</em>
</p>

## Quick start

Use the `subagent` Tool:

```json
{
  "agent": "general-purpose",
  "description": "Inspect parser",
  "task": "Find the parser boundary and report exact source evidence."
}
```

Continue independent work after launch. Open `/agents` to inspect, steer, stop, resume, or review retained results.

## Highlights

- Discovers fixed, settings-scanned, symlinked, and Package Agent definitions with explicit precedence.
- Supports per-Agent Tool allowlists and exclusions without changing the parent Host.
- Supports one Agent, parallel grouped tasks, and status or lifecycle control calls; `agent` selects a launch
  definition, while `id` identifies an existing Agent Target.
- Runs in the background by default; foreground mode waits for the result.
- Delivers bounded success, failure, and partial outcomes to the originating main Agent; idle work resumes integration,
  while busy work queues delivery. Canonical retained output outranks later progress text.
- Explicit terminal status inspection returns the retained output reference, with transcript or Session fallbacks;
  grouped completion text describes the aggregate outcome and member count.
- Cancellation or explicit task ending suppresses late-result restart while retaining the outcome and canonical reference
  for inspection; Session/run identity and duplicate delivery are preserved.
- Keeps concurrency and nesting bounds while productive work has no cumulative-launch, default run-time, or implicit Tool timeout.
- Aggregates attempts and resumes in one durable usage total; later automatic expansion pauses at the documented cost
  guard without stopping an in-flight child.
- Returns stable abnormal-outcome classes, bounded partial evidence, and a resumable Agent Target when continuation is
  supported.
- Quarantines unowned versionless legacy runs instead of leaving them indefinitely active or reclaiming an unknown
  process.
- Keeps Session-owned artifacts and preserves changed isolated worktrees for inspection.

## Launch preparation

Child Hosts skip the root Agents management implementation, which registers nothing in those processes. The parent
loads it during Suite installation; authorized nested delegation keeps its existing child Extension.

Agent, Skill and MCP project paths use Pi's public `CONFIG_DIR_NAME`. Walking project ancestors does not rediscover
that Host constant through synchronous executable or package-metadata reads; discovery precedence is unchanged.

Planning validates Skills, model candidates, Tool budgets and timeouts, and capability/MCP constraints without creating
execution or recovery records or hashing Agent definitions and task bodies. Final construction resolves the launch
inputs and creates their digests, model metadata, and recovery record once. Planning projections are not cached across
launches or reused as finalized child contracts.

When neither per-call nor Agent configuration selects Skills, launch preparation does not load the filesystem Skill
resolver. Selected Skills still resolve at preflight and final construction, preserving changed-file checks and
missing-Skill errors before fork creation. Inheriting ambient Skills still keeps Read available.

Skill path discovery does not read candidate Skill bodies. Selected files are read once per metadata cache miss;
the bounded cache retains names, paths, sources and descriptions, not unused body text. Selected-file modification
checks, discovery precedence, fallback paths and the advertised Skill prompt remain unchanged.

New launches and existing-target controls have separate loading boundaries. A launch loads its selected execution
engine on first use; foreground execution does not load detached-runner launch machinery. Isolated-worktree operations
load only when requested. Session fallback snapshot operations load only when a task has an inherited Session file
and at least two model candidates. Required recovery records, writer ownership, and initial status are still committed
before child execution; fallback snapshots still freeze the Session before the first model attempt.

Foreground startup commits the writer registry and initial status once, then passes that status directly to the
shared runner in a per-run Bun Worker within the same Pi process. The runner still publishes its first observer update without recreating or rewriting those startup
artifacts. Initial turn and Tool counts are zero; the first notification retains the committed timestamp. This
structured-clone handoff is never persisted in background runner configuration. Detached starts, revival handshakes, directory
claims and cancellation keep their existing ownership.

The Worker evaluates and executes the shared child engine off Pi's UI thread. Pi retains foreground controls, status
projection and Session commits. The adapter receives process interrupt signals on Pi's main thread and writes them to
the existing durable control inbox; the Worker consumes pause requests through the shared runner. The signal listener
is released with the foreground execution. The adapter snapshots the parent Host executable and entry arguments, preserves Source
URLs during bundling, and uses the Host resolver for Effect dependencies. Completion waits for the Worker close event;
interruption then records owner exit and reaps writers through the existing recovery path before terminalizing status.
Each run releases its Worker and bundle URL. Per-run bundling avoids a new Session cache, but adds startup work and
temporary memory; responsiveness and total resource cost are measured separately.

Necessary first-use dependency loads yield a timer turn before and after each load. Concurrent callers share the
pending import; failures allow a retry, and warm calls add no timers. Invalid launch inputs do not load builders.
Child protocol loading completes before spawn, and recovery/ownership work retains its existing order.

New foreground and background launches publish finalized recovery records without loading the recovery reader's
schemas. Resume still validates every retained record at the read boundary. Background launch preparation and
detached runner startup load in separate first-use stages; an import failure before spawn cleans the owned,
unstarted run directory. Warm launches share the already-loaded modules.

The writer supervisor starts both pipe readers immediately after spawn, before yielding to asynchronous dispatch.
This preserves final stdout frames and stderr from fast-exiting writers; backpressure and post-exit draining remain
unchanged for foreground and detached execution.

Current Session governor transactions use asynchronous stable-inode kernel claims. Acquiring a claim does not rewrite
or flush diagnostic owner records; mutual exclusion and process-death release remain kernel-owned. Canonical ledger
commits and legacy lock handling are unchanged.

Nested-registry projection and retirement use the same stable-inode kernel claims without rewriting or flushing
unused diagnostic owner records. Event draining, durable projection, contention and exact-route retirement remain intact.

Status publication creates its queue, fiber and timed wakeups only when the current process has a connected IPC
sender. Hosts without that channel still persist status and notify in-process observers; connected background runners
keep their existing progress cadence and immediate terminal delivery.

Atomic artifact writers remove temporary files only after a failed write or rename. Successful same-directory rename
already consumes the temporary pathname; atomic visibility, private permissions, retries and original-error precedence
remain unchanged for both synchronous and asynchronous publication.

Final-output extraction scans ordinary Assistant content once, retaining only the latest eligible text reference.
It joins a complete message only when that message contains an acceptance report; report precedence and bounded
result/error evidence are unchanged.

## Documentation

- [Agents guide](../../../../docs/capabilities/subagents.md)
- [Command reference](../../../../docs/reference/commands.md#work-control)
- [Background Work guide](../../../../docs/capabilities/background-work.md)
- [Tool Display guide](../../../../docs/capabilities/tool-display.md)
- [Upstream references](UPSTREAM.md)
