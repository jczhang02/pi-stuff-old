<!-- translation-source: AGENTS.md; translation-source-sha256: 7b0f5189c4f95bae46a61e129303529171cfef1a41bc8e9f78ce5fa49c3f2e17 -->

# Pi Stuff 仓库指令

这些指令仅适用于本仓库的开发。`AGENTS.md`、`CONTEXT.md` 和 `docs/` 是工程材料，不是 Pi Runtime Resources，也不应复制到用户的全局 Pi Agent 目录。

## 按任务读取

- 修改代码或工程规则前，读取 `CONTEXT.md`、`docs/compatibility.md` 及所属已接受 ADR 或 Module README 的相关章节。只读定位或状态查询只需读取必要内容。
- 修改代码、审查或执行验证时，读取 `docs/code-quality.md` 的相关章节。
- 修改可见界面时，读取 `DESIGN.md` 和所属 Module README 或 ADR。
- 操作 Beads、交付或关闭工作时，读取 `docs/agents/issue-tracker.md`。

## 工程边界

- Pi 是 Host。Pi Stuff 保持一个本地 Package 和一个默认 Extension factory；Capability Module 仅供内部使用，没有独立安装或发布生命周期。不得另建 CLI、runtime、Session 层、SDK 或 TUI shell。
- 生命周期权限留在其所有者：Pi 负责普通前台 Agent 运行，Goal 负责 Goal 延续与终止政策，Agents 负责委派执行，Context Management 负责上下文投影、检索、压缩及压力处理。
- 保持 Extension import 纯净：启动期间不访问网络、不启动子进程、不修改 Host 设置或用户配置。首次配置等待直接交互／RPC 输入或显式命令、Tool；初始化失败应传播错误，不加载部分 Suite。
- 每项状态只有一个可见权威，遵循 `DESIGN.md`。交付 TypeScript 源码，不设 `dist/` 通道。先修改 `packages/pi-stuff/suite.json`，再运行 `bun run suite:generate`，不得单独修改生成结果。

## 修改与验证规则

- 在所属边界修复共享根因，检查完整受影响 Capability，复用 Pi 公共 API 和既有 Suite 组件。明显且可逆的产品、架构选择自主处理；只有范围、权限或重要产品决定依赖用户时才询问。
- 遵循 `docs/code-quality.md` 的风险验证和完成审查要求。复用同一版本的结果；仅因代码变化、失败或未解决风险扩大或重复验证。
- 将已授权工作推进到验证和交付。除非用户取消或替换任务，否则后续消息用于调整当前任务；回答旁支问题后继续工作。复用 Session 中已有的授权。
- 用户的明确指令优先于仓库工作流及 Skill 指南。若 Skill 导致暂停或偏离请求，链接具体文件、引用规则，并区分明确要求与自行解释。
- 进度与最终结果保持简洁，给出决定性证据及剩余工作。
- 直接依赖使用精确版本，`trustedDependencies` 保持为空。Worktree 放在 `.worktrees/` 下；完整、连贯的变更使用签名 Conventional Commit。
- 不凭祖先关系推断合并。报告合并或清理前，检查补丁、目标分支和所有相关 worktree 的已跟踪与未跟踪状态；仅移除已合并且干净的 worktree。
- 已接受且需持久跟踪的实现工作遵循 Beads 和 `docs/agents/issue-tracker.md`；只读讨论、探索及当前轮清单不需要 Bead。

## 文档与安全契约

- 人工编写的英文 Markdown 是权威。保留或修改时，同步更新 `docs/i18n/zh-CN/<repository path>` 下的镜像，记录源路径和原始字节 SHA-256。排除字节敏感的 Runtime `SKILL.md`、`THIRD_PARTY_NOTICES.md`，以及历史中文执行清单。
- 保留 `docs/README.md` 的文档分工：入口和 Package README 描述当前行为，Module README 负责本地契约，`CONTEXT.md` 负责术语和边界，`DESIGN.md` 负责共享可见界面规则，ADR 负责持久取舍，带日期的研究、报告和发布说明提供证据。行为或契约变化时更新主管文档；持久决定不能只留在 Session 历史里。
- `pi install` 是维护者的显式操作；Suite 不得自行安装。绝不提交凭据、认证、模型存储、Session、缓存、`.env`、机器状态、私有绝对路径或私有数据。
