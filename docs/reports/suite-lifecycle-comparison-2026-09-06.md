# Paired Suite lifecycle resource measurements

Six lifecycle workloads used less CPU with the `b0a637fc` Package than with the original `6d0507c1` Package on the same
Pi 0.85.0 executable. CPU medians fell 21.4–33.6%, and every candidate CPU measurement was below every corresponding
baseline measurement. All 48 runs, including preconditioning, passed the existing lifecycle functional checks.
This is evidence for startup, ordinary prompting, unchanged reload and idle shutdown; it is not whole-Suite closure.

The [numeric record](suite-lifecycle-comparison-2026-09-06.json) retains every sample, minima/medians/maxima, full commit
and Package-tree identities, lockfile hashes, and hashes of the private raw reports and reader. The Package dependency
manifest is identical in both trees. The baseline development SDK is 0.84.4 and the candidate SDK is 0.85.0; the current
benchmark/fixture and exact 0.85.0 Host were used for both. No user installation or running Pi changed.

The original baseline also predates Work Continuity, Goal terminal-response changes and the 0.85.0 adaptation.
These totals include those intervening changes and cannot isolate the savings from `ps-yon` optimizations.
The subsequent full-feature comparison uses `40101bb2`, the last pre-optimization Package with those changes already
integrated and the same dependency lockfile as the candidate. The observations below remain valid for their stated trees.

## Comparable runs

Measurements ran sequentially from 17:07:36 to 17:11:13 UTC on 2026-09-06, on an Intel i9-13900H with 20 online logical
CPUs and Linux `6.19.10-jc-xanmod1`. No local tests, agents or other task benchmarks ran concurrently. Ambient machine
activity, CPU frequency and the kernel page cache were not controlled.

The existing `benchmark-lifecycle.ts` ran fresh and resumed-long Sessions at 120×40. Long Sessions contained 240
user/assistant turns and 1,000 historical Tool results, each with 4,096 payload bytes. Each variant/cell had one retained
preconditioning run and three measured runs. Batch order was baseline/candidate, candidate/baseline,
baseline/candidate, candidate/baseline. Every sample started a new Pi process with private configuration and empty
process-local Suite caches inside user/network/PID namespaces. Reload reused that process's import cache.

The prompt action completed first and repeated prompts. Reload issued `/reload`, then verified another prompt through
the Suite surface. Double Ctrl-C exited from the idle editor; it did not test cancellation of an active Agent.
The existing verifier checked Session durability, historical payload markers and restored terminal settings after exit.

| Session / action | CPU median, seconds: baseline → candidate | Waited-Pi maxRSS median, decimal MB: baseline → candidate |
| --- | ---: | ---: |
| Fresh / prompt | 4.913 → 3.469 | 994.402 → 790.553 |
| Fresh / reload | 5.456 → 3.965 | 1,034.322 → 863.326 |
| Fresh / double Ctrl-C | 4.305 → 2.857 | 839.881 → 713.724 |
| Long / prompt | 6.388 → 4.843 | 1,035.514 → 878.858 |
| Long / reload | 8.295 → 6.519 | 976.396 → 880.329 |
| Long / double Ctrl-C | 6.281 → 4.701 | 998.724 → 831.869 |

Median startup-to-editor time was 3.881–3.969 seconds for fresh baseline runs and 2.537–2.718 seconds for candidates;
long-Session medians were 4.743–4.816 and 3.405–3.416 seconds. Accounted output operations were identical between variants
for every measured cell. Input-operation counts varied; they do not support a storage-I/O saving claim.

## Boundary and failed probes

An external Bun 1.4.0 reader inherited the terminal descriptors, spawned the certified Pi, waited for its exit and read
`child.resourceUsage()`. Pi remained on embedded Bun 1.3.14. A temporary one-line fixture change inserted the reader;
removal restored fixture SHA-256 `6b63259cb4d78429de8311bf8d49fec01fb84d834fad1872f9f1e6c7e5799144`.
The reader itself and Expect are outside the reported CPU boundary. The
[Bun API](https://bun.sh/docs/runtime/child-process#resource-usage) reports CPU in microseconds and maxRSS in bytes;
[Linux waited-child accounting](https://man7.org/linux/man-pages/man2/getrusage.2.html) can include waited descendants.
maxRSS is not aggregate peak process-tree RSS, filesystem counters are operations rather than bytes, and context
switches are not scheduler wakeups. Lifetime includes fixture interaction waits and reader spawn overhead.

The first probe loaded successfully but its process-exit callback produced no Suite resource file. Its six functional
runs therefore supplied no resource evidence. The replacement reader initially serialized the native statistics object
as `{}`; its six functional runs were also excluded. Explicitly extracting the numeric fields fixed collection. Both
failed attempts remain in the private evidence directory; neither was counted as a measured or preconditioning batch.

Both variants used the same offline fixture. Context stayed enabled, but dreamer, embeddings, sidekick and Context Todo
services were disabled by that fixture. Automatic Naming/Usage and active remote services were not certified here.
No continuous Spinner observer, allocation/GC counter, wakeup trace or active recovery workload ran in these samples.
The lifecycle benchmark's separate acceptance/confirmation policy was not requested and does not replace the frozen
single-event gates. Full-function Agent/Context measurements and the remaining bounds stay open in the
[resource inventory](suite-resource-inventory-2026-09-05.md).
