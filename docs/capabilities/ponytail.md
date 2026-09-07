# Ponytail

[Simplified Chinese](../i18n/zh-CN/docs/capabilities/ponytail.md)

Ponytail adds Session-scoped guidance that pushes coding work toward the smallest adequate solution.

## Quick start

```text
/ponytail
/ponytail lite
/ponytail off
/ponytail-review
/ponytail-help
```

Bare `/ponytail` opens the control dialog. The default mode is `full`.

## Modes

| Mode | Behavior |
| --- | --- |
| `off` | Adds no Ponytail prompt instructions or model-visible Ponytail Skill catalog |
| `lite` | Suggests a smaller alternative without enforcing the full ladder |
| `full` | Applies the standard library/native-first ladder; default |
| `ultra` | Applies the strictest YAGNI and deletion-first policy |

`/ponytail on` activates the configured default. `/ponytail off` deactivates the current Session. A direct user message
containing only `stop ponytail` or `normal mode` also turns it off.

## Commands

| Command | Action |
| --- | --- |
| `/ponytail <off|lite|full|ultra>` | Change the current Session mode |
| `/ponytail default <lite|full|ultra>` | Set the mode used by `on` |
| `/ponytail status <show|hide>` | Control the Statusline identity |
| `/ponytail startup <show|quiet>` | Control the startup notice |
| `/ponytail-review` | Review current changes for unnecessary complexity |
| `/ponytail-audit` | Audit the repository for avoidable complexity |
| `/ponytail-debt` | List tracked `ponytail:` deferrals |
| `/ponytail-gain` | Show the published impact card |
| `/ponytail-help` | Show the command and mode reference |

## Settings

| Field | Default | Environment override |
| --- | --- | --- |
| `defaultMode` | `full` | `PONYTAIL_DEFAULT_MODE` |
| `hideStatus` | `false` | `PONYTAIL_HIDE_STATUS` |
| `quietStartup` | `false` | `PONYTAIL_QUIET_STARTUP` |

Effective settings are resolved from environment values, the `ponytail` namespace in
`<agentDir>/pi-stuff.json`, a read-only legacy configuration when the namespace is absent, then defaults.

The dialog writes only the merged Pi Stuff settings. Environment overrides remain effective for the current process.

## Prompt and Skills

An active mode contributes one compact policy block and a filtered catalog of six Ponytail Skills. `off` contributes
neither.

The six bundled Skills are explicit-only in native discovery:

- `ponytail` for the full policy;
- `ponytail-review` for the current diff;
- `ponytail-audit` for a whole-repository audit;
- `ponytail-debt` for tracked deferrals;
- `ponytail-gain` for the impact card;
- `ponytail-help` for the reference card.

Explicit `/skill:<name>` invocation remains available in every mode.

## Session and Agent scope

Mode changes are stored in the current Session branch and restore from the newest valid entry. A child Agent receives
the parent's effective mode as a launch snapshot; this does not change global settings.

The Statusline shows `󱖿 <mode>` unless mode is `off` or status is hidden. The optional startup notice reads
`Ponytail active · <mode> mode`. Agent activity remains on Pi's native working indicator in the editor border.

## See also

- [Ponytail Module README](../../packages/pi-stuff/src/ponytail/README.md)
- [Command reference](../reference/commands.md#ponytail)
- [Settings reference](../reference/settings.md#ponytail)
- [Upstream references](../../packages/pi-stuff/src/ponytail/UPSTREAM.md)

