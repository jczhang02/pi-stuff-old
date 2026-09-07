<!-- translation-source: docs/reports/astra-instruction-delivery-review-2026-09-05.md; translation-source-sha256: e6896f312e695e8132064c8183257f75f11bcdf6a777fb5f5c05d54003f311d4 -->

# Astra 指令与交付审查 — 2026-09-05

本次指令迁移减少重复读取、验证和完成规则，同时保留 Pi 权限边界、源码质量限制、真实 Host 验收及 Beads 交付契约。运行时模型默认值保持不变。

## 依据与范围

[OpenAI 的 Astra 指导](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)建议检查 Agent 指令和 Skill 中的冲突，并按工作流程调整澄清、委派、输出和测试。本次本地修改侧重自主完成已授权工作及按风险验证，不增加模型专用配置或迁移 API。

审查范围包括根 AGENTS、代码质量、兼容性、贡献指南、受跟踪的 Beads Skill、Issue 跟踪契约、ADR 0032 及其中文镜像。全局 Codex 指令和已安装 Skill 不在修改范围。全局委派规则仍规定角色、上下文继承和等待方式；修改仓库指令不会移除这些全局规则。

## 验证取舍

| 发现 | 决定 |
| --- | --- |
| 本地全量检查后再跑等价 CI 会重复执行 | 开发时运行针对性检查，复用同一版本所需 CI 证据 |
| 固定清洁审查轮数重复已完成的判断 | 一次审查完整受影响范围；发现问题后修复并复审修改和受影响范围 |
| Package 和 Module README 不必要地触发 Acceptance | 扩展既有普通文档白名单，Runtime Resource 和未知变更仍完整检查 |
| 重命名可能将可执行源码藏在文档路径下 | 本地 CI 和 PR 发布都按重命名前后路径分类 |
| Tool Activity 阈值和重复 Host 启动需要更深入证据 | 保留现有 benchmark、源码及解包 Package 验证，不凭成本猜测删除保护 |
| 验证文字可能声称并未通过的检查 | 发布前依据实际 CI workflow 和精确 attempt 验证目标提交 |

隔离测试运行器串行执行，每个文件启动新进程。Package 验证还对源码和解包内容运行真实 Host/PTY 场景。这些是成本线索，不是实测瓶颈。本报告不声称耗时改善，也不否定不同层级检查能发现不同缺陷。

## 交付强制与限制

发布器要求目标提交最新适用 CI 运行中的必需 job 成功。PR 使用当前 head 和完整文件列表；仅分支记录将最终目标放在最后。文档 PR 和直接推送保留仅 Fast 的政策，手动运行要求两项检查。必需检查缺失或失败会阻止发布。评论链接 Actions attempt，并继续要求精确回读评论及 Issue。

CI 证据不能证明审查质量、提交签名、分支保护、合并授权或真实 Provider 验收；适用时它们仍是明确验收条件。无代码工作需要既有证据及原因，不伪造 CI。历史 Actions 证据缺失时，重新发布不能重新认证成功。

## 实现阶段验证

- 发布器、CI 证据与范围分类的针对性测试全部通过：19 项，无失败。
- 完整 `check:fast` 通过，包括仓库安全和翻译 SHA 校验。
- 对真实 GitHub Actions 的只读检查接受成功的直接推送 Fast 结果，并拒绝已知失败记录；不据此推断本次发布或合并成功。
- 最终审查、分支 CI 和公开交付证据记录在 Bead `ps-8l7`，本报告不替代它们的最终结果。

## 物理行数

比较基准为源码版本 `6ddb5cfa` 与本次实现快照。新增验证保护外部信任边界；指令变短不是省略必需证据的理由。

| 文件 | 修改前 | 修改后 |
| --- | ---: | ---: |
| `AGENTS.md` | 85 | 54 |
| `docs/code-quality.md` | 59 | 41 |
| `.github/CONTRIBUTING.md` | 42 | 31 |
| `.agents/skills/beads/SKILL.md` | 65 | 31 |
| `scripts/publish-beads.ts` | 266 | 298 |
| `scripts/beads-delivery-checks.ts` | 0 | 75 |
| `scripts/ci-acceptance-scope.ts` | 60 | 70 |
| `test/publish-beads.test.ts` | 222 | 298 |
| `test/beads-delivery-checks.test.ts` | 0 | 90 |
| `test/ci-acceptance-scope.test.ts` | 30 | 43 |

## 验收跟进 — 2026-09-06

首次[分支 Acceptance 运行](https://github.com/jczhang02/pi-stuff/actions/runs/33976280826)的 Fast 通过，但 `test/goal-pty.test.ts` 失败：Ubuntu 的 tmux 3.4 不支持 `extended-keys-format`。在匹配到的 PTY 初始化中，只有 Goal 验证器未先探测就设置了这个可选项。使用真实 tmux 3.4 在本地运行同一测试，不到一秒即复现错误。复用既有服务器选项探测后，完整 Goal PTY 测试在 tmux 3.4、3.6a 和 Pi 0.85.0 上均通过。修复仅涉及验证环境初始化，不改变 Goal 行为或断言。

`1724b346` 上的[下一次运行](https://github.com/jczhang02/pi-stuff/actions/runs/34000105818)通过了 Fast 和 Goal PTY，但 Context 多步恢复场景失败：fixture 记录了三次 Provider 请求，预期为两次。随后两次本地针对性运行分别失败和通过，确认存在间歇性失败。计数对应实际请求，并非误匹配经过转义的请求文本。本次变更未修改该场景或 Context 运行时；额外请求的原因仍未查明。其他隔离测试文件通过，但失败阻止了后续验收阶段。PR 228 保持草稿、未合并；完整验收与经验证的交付仍未完成。

## 指令跟进审查 — 2026-09-06

第二次审查依据当前 [Astra 提示指导](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)，以 `cfee220c` 为基准检查完整分支。独立的标准和需求审查发现一处残留冲突：贡献指南仍不加区分地规定开发检查，遗漏纯文档例外。现在它直接引用负责验证政策的文档，包括证据复用。Suite 生成仅由组合变化触发，普通离线测试与显式选择的真实服务验收也有了明确区分。

AGENTS 明确了用户指令优先级、已有授权，以及收到后续消息后继续原任务的要求。Skill 导致暂停时，须引用文件和具体规则，区分明确要求与自行解释。质量文档将已接受的失败诊断政策纳入当前工作流，并保留跨 Capability 或架构变化的独立审查要求，不规定 Agent 调度方式。

本轮 AGENTS 从 54 增至 57 个物理行，贡献指南从 31 增至 32 行，质量文档从 41 增至 46 行。新增规则处理已发现的歧义和失败处置；验证命令只由一份政策文档负责。

代码审查建议增加 PR SHA 格式校验，但源码证据排除了该问题：`readBead()` 验证每个交付 SHA，`deliveryLines()` 在查询 CI 前要求 PR head 属于这个已经验证的列表。因此无需修改可执行代码。指令审查和镜像/SHA 检查不能证明模型行为，也不能解决上述 Context 验收失败；本次不声称行为性能有所改善。

## 合并验收诊断 — 2026-09-06

保留的请求和 Session 记录证明额外调用来自 Session Naming：请求开头要求命名编码会话，Session 末尾出现 `pi-stuff-session-naming-state`。恢复测试只写入 `enabled: false`，未通过命名空间 schema 校验，因此启用了内置默认配置。测试现在复用已有的 `disableSessionNamingForTest()` helper。Goal 生命周期 retry 验证器存在同样的不完整覆盖，现在关闭命名时保留默认设置的其他字段。Provider 匹配逻辑和恢复断言保持不变。

这修复了此前间歇性计数问题的配置根因；完成交付仍需最终版本验证。恢复测试和 Goal 生命周期验证器各增加一行 import，不修改运行时代码。

[下一次 CI](https://github.com/jczhang02/pi-stuff/actions/runs/34009462730)通过了 Context 恢复，但暴露出独立的 Background Work PTY 时序问题。终端显示 Host 因响应仍在运行而拒绝 `/reload`：看到 `MONITOR_RESUMED` 文字并不代表 Host 已空闲。fixture 现在提供一个命令，等待 Pi 公共 `waitForIdle()` 后报告就绪，验证器再发送 `/reload`。这保留了 reload 断言，也避免用固定睡眠猜测时序。验证器从 267 增至 269 行，Provider fixture 从 101 增至 107 行。

[CI 34010463889](https://github.com/jczhang02/pi-stuff/actions/runs/34010463889)通过了上述场景，但暴露出 schema 迁移的锁竞争。Bun 原生 `Worker.terminate()` 不返回 Promise，原有 await 因此会在 Worker 关闭前完成释放。新增的原生 Worker 回归测试复现了这个顺序错误。现有 transport 现在从创建 Worker 起监听 `close`，请求终止后等待该事件，也能处理已经退出的情况。修改的是资源释放边界，不改变数据库重试政策或迁移断言。transport 从 258 增至 262 行，其测试从 341 增至 354 行。
