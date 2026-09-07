<!-- translation-source: docs/capabilities/ponytail.md; translation-source-sha256: 7f40a1f5ae9850fe9d6e6a41144fae30bcddb12d8e40b5cfc0382efad5168edc -->

# Ponytail

[English](../../../../../docs/capabilities/ponytail.md)

Ponytail 提供 Session 级指导，推动编码工作选择足够解决问题的最小方案。

## 快速开始

```text
/ponytail
/ponytail lite
/ponytail off
/ponytail-review
/ponytail-help
```

不带参数的 `/ponytail` 打开控制 dialog。默认模式为 `full`。

## 模式

| 模式 | 行为 |
| --- | --- |
| `off` | 不加入 Ponytail prompt 指令或 model 可见的 Ponytail Skill catalog |
| `lite` | 建议更小方案，不执行完整 ladder |
| `full` | 应用标准库与原生能力优先的 ladder；默认值 |
| `ultra` | 应用最严格的 YAGNI 与删除优先策略 |

`/ponytail on` 激活配置的默认模式。`/ponytail off` 关闭当前 Session。只包含 `stop ponytail` 或
`normal mode` 的直接用户 message 也会关闭它。

## 命令

| 命令 | 操作 |
| --- | --- |
| `/ponytail <off|lite|full|ultra>` | 修改当前 Session mode |
| `/ponytail default <lite|full|ultra>` | 设置 `on` 使用的 mode |
| `/ponytail status <show|hide>` | 控制 Statusline identity |
| `/ponytail startup <show|quiet>` | 控制启动 notice |
| `/ponytail-review` | 检查当前变更中的不必要复杂度 |
| `/ponytail-audit` | 审计仓库中的可避免复杂度 |
| `/ponytail-debt` | 列出记录的 `ponytail:` 延后项 |
| `/ponytail-gain` | 显示已发布 impact card |
| `/ponytail-help` | 显示命令与模式参考 |

## 设置

| 字段 | 默认值 | 环境 override |
| --- | --- | --- |
| `defaultMode` | `full` | `PONYTAIL_DEFAULT_MODE` |
| `hideStatus` | `false` | `PONYTAIL_HIDE_STATUS` |
| `quietStartup` | `false` | `PONYTAIL_QUIET_STARTUP` |

有效设置依次来自环境值、`<agentDir>/pi-stuff.json` 的 `ponytail` 命名空间、命名空间缺失时的只读旧版配置，
最后是默认值。

Dialog 只写入合并的 Pi Stuff 设置。环境 override 对当前进程继续有效。

## Prompt 与 Skill

活动模式加入一段紧凑策略和经过筛选的六项 Ponytail Skill catalog。`off` 两者都不加入。

六项内置 Skill 在原生发现中都只能显式调用：

- `ponytail`：完整策略；
- `ponytail-review`：当前 diff；
- `ponytail-audit`：全仓库审计；
- `ponytail-debt`：记录的延后项；
- `ponytail-gain`：impact card；
- `ponytail-help`：reference card。

任何模式下都可以显式调用 `/skill:<name>`。

## Session 与 Agent 范围

Mode 变更保存在当前 Session branch，并从最新有效 entry 恢复。Child Agent 在 launch 时接收 parent 的有效
mode snapshot；这不会修改全局设置。

除非 mode 为 `off` 或 status 已隐藏，Statusline 会显示 `󱖿 <mode>`。可选启动 notice 为
`Ponytail active · <mode> mode`。Agent activity 仍由编辑框边框中的 Pi 原生运行指示器呈现。

## 相关文档

- [Ponytail Module README](../../packages/pi-stuff/src/ponytail/README.md)
- [命令参考](../reference/commands.md#ponytail)
- [设置参考](../reference/settings.md#ponytail)
- [上游参考](../../packages/pi-stuff/src/ponytail/UPSTREAM.md)

