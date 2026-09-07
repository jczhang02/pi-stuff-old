# Contributing

## Before starting

Follow the task-specific reading and engineering boundaries in [AGENTS.md](../AGENTS.md). Use Beads for accepted
shared work under the [issue-tracker contract](../docs/agents/issue-tracker.md); external requests are adopted by a
maintainer first.

## Development

Use the repository's pinned Bun version and [verification policy](../docs/code-quality.md#risk-based-verification),
including its documentation-only path and reuse of required CI evidence for the same revision. Ordinary automated
tests stay offline and credential-free; live Provider or external-Service acceptance requires explicit selection.

For local work, use `bun run check` for Static Checks, `bun run test` for offline Tests, and `bun run verify` for the
read-only Plan/Checks/selected-Tests workflow. See the [quality-assurance guide](../docs/quality-assurance.md) for
scope, source-install evidence, and migration status.

## Package changes

Pi Stuff has one private local Package. Capability Modules are not independently versioned or published. When behavior
needs a durable user-facing record, update `docs/releases/`. For Suite composition changes, edit
`packages/pi-stuff/suite.json` and run `bun run suite:generate`. Verify source installation with the applicable
Acceptance test, `tests/acceptance/repository/source-install.test.ts`; there is no registry publication or Changesets
workflow.

## Commits

Use signed Conventional Commits:

```text
<type>(<scope>): <imperative subject>
```

Maintainers may push verified commits to `main`. External contributions use a pull request for delivery and review;
accepted scope and status remain in Beads under the [issue-tracker contract](../docs/agents/issue-tracker.md).
Force-pushing and deleting `main` are prohibited.
