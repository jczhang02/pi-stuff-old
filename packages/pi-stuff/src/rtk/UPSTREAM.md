# Upstream provenance

This module contains source derived from the pinned MIT-licensed `pi-rtk-optimizer` 0.9.0 snapshot.

| Field | Value |
| --- | --- |
| Upstream repository | `https://github.com/MasuRii/pi-rtk-optimizer` |
| Owned fork | `https://github.com/jczhang02/pi-rtk-optimizer` |
| Release tag | `v0.9.0` |
| Source commit | `d155d253cb2f1358e34e717d47a82ebccb08cb8e` |
| Source Git tree | `6ce01843a6b3edb7e63c8547d411387ec5ee8e04` |
| Owned provenance commit | `489bf5f3c7ce619071c00fb0275cd4123e52a439` |
| License | MIT, Copyright (c) 2026 MasuRii |
| License SHA-256 | `7d9473dcd84975a7191bc13dcc744f3b4d6578c937c879cc73e31e0107fa4d46` |
| npm archive SHA-1 | `f43bec4bc7385b8c045266abf95c6f87bfb5ea95` |
| npm archive SHA-256 | `4f7c6d98ed90a999deee7b5a4f8315bd0fd17f99d21022b0d0b64f77bc11d3c8` |
| npm integrity | `sha512-yj5DEdutRco5WvYEMEO0krZJP5Z6CpuNZoxlXSGmHEi2srB5Gao1xah/RnmVDn2se1FcqlmtS8+K/nzzkq0Pug==` |

The upstream `LICENSE` is preserved byte-for-byte. Files under `upstream/techniques/` retain the pinned algorithms but
are maintained as Repository-owned Source under Pi Stuff's formatter, lint, and strict TypeScript baseline.

## Pinned upstream technique SHA-256

| File | SHA-256 |
| --- | --- |
| `ansi.ts` | `95f36fab801338a849bab6ea3131f7e22ed630a341f62b4d5c5c75967558b28e` |
| `build.ts` | `0d61121a9d5d9dac5672ffab7a58dc29d21eb101e858e5ccfff3036fc1e5cbd1` |
| `command-detection.ts` | `677daa210328058bc63c540733077b37bb52c7f492cbc3d931747de5bc727fd4` |
| `git.ts` | `04fa0348934f1da5c76c312fea5c6bbec5d5b87087e4807ae841daa9c8c71abe` |
| `index.ts` | `f5bd633431d437b5e360c8811d2e15e6f8039fa4d570515d3e46b120be110b65` |
| `linter.ts` | `b65329f4b0010ebd0f3e2862fce7d11b5f84a7a4af51b519c5960d11a24687b4` |
| `path-utils.ts` | `f5b43486a1d5657650f10a8b9fe7ae266a9b7823922dc8ae4e0a43e04f572c9f` |
| `search.ts` | `9e97ee0de833ecb8f7c740ecd996e5d755c933792477dd7b75a92556decdb9d5` |
| `source.ts` | `a06a884bebccfca099b5d208bdee9af7c4298b2cadf8ab79ea6f09f760e9d9ad` |
| `test-output.ts` | `858b5a73b59738981a9b14c643de60a3e730b2ee73da17f6c67e59249e54ec33` |
| `truncate.ts` | `9e532d4c450e58ba94a1d5b3ff47e219879935b7c742d04b7302967d86670ad4` |

## External RTK runtime certification

The optional executable is not bundled or automatically installed. The supported Linux x64 profile uses RTK
`v0.45.0`, including local source builds and PATH shims that pass version and real-behavior verification. Fixed
executable hashes are not compatibility admission gates. The official release from source commit
`b34be37caf3796b69a50952a28e60e32b5daad43` remains CI download provenance:

| Build | SHA-256 |
| --- | --- |
| Official `rtk-x86_64-unknown-linux-musl.tar.gz` archive | `c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4` |
| Official archive's `rtk` binary | `99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535` |

## Pi Stuff delta

- Keeps only the upstream pure compaction algorithms behind a Suite-owned projection adapter.
- Formats and strictly types the retained algorithms without weakening their output contracts.
- Replaces upstream `tool_result` mutation with Pi's model-visible `context` seam so transcript and session JSONL remain raw.
- Keeps `read` and source projection disabled; failed results and non-text blocks always remain exact.
- Replaces upstream config modal, notifications, Statusline metrics, startup config creation, shell hook assumptions,
  and lifecycle with one interactive `/rtk` control surface in the shared non-floating Command Dialog.
- Verifies installed RTK 0.45.0 by version and real behavior. Runtime identity checks compare the selected local
  executable with its own verified state, not a published hash; path, binary, timeout, or availability drift fails open.
- Delegates the complete rewrite registry to RTK. Official v0.45.0 still rejects compound `find` predicates and
  actions; Pi Stuff documents that constraint instead of adding a command parser or fork.
- Exposes one small `ContextProjectionAdapter` for composition with the Suite Context Capability.
- Does not contain or derive from implementation code in `jczhang02/pi-agent`; that repository supplied behavior evidence only.

The source is absorbed into Pi Stuff and has no independent Package or release lifecycle. Future upstream
incorporations must update every identity and mirrored checksum above, preserve the upstream MIT notice, and re-run
real Host and local RTK certification.
