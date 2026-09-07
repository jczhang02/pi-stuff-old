# Upstream provenance

This module contains source derived from the pinned MIT-licensed `@juicesharp/rpiv-todo` Package snapshot.

| Field | Value |
| --- | --- |
| Upstream repository | `https://github.com/juicesharp/rpiv-mono` |
| Source directory | `packages/rpiv-todo` |
| Source revision | `75823a68024a0a649cc28087976074be791ca554` |
| Published Package | `@juicesharp/rpiv-todo@2.3.1` |
| npm shasum | `8797586bad201f4b2153505347c3b997c320eaa2` |
| archive SHA-256 | `b0ae0f1f4245f471c3fa724dc50425cfa241eb37e399c4948d393fe7965d1fa8` |

The upstream text baseline was imported before product changes. Documentation images were not imported because they are not Runtime Resources or source inputs.

## Pi Stuff delta

- Adapts the source to the Pi 0.85.1 Host contract and the single Package dependency set.
- Replaces the action-multiplexer tool with `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`.
- Exposes stable string IDs, adds atomic forward and reverse dependency updates, and never resets the ID counter.
- Versions new replay snapshots while retaining migration from legacy numeric `todo` snapshots.
- Replaces the configurable, localized upstream panel and command output with one bounded, unheaded above-editor checklist.
- Removes the upstream settings, localization, large overlay, statusline, and duplicate successful tool presentation.

Claude Code release behavior informed the interaction contract only. No Claude Code source is copied or redistributed.
The absorbed source has no independent Package or release lifecycle.
