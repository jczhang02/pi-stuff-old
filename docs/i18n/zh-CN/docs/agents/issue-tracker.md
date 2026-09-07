<!-- translation-source: docs/agents/issue-tracker.md; translation-source-sha256: 2f81be3ef0b19da60fbffbe8699f961e1a1413430a385e0ffa30e86fbb8820f3 -->

# Issue 跟踪器：Beads，配合 GitHub 接收与镜像

Beads 是本仓库的规范 Issue 跟踪器。GitHub Issues 是已接受工作的公开单向推送镜像，也是外部报告的接收界面。

所有已接受工作的创建、更新、依赖、认领和关闭都从 Beads 开始。不要把镜像 GitHub Issue 当作权威副本来编辑。

## 本地操作

- 创建：`bd create`
- 读取：`bd show <id>`
- 列表：`bd list`
- 查找就绪工作：`bd ready`
- 认领：`bd update <id> --claim`
- 更新：`bd update <id> ...`
- 关闭：`bd close <id> --reason "..."`
- 添加阻塞项：`bd dep add <blocked-id> <blocker-id>`
- 检查依赖：`bd dep tree <id>` 或 `bd graph`

Issue ID 使用 `ps` 前缀。

## 本地存储

本地 Dolt 数据库是 Beads 命令的权威。整个 `.beads/` 工作区仅限本地，并排除在 Git 之外。

发布命令可以在把已接受工作同步到 GitHub Issues 后，刷新经过清理的本地 `.beads/issues.jsonl`。该导出不受版本控制，也不是完整 Dolt 备份。Beads 不得暂存、提交、推送或以其他方式操作 Git，仓库也不安装 Beads Git Hook。

## GitHub 镜像

使用以下命令显式发布 Beads Issue：

```bash
bun run beads:publish -- <epic-or-bead-id>
```

命令可从任意仓库 worktree 运行，使用规范仓库中的 Beads 数据库。它通过操作系统锁串行化发布，先预览并执行单向同步，再为每个 Issue 更新一条受管理的交付评论。进程退出或中断时锁自动释放。认证在运行时取得，token 不会持久化。人工评论保留；重复的受管理评论或不同发布身份需要显式核对，不会自动删除或接管。

评论包含规范状态、已关闭时的关闭原因、交付证据、已验证的 commit 和 PR 链接、PR 实际合并状态，以及转换为 GitHub Issue 链接的 Beads 入向/出向关系。关联 Bead 尚无 GitHub 镜像时，先发布该 Bead。关系仍由 Beads 管理；可见链接不承诺映射为 GitHub 原生依赖或子 Issue 字段。PR 正文必须引用镜像 Issue 的完整 URL，使读者能从 PR 返回原始工作项。

成功必须回读核对完整受管理评论及 Issue 状态、标题。重复发布更新同一评论，也适用于重新打开和 PR 合并之后；内容未变则不写入。失败或中断的请求可能已修改 GitHub。解决报告的问题后重试相同命令，它会识别已有评论，不会盲目重复创建。回读成功前，应报告发布未完成。单独的 `bd close` 或上游同步成功消息不等于公开交付完成。

## 交付与关闭

已接受且需持久跟踪的仓库工作，包括由通用实现 Skill 启动的工作，遵循以下步骤。只读探索、讨论和当前轮清单不要求修改跟踪器：

1. 读取并认领 Bead，在其中维护范围和关系，使用独立 worktree。
2. 完成请求的结果，以及[代码质量](../code-quality.md)要求的针对性检查和审查，再签名并推送连贯提交。复用该版本所需 CI 的结果，不在本地重复运行整套检查。
3. 代码工作创建或更新 PR，说明问题、最终行为、验证和 Issue 完整 URL。复用分支已有 PR，避免重复创建。用户明确只要求分支交付时可省略 PR，但必须记录原因。不要仅为完成此流程而执行合并。
4. 在保留其他 metadata 的同时记录 `metadata.github_delivery`。包含当前 PR head SHA、实际验证、限制及未完成事项。明确标注未验证或失败的验收。
5. 请求的验收标准全部满足后，才以有实质内容的 `--reason` 在 Beads 中关闭。实现并交付的请求可以在合并前关闭；包含合并要求的请求必须保持进行中，直到验证合并。Beads 完成状态与 GitHub PR 合并状态是独立事实，必须同时可见。
6. 发布已授权时，运行 `bun run beads:publish -- <id>`，要求返回已验证的评论 URL。交付答复包含 Bead、Issue、PR 或仅分支交付的原因、最终 commit、验证与合并状态。发布失败时分别报告本地与公开状态。之后执行已授权合并时，核对补丁与 worktree 状态，更新 Beads、重新发布，并仅移除已合并且干净的 worktree。

交付对象字段如下：

| 字段 | 契约 |
| --- | --- |
| `kind` | `code` 或 `no-code` |
| `summary` | 非空公开结果，包含限制或未完成事项 |
| `validation` | 非空说明，记录针对性检查、审查、验收限制和剩余工作；不能替代已验证的 CI |
| `commits` | 完整的小写 40 位 SHA；代码至少一项，无代码时为空；仅分支交付将最终提交放在最后 |
| `pull_request` | 可选的本仓库正整数 PR 编号；代码通常必须填写 |
| `no_pr_reason` | 仅分支交付的明确原因，或无需代码/PR 的原因 |

例如，在忽略的 JSON 文件中保留既有 metadata 并加入 `github_delivery`，然后执行 `bd update <id> --metadata @<file.json>`。发布器拒绝格式错误的 metadata、缺少交付记录或关闭原因的已关闭 Bead、远端不存在的提交，以及当前 head 未列入提交记录的 PR。合并状态从 PR 实际数据读取，而非信任自由文本声明。无代码工作必须有原因，且不得包含 commit/PR 引用。进行中的规划 Bead 可不含交付记录；评论会明确说明尚未记录交付。


### 已验证的 CI 证据

Plan、Checks、Verify 各需要一个已完成且成功的结果。Tests 必须是一个历史单 job，或 job 名称声明的全部唯一编号分片；混合、缺失或重复分片拒绝发布。只有成功 Verify 确认 no-tests 后，普通 Tests job 才可跳过。

发布器在同步前以及准备交付评论前检查代码交付。它读取本仓库 `.github/workflows/ci.yml` 中对应目标 SHA 的运行记录，按运行编号选择最新适用记录，并检查该次运行的精确 attempt。每个必需 job 必须只有一条已完成且成功的结果。缺失、失败、取消、跳过或等待中的必需证据都会拒绝发布，自由文本不能覆盖检查结果。受管理评论链接到已验证的 Actions attempt，并列出通过的检查。

- PR 交付以当前 PR head 为目标，接受 pull_request 或手动运行。发布器验证当前 workflow 的 `Plan`、`Checks`、完整 `Tests` 分片集合和 `Verify`，不再重新按路径分类；只有成功的 Plan 明确要求零测试时，`Tests` 才可跳过。workflow 不完整或已过期时阻止发布。
- 仅分支交付以最后记录的提交为目标，接受 push 或手动运行，并要求同样的 job 职责及完整 Tests 分片集合；允许同样有效的 no-tests 例外。未测试的功能分支需要手动触发 CI。
- 无代码和开放规划记录无需 CI 证据。历史代码交付重新发布时必须能取回证据；历史缺失不等于成功。

这些检查认证已记录的 CI 结果，不认证审查质量、签名、分支保护或合并权限。成功的 Plan/Checks/Tests/Verify aggregate 记录该 revision 的 workflow 结果，但不替代 workflow 外要求的真实 Host 证据。发布仍需精确回读评论和 Issue；远端操作不是事务，后续检查或写入失败时应报告部分发布状态并重试。

历史已关闭 Bead 在重新发布时遵循相同验证：先恢复真实公开证据和引用，适用时明确记录仅分支交付或无代码结果。不要为通过旧记录发布而编造 PR、合并状态或成功验收。发布范围为所选 Bead 及其完整子树；其他依赖只建立链接，不会被隐式发布或关闭。

## 外部接收

Bug 和功能表单会创建 GitHub 接收 Issue。在 GitHub 上分诊。Issue 被接受后，维护者可进行一次定向接纳：

```bash
bd github pull gh-<number>
```

接纳后，在 Beads 中更新，并使用仅推送同步。这次性接收操作是“不拉取”规则唯一的常规例外。

## Skill 操作

Skill 要求“发布到 Issue 跟踪器”时：

1. 创建或更新 Beads Issue。
2. 在 Beads 中添加其父级和阻塞关系。
3. 显式发布相关 Issue 或 Epic 子树。
4. 可用时同时返回 Beads ID 和 GitHub URL。

Skill 要求“获取相关 Ticket”时，使用 `bd show <id>`。把对应 GitHub Issue 视为公开镜像。

## 工作地图

- 一张地图是一个 Beads Epic。
- 子 Ticket 使用该 Epic 作为父级。
- 阻塞关系使用 Beads 依赖边。
- `bd ready --parent <epic-id>` 标识可执行前沿。
- 实现前先认领 Ticket。
- 只有验证验收标准后才关闭。
- 发布 Epic 子树以刷新 GitHub 状态。

## 把拉取请求作为分诊界面

PR 用于交付和审查代码，不用于请求工作或定义其权威范围。外部贡献者可以提交 PR，但维护者必须先把接受的范围接纳到 Beads，之后实现才算仓库工作。审查意见可以完善补丁；工作项状态、依赖和关闭仍由 Beads 负责。

## 公开数据政策

仓库、JSONL 导出和 GitHub Issues 都是公开的。绝不要在 Beads 字段或 GitHub Issue 中放置凭据、私有路径、私有数据、未公开个人信息或敏感运行细节。
