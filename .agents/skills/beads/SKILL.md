---
name: beads
description: Manage accepted Pi Stuff work in Beads, including work maps and GitHub issue intake; do not use for a current-turn checklist.
---

# Beads

The [issue-tracker contract](../../../docs/agents/issue-tracker.md) is authoritative for tracker mutations and delivery.
Read the relevant section before changing tracker state; when generic `bd` guidance conflicts, follow the contract.
If Beads context is missing, run `bd prime` after consulting the contract.

Use Beads for accepted shared work, dependencies, follow-ups, and handoff. A local plan may track the current turn but
never replaces Beads. Record durable terminology or architecture decisions in `CONTEXT.md` or an ADR too.

## Operate the tracker

1. Fetch a supplied `ps-...` ID with `bd show`; select work with `bd ready` or `bd ready --parent <epic-id>`. For
   `gh-...` intake, search `bd search --external-contains "gh-<number>"` before the maintainer-directed one-time pull.
2. Search all statuses before creating likely duplicates. Create accepted work with `bd create`, verify the `ps` prefix,
   and record only public metadata: originating Host or Agent surface, Session name when available, and stable lookup ID.
3. Claim before implementation with `bd update <id> --claim`; use non-interactive `bd update` flags, never `bd edit`.
4. Model work maps as epics with child tickets and blockers with `bd dep add <blocked-id> <blocker-id>`.

## Keep Beads local and publish safely

- The local Dolt database is authoritative. Keep `.beads/` ignored; do not run `bd init`, `setup`, `hooks`, Dolt push/
  pull, general GitHub sync, or install Beads hooks. Beads must not operate repository Git.
- GitHub Issues is public intake and a push-only mirror. PRs deliver and review code; they do not own scope, dependencies,
  status, or closure. Keep credentials, private paths/data, personal information, and sensitive Session details out of
  every public field.
- For delivery or closure, follow `docs/agents/issue-tracker.md`, including its evidence and publication requirements.
