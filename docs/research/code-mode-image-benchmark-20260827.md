# Code Mode image benchmark preregistration

Date: 2026-08-27

The V1/V2 sections preserve their original preregistration and outcomes. The retired runner advanced only through the
separately preregistered V3 Luna study below; Git history retains the exact V1/V2 runner.

This document freezes the real-model benchmark before any benchmark outcome is observed. Its retired runner was
[`scripts/benchmark-code-mode-image.ts`](https://github.com/jczhang02/pi-stuff/blob/4e517e771b54489eee3c57d0ec696bc312d945c9/scripts/benchmark-code-mode-image.ts), and its Provider-boundary observer was
[`test/fixtures/code-mode-image-benchmark-observer.ts`](https://github.com/jczhang02/pi-stuff/blob/4e517e771b54489eee3c57d0ec696bc312d945c9/test/fixtures/code-mode-image-benchmark-observer.ts).

## Question and immutable inputs

The benchmark asks whether the Code Mode image compatibility and discovery patch improves successful image handling
without allowing damaged images or increasing standing Provider context.

- Host: certified Pi 0.84.3 release artifact.
- Provider/model: `openai-codex/gpt-5.6-sol`, medium Thinking, image input enabled.
- Baseline Package commit/tree: `65b676474cc73411b62bf2cab1c910e2e359a6b9` /
  `24cab67c6893732155ad113747b7f8830335d5c9`.
- Candidate Package commit/tree: `4487a063d1e2693e00e5fbe12ff523366d670baa` /
  `480dcad7f133d4eee1d13ed243620b3111561a96`.
- Prompt: “Inspect challenge.png with the available image Tool. Reply with exactly the six digits shown and nothing
  else. Do not use shell commands or encode the file as text.”
- Resume prompt: “Reply exactly SESSION_SAFE”.
- Twenty fixed six-digit fixtures per arm, in this order: `731905`, `284167`, `609352`, `418730`, `952641`,
  `367824`, `805219`, `146593`, `573086`, `920475`, `238761`, `694028`, `351972`, `782436`,
  `469105`, `817354`, `205687`, `936412`, `542809`, `173648`.
- Pair order alternates: candidate then baseline for odd-numbered fixtures, baseline then candidate for even-numbered
  fixtures.

Each fixture is rendered by the checked-in deterministic grayscale PNG generator. Every run gets a fresh project,
Session directory, temporary directory, runtime directory, and Session ID. Context files, prompt templates, discovered
Extensions, and discovered Skills are disabled. Ponytail is set to `off`; inherited child-Agent and frozen Code Mode
environment values are cleared. Code Mode is enabled by project settings. Runs are sequential to avoid concurrency and
rate-limit asymmetry.

There are 40 independent primary Sessions: 20 baseline and 20 candidate. Tool use and the mandatory resume check can
produce more than one Provider request per Session; the report records the actual request count. No run is retried,
replaced, or excluded. An instrumentation, process, Provider, parsing, or resume failure counts as a failed sample.

## Measures and gates

For each Session, the runner records these booleans:

1. **Tool choice:** nested Code Mode operations contain `view_image`, contain neither `read` nor `bash`, and the
   Code Mode program does not call the explicit `image(...)` helper.
2. **Exact transfer:** the complete Provider payload is traversed in memory; every observed image is canonical PNG, and
   at least one image has the same SHA-256 as the fixture file.
3. **Understanding:** the first final answer is exactly the six fixture digits.
4. **Session safety:** Session JSON contains exactly one decoder-readable image with the fixture SHA-256; a new real Pi
   process resumes that Session, its complete Provider payload contains the same valid image, and the model answers
   exactly `SESSION_SAFE`.
5. **End to end:** instrumentation, Tool choice, exact transfer, understanding, Session safety, and successful Code Mode
   status all pass.

The complete payload is inspected but never archived. The observer archives only payload SHA-256, byte count, traversed
node count, Tool names, Code Mode and total Provider Tool-definition character counts, and image byte/hash/validity metadata. Session and
fixture directories are deleted after the run. The report contains no credentials or machine-specific temporary paths.

Candidate acceptance requires:

- exact transfer: 20/20;
- Session safety and exactly-once image persistence: 20/20;
- no corrupt, truncated, unsupported, or undecodable persisted image: 20/20;
- Tool choice: at least 18/20;
- understanding: at least 18/20;
- end to end: at least 18/20;
- every candidate sample has valid instrumentation and no Code Mode error;
- candidate total Provider Tool-definition size is no greater than baseline.

The report gives raw fractions and Wilson score 95% binomial intervals for both arms. The baseline is descriptive and is
not subject to candidate acceptance thresholds. Separate matched real Pi Host screenshots compare Code Mode's nested
`view_image` row with a direct `view_image` invocation; this behavioral benchmark does not infer pixels from model
text or PTY strings. A Claude Code comparison is outside this acceptance scope.

Run from the candidate worktree with a baseline repository root that still has the preregistered Package tree:

```sh
PI_BIN=<absolute-certified-pi-release> \
bun run benchmark:code-mode-image --baseline-root <absolute-baseline-root> --output <absolute-report-path>
```

## Pre-outcome clarification

Recorded at 2026-08-26T01:17:43Z after the runner started and before any run output, log, or outcome was inspected:
`--no-skills` disables ordinary discovered Skills, but Pi 0.84.3 can still expose Skills declared by the explicitly loaded
Pi Stuff Package. Ponytail's standing contribution remains `off`; the Package-declared Skill catalog is the same in both
arms and is part of the real installed-Package target surface. No benchmark input, ordering, measure, threshold, or
failure policy changed.

Recorded at 2026-08-26T01:22:25Z before any benchmark Session or Provider request: the first command invocation stopped
inside the mandatory Host-provenance preflight because `PI_BIN` selected a non-release local build. It produced zero
samples and no model outcome. The certified v0.84.3 Linux x64 release artifact was then downloaded from the
preregistered official release and verified as 104,487,040 bytes with SHA-256
`ca858fde375ab91531353b22fac6ebdf29c0a153efe754f5f9b8a72a7423ed08`. Supplying that artifact through `PI_BIN`
starts the first and only sample set; this preflight correction does not retry or replace a sample.

## V1 outcome and V2 preregistration

V1 completed before 2026-08-26T01:56:02Z and is retained verbatim as
`docs/reports/code-mode-image-20260827/benchmark-v1.json`. It failed its preregistered verdict. The baseline produced
20/20 exact transfers, 18/20 correct readings, and 20 Code Mode envelope errors. The candidate produced 19/20 exact
transfers, 16/20 correct readings, zero Code Mode envelope errors, and a valid, decoder-readable image in every image
and resume Provider payload for the 19 runs that used an image Tool. Nineteen candidate runs selected `view_image`,
but 18 of those still called the compatibility form `image(result)`; only one met the preregistered direct-return Tool
choice. One candidate run made no Tool call. No observed Provider payload contained a malformed, truncated, or
undecodable image.

V1 cannot certify the change for three independent reasons discovered from its archived evidence:

1. Its two arms reused the same 20 generated PNGs, violating the accepted requirement for 40 distinct challenge
   images.
2. Its Session counter traversed custom UI event copies as well as persisted Provider-message entries, so the
   `imagePersistedOnce` hard gate was invalid even though the resume Provider payload contained one valid image.
3. Every candidate OCR miss involved the generated zero glyph, which was visibly ambiguous; the behavioral fixture did
   not isolate image transport from glyph quality.

V2 is a new benchmark, not a retry or replacement of any V1 sample. It retains every V1 run and result, uses no V1
outcome as a V2 exclusion, and keeps the same Host, model, prompts, 20 Sessions per arm, deterministic interleaving,
thresholds, no-retry rule, no-exclusion rule, complete Provider-payload observer, and hard image-integrity gates. Before
any V2 run or outcome:

- candidate Package commit is `7a3e753975cf54bfa6e2f3ee99e5242de5f8a731` with tree
  `ddc5e95dd6817abac6c131d36a6b5eb7d0497a4a`;
- baseline remains `65b676474cc73411b62bf2cab1c910e2e359a6b9` with Package tree
  `24cab67c6893732155ad113747b7f8830335d5c9`;
- the candidate standing rule now names the exact forbidden compatibility call, `image(result)`, while remaining no
  larger than the baseline Provider Tool surface;
- the two arms use separate preregistered code lists whose 40 PNG hashes are all distinct;
- the zero glyph is hollow and unambiguous, and all 40 PNGs pass the real decoder before execution;
- Session persistence counts only image blocks under durable `message` entries; custom UI event copies remain
  observable Session diagnostics but are not Provider conversation history;
- the V2 report path is `docs/reports/code-mode-image-20260827/benchmark-v2.json`.

V2 remains a failure if any candidate Session is retried or replaced, any candidate Provider image is malformed,
truncated, undecodable, or hash-mismatched, any candidate durable Provider message persists other than exactly one
challenge image, any resumed payload fails image validation, or any original acceptance threshold is missed.

## V2 certified outcome

V2 completed at 2026-08-26T02:18:36.030Z on the certified Pi 0.84.3 artifact and passed every preregistered gate.
The complete sanitized report is `docs/reports/code-mode-image-20260827/benchmark-v2.json`.

| Measure | Baseline | Candidate | Candidate gate |
| --- | ---: | ---: | ---: |
| Activated `view_image` and returned its result directly | 0/20 | 20/20 | at least 18/20 |
| Challenge bytes reached the Provider exactly | 20/20 | 20/20 | 20/20 |
| Model read the challenge correctly | 19/20 | 20/20 | at least 18/20 |
| End to end | 0/20 | 20/20 | at least 18/20 |
| Safe after Session resume | 20/20 | 20/20 | 20/20 |
| Code Mode envelope errors | 20 | 0 | 0 |

The 20/20 candidate proportions have Wilson 95% intervals of [0.8389, 1.0000]. All 40 challenge PNG hashes were
distinct and decoder-readable. Every candidate durable Provider message contained exactly one valid challenge image,
every image and resumed Provider payload preserved its exact SHA-256, and no malformed, truncated, undecodable, or
extra image was observed. All candidate runs used nested `view_image`; none called `image(result)`, timed out, was
retried, was replaced, or failed instrumentation.

The complete candidate Provider Tool surface was 2,135 characters, including a 1,728-character Code Mode definition,
versus 2,177 and 1,748 respectively for the baseline. The standing Provider context therefore decreased by 42
characters overall and 20 characters for Code Mode while adding the direct-return rule. V1 remains archived as a
failed experiment and is not included in these V2 pass counts. Temporary benchmark paths in both archived reports
were replaced with stable placeholders after execution; no outcome, payload hash, metric, or sample was changed. The
sanitized V1 and V2 report SHA-256 values are `3d1807dd304e7582535b5d8752b8f94bb42d7f62c93bf1f61d53e1b22a5b248f`
and `4943cc1296d575f067221333c780bf9e4ca6866d07b1a6fb1a03d9ee1ae93297`, respectively.

## Real Pi View UI acceptance

The visual scope was confirmed after V2: compare Code Mode with Pi's direct `view_image` path; no Claude Code
comparison is required. Two fresh authenticated Sessions on the exact certified Pi 0.84.3 release artifact use the same
decoder-readable PNG. One asks Code Mode to return `tools.view_image`; the other invokes `view_image` directly.

The retained [Code Mode capture](../reports/code-mode-image-20260827/ui/pi-code-mode.png) and
[pixel difference](../reports/code-mode-image-20260827/ui/diff-pi-code-vs-direct.png) came from independent `100 × 32`
tmux Sessions with `extended-keys=on` and `extended-keys-format=csi-u`. Freeze rendered the real ANSI Tool rows rather
than redrawing the UI. Both paths showed one `View pixel.png · loaded` row, the image fallback, and `UI_COMPLETE`;
Code Mode added no outer row.

The direct Session produced the same ANSI, plain-text, and PNG hashes as the retained Code Mode capture. ImageMagick
reported 0 absolute-error pixels across 850,586 pixels at `1886 × 451`. The duplicate direct files were removed from
the current tree and remain recoverable at Git commit `94849d94ac23239d7f522bc3c40feb9b2822e61e`.
[metadata.json](../reports/code-mode-image-20260827/ui/metadata.json) records both hash sets, Host provenance, and the
pixel metric.

The `Image preview unavailable` line is the certified Pi tmux fallback, not a missing Provider image. The benchmark's
complete payload hashes and decoder checks remain the authority for image transfer and Session safety; this matched
capture verifies the visible Tool authority and layout.

## V3 Luna preregistration

Recorded at 2026-08-29T09:53:12+08:00 before any V3 Provider request or outcome. V3 certifies the final `ps-8z1`
Package tree with the specification's selected `openai-codex/gpt-5.6-luna` configuration and medium Thinking. It is a
new study, not a retry or replacement of V1 or V2.

V3 retains the V2 Host, observer, prompt, resume prompt, 20 Sessions per arm, 40 distinct fixed challenge codes,
alternating pair order, isolated fresh projects and Sessions, sequential execution, measures, thresholds, complete
Provider-payload validation, and no-retry/no-replacement/no-exclusion rules. The immutable Package inputs are:

- baseline commit/tree: `65b676474cc73411b62bf2cab1c910e2e359a6b9` /
  `24cab67c6893732155ad113747b7f8830335d5c9`;
- candidate commit/tree: `59742b386c8926cb8db05a8c2fd50e41a8692624` /
  `f8fa74268f41ac0877ded9eb650dd39d9a8334e4`.

The output path is `docs/reports/code-mode-image-20260827/benchmark-v3-luna.json`. Any process, Provider,
instrumentation, parsing, image-integrity, or resume failure counts as the original sample's failure. No V3 Session may
be retried, replaced, or omitted after an outcome is observed.

## V3 Luna outcome

V3 completed at 2026-08-29T02:05:26.143Z and failed its preregistered verdict. The complete, content-preserving
repository-formatted report is
`docs/reports/code-mode-image-20260827/benchmark-v3-luna.json`, SHA-256
`c2ba372ebc494f642e187cac46a1c1a3a0fe303915fb1223a3dcd875dbe4ab1e`.

The candidate achieved 20/20 direct `view_image` Tool choice, exact image transfer, exactly-once decoder-readable
persistence, safe new-process Session resume, valid instrumentation, and zero Code Mode errors. Luna read 15/20 small
304×80 point-matrix images exactly, below the 18/20 behavioral gate; each miss was a one-digit substitution after the
correct image bytes had reached the Provider. The baseline Package exited before every Provider request because its
fresh worktree had no installed dependencies, so its 20 failures remain in V3 and the standing-context comparison is
invalid. No V3 sample was retried, replaced, or excluded.

## V4 Luna preregistration

Recorded at 2026-08-29T10:07:45+08:00 before any V4 Provider request or outcome. V4 is a new study, not a retry or
replacement of V3. It retains the certified Host, `openai-codex/gpt-5.6-luna` with medium Thinking, Package trees,
observer, prompts, 20 Sessions per arm, alternating order, isolation, sequential execution, measures, thresholds,
complete-payload validation, and no-retry/no-replacement/no-exclusion rules.

V4 uses 40 new fixed six-digit codes, in runner order:

- baseline: `274906`, `581347`, `630285`, `947120`, `362748`, `715903`, `489261`, `826570`, `193684`, `504739`,
  `768312`, `250967`, `913475`, `647208`, `385621`, `729046`, `156830`, `894572`, `431709`, `570284`;
- candidate: `682930`, `145782`, `907463`, `358174`, `726591`, `410836`, `839205`, `264718`, `591024`, `773460`,
  `208675`, `964103`, `537920`, `681254`, `349806`, `812597`, `475130`, `926348`, `103769`, `754682`.

The same deterministic high-contrast glyphs are doubled from 304×80 to 608×160. This isolates the Tool-selection,
transport, persistence, and continuation question from the small Luna model's observed low-resolution digit-reading
errors; the prompt and success thresholds do not change. The baseline worktree has been installed from its frozen
lockfile, and the runner now imports both Package entries before creating a benchmark Session so an unloadable arm
fails before any sample. The output path is `docs/reports/code-mode-image-20260827/benchmark-v4-luna.json`.

## V4 Luna outcome

V4 completed at 2026-08-29T02:31:10.098Z and failed its preregistered overall verdict. The complete,
content-preserving repository-formatted report is
`docs/reports/code-mode-image-20260827/benchmark-v4-luna.json`, SHA-256
`cfd4f754b87ea1537c63439ddbe7cf213d0194f2b6cc8042642e15866d462a2d`. No sample was retried, replaced, excluded,
or run concurrently.

Both arms produced valid instrumentation, exact image transfer, exactly-once decoder-readable Session persistence,
and safe new-process resume in all 20 Sessions. The candidate selected nested `view_image` directly in 20/20 versus
1/20 for the baseline, demonstrating the prompt-steering contribution. Candidate Code Mode errors were 0 versus 16
for the baseline, demonstrating the complete-envelope compatibility invariant. Candidate Provider Tool definitions
were 2,135 characters versus 2,177 for the baseline, so standing context decreased by 42 characters.

Luna read 12/20 candidate images and 16/20 baseline images exactly. Candidate understanding and end-to-end success
therefore missed the unchanged 18/20 behavioral gate even though every candidate Tool-selection, byte-integrity,
persistence, continuation, instrumentation, and Code Mode error gate passed. Doubling the deterministic point-matrix
fixture did not improve Luna's exact digit reading, so the result does not support further outcome-driven fixture
tuning.

## Maintainer acceptance disposition

Recorded on 2026-08-29 after the V4 outcome. The preregistered V4 verdict and report remain unchanged: the study failed
its original understanding and composite end-to-end thresholds. For `ps-8z1` completion, those two rates are retained
as observational model-quality evidence rather than Suite compatibility gates because exact digit recognition is
model behavior after the verified image bytes reach the Provider.

The Suite-controlled compatibility gates remain hard: Tool choice, exact image transfer and integrity, exactly-once
Session persistence, safe new-process resume, valid instrumentation, zero Code Mode errors, and no standing
Provider-context increase. V4 passed each of those gates.
