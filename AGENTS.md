# Pi Stuff repository instructions

These instructions apply only while developing this repository. `AGENTS.md`, `CONTEXT.md`, and `docs/` are engineering
material, never Pi Runtime Resources or files for a user's global Pi Agent directory.

## Read by task

- Code changes and engineering-rule changes: read the relevant sections of `CONTEXT.md`, `docs/compatibility.md`, and
  the owning accepted ADR or Module README before editing. Read only enough for read-only location or status work.
- Code changes, reviews, or verification work: read the relevant sections of `docs/code-quality.md`.
- Visible surfaces: read `DESIGN.md` and the owning Module README or ADR.
- Beads, delivery, or closure: read `docs/agents/issue-tracker.md`.

## Engineering boundaries

- Pi is the Host. Keep Pi Stuff as one local Package with one default Extension factory; Capability Modules are
  internal and have no installation or publication lifecycle. Do not create another CLI, runtime, Session layer, SDK,
  or TUI shell.
- Keep lifecycle authority with its owner: Pi owns ordinary foreground Agent runs, Goal owns Goal continuation and
  terminal policy, Agents owns delegated execution, and Context Management owns context projection, retrieval,
  compaction, and pressure handling.
- Keep Extension import pure: startup performs no network, subprocess, Host-setting, or user-configuration work.
  First-use configuration waits for direct interactive/RPC input or an explicit command or Tool; initialization errors
  propagate instead of loading a partial Suite.
- Preserve one visible authority per state and follow `DESIGN.md`. Ship TypeScript source without a `dist/` lane.
  Change `packages/pi-stuff/suite.json`, then run `bun run suite:generate`; never edit generated output alone.

## Change and verification rules

- Fix the shared root cause at its owning seam, inspect the complete affected Capability, and reuse Pi public APIs and
  existing Suite components. Make product and architecture choices that are obvious and reversible; ask only when
  scope, authority, or a material product decision depends on the user.
- Follow the risk-based checks and completion review in `docs/code-quality.md`. Reuse results for the same revision;
  broaden or repeat verification only for changed code, a failure, or an unresolved risk.
- Carry authorized work through verification and delivery. Apply follow-up messages to the ongoing task unless the
  user cancels or replaces it; answer side questions and continue. Reuse authorization already given in the Session.
- Explicit user instructions take precedence over repository workflow and skill guidelines. If a skill causes a pause
  or departure from the request, link its exact file, quote the rule, and distinguish the requirement from interpretation.
- Keep progress and the final outcome concise, with decisive evidence and remaining work.
- Keep direct dependencies exact and `trustedDependencies` empty. Put worktrees under `.worktrees/`. Use signed
  Conventional Commits for coherent completed changes.
- Do not infer merge from ancestry. Before reporting merge or cleanup, inspect the patch, target branch, and every
  associated worktree's tracked and untracked state; remove a merged worktree only after it is clean.
- Accepted durable implementation follows Beads and `docs/agents/issue-tracker.md`; read-only discussion, exploration, and
  current-turn checklists need no Bead.

## Documentation and safety contract

- Human-authored English Markdown is authoritative. When retaining or changing it, update its mirror under
  `docs/i18n/zh-CN/<repository path>` with the source path and raw-source SHA-256 in the same change. Exclude
  byte-sensitive Runtime `SKILL.md`, `THIRD_PARTY_NOTICES.md`, and the historical Chinese-only execution checklist.
- Preserve the wiki roles in `docs/README.md`: entry and Package READMEs describe current behavior, Module READMEs own
  local contracts, `CONTEXT.md` owns language and boundaries, `DESIGN.md` owns shared visible-surface rules, ADRs own
  durable trade-offs, and dated research/reports/release notes provide evidence. Update the owning document with changed
  behavior or contracts; record durable decisions there instead of leaving them only in Session history.
- `pi install` remains an explicit maintainer action; Suite code never installs itself. Never commit credentials, auth,
  model stores, Sessions, caches, `.env`, machine state, private absolute paths, or private data.
