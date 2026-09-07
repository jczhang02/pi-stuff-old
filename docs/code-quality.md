# Repository-owned Source quality

All tracked Pi Stuff code is Repository-owned Source, regardless of whether it is local, forked, vendored, upstream-
derived, generated, a test, prototype, script, or quality tool. Provenance affects attribution and licensing, never
quality exemptions. Machine state, caches, worktrees, build artifacts, binary assets, and prose are outside code checks.

## Required standard

- Every tracked code directory participates in Biome, Oxlint with anti-slop rules, applicable strict TypeScript, and
  unused-file/dependency analysis. Profiles may differ only for runtime library, module-resolution, or target needs;
  shared strictness, unused-code, indexed-access, optional-property, override, side-effect, and erasable-syntax rules
  remain enabled.
- If Effect is a direct dependency, use `effect/<Module>` public subpaths. The root barrel is denied. The Effect
  constructor rule and repository-safety boundary inventory govern service constructors, runners, and native effects;
  each inventory entry is an exact existing Source path, with no duplicates or missing paths.
- Formatted hand-maintained files should normally be 200–400 physical lines. More than 500 requires a cohesion review;
  800 is the merge limit. Functions should normally be 20–50 lines, require review above 80, and never exceed 120.
  `check:repository` enforces the file and function limits across tracked and non-ignored untracked code.
- A split must reduce responsibilities, mutable state, branching, or concepts held at once. Moving unchanged
  complexity into mechanical fragments fails this standard. Report before-and-after physical line counts for quality
  work; investigate unexplained growth and prefer deletion. Size is evidence, not an acceptance quota.
- Tests establish behavior and compatibility. Passing tests does not replace source review.

## Risk-based verification

- Pure documentation changes need the documentation mirror/SHA check and relevant focused checks; they do not require a
  full code check. Code changes use focused Tests plus `bun run check` during development; `bun run verify` combines
  read-only Static Checks with conservatively selected offline Tests.
- For PR or release readiness, required CI checks on the same revision are authoritative; reuse their results rather
  than repeating the full suite locally. Run the full check when impact is unknown or CI cannot cover the affected path.
- Public interfaces and releases require representative real-Host evidence; mocks cannot certify them. Keep acceptance
  evidence separate from benchmarks and aggregate Suite evaluations.
- For failed checks, reuse recorded diagnoses and investigate the smallest failing scenario. Distinguish product,
  test, and environment faults; an unexplained passing retry does not resolve an intermittent failure. Keep blocked
  acceptance explicit while completing independent work in scope.

## Thermo-Nuclear completion review

- Review the complete diff from a fixed base and the complete affected Capability with `thermo-nuclear-code-quality-review`.
  If unavailable, apply this standard directly. Approval requires no structural regression, clear simplification
  left undone, ad hoc branch or boundary leak, unnecessary wrapper/cast/optionality/helper, or unjustified size growth.
  Inspect ownership, state, coupling, type boundaries, canonical placement, and atomicity.
- One complete relevant-scope review is required for every code change. If it finds an issue, fix it and review the
  change plus affected scope again. Expand the scope only when the fix introduces new risk. A clean result applies only
  to the exact source reviewed, so later changes require review again.
- Cross-Capability and architecture changes require independent review. Review instruction and workflow changes for
  conflicting requirements and completion criteria; static checks cannot establish their behavioral effect.
