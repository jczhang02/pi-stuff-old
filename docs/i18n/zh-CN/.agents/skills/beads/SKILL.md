<!-- translation-source: .agents/skills/beads/SKILL.md; translation-source-sha256: d516556643fda1e4076d7969a7aed240f572bd483515ea809acd065331dd98df -->
---
name: beads
description: 管理 Pi Stuff 已接受的工作，包括工作地图和 GitHub issue 接收；不用于当前轮次清单。
---

# Beads

[Issue tracker 契约](../../../docs/agents/issue-tracker.md)是 tracker 变更与交付的权威。修改 tracker 状态前阅读相关章节；通用 `bd` 指引冲突时以契约为准。
如果缺少 Beads 上下文，在查阅契约后运行 `bd prime`。

已接受的共享工作、依赖、后续工作和交接使用 Beads。本地计划可以跟踪当前轮次，但不能替代 Beads。持久术语或架构决策也写入 `CONTEXT.md` 或 ADR。

## 操作 tracker

1. 已知 `ps-...` ID 时运行 `bd show`；选择工作用 `bd ready` 或 `bd ready --parent <epic-id>`。对于 `gh-...` 接收，先用 `bd search --external-contains "gh-<number>"` 查重，再按维护者指示执行一次 pull。
2. 创建可能重复的工作前搜索所有状态。用 `bd create` 创建已接受工作，确认 `ps` 前缀，并只记录公开元数据：来源 Host 或 Agent 界面、可用的 Session 名及稳定检索 ID。
3. 实现前用 `bd update <id> --claim` 认领；使用非交互 `bd update` 参数，不使用 `bd edit`。
4. 工作地图用 epic 和子 ticket 表达，阻塞关系使用 `bd dep add <blocked-id> <blocker-id>`。

## 保持本地并安全发布

- 本地 Dolt 数据库是权威。保持 `.beads/` 被忽略；不要运行 `bd init`、`setup`、`hooks`、Dolt push/pull、通用 GitHub sync 或安装 Beads hooks。Beads 不得操作仓库 Git。
- GitHub Issues 是公开接收界面和单向镜像。PR 负责代码交付和审查，不负责范围、依赖、状态或关闭。所有公开字段都不得包含凭据、私有路径/数据、个人信息或敏感 Session 详情。
- 交付或关闭时遵循 `docs/agents/issue-tracker.md`，包括其中的证据与发布要求。
