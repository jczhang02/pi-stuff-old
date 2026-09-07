---
status: superseded by ADR-0031
---

# Bound Context-managed Provider requests

The Context fallback, request-admission, and recovery clauses below are superseded by
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md). Other decisions remain unchanged.

## Context

Context Management usually sends a derived projection, while Pi owns the final Provider request assembled from the
Session and registered contributions. A transport or Worker failure can otherwise cause a later request to use native
context without proving that its final payload remains within the configured model window.

## Decision

For every active, Host-managed foreground `before_provider_request`, Context Management measures the final JSON-
serialized Provider payload and requires a finite token estimate no greater than 95% of the model Context window.
Missing or unreliable window data, serialization or measurement failure, nonfinite estimates, and over-bound payloads
produce a local abort/error and an unknown estimate. Startup and degraded-engine paths may use Pi's native fallback, but
the active Provider boundary fails closed. Direct calls that bypass this hook are excluded.

Only a result validated at this Provider boundary may be reused, and only when every ordered raw message object and the
Provider, model id, and Context window are identical. Any change reruns validation. Pi retains ownership of its existing
retry, continuation, and compaction behavior; this policy adds no budgets.

During normal operation the Statusline reports the latest validated percentage. Recovery reports `recovering` until a
validated result is available. Failure reports `unknown` and aborts locally. Recovery state clears after a successful
assistant or Session lifecycle.

## Rejected alternatives

- Retrying indefinitely cannot repair an unmeasurable or deterministically oversized payload.
- Guarding only WebSocket close code 1006 misses other transport and Worker failures.
- Dynamic limits based on observed Provider acceptance weaken the local safety guarantee.
- Changing only the pinned Magic Context package cannot validate Pi's final assembled payload.
- Upstream submission or a new dependency is outside this local adapter contract.

## Consequences

Pi Stuff may abort a request that a Provider could accept, but an active recovery cannot silently send an unvalidated
native payload. Evidence must include a focused unit regression and real Pi Host PTY coverage of long raw history,
post-stream transport failure, recovery without new user input, bounded serialized payloads, changed-input reruns,
status transitions, and local failure behavior. The evidence must not claim new retry budgets or terminal exhaustion.
