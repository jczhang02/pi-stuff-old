# Agents

[Simplified Chinese](../i18n/zh-CN/docs/capabilities/subagents.md)

Agents delegates bounded work to named child Agents and keeps their lifecycle available through one Tool and the
`/agents` dialog.

## Prerequisites

Agent definitions are discovered from:

1. the current project's `.pi/agents` directory;
2. the user's Pi `agents` directory;
3. installed Pi Packages.

When names collide, project definitions take precedence over user definitions, which take precedence over Package
definitions. The `subagent` Tool description lists the effective roster and each Agent's purpose before a main run.
Agent frontmatter may declare `tools` and `excludeTools`; exclusions always win for that child.

Pi settings may add recursive roots through `subagents.agentScanDirs`. User settings contribute user-scoped roots;
project `.pi/settings.json` contributes project-scoped roots. Entries expand `~` and may contain one whole `*` path
segment to scan one directory level. Missing roots are ignored, symlinked directories are followed once, and the fixed
user or project Agent directory wins when names collide with a scan root.

## Quick start

Launch one Agent in the background:

```json
{
  "agent": "general-purpose",
  "description": "Inspect parser",
  "task": "Find the parser boundary and report exact source evidence."
}
```

Background is the default. Completion is delivered automatically to the originating main Agent: an idle Agent resumes
integration, and a busy Agent queues the bounded outcome. Set `"foreground": true` only when the result is required
before the current Tool call can return.

## Tool shapes

Each `subagent` call uses exactly one shape.

### One Agent

`agent` and `task` are required. Optional fields select a short `description`, working directory, model, Skill,
an explicit Tool budget or per-Tool timeout, context mode, isolation, and foreground execution.

### Parallel Agents

```json
{
  "tasks": [
    {
      "agent": "general-purpose",
      "description": "Inspect API",
      "task": "Report the public API with source references."
    },
    {
      "agent": "reviewer",
      "description": "Check behavior",
      "task": "Independently verify the documented behavior."
    }
  ]
}
```

Grouped tasks run concurrently within the current capacity. Independent native `subagent` Tool calls emitted in one
Assistant response can also run concurrently.

### Control

```json
{ "action": "status" }
{ "action": "steer", "id": "agent-id", "message": "Check the fallback path too." }
{ "action": "stop", "id": "agent-id" }
{ "action": "resume", "id": "agent-id" }
{ "action": "resume", "id": "agent-id", "index": 0, "acknowledgeCost": true }
```

`status` may omit `id` for a one-shot overview. `steer`, `stop`, and `resume` require `id`; grouped runs can also select
a child by `index`. `agent` names an Agent definition only when launching, while `id` identifies an existing Agent
Target; the Todo field `taskId` is not an Agent identifier. `acknowledgeCost` is valid only for a direct user-started
resume after the cost guard requests attention. Use `/agents` for regular inspection and control.

For a terminal Agent, `status` with `id` returns the exact retained output path before its bounded progress excerpt.
Read that path to retrieve the complete report. If no output path is retained, it returns the transcript or Session
path instead, or explicitly reports that no reference remains. Prose remains bounded and compacts embedded paths;
the retrieval reference preserves the exact path.

## Background and foreground

Background launches return after admission and start. A terminal success, failure, or partial outcome creates a compact
durable TUI result and is also delivered to the originating main Agent while its task remains open. Idle delivery resumes
integration; busy delivery queues until the current turn settles. Full reports remain available in `/agents`. Diagnostic
event logs retain a bounded suffix; rolling that log does not redeliver already observed control events.

Grouped TUI results describe the group's aggregate outcome and member count. For example, `Agent group (2) failed`
means at least one member failed; inspect the individual Agents for their outcomes. Retained Session entries use the
same wording when reopened.

Delivery is bound to the originating Session and run and is deduplicated. User cancellation or explicit task ending
suppresses a late continuation while retaining the outcome and canonical reference for inspection. A Goal-owned active
run uses its canonical Goal query to coordinate continuation, so one outcome cannot create competing continuations.

Foreground launches block until the result is ready and return it to the current Tool call. Nested fanout remains
owned by the launching child and cannot detach beyond that owner.

## `/agents`

`/agents` shows current-Session Agent lifecycle, retained outcomes, Result, Activity, and a rolling bounded child transcript. Transcript omission remains explicit.
Terminal details include a stable outcome class and reason, cumulative turns, Tool calls, input/output tokens, reported
cost when the Provider supplied it, model attempts, resumes, the Agent Target, and whether continuation is supported.
An abnormal end remains `incomplete` or `failed`; retained partial evidence is not relabelled as a successful report.

| Key | Action |
| --- | --- |
| Up / Down | Select an Agent |
| Enter | Open details |
| `x` | Stop a live Agent or dismiss a terminal entry |
| `t` | Expand eligible Tool output in details |
| Escape | Return or close |

The footer roster is the compact lifecycle view. Opening Agent management replaces the latest-prompt row so one surface
owns control at a time.

## Context, models, and Tools

A launch can request fresh or forked context, an explicit model, one Skill, and an explicit Tool budget. Capacity,
authentication, and model availability are checked before child execution. Ordinary delegated work has no fixed turn
cutoff, so a productive Agent is not terminated merely because it has continued working.

Explicit per-call models must resolve in Pi's active model registry. Unavailable Agent-configured models and fallbacks
are skipped in favor of the next available candidate, while the current parent model remains trusted even when a
custom provider has not registered it. Model IDs containing `owner/name` are resolved as IDs unless `owner` is an
actual registered provider. When registry evidence is available, the child-reported model is also checked against the
launch candidate. Provider failures rotate to a fallback only before useful child activity, avoiding repeated work or
external mutations.

`toolTimeoutMs` sets a hard timeout for each non-waiting Tool call. A task-level value overrides the launch value,
which overrides Agent frontmatter and `PI_SUBAGENT_TOOL_TIMEOUT_MS`. Without one of those explicit values, ordinary
child Tools have no implicit deadline. Supervisor and intercom Tools that legitimately wait remain exempt.

`excludeTools` subtracts names from ambient, explicit, MCP, and Suite-injected child Tools. Excluding `subagent`
disables nested fanout for that Agent. Excluding `read` is rejected when the Agent needs it for lazy Skill loading.

Each child uses the same Pi Host binary with the owning Package loaded and ambient discovery disabled. Context Management
and Magic own child Context pressure and projection; Agents preserves child protocol, Tool pairing, and recoverable
evidence through that boundary. Non-fanout children do not receive the `subagent` Tool.

## Limits

Default governor limits are:

- 20 concurrently running Agents;
- nesting depth 3.

There is no cumulative launch quota or default total runtime. `timeoutMs` sets an explicit run deadline when the caller
needs one.

Ordinary launches have no turn or Tool-call budget. An explicit `toolBudget` can limit Tool calls and `toolTimeoutMs`
can bound one Tool call.

The initial child, model attempts, fallbacks, and resumes share one durable work unit. Before starting later automatic
work, the governor requests attention once cumulative reported usage reaches 1,000,000 input-plus-output tokens or
$5.00 of Provider-reported cost. Missing Provider cost is never estimated as authoritative USD. The guard does not stop
an in-flight child. A direct user can acknowledge a resume, which retains the same Session and cumulative totals.

An explicit Tool hard limit blocks only the configured Tool names. Unconfigured Tools and the final Assistant response
remain available so the Agent can synthesize a bounded partial or final result from evidence already collected.

## Artifacts and isolation

Agent artifacts live beside the persisted Pi Session under the Settings-owned Session root. Ordinary delegation does
not create a project `.pi-subagents` directory.

Optional per-Agent worktree isolation keeps changed or uncertain worktrees for inspection. Only clean owned worktrees
may be removed automatically.

Changing or ending the parent Session cancels an in-flight launch safely and records its terminal state.

On cold restore, current versioned lifecycle artifacts keep their recorded state. Versionless legacy records remain
live only when current process or writer evidence proves ownership; terminal proof, a dead or reused PID, or unknown
ownership is projected as a dismissible incomplete legacy result. Recovery never signals or reclaims an unknown owner.

## See also

- [Agents Module README](../../packages/pi-stuff/src/subagents/README.md)
- [Command reference](../reference/commands.md#work-control)
- [Background Work](background-work.md)
- [Tool Display](tool-display.md)
