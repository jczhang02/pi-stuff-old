# Context Management

[Simplified Chinese](../i18n/zh-CN/docs/capabilities/context-management.md)

Context Management adds retrieval, memory, notes, compaction, and pressure handling while Pi retains its conversation,
Session, foreground-run, retry, and queue behavior.

## Commands and Tools

| Command | Action |
| --- | --- |
| `/ctx` or `/ctx status` | Open status and available actions |
| `/ctx flush` | Apply queued drops with the next message |
| `/ctx wrapup [N]` | Compact older history, keeping 20 messages by default |
| `/ctx recomp [start-end]` | Explicitly rebuild compartments for all or part of history |
| `/ctx upgrade` | Upgrade supported legacy Session history and memories |

The dialog reports usage, active and dropped tags, compartments, memory, notes, pending work, Historian state, cache,
history tokens, and errors. Maintenance persists as model-invisible Context Activity. `recomp` and `upgrade` continue
in the background; switching or forking detaches their visible updates without cancelling the operation.

The configured engine exposes deferred `ctx_search`, `ctx_expand`, `ctx_memory`, `ctx_note`, and `ctx_reduce` Tools.
Pi Stuff owns `/ctx` and suppresses duplicate upstream status, dialog, announcement, and Todo UI.

## Startup and projection

Recognized, migration-free configuration activates before the editor is ready. Missing or legacy configuration stays
dormant until direct input, `/ctx`, or an explicit projection authorizes first-use setup. Automatic turns cannot create
or migrate user configuration. Unconfigured or explicitly disabled Magic leaves native Pi behavior available.

With Magic enabled, Magic owns foreground projection even after an engine failure. The Suite never falls back to raw
history or native summarization. Pi Session JSONL remains the raw record. A Worker receives a full snapshot on first
bind or branch discontinuity; ordinary refreshes send the new leaf. Every foreground Context event calls Magic, so
retry correctness does not depend on an additional Suite projection cache.

Local payload estimates are informational. High, unknown, nonfinite, or unavailable estimates do not themselves abort
a valid Magic request. Status percentages are estimates, not guarantees of remote Provider acceptance. A correct
projection must retain the current input and completed Tool results; failure to obtain it enters bounded recovery.
BTW and Agents retain their existing bounded reference projections and caller-owned snapshot contracts.

Prompt contributions follow Host, Context Management, then other registered Capability contributions. Direct-mode
guidance remains bounded to 8,000 characters.

## Compaction and recovery

Magic performs ordinary proactive compaction. On actual Provider overflow, Pi invokes its public compaction hook; Magic
runs its existing Historian and returns a genuine durable summary and retained-history boundary. Pi persists that
result and performs its existing retry. A second overflow stops that attempt under Pi's policy. Manual compaction also
uses Magic. Automatic recovery never invokes full `/ctx recomp` and never repeats completed Tools or resubmits input.

One fault-recovery phase shares ten minutes across compression, existing transient retries, backoff, completion checks,
and at most one Worker restart. No progress or uncertain completion stops earlier. A lost acknowledgement triggers a
durable-state check: confirmed completion is reused; only confirmed incomplete, safe work can repeat. Healthy Agent
execution, ordinary proactive compaction, and normal Provider response time are outside the recovery deadline.

Pi's auto-compaction setting must be enabled for Pi to invoke automatic overflow recovery. Disabling it does not
disable ordinary Magic compaction. `/ctx` explains the missing Host hook; Pi Stuff never changes the setting itself.
Native custom-turn preflight applies only when Magic is unconfigured or explicitly disabled.

## Worker, cancellation, and display

The engine runs in one internal Worker, keeping terminal painting responsive. Ordinary mirrored lifecycle events do
not inherit the ambient Agent-turn signal. Compaction receives its own cancellation signal; Tools and signal-aware
commands retain invocation-owned cancellation. A fatal Worker is replaced only through bounded critical recovery.
Late results and Host effects remain bound to their originating Session; shutdown uses a bounded grace period.

Input during recovery follows Pi's compaction queue. Explicit cancellation stops the Magic operation; Pi may then
deliver queued input, as it does without the Suite. Pi Stuff does not clear or resubmit queues, and does not patch the
Host to impose another terminal policy.

Actual recovery uses the existing Context display with `recovering` and a short phase. Success clears recovery state.
Unrecoverable failure explains the cause once and preserves the Session and current input. Technical details stay in
`/diagnostics`, outside model context. Estimate uncertainty and optional maintenance failure do not proactively
interrupt an otherwise viable Agent run.

## Configuration and references

Context engine and Worker configuration remain external to `pi-stuff.json`. After changing them, restart Pi and inspect
`/ctx` and `/diagnostics`.

- [Module contract](../../packages/pi-stuff/src/context-management/README.md)
- [Recovery decision](../adr/0031-preserve-magic-context-behavior-through-suite-integration.md)
- [Command reference](../reference/commands.md#context)
- [Troubleshooting](../troubleshooting.md#context)
