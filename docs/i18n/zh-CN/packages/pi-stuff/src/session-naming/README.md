<!-- translation-source: packages/pi-stuff/src/session-naming/README.md; translation-source-sha256: c668fb45b6a3c2de3cd42eab99be307a6924cb86bb6c131b455a116c42b599d5 -->

# Session Naming

[English](../../../../../../../packages/pi-stuff/src/session-naming/README.md)

直接用户工作结算后生成简短、可搜索的 Session 名称。

<p align="center">
  <a href="../../../../../../assets/readme/capabilities/session-naming.png">
    <img src="../../../../../../assets/readme/capabilities/session-naming.png" alt="Pi 中的自动 Session 命名控制" width="100%">
  </a>
  <br>
  <em>Session Naming 集中控制自动命名、冷却时间和模型选择。</em>
</p>

## 快速开始

```text
/autoname
/autoname settings
```

`/autoname` 立即重命名当前 Session。`/autoname settings` 控制自动命名、冷却期、手动名称策略与主要
naming model。

## 亮点

- 在未命名 Session 第一次用户运行结算后命名。
- 按可配置的冷却期刷新符合条件的名称。
- 开启对应偏好后保留手动名称。
- 依次使用固定 model、活动 Session model 与可选 fallback。
- 生成有界的两到四词英文名称。
- 使用有界、脱敏的 conversation 文字，不使用 Tool。

消息选择从后向前查找，找到最近六条 user/assistant 消息即停止，再恢复时间顺序。首次短对话仍要求 user
之后有 assistant。不会保留历史缓存；[测量记录](../../../../docs/reports/history-selection-cost-2026-09-06.md)
区分选择器成本、Host 分支构建和命名模型工作。

## 文档

- [Session Naming 指南](../../../../docs/capabilities/session-naming.md)
- [设置参考](../../../../docs/reference/settings.md#sessionnaming)
- [命令参考](../../../../docs/reference/commands.md#session-与支线问题)
- [故障排查](../../../../docs/troubleshooting.md)
