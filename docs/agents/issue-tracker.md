# Issue tracker: Beads with GitHub intake and mirror

Beads is the canonical issue tracker for this repository. GitHub Issues is a public push-only mirror for accepted work and an intake surface for external reports.

All accepted-work creation, updates, dependencies, claiming, and closure begin in Beads. Do not edit a mirrored GitHub issue as the authoritative copy.

## Local operations

- Create: `bd create`
- Read: `bd show <id>`
- List: `bd list`
- Find ready work: `bd ready`
- Claim: `bd update <id> --claim`
- Update: `bd update <id> ...`
- Close: `bd close <id> --reason "..."`
- Add a blocker: `bd dep add <blocked-id> <blocker-id>`
- Inspect dependencies: `bd dep tree <id>` or `bd graph`

Issue IDs use the `ps` prefix.

## Local storage

The local Dolt database is authoritative for Beads commands. The entire `.beads/` workspace is local-only and excluded from Git.

The publish command may refresh a scrubbed local `.beads/issues.jsonl` after syncing accepted work to GitHub Issues. That export is not version-controlled or a full Dolt backup. Beads must not stage, commit, push, or otherwise operate Git, and repository Git hooks are not installed by Beads.

## GitHub mirror

Publish Beads issues explicitly with:

```bash
bun run beads:publish -- <epic-or-bead-id>
```

The command runs from any repository worktree, using the canonical repository's Beads database. It serializes
publishers with an OS lock, previews and performs push-only synchronization, then updates one managed delivery comment
per Issue. The lock is released on process exit, including interruption. It obtains authentication at runtime and never
persists a token. Human comments are preserved; duplicate managed comments or a different publishing identity require
explicit reconciliation rather than deletion or takeover.

The comment contains canonical status, the closure reason when closed, delivery evidence, verified commit and PR links,
actual PR merge state, and incoming/outgoing Beads relationships resolved to GitHub Issue links. Publish related Beads
first if they do not yet have GitHub mirrors. Relationships remain Beads-owned; visible links do not promise GitHub
native dependency or sub-issue fields. A PR must reference the full mirrored Issue URL in its body, which gives readers
a reverse path from the PR to the originating work.

Success requires readback of the exact managed comment and Issue status/title. Repeating publication updates the same
comment, including after reopening or PR merge; unchanged content creates no write. A failed or interrupted request may
have changed GitHub already. Retry the same command after correcting its reported problem; it discovers the existing
comment instead of blindly creating another. Report publication as incomplete until readback succeeds. Never treat
`bd close` or an upstream sync success message alone as complete public delivery.

## Delivery and closure

For accepted durable repository work, including work started through generic implementation skills. Read-only
exploration, discussion, and current-turn checklists do not require tracker mutations:

1. Read and claim the Bead. Keep scope and relationships there. Work in an isolated worktree.
2. Finish the requested outcome and the focused checks and review in [code quality](../code-quality.md), then sign and
   push coherent commits. Reuse the required CI results for that revision instead of rerunning the whole suite locally.
3. For code work, create or update a PR with the problem, resulting behavior, validation, and the full Issue URL.
   Reuse a PR for the branch rather than creating duplicates. A user-requested branch-only delivery may omit a PR,
   but its reason must be recorded. Do not merge merely to complete this workflow.
4. Record the delivery in `metadata.github_delivery`, preserving other metadata. Include the current PR head SHA and
   actual validation, limitations, and remaining work. Keep unverified or failed acceptance explicit.
5. Close in Beads only when its requested acceptance criteria are satisfied, with a substantive `--reason`. A request
   to implement and deliver may close before merge; a request requiring merge stays active until merge is verified.
   Beads completion and GitHub PR merge state are separate facts and must both remain visible.
6. When publication is authorized, run `bun run beads:publish -- <id>` and require verified comment URLs. Return the
   Bead, Issue, PR or branch-only reason, final commit, validation, and merge state. If publication fails, report the
   local and public states separately. After an authorized merge, verify the patch and worktree state, update Beads,
   publish again, and remove only the clean merged worktree.

The delivery object has the following fields:

| Field | Contract |
| --- | --- |
| `kind` | `code` or `no-code` |
| `summary` | Nonempty public outcome, including limitations or remaining work |
| `validation` | Nonempty account of focused checks, review, acceptance limitations, and remaining work; not a substitute for verified CI |
| `commits` | Full lowercase 40-character SHAs; at least one for code, empty for no-code; branch-only lists the final delivery commit last |
| `pull_request` | Optional positive PR number in this repository; code normally requires it |
| `no_pr_reason` | Explicit reason for branch-only code delivery, or why no code/PR was needed |

For example, prepare an ignored JSON file containing the existing metadata plus `github_delivery`, then use
`bd update <id> --metadata @<file.json>`. The publisher rejects malformed metadata, closed Beads without delivery or a
closure reason, missing remote commits, and a PR whose current head is absent from the recorded commits. It reads PR
merge state directly instead of trusting a free-form claim. No-code work must have a reason and no commit/PR references.
Open planning Beads may publish without a delivery record; their comment states that delivery is not yet recorded.

### Verified CI evidence

The publisher checks code delivery before synchronization and again before preparing the delivery comment. It reads
this repository's `.github/workflows/ci.yml` runs for the target SHA, selects the latest eligible run by run number,
and checks jobs from that run's exact attempt. Plan, Checks, and Verify must each have one completed successful result. Tests must have one legacy result or every
uniquely numbered successful shard declared by its job names; mixed, missing, or duplicated shards reject publication.
Only the plain Tests job may be skipped under the successful Verify no-tests decision. Missing, failed, cancelled, or
pending required evidence rejects publication; a free-form validation statement cannot
override it. The managed comment links the verified Actions attempt and names the checks that passed.

- PR delivery targets the current PR head. Pull-request and manual runs are eligible. The publisher verifies the current
  workflow's `Plan`, `Checks`, complete `Tests` shard set, and `Verify` jobs rather than reclassifying paths; `Tests` may be skipped only
  when the successful Plan explicitly requires no tests. An incomplete or stale workflow run blocks publication.
- Branch-only delivery targets the last recorded commit. Push and manual runs are eligible and require the same job roles
  and complete Tests shard set, with the same valid no-tests exception. An untested feature branch needs a manual CI run.
- No-code and open planning records need no CI evidence. Historical code deliveries need retrievable evidence when
  republished; missing history is not success.

These checks certify recorded CI results, not review quality, signatures, branch protection, or permission to merge.
Keep those obligations and any additional real-Host acceptance in the work item's criteria. A successful Plan/Checks/
Tests/Verify aggregate records the workflow result for that revision; it does not replace required real-Host evidence
outside that workflow. Publication still requires exact comment and Issue readback; remote changes are not transactional,
so report partial publication and retry if a later check or write fails.

Historical closed Beads follow the same validation when republished: recover their real public evidence and references
first, and explicitly record branch-only or no-code outcomes where applicable. Do not invent a PR, merged state, or
successful acceptance to make legacy publication pass. Publication covers the selected Bead and its full child tree;
other dependencies are linked, not implicitly published or closed.

## External intake

Bug and feature forms create GitHub intake issues. Triage them on GitHub. When an issue is accepted, a maintainer may perform one targeted adoption:

```bash
bd github pull gh-<number>
```

After adoption, update it in Beads and use push-only sync. This one-time intake operation is the only routine exception to the no-pull rule.

## Skill operations

When a skill says "publish to the issue tracker":

1. Create or update the Beads issue.
2. Add its parent and blocker relationships in Beads.
3. Explicitly publish the relevant issue or epic subtree.
4. Return both the Beads ID and GitHub URL when available.

When a skill says "fetch the relevant ticket", use `bd show <id>`. Treat its GitHub issue as a public mirror.

## Work maps

- A map is a Beads epic.
- Child tickets use the epic as their parent.
- Blocking relationships use Beads dependency edges.
- `bd ready --parent <epic-id>` identifies the executable frontier.
- Claim a ticket before implementation.
- Close it only after its acceptance criteria have been verified.
- Publish the epic subtree to refresh GitHub state.

## Pull requests as a triage surface

PRs are for delivering and reviewing code, not for requesting work or defining its authoritative scope. External
contributors may submit a PR, but a maintainer must adopt accepted scope into Beads before implementation is treated
as repository work. Review comments may refine the patch; Beads retains work-item status, dependencies, and closure.

## Public-data policy

The repository, JSONL export, and GitHub Issues are public. Never put credentials, private paths, private data, unpublished personal information, or sensitive operational details in Beads fields or GitHub issues.
