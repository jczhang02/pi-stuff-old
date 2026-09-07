# Code Mode

[Simplified Chinese](../../../../docs/i18n/zh-CN/packages/pi-stuff/src/code-mode/README.md)

JavaScript composition of active Pi Stuff Tools inside an isolated V8 host.

<p align="center">
  <a href="../../../../docs/assets/readme/capabilities/code-mode.png">
    <img src="../../../../docs/assets/readme/capabilities/code-mode.png" alt="Code Mode project controls and local catalog" width="100%">
  </a>
  <br>
  <em>Code Mode exposes project policy and its local operation catalog in one control surface.</em>
</p>

## Quick start

```text
/codemode on
```

The model can then discover the local catalog and call `tools.*` from `codemode({ code })`. Open `/codemode` to inspect
the effective policy, catalog, approvals, and Session ledger.

## Highlights

- Resolves trusted-project, global, process, and child-Agent policy explicitly.
- Keeps direct Node, filesystem, process, network, module, and credential access out of the sandbox.
- Preserves each nested Tool's validation, permissions, lifecycle, renderer, and media behavior.
- Keeps bounded Tool Discovery callable, or explicitly requires `codemode.describe` instead of exposing an incomplete
  signature.
- Records stable execution and nested-call IDs in the append-only Session ledger without turning retained bytes into a work quota.
- Folds only new Session entries during normal branch progress and rebuilds from Pi on branch divergence.
- Selects each cold Ledger event's declared kind before cleaning and validation. One TypeBox clone retains unsafe-key
  filtering and Host record isolation without retrying unrelated event schemas.
- Restores validated scalar results without a second JSON roundtrip. Object and array results retain storage-codec decoding.
- Treats post-effect serialization or persistence failure as incomplete, blocking later nested calls and automatic replay.
- Supports durable approval, replay policy, rollback, checkpoints, and saved snippets.
- Installs and verifies the pinned V8 helper only on first explicit execution.

## Documentation

- [Code Mode guide](../../../../docs/capabilities/code-mode.md)
- [Command reference](../../../../docs/reference/commands.md#code-mode)
- [Settings reference](../../../../docs/reference/settings.md#codemode)
- [Troubleshooting](../../../../docs/troubleshooting.md#codex-and-code-mode)
- [Upstream references](UPSTREAM.md)
