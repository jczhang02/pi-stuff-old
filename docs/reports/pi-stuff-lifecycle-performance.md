# Pi Stuff lifecycle performance

> **Historical performance follow-up.** This report keeps the recorded Pi 0.84.2 schema 6 result and the executable
> lifecycle contract. It supported an interim Effect-acceptance decision on 2026-08-31, but it is not current
> mainline certification; the [preregistered 2026-09-01 comparison](./effect-v4-mainline-decision-2026-09-01.md)
> supersedes that adoption conclusion. Current Host identity belongs to the [compatibility guide](../compatibility.md).

## Measurement contract

Each sample starts a real fullscreen Pi process with isolated Settings, home, cache, and Session directories. A local
deterministic Provider keeps the run offline and credential-free.

| Dimension | Required coverage |
| --- | --- |
| Variants | Host fixture alone; Pi Stuff plus the same fixture |
| Sessions | `fresh`, `resume-short`, `resume-long`, `degraded` |
| Actions | `exit`, `ctrl-c`, `reload`, `reload-change`, `prompt`, `background-exit`, `agent-exit` |
| Terminals | 100×32 and 64×28 |
| Sampling | one warmup and at least three measured samples per normal cell |
| Long history | at least 6,000 retained Tool results of at least 8,192 bytes each |
| Verification | lifecycle trace, terminal restoration, valid Session JSONL, prompt markers, and child-process settling |

Run the certifying matrix with:

```bash
bun run benchmark:lifecycle --output .artifacts/lifecycle-benchmark/final.json
```

The command rejects missing coverage and p95 budget violations. An initially over-budget cell receives one independent
confirmation batch with the same warmup and sample counts. Both batches remain in the JSON; the cell fails only if it
exceeds the same absolute or paired Host-overhead budget again. Direct script invocations are non-certifying.

The executable contract lives in [`benchmark-lifecycle.ts`](../../scripts/benchmark-lifecycle.ts) and its
[tests](../../tests/unit/repository/lifecycle-benchmark.test.ts).

## Recorded schema 6 result

The original JSON was stored at `.artifacts/lifecycle-benchmark/ps-9t2-1-4-final.json` and is not tracked. This report
retains its result digest: 292 isolated Pi 0.84.2 processes, 6,500 retained 8 KiB Tool results,
`acceptance.passed: true`, no findings, and no confirmation cells.

| Suite p95 across both terminal sizes | Recorded range |
| --- | ---: |
| 6,500-Tool reload | 1,997.18–2,053.80 ms |
| First deterministic response | 465.75–488.09 ms |
| Second response in the same process | 54.53–68.28 ms |
| Active Background Shell shutdown | 198.84–201.99 ms |

## Current schema 6 budgets

The benchmark enforces these p95 ceilings:

| Measurement | Ordinary / long-Session budget |
| --- | ---: |
| Configured or degraded Suite startup | ≤ 2,700 ms |
| Long-Session Suite startup | ≤ 12,000 ms and ≤ paired Host + 2,250 ms |
| Other Suite startup overhead | ≤ paired Host + 2,250 ms |
| First input acknowledgment | ≤ 50 ms |
| First Provider boundary | ≤ 800 / 2,300 ms |
| First deterministic response | ≤ 1,100 / 2,600 ms |
| Same-process input acknowledgment | ≤ 15 ms |
| Same-process Provider boundary | ≤ 100 / 350 ms |
| Same-process deterministic response | ≤ 150 / 550 ms |
| Normal exit | ≤ 150 / 550 ms |
| Ctrl-C | ≤ 250 / 550 ms |
| Unchanged reload | ≤ 200 / 2,500 ms |
| Active Background Shell or Agent shutdown | ≤ 250 / 375 ms |
| Agent interrupt | ≤ 1,000 ms |
| Source-changing reload | ≤ 8,000 ms |

The larger startup ceiling allows configured Context initialization before editor readiness. It does not authorize
configuration creation or migration. Historical `ps-5bw` diagnosis, schema 5 measurements, and superseded budgets are
available in Git history rather than repeated here.
