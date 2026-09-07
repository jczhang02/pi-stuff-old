---
status: accepted
---

# Isolate Context engine work from the Host UI thread

The Context fallback, request-admission, and recovery clauses below are superseded by
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md). Other decisions remain unchanged.

## Context

Magic Context projection can perform enough CPU and module-loading work to stall Pi input paint and the Working
animation. Deferring the same work on the Host event loop does not change that contention.

## Decision

Magic Context projection executes inside one Context Engine Worker. Pi remains the Host and continues to own input,
Conversation Transcript rendering, Sessions, model requests, and Agent lifecycle. Context Management does not render a
second copy of submitted input or call a synthetic refresh API.

The adapter lazily bundles the exact pinned Magic Context package and its worker entry into one in-memory Bun artifact,
then starts it from a Blob URL. This happens during the configured Context initialization already governed by ADR 0007.
The artifact is not written to disk, published, or installed. The upstream Package is not forked; its exact pinned npm
artifact carries the temporary audited tokenizer compatibility dependency patch recorded in Context Management's
`UPSTREAM.md`. The bundle preserves the upstream Package's original `import.meta.url` so package-relative resources
and version identity keep their official semantics.

Pi event, Tool, and command registrations remain in the Host. Each invocation sends an immutable Context snapshot and
only the event fields read by the pinned engine. The Worker boundary changes execution location, not cancellation
semantics: mirrored lifecycle work for an accepted prompt is owned by the Session and does not inherit the current
Agent-turn signal. The adapter forwards cancellation only at invocation seams where the pinned official handler
consumes it. An interrupted Agent turn therefore cannot classify a healthy Worker as failed or own its recovery.

Context snapshots are demand-shaped at that pinned boundary. Tool start and end handlers receive Session metadata but
not an unused Host context-usage estimate, and an intermediate Tool-use `message_end` relies on its Assistant usage
until the following Context refresh. Session-mirror synchronization also omits the context-usage field that its caller
does not consume. This prevents the Host from serializing complete in-flight Tool arguments merely to construct
discarded snapshot data.

The complete Session branch crosses the boundary when a Worker first
binds a Session, when a changed leaf is not the direct successor of the mirrored leaf, and for the three explicit
history-rebuild commands. Ordinary Context projection and persistence send at most one new leaf entry. The snapshot
fallback therefore repairs fork, tree, compaction, and other discontinuities without cloning an unbounded Session on
every Enter.

Worker-to-Host effects are limited to `appendEntry`, `sendMessage`, `sendUserMessage`, `notify`, and `setStatus`, and are
bound to the originating Pi Session. The one SessionManager operation that the pinned upstream API requires synchronously,
`appendCompaction`, uses a bounded shared-memory response while blocking only the worker. A failed Host effect, mirror
synchronization, or fatal Worker error immediately returns Context ownership to Pi native behavior. Shutdown gives the
official handler one bounded Host grace period, then terminates the Worker independently of its serialized request queue
and revokes the in-memory URL.

## Rejected alternatives

- Rendering or refreshing the submitted prompt from the adapter creates a second visible authority and caused full-frame
  refresh and stuck-Working regressions.
- Deferring the same Magic Context call with a timer still lets CPU-heavy projection monopolize Pi's UI thread.
- Loading an external module graph directly from a worker is not reliable in the certified standalone Pi binary: bare
  imports do not resolve there, while absolute external entry URLs crashed the standalone Bun worker path. The single
  in-memory bundle is the smallest deterministic loader at this boundary.
- Forking Magic Context would duplicate upstream ownership without changing the Pi-facing seam.

## Consequences

Configured startup pays one worker build/start and tokenizer-preload cost, one initial Session snapshot before editor
readiness, and one worker's memory while Context is active. In return, a healthy Magic Context projection can run concurrently with Pi's
native input paint and Working animation without another full-Session clone per ordinary turn. Acceptance must use a
real Pi TUI with a long resumed Session containing malformed image history, require the submitted prompt in the
Conversation Transcript within 150 ms from submission through PTY observation, including tmux submission and capture
overhead, bound the maximum Working-frame stall, and confirm that the expected marker occurs inside the Magic Context
history projection sent to the Provider. The same
gate must interrupt one accepted Agent turn, require the next prompt in the Transcript within the 150 ms boundary, and
confirm that the interrupted prompt remains in the next complete Provider payload. A real supported model smoke test
must also exercise a Magic Context Tool successfully.
