---
status: accepted
---

# Initialize configured Context before editor readiness

The Context fallback, request-admission, and recovery clauses below are superseded by
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md). Other decisions remain unchanged.

## Context

Lazy initialization moved Magic Context module, database, and synthetic-frame work onto the first normal
Enter-to-provider path. Configured Sessions need native-like submission latency without weakening startup purity.

## Decision

When a Session already has a recognized Magic Context configuration with no pending file migration, Pi Stuff completes
the official module load, factory initialization, SQLite setup, and `session_start` handling before the editor is
reported ready. A missing or legacy configuration leaves Context dormant until direct user action authorizes creation
or migration. Startup may initialize rebuildable derived Context state, but it does not create, rewrite, or migrate
user configuration. Failure remains fail-open to Pi native context and may retry on later accepted work.

## Consequences

- A configured Session deliberately pays more process-startup time so ordinary message submission does not wait for
  Context initialization.
- Unconfigured and legacy Sessions remain read-only at startup.
- Context failure returns ownership to Pi native behavior rather than blocking the Host.
