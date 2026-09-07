<!-- translation-source: packages/pi-stuff/src/conversation-ui/README.md; translation-source-sha256: 998b95974a0319bdc5c5e7808de04e649c34568310cbf088c640808aa61ea281 -->

# Conversation UI

[English](../../../../../../../packages/pi-stuff/src/conversation-ui/README.md)

Pi Stuff 面向 conversation、编辑器、Statusline、Welcome header 与聚焦 Command Dialog 的共享呈现层。

<p align="center">
  <a href="../../../../../../assets/readme/capabilities/conversation-ui.png">
    <img src="../../../../../../assets/readme/capabilities/conversation-ui.png" alt="Pi 中的 Conversation UI 设置对话框" width="100%">
  </a>
  <br>
  <em>UI 对话框集中配置 Statusline、prompt、欢迎卡片、高亮、补全和计时器。</em>
</p>

## 快速开始

```text
/ui
```

使用交互列表配置 Statusline、latest prompt、Welcome header、输入高亮、行内 slash 补全与 Tool running timer。

## 亮点

- 具有稳定 model、工作区、Context、用量、Goal 与 Ponytail 分组的响应式 Statusline；每个 settled Session
  leaf 与 model 的 context usage 只在 Host idle 时读取一次，因此 Tool 与输入 repaint 不会重新扫描它。
- Context 显示本地百分比估算或 `unknown`；实际恢复时显示 `recovering` 和当前阶段。估算不确定不会中断 Agent。
- 单行 latest-prompt 预览与紧凑 Skill 标签。
- 原生编辑器输入高亮与 slash 补全；所有渲染行都不含 `/` 时，高亮跳过命令表相关工作，且不在重画之间缓存命令表内容。
  否则直接识别完整调用词并查询实时命令集合，不再排序命令名或重建命令专用正则表达式。
- Host 拥有的 Thinking，显示为最新一条原生 Markdown 终端行或隐藏态 `• thoughts` 标签，保留原生鼠标和键盘
  可见性控制；并支持 `chart` 或 `tree` Markdown 投影。
- 关闭后恢复编辑器草稿的全宽 Command Dialog。
- 通过 `/diagnostics` 查看有界 Suite 诊断。

User Message 保留原生背景，`` 与正文分别对齐 Tool 行。Skill invocation（包括纯 Skill 输入）共用一张卡片；原生
`Ctrl+O` 在 prompt 后展开 instructions。版本约束适配器保留规范消息，并在 Session 关闭或 reload 时释放。
异常展示故障保留原生消息、停用该 Session 后续 projection，并通过 `/diagnostics` 报告一次。
Pi 的 spinner 与运行提示只在顶部边框出现一次。Pi 负责 thinking 等级配色、裁剪、动画与清理，弹窗和 reload
保留编辑器行为。

## 文档

- [Conversation UI 指南](../../../../docs/capabilities/conversation-ui.md)
- [设置参考](../../../../docs/reference/settings.md#ui)
- [命令参考](../../../../docs/reference/commands.md#界面与查看)
- [共享 UI 契约](../../../../DESIGN.md)
