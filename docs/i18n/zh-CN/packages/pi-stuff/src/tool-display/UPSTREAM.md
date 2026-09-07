<!-- translation-source: packages/pi-stuff/src/tool-display/UPSTREAM.md; translation-source-sha256: 10cd7be8ab9c2df5e42f544445f19c403aac4e6965f779f8573332e781fda5e2 -->

# 上游来源

本模块包含派生自固定 `@mobrienv/pi-tidy-tools` 0.4.1 快照的源码。

| 字段 | 值 |
| --- | --- |
| 仓库 | `https://github.com/mikeyobrien/pi-tidy-tools` |
| 软件包目录 | `packages/pi-tidy-tools` |
| 发布标签 | `pi-tidy-tools-v0.4.1` |
| 源码提交 | `4b251377f1b64f904704e7f760e8947688d12a9a` |
| 许可证 | MIT |
| npm 归档 SHA-1 | `3412d29d584f9226b02a13279d88a3ea03a1422e` |
| npm 归档 SHA-256 | `59bf767e047a0799257af3c510a92f0841db2791e8e11aceca14fc2f7221f71a` |

## Pi Stuff 差异

- 保留上游结果优先、同名内置覆盖和语义摘要思想。
- 直接使用七个 Pi 0.85.1 工具定义，因此其参数 Schema、提示词元数据、执行、结果形态、事件和权限拦截仍由宿主负责且保持不变。Pi 额外的 PowerShell 工具继续由宿主渲染，只为生命周期成员关系进行识别。
- 删除注入的 `reasoning` 参数和所有非结果呈现模式。
- 删除固定 ANSI 颜色、emoji、整行成功背景、`/diff`、以全局展开作为详情路径、`pi-fff`、命令驱动配置和上游写文件式启动/配置行为。
- 使用 Pi 语义主题 token、有界宽度缓存、硬限制聚焦详情和共享非浮动 Pi Stuff 命令对话框。
- 为每个套件负责的工具增加必需 Activity 元数据约定，包含语义现在/过去分句、去重身份、有界实时目标和真实问题状态。
- 把公开生命周期事件、当前分支重建和逐行失效组合为跨 Assistant 工具往返的原生检索组。Bash 和每个非原生检索工具保持独立；Assistant 说明文字、用户输入、模型上下文可见自定义消息和新的逻辑 Thinking 运行形成边界。Ctrl+O 恢复合格的原生工具行；模型可见结果和持久会话数据保持不变。
- 不包含或派生自 `jczhang02/pi-agent` 中的代码。

上游许可证保留在 `LICENSE`。源码已吸收到 Pi Stuff，没有独立软件包或发布生命周期。未来吸收上游时，必须更新本记录并保持本地变更可审计。
