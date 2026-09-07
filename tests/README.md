# Tests

This directory contains Pi Stuff's verification scenarios, shared fixtures, and pinned benchmark inputs.
See [Quality assurance](../docs/quality-assurance.md) for execution policy and
[Code quality](../docs/code-quality.md) for required checks and review.

## Directory guide

Test files are organized as `<level>/<capability>/<scenario>.test.ts`; Node compatibility scenarios use `.node.ts`.
`repository` groups tests of repository tooling. The five levels describe the boundary each scenario verifies.

| Directory | Purpose |
| --- | --- |
| [`unit/`](unit/) | Individual functions and components with isolated dependencies |
| [`component-integration/`](component-integration/) | Cooperation between components through their declared interfaces |
| [`system/`](system/) | Suite and Host contracts at the system boundary |
| [`system-integration/`](system-integration/) | Integration with local runtimes, tools, and external boundaries |
| [`acceptance/`](acceptance/) | Observable user and Host behavior, including RPC, PTY, and source installation |
| [`fixtures/`](fixtures/) | Shared fixture Providers, data, and assertion helpers |
| [`goal-upstream/`](goal-upstream/) | Goal compatibility support and the Node compilation bridge |
| [`benchmarks/`](benchmarks/) | Pinned public-task inputs, currently the Terminal-Bench 2.1 manifest |

`agents/`, `code-mode/`, `context/`, `tools/`, `ui/`, and `work/` contain shared scenario support. They are not additional
test levels. Put executable tests under the owning level and Capability; reuse support helpers when scenarios share
setup or fixtures.

## Running tests

Run commands from the repository root:

```bash
bun run test --list
bun run test
bun run test --level unit --capability todo
bun run test --level acceptance --file repository/source-install.test.ts
bun run test --level acceptance --capability code-mode --matrix representative
bun run check
bun run verify
```

`bun run test` defaults to the full offline inventory and full Acceptance matrix, with one OS process per file.
Offline scenarios use fixture Providers without credentials or live model calls; some still require installed Pi,
RTK, Node, tmux, or other local tools. `--list` previews requirements without executing scenarios. Missing requirements
fail preflight. Failures stop the remaining files unless `--keep-going` is explicit. Reports go to `.artifacts/tests/`.

For a single Bun-compatible file, `bun test tests/unit/todo/format.test.ts` uses Bun directly. Use the repository
runner for Node compatibility files and scenarios requiring its environment preflight. `check` performs static checks;
`verify` combines them with tests selected from the changed scope.

## Benchmarks

Benchmark inputs live here for organization, but benchmarks remain separate from Tests and CI gates. The runners live
under `scripts/`; use their explicit `benchmark:capability:*` or `benchmark:suite:*` commands. For example:

```bash
bun run benchmark:suite:terminal-bench --list
```

A preview makes no model calls. Executing the Terminal-Bench command starts a live local Harbor evaluation; follow the
[documented protocol](../docs/quality-assurance.md#local-terminal-bench-evaluation). Keep generated results in
ignored `.artifacts/`, not alongside pinned inputs.
