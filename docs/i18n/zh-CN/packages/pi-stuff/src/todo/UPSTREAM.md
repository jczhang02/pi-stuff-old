<!-- translation-source: packages/pi-stuff/src/todo/UPSTREAM.md; translation-source-sha256: b6aa0d173538c1aef691d30dede8184cc6c9cfcc06ded4671fe85e900310f47a -->

# 上游来源

本模块包含派生自固定 MIT 许可证 `@juicesharp/rpiv-todo` 软件包快照的源码。

| 字段 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/juicesharp/rpiv-mono` |
| 源码目录 | `packages/rpiv-todo` |
| 源码修订 | `75823a68024a0a649cc28087976074be791ca554` |
| 已发布软件包 | `@juicesharp/rpiv-todo@2.3.1` |
| npm shasum | `8797586bad201f4b2153505347c3b997c320eaa2` |
| 归档 SHA-256 | `b0ae0f1f4245f471c3fa724dc50425cfa241eb37e399c4948d393fe7965d1fa8` |

上游文字基线在产品变更前导入。文档图像没有导入，因为它们不是运行时资源或源码输入。

## Pi Stuff 差异

- 使源码适配 Pi 0.85.1 宿主约定和单一软件包依赖集合。
- 用 `TaskCreate`、`TaskGet`、`TaskList` 和 `TaskUpdate` 替换动作多路复用工具。
- 暴露稳定字符串 ID，增加原子正反向依赖更新，绝不重置 ID 计数器。
- 为新重放快照设置版本，同时保留从旧版数字 `todo` 快照迁移。
- 用一个有界、无标题、位于编辑器上方的清单，替换可配置、本地化的上游面板和命令输出。
- 删除上游设置、本地化、大型浮层、状态栏和重复的成功工具呈现。

Claude Code 发布行为只影响交互约定。没有复制或再分发 Claude Code 源码。吸收的源码没有独立软件包或发布生命周期。
