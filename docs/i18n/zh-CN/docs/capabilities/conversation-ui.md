<!-- translation-source: docs/capabilities/conversation-ui.md; translation-source-sha256: e75bd030d8600eef300007de09c83d6e76bd72f6cb9cca84327a21a8c6d77c6d -->

# Conversation UI

[English](../../../../../docs/capabilities/conversation-ui.md)

Conversation UI 让 Pi Stuff 的当前状态在 Pi 内保持易读。它负责 Welcome header、响应式 Statusline、输入呈现、
User Message 呈现、Thinking 标签、围栏可视化、共享 Command Dialog 和 Suite 诊断。

## 快速开始

启动 Pi，然后运行：

```text
/ui
```

交互设置列表会立即应用变更，并把用户修改保存到 `<agentDir>/pi-stuff.json` 的 `ui` 或 `tools` 命名空间。

## UI 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| Statusline | 开 | 显示当前 model、工作区、Context、用量和选定能力状态 |
| Statusline density | Auto | 随终端宽度在完整与紧凑内容之间切换 |
| Latest prompt | 开 | 用一行有界文字显示最近提交的 prompt |
| Welcome header | 开 | 显示 Suite 启动概览 |
| Input highlighting | 开 | 高亮已识别的 slash 命令和输入结构 |
| Inline slash autocomplete | 开 | 在原生编辑器中补全命令和 Skill 名称 |
| Tool running timer | 开 | 为长时间运行的活动 Tool 行加入经过时间 |

Tool timer 由 Tool Display 负责，但放在 `/ui` 中，便于集中管理呈现设置。

## Statusline

Statusline 使用一行状态和可选的一行 latest prompt。在空间允许时，状态行保持固定顺序：model 与 Thinking、
Codex Fast mode、工作目录与 Git、Context、cache 或用量、当前 Goal，以及 Ponytail mode。

每个 settled Session leaf 与 model 的 Context usage 只在 Host idle 时读取一次。Agent 或 Tool 正在工作时，
Statusline 会保留上一次 settled value，不会在每次 repaint 时要求 Pi 重新扫描 conversation。

`auto` 密度会先缩短字段，再移除低优先级组。它不会换行，也不会留下截断的半个字段。Model 与 Context
保留最久。只有当前状态需要持续指示时，Goal 与 Ponytail 才会出现。

Latest-prompt 行只占一个终端行。Skill 调用会缩减为提交任务与紧凑 Skill 标签；展开的 Skill 指令和本地路径
不会显示。

在 Context projection 期间，Context 分组显示 `recovering`。如果 Provider boundary 无法安全测量或限制请求，
则显示 `unknown` 并中止请求。boundary 验证完成后，经验证的百分比会替换过时的 Host 用量。只有 assistant
成功完成或发生 Session 生命周期事件后，snapshot 才会清除。

## Welcome header

Welcome header 提供活动 model、项目和 Suite 入口的紧凑启动视图。关闭后不会显示，聚焦 Command Dialog
打开时也会让出界面。`/ui` 是修改该呈现选项的唯一入口。

## 输入呈现

输入高亮和行内补全扩展 Pi 的原生编辑器，不替换其快捷键或草稿处理。Slash 补全覆盖已注册命令，并为 Skill
插入规范的 `/skill:<name>` 形式。

聚焦 dialog 会暂时占用编辑器界面。关闭后恢复完全相同的草稿和普通 Pi chrome。

## User Message

User Message 保留 Pi 全宽卡片底色和间距。在认证的 `outputPad=1` 设置下，一个 `` 与 Tool 标记对齐，
prompt 和续行正文与 Tool 正文对齐。标记表示 Provider Prompt，包括自动用户角色消息，不声明由人类输入。

提交 `/skill:implement <prompt>` 后，`/skill:implement` 与 prompt 一起显示在这张卡片中。纯 Skill 使用
相同呈现。Skill 调用文字采用固定的 workflow 演示中的静态彩虹配色；列表、引用和代码块在需要时从它的下方开始，保留原生 Markdown 结构。
原生 `Ctrl+O` 在 prompt 后的 `Skill instructions` 标签下展开完整 Skill instructions，不重复 prompt，
不创建另一张卡片。prompt 中各处的行内 `/skill:<name>` 文本在原位采用相同配色。此装饰不会执行 Skill
或为文字提及添加 instructions。展开的 instructions 使用相同的行内装饰；围栏代码和超链接目标保留原生呈现。

实时和恢复后的 regular/fullscreen TUI 共用相同渲染。Session 内容、Provider 输入、编辑器历史和 HTML 导出
保留原生语义。版本约束适配器在 Session 切换、关闭和 `/reload` 时释放。初始化不兼容会明确失败；工作中的
异常展示故障保留原生消息、停用该 Session 后续的 User Message projection，并通过 `/diagnostics` 报告一次。
使用 `/reload` 可重新尝试安装。正常认证场景出现非预期回退即验收失败。

## Thinking 标签

Thinking 内容、可见性和 run 边界都由 Pi 负责。关闭 Pi 原生 **Hide thinking blocks** 设置后，每个 streaming
或 settled Thinking run 只占一行：`• thoughts: ` 后面接当前原生 Markdown 渲染的最后一条终端行。流式更新
会替换这一行，run 结束后保留最终行；整行过宽时保留内容尾部。打开该设置后，Host 会把每个 run 替换为
斜体 `• thoughts` 标签。相邻的 Assistant prose 与 Thinking run 无论顺序如何都由一行空白分隔，包括二者属于
同一条 Host Assistant message 时。`Ctrl+T` 仍用于切换 Host 设置。

该改动只影响显示。Pi Stuff 不使用语义 parser、源码截断、计时器、模型分类或合并后的 run 状态。选中的
终端行保留原生 Markdown 样式；Session record、Provider context、复制和导出源码均不变。Pi 目前没有公开的
Thinking 渲染后 hook，因此 adapter 与认证 Host 的 component 布局绑定；布局不可用时会明确失败。

## Chart 与 tree

完整的 `chart` 或 `tree` Markdown fence 可以渲染为终端可视化：

````markdown
```tree
Pi Stuff
  Work
    Goal
    Agents
  Context
    Search
    Compaction
```
````

投影只影响显示。保存的 Markdown 和 provider message 保留原 fence。不完整、格式错误、不安全、嵌套、超限
或终端过窄的可视化仍按普通代码显示。一条 Assistant message 最多投影 16 个可视化 block，每个源文本最多
12,000 个字符。

## Command Dialog

Pi Stuff 命令使用共享的全宽非浮动 Command Dialog。它提供稳定焦点、响应式布局、语义状态行和一条回到编辑器的
Escape 路径。只有 `/tools` 与 `/tasks` 这类宽屏检查工作流使用分栏；其他 dialog 保持单栏。

阻塞式权限或确认工作优先于普通检查，关闭后恢复先前界面。共享布局和交互规则见
[DESIGN.md](../../DESIGN.md)。

## 诊断

`/diagnostics` 列出当前进程中有界、脱敏的问题。存在引导式恢复路径时，每条记录都会标明所属能力和应采取的操作。
打开 dialog 会确认可见 notice；诊断不会成为 conversation message。

## 相关文档

- [Conversation UI Module README](../../packages/pi-stuff/src/conversation-ui/README.md)
- [命令参考](../reference/commands.md)
- [设置参考](../reference/settings.md)
- [故障排查](../troubleshooting.md)
