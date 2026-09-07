# Upstream provenance

This module contains source derived from the pinned `@mobrienv/pi-tidy-tools` 0.4.1 snapshot.

| Field | Value |
| --- | --- |
| Repository | `https://github.com/mikeyobrien/pi-tidy-tools` |
| Package directory | `packages/pi-tidy-tools` |
| Release tag | `pi-tidy-tools-v0.4.1` |
| Source commit | `4b251377f1b64f904704e7f760e8947688d12a9a` |
| License | MIT |
| npm archive SHA-1 | `3412d29d584f9226b02a13279d88a3ea03a1422e` |
| npm archive SHA-256 | `59bf767e047a0799257af3c510a92f0841db2791e8e11aceca14fc2f7221f71a` |

## Pi Stuff delta

- Keeps the upstream result-first, same-name built-in override and semantic summary ideas.
- Uses seven Pi 0.85.1 Tool definitions directly so their parameter schemas, prompt metadata, execution, result shapes,
  events, and permission interception remain Host-owned and unchanged. Pi's additional PowerShell Tool remains
  Host-rendered and is recognized only for lifecycle membership.
- Removes the injected `reasoning` argument and every non-result presentation mode.
- Removes fixed ANSI colors, emoji, full-row success backgrounds, `/diff`, global expansion as the detail path,
  `pi-fff`, command-driven configuration, and upstream file-writing startup/configuration behavior.
- Uses Pi semantic theme tokens, a bounded width cache, hard-capped focused details, and the shared non-floating Pi
  Stuff Command Dialog.
- Adds a required Activity metadata contract for every Suite-owned Tool, with semantic present/past clauses,
  deduplication identities, bounded live targets, and honest issue states.
- Composes public lifecycle events, current-branch reconstruction, and per-row invalidation into native Retrieval
  Groups across Assistant Tool round-trips. Bash and every non-native retrieval Tool remain independent; Assistant
  prose, user input, visible model-context Custom Messages, and new Logical Thinking Runs are boundaries. Ctrl+O
  restores eligible native Tool rows; model-visible results and persisted Session data remain unchanged.
- Does not contain or derive from code in `jczhang02/pi-agent`.

The upstream license is preserved in `LICENSE`. The source is absorbed into Pi Stuff and has no independent Package or
release lifecycle. Future upstream incorporations must update this record and keep local changes auditable.
