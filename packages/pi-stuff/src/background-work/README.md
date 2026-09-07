# Background Work

[Simplified Chinese](../../../../docs/i18n/zh-CN/packages/pi-stuff/src/background-work/README.md)

Background Shells and one-shot Monitors that report completion while the main Agent continues.

<p align="center">
  <a href="../../../../docs/assets/readme/capabilities/background-work.png">
    <img src="../../../../docs/assets/readme/capabilities/background-work.png" alt="Background Work tasks dialog in Pi" width="100%">
  </a>
  <br>
  <em>The Background Work dialog keeps Shells and Monitors visible without leaving Pi.</em>
</p>

## Quick start

Ask the Agent to use `run_in_background: true` for an independent Bash command, or to create a `monitor` for command,
file, log, or HTTP evidence. Keep a required Bash command in the foreground; a later handoff resumes the Agent when it
settles. Then open:

```text
/tasks
```

The dialog lists current work, follows bounded output, and stops activities owned by the Session.

## Highlights

- Detaches Bash immediately, through `Ctrl+B`, or after a two-minute foreground handoff.
- Keeps explicit background launches independent while foreground handoffs resume the main Agent at terminal outcome.
- Monitors exact success or failure text across four source types.
- Delivers terminal outcomes automatically without conversational polling.
- Keeps the newest 64 bounded completion receipts for recent inspection.
- Limits one Session to 16 simultaneous Shells and Monitors.
- Keeps a rolling output tail with an omission count instead of stopping productive work at the retention threshold.
- Labels completed output paths as full or retained according to whether rolling occurred.
- Stops owned process trees and records authenticated recovery metadata at shutdown.

Shell launch waits up to ten seconds for supervisor readiness before publishing the authenticated command.
The three-second command acknowledgement deadline starts after readiness. Failed startup rolls back the launch;
Session shutdown prevents pending launches from releasing a command.

## Documentation

- [Background Work guide](../../../../docs/capabilities/background-work.md)
- [Command reference](../../../../docs/reference/commands.md#work-control)
- [Tool Display guide](../../../../docs/capabilities/tool-display.md)
- [Agents guide](../../../../docs/capabilities/subagents.md)
- [Upstream references](UPSTREAM.md)
