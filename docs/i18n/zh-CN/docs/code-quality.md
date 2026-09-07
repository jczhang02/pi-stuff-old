<!-- translation-source: docs/code-quality.md; translation-source-sha256: 5e11f47448a64dc3134beb7109cd0653638f34c19f7ecc8810edce9a0d4f8e10 -->

# Repository-owned Source 质量

所有被跟踪的 Pi Stuff 代码都是 Repository-owned Source，无论来自本地、fork、vendored、上游、生成文件、测试、prototype、脚本或质量工具。来源影响归属与许可，不产生质量豁免。机器状态、缓存、worktree、构建产物、二进制资产和正文不属于代码检查。

## 必须达到的标准

- 每个被跟踪的代码目录都参与 Biome、带 anti-slop 规则的 Oxlint、适用的严格 TypeScript 及未使用文件/依赖分析。Profile 只能因运行时库、模块解析或 target 不同而不同；共享严格性、未使用代码、索引访问、可选属性、override、副作用导入和 erasable syntax 规则必须保持启用。
- Effect 为直接依赖时使用 `effect/<Module>` 公开子路径，禁止根 barrel。Effect constructor 规则与 repository-safety 边界清单管理 service constructor、runner 和原生 effect；每项必须是确切存在的 Source 路径，不能重复或缺失。
- 格式化的人工维护文件通常应为 200–400 个物理行；超过 500 行须进行 cohesion review，800 行是合并上限。函数通常为 20–50 行，超过 80 行须审查，且不得超过 120 行。`check:repository` 对已跟踪及未忽略的未跟踪代码执行这些限制。
- 拆分必须减少同时承担的职责、可变状态、分支或概念；把原有复杂度搬到机械碎片不符合标准。质量工作报告前后物理行数，调查无法解释的增长并优先删除。行数是证据，不是验收配额。
- 测试用于证明行为和兼容性；测试通过不能替代源码审查。

## 按风险验证

- 纯文档变更需要文档镜像/SHA 检查和相关聚焦检查，不需要完整代码检查。代码变更开发期间运行聚焦 Tests 和 `bun run check`；`bun run verify` 将只读 Static Checks 与保守选择的离线 Tests 组合起来。
- PR 或发布准备以同一 revision 的必要 CI 检查为权威；复用其结果，不在本地重复完整套件。影响未知或 CI 无法覆盖受影响路径时运行完整检查。
- 公共接口和发布需要有代表性的真实 Host 证据；mock 不能认证它们。验收证据须与 benchmark 和聚合 Suite 评估分开。
- 检查失败时，复用已有诊断，排查最小失败场景。区分产品、测试和环境故障；原因不明的重试通过不能解决间歇性失败。保持验收受阻状态明确，同时完成范围内不依赖该验收的工作。

## Thermo-Nuclear 完成审查

- 使用 `thermo-nuclear-code-quality-review` 审查固定 base 的完整 diff 和完整受影响 Capability。不可用时直接执行本标准。通过要求没有结构退化、明显可行的简化遗漏、临时分支或边界泄漏、不必要的 wrapper/cast/optionality/helper 或无法说明的规模增长；检查 ownership、状态、耦合、类型边界、规范归属和原子性。
- 每次代码变更都需要一次完整相关范围审查。发现问题后修复，并复查变更及受影响范围；只有修复引入新风险时才扩大范围。无发现结果只适用于精确审查的源码，之后的变更必须重新审查。
- 跨 Capability 和架构变更需要独立审查。指令及工作流变更须审查要求是否冲突、完成标准是否明确；静态检查不能证明它们对行为的影响。
