# Session Naming

[Simplified Chinese](../../../../docs/i18n/zh-CN/packages/pi-stuff/src/session-naming/README.md)

Short, searchable Session names generated after direct user work settles.

<p align="center">
  <a href="../../../../docs/assets/readme/capabilities/session-naming.png">
    <img src="../../../../docs/assets/readme/capabilities/session-naming.png" alt="Automatic Session Naming controls in Pi" width="100%">
  </a>
  <br>
  <em>Session Naming controls automatic names, cooldown, and model choice.</em>
</p>

## Quick start

```text
/autoname
/autoname settings
```

`/autoname` renames the current Session now. `/autoname settings` controls automatic naming, cooldown, manual-name
policy, and the primary naming model.

## Highlights

- Names an unnamed Session after its first settled user run.
- Refreshes eligible names on a configurable cooldown.
- Keeps manual names when that preference is enabled.
- Routes through a fixed model, the active Session model, and optional fallbacks.
- Produces bounded two-to-four-word English names.
- Uses bounded, redacted conversation text without Tools.

Message selection walks backward only until it finds the six most recent user/assistant messages, then restores
chronological order. The first short exchange still requires a user followed by an assistant. No history cache is
retained; [measurements](../../../../docs/reports/history-selection-cost-2026-09-06.md) distinguish selector cost from
Host branch construction and naming-model work.

## Documentation

- [Session Naming guide](../../../../docs/capabilities/session-naming.md)
- [Settings reference](../../../../docs/reference/settings.md#sessionnaming)
- [Command reference](../../../../docs/reference/commands.md#sessions-and-side-questions)
- [Troubleshooting](../../../../docs/troubleshooting.md)
