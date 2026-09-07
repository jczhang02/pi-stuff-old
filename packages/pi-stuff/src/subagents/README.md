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

## Documentation

- [Agents guide](../../../../docs/capabilities/subagents.md)
- [Command reference](../../../../docs/reference/commands.md#work-control)
- [Background Work guide](../../../../docs/capabilities/background-work.md)
- [Tool Display guide](../../../../docs/capabilities/tool-display.md)
- [Upstream references](UPSTREAM.md)
