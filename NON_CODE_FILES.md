# Non-code file review checklist

[Simplified Chinese](docs/i18n/zh-CN/NON_CODE_FILES.md)

## What this file is for

This checklist answers a practical review question: after code and images are set aside, what files are left? Every row
pairs a repository path with a Chinese explanation of what that file controls, records, or provides.

Use it when reviewing or reorganizing documentation, configuration, metadata, licenses, and test data. The snapshot was
taken from the `docs/readme-rewrite` worktree on 2026-09-01.

## Scope

- Source of truth: the final tracked file set reported by `git ls-files`, including this checklist and its Chinese mirror.
- Included: prose, configuration, structured data, text captures, locks, patches, checksums, metadata, and licenses.
- Excluded: TypeScript, JavaScript, Python, shell scripts, native executables, and PNG images.
- Machine state, caches, ignored files, and untracked files are outside this inventory.

## Summary

| Area | Files |
| --- | ---: |
| Repository root and configuration | 31 |
| Core documentation | 44 |
| Research, reports, and releases | 49 |
| Simplified Chinese mirrors | 122 |
| Pi Stuff Package | 80 |
| Test data | 11 |
| **Included non-code files** | **337** |
| Excluded code or executable files | 936 |
| Excluded image files | 29 |
| **Tracked files** | **1302** |

## Repository root and configuration (31)

| File | 作用 |
| --- | --- |
| `.bun-version` | 固定仓库使用的 Bun 版本，避免本地开发与 CI 使用不同工具链。 |
| `.editorconfig` | 统一编辑器的编码、换行、末尾空白和各类文本文件的缩进规则。 |
| `.gitattributes` | 关闭内部 fork 快照目录的 Git 空白规范化，保留上游文件的原始字节。 |
| `.github/CODEOWNERS` | 把仓库路径的默认代码审查责任分配给维护者 `@jczhang02`。 |
| `.github/CONTRIBUTING.md` | 说明贡献前要读什么、如何使用 Beads、运行检查、生成 Package 以及提交签名 commit。 |
| `.github/ISSUE_TEMPLATE/bug.yml` | 定义缺陷报告表单，收集版本、实际行为、最小复现和必要的脱敏信息。 |
| `.github/ISSUE_TEMPLATE/config.yml` | 关闭空白 Issue，并把安全问题引导到 GitHub 私密漏洞报告入口。 |
| `.github/ISSUE_TEMPLATE/feature.yml` | 定义功能请求表单，要求先讲用户问题、可观察目标和边界取舍。 |
| `.github/SECURITY.md` | 说明受支持版本、私密漏洞报告方式和 Pi Extension 的安全信任边界。 |
| `.github/dependabot.yml` | 让 Dependabot 每周检查 GitHub Actions 更新，并限制和归组自动 PR。 |
| `.github/workflows/ci.yml` | 定义 PR、main push 和手动触发的 CI，包括版本校验、快速检查和条件验收。 |
| `.github/workflows/pi-upstream-watch.yml` | 定期比较已认证 Pi 版本与 npm 最新版本，上游落后时让工作流失败。 |
| `.gitignore` | 排除依赖、构建产物、凭据、worktree、缓存和 Beads/Dolt 机器状态。 |
| `.oxlintrc.json` | 配置 Oxlint、anti-slop 插件、忽略路径和仓库采用的严格代码质量规则。 |
| `AGENTS.md` | 规定 Agent 在本仓库开发时必须遵守的架构、文档、检查、worktree 和安全规则。 |
| `CONTEXT.md` | 维护 Pi Stuff 的规范术语、概念定义、生命周期所有权和架构边界。 |
| `DESIGN.md` | 规定终端界面的布局、颜色、交互、状态呈现和共享组件设计规则。 |
| `LICENSE` | 保存项目的 MIT 许可证和版权声明，说明代码可如何使用与分发。 |
| `NON_CODE_FILES.md` | 逐项列出所有 tracked 非代码文件及中文用途，供文档和配置审查时防漏。 |
| `README.md` | 作为项目首页，介绍 Pi Stuff、核心能力、安装方法、常用入口和文档导航。 |
| `biome.json` | 配置 Biome 的检查范围、排除目录、格式化风格和推荐 lint 规则。 |
| `bun.lock` | 锁定工作区依赖、peer 依赖、补丁映射和解析结果，保证安装可复现。 |
| `config/typescript/agents-tests.json` | 给 Agents Host、PTY 测试和相关 Conversation UI 源码定义专用类型检查范围。 |
| `config/typescript/agents.json` | 给 Subagents 模块定义 ES2023、Bundler 模块解析和共享严格检查配置。 |
| `config/typescript/base.json` | 提供全仓共享的严格 TypeScript 编译基线，其他 tsconfig 从这里继承。 |
| `config/typescript/goal-upstream-run.json` | 为 Goal 上游测试设置可发射编译、独立输出目录和所需源码范围。 |
| `config/typescript/rtk.json` | 给 RTK 模块及其测试定义独立的 TypeScript 编译和类型检查范围。 |
| `package.json` | 定义根工作区、Bun 脚本、检查与测试命令、开发依赖和 Knip 入口。 |
| `patches/@cortexkit%2Fpi-magic-context@0.41.1.patch` | 修补 Magic Context 0.41.1 的 tokenizer 发现、token 复用和启动预加载行为。 |
| `schemas/suite.schema.json` | 定义 `suite.json` 的 JSON Schema，用来校验模块声明、顺序和配置形状。 |
| `tsconfig.json` | 定义根 TypeScript 检查范围，并排除由独立 tsconfig 负责的模块和测试。 |

## Core documentation (44)

| File | 作用 |
| --- | --- |
| `docs/README.md` | 作为文档总入口，导航入门、能力指南、工程规范、ADR、研究和报告。 |
| `docs/adr/0001-keep-pi-as-the-host.md` | 记录“Pi 继续作为 Host、Pi Stuff 保持单一 Package”的架构决定及其后果。 |
| `docs/adr/0004-route-suite-diagnostics-through-owned-ui.md` | 记录 Suite 诊断应通过归属模块 UI 和 `/diagnostics` 展示的决定。 |
| `docs/adr/0006-cache-unchanged-suite-modules-across-host-reload.md` | 记录 Host reload 时缓存未变化 Suite Module 的策略、边界和后果。 |
| `docs/adr/0007-initialize-configured-context-before-editor-readiness.md` | 记录编辑器就绪前初始化已配置 Context 的启动顺序决定。 |
| `docs/adr/0008-own-the-context-command-surface.md` | 记录 Context 模块拥有 `/ctx` 命令面及其输出、可读性和生命周期契约的决定。 |
| `docs/adr/0009-align-code-mode-with-openai-and-cloudflare.md` | 记录 Code Mode 与 OpenAI、Cloudflare 对齐后的 Provider、审批、恢复和 Host 边界。 |
| `docs/adr/0012-merge-pi-stuff-settings-file.md` | 记录使用单一合并设置文件、启动只读、共享 I/O 和旧格式兼容的决定。 |
| `docs/adr/0015-certify-the-upstream-release-binary.md` | 记录认证上游 Pi 发布二进制的方法、证据和发布后果。 |
| `docs/adr/0017-project-chart-and-tree-fences-inside-conversation-markdown.md` | 记录在 Conversation Markdown 中投影 chart/tree fence 的方案和取舍。 |
| `docs/adr/0018-end-live-v1-agent-governor-coexistence.md` | 记录结束 live v1 Agent governor 共存的迁移决定和生命周期后果。 |
| `docs/adr/0019-isolate-context-engine-work-from-the-host-ui-thread.md` | 记录把 Context engine 工作移出 Host UI 线程的并发边界和拒绝方案。 |
| `docs/adr/0020-add-automatic-session-naming.md` | 记录在 settled user-work 边界自动命名 Session 的触发和恢复规则。 |
| `docs/adr/0021-fork-ponytail-as-a-suite-capability.md` | 记录把 Ponytail fork 作为 Suite Capability 集成的范围与后果。 |
| `docs/adr/0022-restrict-folding-to-native-retrieval.md` | 记录 compact folding 只用于 native retrieval 的归属、投影和生命周期边界。 |
| `docs/adr/0023-use-a-closed-operation-block-family.md` | 记录采用封闭 Operation Block 类型族的理由、范围和后果。 |
| `docs/agents/domain.md` | 说明 Agent 领域文档的阅读顺序、目录布局、术语和架构决策归属。 |
| `docs/agents/issue-tracker.md` | 规定 Beads、GitHub Issue 镜像、work map、PR 分诊和工作项来源记录流程。 |
| `docs/agents/triage-labels.md` | 定义 Issue 分诊可使用的规范标签及每个标签的含义。 |
| `docs/architecture.md` | 描述 Suite 组合、运行时加载、生命周期所有权、配置数据流和设计权威。 |
| `docs/capabilities/background-work.md` | 指导后台 Shell、Monitor、容量、完成通知以及关闭后的恢复。 |
| `docs/capabilities/btw.md` | 指导 BTW 支线问答的启动、上下文、历史、控制和答案提升。 |
| `docs/capabilities/code-mode.md` | 指导 Code Mode 的 Provider、沙箱、目录输出、Tool UI、审批和恢复。 |
| `docs/capabilities/codex.md` | 指导 Codex Responses、Fast mode、认证、用量和专属 Tool。 |
| `docs/capabilities/context-management.md` | 指导 Context 的 retrieval、memory、note、compaction、压力处理和恢复。 |
| `docs/capabilities/conversation-ui.md` | 指导 Welcome、Statusline、输入、Thought、chart/tree 和诊断等对话界面。 |
| `docs/capabilities/goal.md` | 指导 Goal 的生命周期、续行、完成/阻塞判定、状态栏和压缩恢复。 |
| `docs/capabilities/mcp.md` | 指导 MCP server 配置、gateway Tool、连接、认证、输出和诊断。 |
| `docs/capabilities/notification.md` | 指导工作结算后的终端通知、tmux passthrough、隐私和响铃行为。 |
| `docs/capabilities/ponytail.md` | 指导 Ponytail 模式、命令、设置、Prompt、Skills 和 Agent 作用域。 |
| `docs/capabilities/rtk.md` | 指导 RTK 安装、命令重写、模型输出投影、验证和节省统计。 |
| `docs/capabilities/session-naming.md` | 指导自动 Session 命名的触发、模型路由、隐私上下文和恢复。 |
| `docs/capabilities/subagents.md` | 指导 Agents 的单个/并行委派、工具形状、控制和前后台行为。 |
| `docs/capabilities/todo.md` | 指导 Todo 项、状态转换、依赖关系、可见清单和 Session 状态。 |
| `docs/capabilities/tool-display.md` | 指导 Retrieval Group、Operation Block、活动状态、详情和计时器显示。 |
| `docs/capabilities/web.md` | 指导 Web 搜索、公开 HTTP 抓取、Provider 路由和配置。 |
| `docs/code-quality.md` | 规定 Repository-owned Source 的质量门槛和 Thermo-Nuclear 完成审查要求。 |
| `docs/compatibility.md` | 记录已认证的 Pi Host、Bun、RTK 和直接依赖版本及兼容约束。 |
| `docs/getting-started.md` | 指导安装环境、安装 Package、选择主题、运行首批命令和配置可选集成。 |
| `docs/readme-style.md` | 规定各类 README 的职责、内容边界、徽章、截图、链接和翻译方式。 |
| `docs/reference/commands.md` | 集中列出 Pi Stuff 的命令、参数和对应使用场景。 |
| `docs/reference/settings.md` | 集中说明合并设置文件、各 Capability 的配置键、默认值和作用。 |
| `docs/reference/themes.md` | 说明可用主题、选择方法、语义颜色映射和许可证来源。 |
| `docs/troubleshooting.md` | 按安装、设置、Context、Web、MCP、通知和图片等场景提供排障办法。 |

## Research, reports, and releases (50)

| File | 作用 |
| --- | --- |
| `docs/releases/0.1.0.md` | 记录 Pi Stuff 0.1.0 候选版的功能范围、安装方式和当时认证状态。 |
| `docs/releases/0.2.1.md` | 记录 Pi Stuff 0.2.1 候选版的完整 Capability 集、安装和认证快照。 |
| `docs/releases/0.2.2.md` | 记录 Pi Stuff 0.2.2 候选版的日常使用修复、安装和认证快照。 |
| `docs/reports/README.md` | 作为报告索引，导航验收、设计、迁移和性能证据。 |
| `docs/reports/code-mode-image-20260827/benchmark-v1.json` | 保存 Code Mode 图片任务首轮真实模型基准结果，作为后续比较基线。 |
| `docs/reports/code-mode-image-20260827/benchmark-v2.json` | 保存 Code Mode 图片任务第二轮真实模型基准结果，用来和首轮基线比较。 |
| `docs/reports/code-mode-image-20260827/benchmark-v3-luna.json` | 保存使用 `gpt-5.6-luna` 的第三轮 Code Mode 图片基准结果。 |
| `docs/reports/code-mode-image-20260827/benchmark-v4-luna.json` | 保存使用 `gpt-5.6-luna` 的第四轮 Code Mode 图片基准结果。 |
| `docs/reports/code-mode-image-20260827/ui/metadata.json` | 记录保留的 Code Mode 捕获、已归档直接捕获的哈希以及零差异像素结果。 |
| `docs/reports/code-mode-image-20260827/ui/pi-code-mode.ansi` | 保存 Code Mode 图片查看场景的带 ANSI 颜色终端输出。 |
| `docs/reports/code-mode-image-20260827/ui/pi-code-mode.txt` | 保存 Code Mode 图片查看场景去掉 ANSI 后的可读终端文本。 |
| `docs/reports/context-submit-concurrency-research-2026-08-14.md` | 保留 Context 提交时的渲染顺序事实，并说明现行 Worker 方案如何取代早期屏障。 |
| `docs/reports/magic-context-effect-optimization-2026-09-02.md` | 记录 Effect 下 Magic Context 0.41.1 的升级、配对性能、真实宿主验收和优化取舍。 |
| `docs/reports/magic-context-real-acceptance.json` | 保存 Magic Context 真实验收使用的归档包哈希、缓存和运行证据。 |
| `docs/reports/pi-stuff-0.3.0-final-acceptance.md` | 汇总 0.3.0 的归档身份、真实 Session、Magic-only gate 和最终检查结果。 |
| `docs/reports/pi-stuff-lifecycle-performance.md` | 记录 schema 6 生命周期测量契约、历史结果摘要和当前回归预算。 |
| `docs/reports/ps-8z1-final-acceptance-2026-08-29.md` | 记录 Bead `ps-8z1` 的最终验收范围、直接证据和结论。 |
| `docs/reports/single-package-migration.md` | 保留旧 Package 到现行 Module 的映射和迁移后的 Runtime Resource 去向。 |
| `docs/reports/skill-discovery-benchmark-20260830.json` | 保存Skill Discovery 首轮真实模型基准的结构化评估结果和原始判定。 |
| `docs/reports/skill-discovery-confirmation-20260830.json` | 保存修正 Tool allowlist 后的 Skill Discovery 确认实验的结构化评估结果和原始判定。 |
| `docs/reports/skill-discovery-direct-read-20260830.json` | 保存直接读取 Skill 内容的 Skill Discovery 实验的结构化评估结果和原始判定。 |
| `docs/reports/skill-discovery-isolated-confirmation-20260830.json` | 保存隔离 Context worker 混淆因素后的 Skill Discovery 确认实验的结构化评估结果和原始判定。 |
| `docs/reports/skill-discovery-startup-bounded-confirmation-20260830.json` | 保存拆分冷启动与 RPC 时序后的 Skill Discovery 有界确认实验的结构化评估结果和原始判定。 |
| `docs/research/README.md` | 作为研究索引，导航保留的产品参考、实验和设计调查。 |
| `docs/research/agent-activity-ui-reference.md` | 比较 Claude Code 与 Pi Subagents 的 Agent 活动 UI、生命周期和可见表面。 |
| `docs/research/claude-code-tool-grouping-narrative-boundary-20260826.md` | 研究 Claude Code 的 Tool 分组与叙事边界，为 Pi Stuff 展示边界提供依据。 |
| `docs/research/claude-code-transcript-source-decisions.md` | 基于源码记录 Claude Code Transcript 的结构和相关决策证据。 |
| `docs/research/code-mode-image-benchmark-20260827.md` | 预注册 Code Mode 图片任务基准的假设、变量、判定和实验协议。 |
| `docs/research/code-volume-reduction-20260823.md` | 记录 Pi Stuff 代码量削减前后的测量结果和减少来源。 |
| `docs/research/live-only-thoughts-feasibility-20260813.md` | 评估 Pi 0.84.1 只实时显示 Thoughts、不持久化的可行性。 |
| `docs/research/notification-capability-reference.md` | 调查 Notification Capability 的行为、边界和可复用实现参考。 |
| `docs/research/pi-latest-markdown-transform-20260820.md` | 记录 Pi Markdown transformation API 的已验证事实和适用边界。 |
| `docs/research/pi-stuff-operation-block-dialog-study-20260829.md` | 研究 Operation Block 与 Tool Dialog 的结构、状态和展示决定。 |
| `docs/research/pi-stuff-tool-activity-taxonomy-20260806.md` | 建立 Tool activity 分类法及各类活动的展示边界。 |
| `docs/research/pi-tmux-kitty-images-feasibility-20260815.md` | 评估 tmux 中使用 Kitty 图片协议显示 Pi 图片的可行性。 |
| `docs/research/pi-xdg-base-directory-20260811.md` | 记录 Pi/Pi Stuff 的 XDG 目录行为、路径约束和实现依据。 |
| `docs/research/skill-discovery-benchmark-20260830.md` | 预注册Skill Discovery 首轮真实模型基准的假设、变量、步骤和冻结判定。 |
| `docs/research/skill-discovery-confirmation-20260830.md` | 预注册修正 Tool allowlist 后的 Skill Discovery 确认实验的假设、变量、步骤和冻结判定。 |
| `docs/research/skill-discovery-direct-read-20260830.md` | 预注册直接读取 Skill 内容的 Skill Discovery 实验的假设、变量、步骤和冻结判定。 |
| `docs/research/skill-discovery-isolated-confirmation-20260830.md` | 预注册隔离 Context worker 混淆因素后的 Skill Discovery 确认实验的假设、变量、步骤和冻结判定。 |
| `docs/research/skill-discovery-startup-bounded-confirmation-20260830.md` | 预注册拆分冷启动与 RPC 时序后的 Skill Discovery 有界确认实验的假设、变量、步骤和冻结判定。 |
| `docs/research/work-background-notification-ui-reference.md` | 研究后台 Agent/Shell 完成、失败、停止和权限场景对应的 UI。 |
| `docs/research/work-background-package-reference.md` | 比较后台任务 Package，并记录采用 `pi-background-tasks@2.0.0` fork 的依据。 |
| `docs/research/work-btw-package-reference.md` | 比较 BTW Package，并记录采用 `@juicesharp/rpiv-btw@2.3.1` fork 的依据。 |
| `docs/research/work-btw-ui-reference.md` | 比较 BTW 的单次问答、侧线程和邮箱 UI 生命周期并记录所选方案。 |
| `docs/research/work-todo-ui-reference.md` | 比较 Todo 可见性方案，并记录采用最多五行清单的 UI 决定。 |

## Simplified Chinese mirrors (122)

| File | 作用 |
| --- | --- |
| `docs/i18n/zh-CN/.github/CONTRIBUTING.md` | 中文镜像：说明贡献前要读什么、如何使用 Beads、运行检查、生成 Package 以及提交签名 commit。 |
| `docs/i18n/zh-CN/.github/SECURITY.md` | 中文镜像：说明受支持版本、私密漏洞报告方式和 Pi Extension 的安全信任边界。 |
| `docs/i18n/zh-CN/AGENTS.md` | 中文镜像：规定 Agent 在本仓库开发时必须遵守的架构、文档、检查、worktree 和安全规则。 |
| `docs/i18n/zh-CN/CONTEXT.md` | 中文镜像：维护 Pi Stuff 的规范术语、概念定义、生命周期所有权和架构边界。 |
| `docs/i18n/zh-CN/DESIGN.md` | 中文镜像：规定终端界面的布局、颜色、交互、状态呈现和共享组件设计规则。 |
| `docs/i18n/zh-CN/NON_CODE_FILES.md` | 中文镜像：逐项列出所有 tracked 非代码文件及中文用途，供文档和配置审查时防漏。 |
| `docs/i18n/zh-CN/README.md` | 中文镜像：作为项目首页，介绍 Pi Stuff、核心能力、安装方法、常用入口和文档导航。 |
| `docs/i18n/zh-CN/docs/README.md` | 中文镜像：作为文档总入口，导航入门、能力指南、工程规范、ADR、研究和报告。 |
| `docs/i18n/zh-CN/docs/adr/0001-keep-pi-as-the-host.md` | 中文镜像：记录“Pi 继续作为 Host、Pi Stuff 保持单一 Package”的架构决定及其后果。 |
| `docs/i18n/zh-CN/docs/adr/0004-route-suite-diagnostics-through-owned-ui.md` | 中文镜像：记录 Suite 诊断应通过归属模块 UI 和 `/diagnostics` 展示的决定。 |
| `docs/i18n/zh-CN/docs/adr/0006-cache-unchanged-suite-modules-across-host-reload.md` | 中文镜像：记录 Host reload 时缓存未变化 Suite Module 的策略、边界和后果。 |
| `docs/i18n/zh-CN/docs/adr/0007-initialize-configured-context-before-editor-readiness.md` | 中文镜像：记录编辑器就绪前初始化已配置 Context 的启动顺序决定。 |
| `docs/i18n/zh-CN/docs/adr/0008-own-the-context-command-surface.md` | 中文镜像：记录 Context 模块拥有 `/ctx` 命令面及其输出、可读性和生命周期契约的决定。 |
| `docs/i18n/zh-CN/docs/adr/0009-align-code-mode-with-openai-and-cloudflare.md` | 中文镜像：记录 Code Mode 与 OpenAI、Cloudflare 对齐后的 Provider、审批、恢复和 Host 边界。 |
| `docs/i18n/zh-CN/docs/adr/0012-merge-pi-stuff-settings-file.md` | 中文镜像：记录使用单一合并设置文件、启动只读、共享 I/O 和旧格式兼容的决定。 |
| `docs/i18n/zh-CN/docs/adr/0015-certify-the-upstream-release-binary.md` | 中文镜像：记录认证上游 Pi 发布二进制的方法、证据和发布后果。 |
| `docs/i18n/zh-CN/docs/adr/0017-project-chart-and-tree-fences-inside-conversation-markdown.md` | 中文镜像：记录在 Conversation Markdown 中投影 chart/tree fence 的方案和取舍。 |
| `docs/i18n/zh-CN/docs/adr/0018-end-live-v1-agent-governor-coexistence.md` | 中文镜像：记录结束 live v1 Agent governor 共存的迁移决定和生命周期后果。 |
| `docs/i18n/zh-CN/docs/adr/0019-isolate-context-engine-work-from-the-host-ui-thread.md` | 中文镜像：记录把 Context engine 工作移出 Host UI 线程的并发边界和拒绝方案。 |
| `docs/i18n/zh-CN/docs/adr/0020-add-automatic-session-naming.md` | 中文镜像：记录在 settled user-work 边界自动命名 Session 的触发和恢复规则。 |
| `docs/i18n/zh-CN/docs/adr/0021-fork-ponytail-as-a-suite-capability.md` | 中文镜像：记录把 Ponytail fork 作为 Suite Capability 集成的范围与后果。 |
| `docs/i18n/zh-CN/docs/adr/0022-restrict-folding-to-native-retrieval.md` | 中文镜像：记录 compact folding 只用于 native retrieval 的归属、投影和生命周期边界。 |
| `docs/i18n/zh-CN/docs/adr/0023-use-a-closed-operation-block-family.md` | 中文镜像：记录采用封闭 Operation Block 类型族的理由、范围和后果。 |
| `docs/i18n/zh-CN/docs/agents/domain.md` | 中文镜像：说明 Agent 领域文档的阅读顺序、目录布局、术语和架构决策归属。 |
| `docs/i18n/zh-CN/docs/agents/issue-tracker.md` | 中文镜像：规定 Beads、GitHub Issue 镜像、work map、PR 分诊和工作项来源记录流程。 |
| `docs/i18n/zh-CN/docs/agents/triage-labels.md` | 中文镜像：定义 Issue 分诊可使用的规范标签及每个标签的含义。 |
| `docs/i18n/zh-CN/docs/architecture.md` | 中文镜像：描述 Suite 组合、运行时加载、生命周期所有权、配置数据流和设计权威。 |
| `docs/i18n/zh-CN/docs/capabilities/background-work.md` | 中文镜像：指导后台 Shell、Monitor、容量、完成通知以及关闭后的恢复。 |
| `docs/i18n/zh-CN/docs/capabilities/btw.md` | 中文镜像：指导 BTW 支线问答的启动、上下文、历史、控制和答案提升。 |
| `docs/i18n/zh-CN/docs/capabilities/code-mode.md` | 中文镜像：指导 Code Mode 的 Provider、沙箱、目录输出、Tool UI、审批和恢复。 |
| `docs/i18n/zh-CN/docs/capabilities/codex.md` | 中文镜像：指导 Codex Responses、Fast mode、认证、用量和专属 Tool。 |
| `docs/i18n/zh-CN/docs/capabilities/context-management.md` | 中文镜像：指导 Context 的 retrieval、memory、note、compaction、压力处理和恢复。 |
| `docs/i18n/zh-CN/docs/capabilities/conversation-ui.md` | 中文镜像：指导 Welcome、Statusline、输入、Thought、chart/tree 和诊断等对话界面。 |
| `docs/i18n/zh-CN/docs/capabilities/goal.md` | 中文镜像：指导 Goal 的生命周期、续行、完成/阻塞判定、状态栏和压缩恢复。 |
| `docs/i18n/zh-CN/docs/capabilities/mcp.md` | 中文镜像：指导 MCP server 配置、gateway Tool、连接、认证、输出和诊断。 |
| `docs/i18n/zh-CN/docs/capabilities/notification.md` | 中文镜像：指导工作结算后的终端通知、tmux passthrough、隐私和响铃行为。 |
| `docs/i18n/zh-CN/docs/capabilities/ponytail.md` | 中文镜像：指导 Ponytail 模式、命令、设置、Prompt、Skills 和 Agent 作用域。 |
| `docs/i18n/zh-CN/docs/capabilities/rtk.md` | 中文镜像：指导 RTK 安装、命令重写、模型输出投影、验证和节省统计。 |
| `docs/i18n/zh-CN/docs/capabilities/session-naming.md` | 中文镜像：指导自动 Session 命名的触发、模型路由、隐私上下文和恢复。 |
| `docs/i18n/zh-CN/docs/capabilities/subagents.md` | 中文镜像：指导 Agents 的单个/并行委派、工具形状、控制和前后台行为。 |
| `docs/i18n/zh-CN/docs/capabilities/todo.md` | 中文镜像：指导 Todo 项、状态转换、依赖关系、可见清单和 Session 状态。 |
| `docs/i18n/zh-CN/docs/capabilities/tool-display.md` | 中文镜像：指导 Retrieval Group、Operation Block、活动状态、详情和计时器显示。 |
| `docs/i18n/zh-CN/docs/capabilities/web.md` | 中文镜像：指导 Web 搜索、公开 HTTP 抓取、Provider 路由和配置。 |
| `docs/i18n/zh-CN/docs/code-quality.md` | 中文镜像：规定 Repository-owned Source 的质量门槛和 Thermo-Nuclear 完成审查要求。 |
| `docs/i18n/zh-CN/docs/compatibility.md` | 中文镜像：记录已认证的 Pi Host、Bun、RTK 和直接依赖版本及兼容约束。 |
| `docs/i18n/zh-CN/docs/getting-started.md` | 中文镜像：指导安装环境、安装 Package、选择主题、运行首批命令和配置可选集成。 |
| `docs/i18n/zh-CN/docs/readme-style.md` | 中文镜像：规定各类 README 的职责、内容边界、徽章、截图、链接和翻译方式。 |
| `docs/i18n/zh-CN/docs/reference/commands.md` | 中文镜像：集中列出 Pi Stuff 的命令、参数和对应使用场景。 |
| `docs/i18n/zh-CN/docs/reference/settings.md` | 中文镜像：集中说明合并设置文件、各 Capability 的配置键、默认值和作用。 |
| `docs/i18n/zh-CN/docs/reference/themes.md` | 中文镜像：说明可用主题、选择方法、语义颜色映射和许可证来源。 |
| `docs/i18n/zh-CN/docs/releases/0.1.0.md` | 中文镜像：记录 Pi Stuff 0.1.0 候选版的功能范围、安装方式和当时认证状态。 |
| `docs/i18n/zh-CN/docs/releases/0.2.1.md` | 中文镜像：记录 Pi Stuff 0.2.1 候选版的完整 Capability 集、安装和认证快照。 |
| `docs/i18n/zh-CN/docs/releases/0.2.2.md` | 中文镜像：记录 Pi Stuff 0.2.2 候选版的日常使用修复、安装和认证快照。 |
| `docs/i18n/zh-CN/docs/reports/README.md` | 中文镜像：作为报告索引，导航验收、设计、迁移和性能证据。 |
| `docs/i18n/zh-CN/docs/reports/context-submit-concurrency-research-2026-08-14.md` | 中文镜像：保留 Context 提交时的渲染顺序事实，并说明 Worker 如何取代早期屏障。 |
| `docs/i18n/zh-CN/docs/reports/pi-stuff-0.3.0-final-acceptance.md` | 中文镜像：汇总 0.3.0 的归档身份、真实 Session、Magic-only gate 和检查结果。 |
| `docs/i18n/zh-CN/docs/reports/pi-stuff-lifecycle-performance.md` | 中文镜像：记录 schema 6 生命周期测量契约、历史结果摘要和当前预算。 |
| `docs/i18n/zh-CN/docs/reports/ps-8z1-final-acceptance-2026-08-29.md` | 中文镜像：记录 Bead `ps-8z1` 的最终验收范围、直接证据和结论。 |
| `docs/i18n/zh-CN/docs/reports/single-package-migration.md` | 中文镜像：保留旧 Package 到现行 Module 的映射和 Runtime Resource 去向。 |
| `docs/i18n/zh-CN/docs/research/README.md` | 中文镜像：作为研究索引，导航保留的产品参考、实验和设计调查。 |
| `docs/i18n/zh-CN/docs/research/agent-activity-ui-reference.md` | 中文镜像：比较 Claude Code 与 Pi Subagents 的 Agent 活动 UI、生命周期和可见表面。 |
| `docs/i18n/zh-CN/docs/research/claude-code-tool-grouping-narrative-boundary-20260826.md` | 中文镜像：研究 Claude Code 的 Tool 分组与叙事边界，为 Pi Stuff 展示边界提供依据。 |
| `docs/i18n/zh-CN/docs/research/claude-code-transcript-source-decisions.md` | 中文镜像：基于源码记录 Claude Code Transcript 的结构和相关决策证据。 |
| `docs/i18n/zh-CN/docs/research/code-mode-image-benchmark-20260827.md` | 中文镜像：预注册 Code Mode 图片任务基准的假设、变量、判定和实验协议。 |
| `docs/i18n/zh-CN/docs/research/code-volume-reduction-20260823.md` | 中文镜像：记录 Pi Stuff 代码量削减前后的测量结果和减少来源。 |
| `docs/i18n/zh-CN/docs/research/live-only-thoughts-feasibility-20260813.md` | 中文镜像：评估 Pi 0.84.1 只实时显示 Thoughts、不持久化的可行性。 |
| `docs/i18n/zh-CN/docs/research/notification-capability-reference.md` | 中文镜像：调查 Notification Capability 的行为、边界和可复用实现参考。 |
| `docs/i18n/zh-CN/docs/research/pi-latest-markdown-transform-20260820.md` | 中文镜像：记录 Pi Markdown transformation API 的已验证事实和适用边界。 |
| `docs/i18n/zh-CN/docs/research/pi-stuff-operation-block-dialog-study-20260829.md` | 中文镜像：研究 Operation Block 与 Tool Dialog 的结构、状态和展示决定。 |
| `docs/i18n/zh-CN/docs/research/pi-stuff-tool-activity-taxonomy-20260806.md` | 中文镜像：建立 Tool activity 分类法及各类活动的展示边界。 |
| `docs/i18n/zh-CN/docs/research/pi-tmux-kitty-images-feasibility-20260815.md` | 中文镜像：评估 tmux 中使用 Kitty 图片协议显示 Pi 图片的可行性。 |
| `docs/i18n/zh-CN/docs/research/pi-xdg-base-directory-20260811.md` | 中文镜像：记录 Pi/Pi Stuff 的 XDG 目录行为、路径约束和实现依据。 |
| `docs/i18n/zh-CN/docs/research/skill-discovery-benchmark-20260830.md` | 中文镜像：预注册Skill Discovery 首轮真实模型基准的假设、变量、步骤和冻结判定。 |
| `docs/i18n/zh-CN/docs/research/skill-discovery-confirmation-20260830.md` | 中文镜像：预注册修正 Tool allowlist 后的 Skill Discovery 确认实验的假设、变量、步骤和冻结判定。 |
| `docs/i18n/zh-CN/docs/research/skill-discovery-direct-read-20260830.md` | 中文镜像：预注册直接读取 Skill 内容的 Skill Discovery 实验的假设、变量、步骤和冻结判定。 |
| `docs/i18n/zh-CN/docs/research/skill-discovery-isolated-confirmation-20260830.md` | 中文镜像：预注册隔离 Context worker 混淆因素后的 Skill Discovery 确认实验的假设、变量、步骤和冻结判定。 |
| `docs/i18n/zh-CN/docs/research/skill-discovery-startup-bounded-confirmation-20260830.md` | 中文镜像：预注册拆分冷启动与 RPC 时序后的 Skill Discovery 有界确认实验的假设、变量、步骤和冻结判定。 |
| `docs/i18n/zh-CN/docs/research/work-background-notification-ui-reference.md` | 中文镜像：研究后台 Agent/Shell 完成、失败、停止和权限场景对应的 UI。 |
| `docs/i18n/zh-CN/docs/research/work-background-package-reference.md` | 中文镜像：比较后台任务 Package，并记录采用 `pi-background-tasks@2.0.0` fork 的依据。 |
| `docs/i18n/zh-CN/docs/research/work-btw-package-reference.md` | 中文镜像：比较 BTW Package，并记录采用 `@juicesharp/rpiv-btw@2.3.1` fork 的依据。 |
| `docs/i18n/zh-CN/docs/research/work-btw-ui-reference.md` | 中文镜像：比较 BTW 的单次问答、侧线程和邮箱 UI 生命周期并记录所选方案。 |
| `docs/i18n/zh-CN/docs/research/work-todo-ui-reference.md` | 中文镜像：比较 Todo 可见性方案，并记录采用最多五行清单的 UI 决定。 |
| `docs/i18n/zh-CN/docs/troubleshooting.md` | 中文镜像：按安装、设置、Context、Web、MCP、通知和图片等场景提供排障办法。 |
| `docs/i18n/zh-CN/packages/pi-stuff/README.md` | 中文镜像：作为 Package 入口，介绍安装方式、能力组成、常用命令和文档链接。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/background-work/README.md` | 中文镜像：Background Work Module README：说明后台 Shell、Monitor、容量和恢复的模块契约。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/background-work/UPSTREAM.md` | 中文镜像：记录 Background Work 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/btw/README.md` | 中文镜像：BTW Module README：说明 BTW 支线问答、后台执行和用户交互的模块契约。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/btw/UPSTREAM.md` | 中文镜像：记录 BTW 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/code-mode/README.md` | 中文镜像：Code Mode Module README：说明 Code Mode 的 Provider、沙箱、工具组合和运行行为。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/code-mode/UPSTREAM.md` | 中文镜像：记录 Code Mode 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/codex/README.md` | 中文镜像：Codex Module README：说明 Codex Responses、认证、Fast mode、用量和 Tool 集成。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/codex/UPSTREAM.md` | 中文镜像：记录 Codex 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/context-management/README.md` | 中文镜像：Context Management Module README：说明 Context 投影、检索、记忆、压缩和压力处理。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/context-management/UPSTREAM.md` | 中文镜像：记录 Context Management 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/conversation-ui/README.md` | 中文镜像：Conversation UI Module README：说明对话渲染、输入、状态栏、Thought 和可见状态。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/conversation-ui/UPSTREAM.md` | 中文镜像：记录 Conversation UI 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/goal/README.md` | 中文镜像：Goal Module README：说明 Goal 生命周期、续跑、完成/阻塞和终止策略。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/goal/UPSTREAM.md` | 中文镜像：记录 Goal 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/mcp/README.md` | 中文镜像：MCP Module README：说明 MCP gateway、连接、认证、工具和资源边界。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/mcp/UPSTREAM.md` | 中文镜像：记录 MCP 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/mcp/runtime/README.md` | 中文镜像：MCP Runtime Module README：说明 MCP Runtime 的运行时资源、执行环境和适配边界。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/mcp/runtime/UPSTREAM.md` | 中文镜像：记录 MCP Runtime 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/notification/README.md` | 中文镜像：Notification Module README：说明终端通知、tmux、隐私和响铃投递行为。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/ponytail/README.md` | 中文镜像：Ponytail Module README：说明 Ponytail 的反过度工程规则、模式、命令和集成。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/ponytail/UPSTREAM.md` | 中文镜像：记录 Ponytail 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/rtk/README.md` | 中文镜像：RTK Module README：说明 RTK 命令重写、模型输出投影和运行时验证。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/rtk/UPSTREAM.md` | 中文镜像：记录 RTK 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/session-naming/README.md` | 中文镜像：Session Naming Module README：说明 Session 自动命名的触发、模型路由和命名规则。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/session-naming/UPSTREAM.md` | 中文镜像：记录 Session Naming 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/subagents/README.md` | 中文镜像：Agents Module README：说明 child Agent 委派、生命周期、控制和执行边界。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/subagents/UPSTREAM.md` | 中文镜像：记录 Agents 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/todo/README.md` | 中文镜像：Todo Module README：说明 Todo 项、状态、依赖和会话内可见清单。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/todo/UPSTREAM.md` | 中文镜像：记录 Todo 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/tool-display/README.md` | 中文镜像：Tool Display Module README：说明 Tool 调用的分组、折叠、活动状态和详情显示。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/tool-display/UPSTREAM.md` | 中文镜像：记录 Tool Display 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/web/README.md` | 中文镜像：Web Module README：说明 Web 搜索、抓取、Provider 路由和工具行为。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/web/UPSTREAM.md` | 中文镜像：记录 Web 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/web/runtime/README.md` | 中文镜像：Web Runtime Module README：说明 Web Runtime 的资源、执行环境和网络适配边界。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/web/runtime/SECURITY.md` | 中文镜像：规定 Web Runtime 的凭据、SSRF、网络请求和敏感输出安全边界。 |
| `docs/i18n/zh-CN/packages/pi-stuff/src/web/runtime/UPSTREAM.md` | 中文镜像：记录 Web Runtime 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `docs/i18n/zh-CN/packages/pi-stuff/themes/README.md` | 中文镜像：说明主题文件格式、安装方式、四种 Catppuccin 风味和颜色映射。 |

## Pi Stuff Package (80)

| File | 作用 |
| --- | --- |
| `packages/pi-stuff/LICENSE` | 保存 Pi Stuff Package 的 MIT 许可证和版权声明。 |
| `packages/pi-stuff/README.md` | 作为 Package 入口，介绍安装方式、能力组成、常用命令和文档链接。 |
| `packages/pi-stuff/package.json` | 声明 Package 名称、版本、Pi 入口、依赖、发布文件和脚本。 |
| `packages/pi-stuff/src/background-work/LICENSE` | 保存 Background Work 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/background-work/README.md` | Background Work Module README：说明后台 Shell、Monitor、容量和恢复的模块契约。 |
| `packages/pi-stuff/src/background-work/UPSTREAM.md` | 记录 Background Work 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/btw/LICENSE` | 保存 BTW 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/btw/README.md` | BTW Module README：说明 BTW 支线问答、后台执行和用户交互的模块契约。 |
| `packages/pi-stuff/src/btw/UPSTREAM.md` | 记录 BTW 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/btw/prompts/btw-system.txt` | 提供 BTW 后台问答运行时使用的系统提示词，约束回答范围和输出方式。 |
| `packages/pi-stuff/src/code-mode/LICENSE` | 保存 Code Mode 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/code-mode/LICENSES/Apache-2.0.txt` | 保存 Code Mode 引入第三方内容所适用的 Apache-2.0 许可证正文。 |
| `packages/pi-stuff/src/code-mode/LICENSES/Cloudflare-MIT.txt` | 保存 Code Mode 引入第三方内容所适用的 Cloudflare-MIT 许可证正文。 |
| `packages/pi-stuff/src/code-mode/README.md` | Code Mode Module README：说明 Code Mode 的 Provider、沙箱、工具组合和运行行为。 |
| `packages/pi-stuff/src/code-mode/THIRD_PARTY_NOTICES.md` | 列出 Code Mode 包含的第三方来源、版权和许可证归属。 |
| `packages/pi-stuff/src/code-mode/UPSTREAM.md` | 记录 Code Mode 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/codex/LICENSE` | 保存 Codex 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/codex/LICENSES/Apache-2.0.txt` | 保存 Codex 引入第三方内容所适用的 Apache-2.0 许可证正文。 |
| `packages/pi-stuff/src/codex/README.md` | Codex Module README：说明 Codex Responses、认证、Fast mode、用量和 Tool 集成。 |
| `packages/pi-stuff/src/codex/THIRD_PARTY_NOTICES.md` | 列出 Codex 包含的第三方来源、版权和许可证归属。 |
| `packages/pi-stuff/src/codex/UPSTREAM.md` | 记录 Codex 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/context-management/LICENSE` | 保存 Context Management 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/context-management/README.md` | Context Management Module README：说明 Context 投影、检索、记忆、压缩和压力处理。 |
| `packages/pi-stuff/src/context-management/UPSTREAM.md` | 记录 Context Management 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/conversation-ui/LICENSE` | 保存 Conversation UI 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/conversation-ui/LICENSES/Howaboua-MIT.txt` | 保存 Conversation UI 引入第三方内容所适用的 Howaboua-MIT 许可证正文。 |
| `packages/pi-stuff/src/conversation-ui/README.md` | Conversation UI Module README：说明对话渲染、输入、状态栏、Thought 和可见状态。 |
| `packages/pi-stuff/src/conversation-ui/THIRD_PARTY_NOTICES.md` | 列出 Conversation UI 包含的第三方来源、版权和许可证归属。 |
| `packages/pi-stuff/src/conversation-ui/UPSTREAM.md` | 记录 Conversation UI 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/goal/LICENSE` | 保存 Goal 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/goal/README.md` | Goal Module README：说明 Goal 生命周期、续跑、完成/阻塞和终止策略。 |
| `packages/pi-stuff/src/goal/UPSTREAM.md` | 记录 Goal 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/mcp/LICENSE` | 保存 MCP 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/mcp/README.md` | MCP Module README：说明 MCP gateway、连接、认证、工具和资源边界。 |
| `packages/pi-stuff/src/mcp/UPSTREAM.md` | 记录 MCP 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/mcp/runtime/LICENSE` | 保存 MCP Runtime 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/mcp/runtime/README.md` | MCP Runtime Module README：说明 MCP Runtime 的运行时资源、执行环境和适配边界。 |
| `packages/pi-stuff/src/mcp/runtime/UPSTREAM.md` | 记录 MCP Runtime 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/notification/README.md` | Notification Module README：说明终端通知、tmux、隐私和响铃投递行为。 |
| `packages/pi-stuff/src/ponytail/LICENSE.upstream` | 保存 Ponytail 上游项目的原始许可证，供 fork 的授权与归属审计。 |
| `packages/pi-stuff/src/ponytail/README.md` | Ponytail Module README：说明 Ponytail 的反过度工程规则、模式、命令和集成。 |
| `packages/pi-stuff/src/ponytail/THIRD_PARTY_NOTICES.md` | 列出 Ponytail 包含的第三方来源、版权和许可证归属。 |
| `packages/pi-stuff/src/ponytail/UPSTREAM.md` | 记录 Ponytail 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/ponytail/UPSTREAM.sha256` | 记录 Ponytail 上游资源的 SHA-256，验证同步快照没有被意外改写。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail-audit/SKILL.md` | 指导对整个仓库做过度工程审计并列出可删除内容。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail-debt/SKILL.md` | 指导收集 `ponytail:` 延期标记并形成债务清单。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail-gain/SKILL.md` | 定义如何展示 Ponytail 的代码量、成本和速度收益。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail-help/SKILL.md` | 提供 Ponytail 模式、技能和命令的快速参考。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail-review/SKILL.md` | 指导只针对过度工程问题做精简审查。 |
| `packages/pi-stuff/src/ponytail/skills/ponytail/SKILL.md` | 定义 Ponytail 主模式的最小实现、YAGNI 和验证规则。 |
| `packages/pi-stuff/src/rtk/LICENSE` | 保存 RTK 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/rtk/README.md` | RTK Module README：说明 RTK 命令重写、模型输出投影和运行时验证。 |
| `packages/pi-stuff/src/rtk/UPSTREAM.md` | 记录 RTK 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/session-naming/LICENSE` | 保存 Session Naming 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/session-naming/README.md` | Session Naming Module README：说明 Session 自动命名的触发、模型路由和命名规则。 |
| `packages/pi-stuff/src/session-naming/UPSTREAM.md` | 记录 Session Naming 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/subagents/LICENSE` | 保存 Agents 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/subagents/README.md` | Agents Module README：说明 child Agent 委派、生命周期、控制和执行边界。 |
| `packages/pi-stuff/src/subagents/UPSTREAM.md` | 记录 Agents 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/todo/LICENSE` | 保存 Todo 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/todo/README.md` | Todo Module README：说明 Todo 项、状态、依赖和会话内可见清单。 |
| `packages/pi-stuff/src/todo/UPSTREAM.md` | 记录 Todo 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/tool-display/LICENSE` | 保存 Tool Display 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/tool-display/README.md` | Tool Display Module README：说明 Tool 调用的分组、折叠、活动状态和详情显示。 |
| `packages/pi-stuff/src/tool-display/UPSTREAM.md` | 记录 Tool Display 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/web/LICENSE` | 保存 Web 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/web/README.md` | Web Module README：说明 Web 搜索、抓取、Provider 路由和工具行为。 |
| `packages/pi-stuff/src/web/UPSTREAM.md` | 记录 Web 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/src/web/runtime/LICENSE` | 保存 Web Runtime 随附的开源许可证，明确使用和分发义务。 |
| `packages/pi-stuff/src/web/runtime/README.md` | Web Runtime Module README：说明 Web Runtime 的资源、执行环境和网络适配边界。 |
| `packages/pi-stuff/src/web/runtime/SECURITY.md` | 规定 Web Runtime 的凭据、SSRF、网络请求和敏感输出安全边界。 |
| `packages/pi-stuff/src/web/runtime/UPSTREAM.md` | 记录 Web Runtime 的上游来源、版本或 commit、同步范围和本地偏差。 |
| `packages/pi-stuff/suite.json` | 定义 Suite 要装配的 Module、加载顺序和各模块配置，是生成组合代码的来源。 |
| `packages/pi-stuff/themes/LICENSE` | 保存 bundled themes 的许可证和归属信息。 |
| `packages/pi-stuff/themes/README.md` | 说明主题文件格式、安装方式、四种 Catppuccin 风味和颜色映射。 |
| `packages/pi-stuff/themes/catppuccin-frappe.json` | 定义 Catppuccin Frappé 主题的终端和 Pi UI 语义色值。 |
| `packages/pi-stuff/themes/catppuccin-latte.json` | 定义 Catppuccin Latte 主题的终端和 Pi UI 语义色值。 |
| `packages/pi-stuff/themes/catppuccin-macchiato.json` | 定义 Catppuccin Macchiato 主题的终端和 Pi UI 语义色值。 |
| `packages/pi-stuff/themes/catppuccin-mocha.json` | 定义 Catppuccin Mocha 主题的终端和 Pi UI 语义色值。 |
| `packages/pi-stuff/tsconfig.json` | 定义 Package 源码的 TypeScript 编译目标、模块解析和类型检查范围。 |

## Test data (11)

| File | 作用 |
| --- | --- |
| `tests/fixtures/skill-discovery-benchmark-manifest.jsonl` | 定义 Skill Discovery 首轮真实模型基准的固定任务、目标与干扰 Skill、提示词、期望 token、arm 顺序和 fixture 哈希。 |
| `tests/fixtures/skill-discovery-benchmark-run-lock.json` | 冻结 Skill Discovery 首轮真实模型基准使用的候选 commit、Package tree、Pi Host、manifest 哈希和运行配置，保证结果可复现。 |
| `tests/fixtures/skill-discovery-confirmation-manifest.jsonl` | 定义修正 Tool allowlist 后的 Skill Discovery 确认实验的固定任务、目标与干扰 Skill、提示词、期望 token、arm 顺序和 fixture 哈希。 |
| `tests/fixtures/skill-discovery-confirmation-run-lock.json` | 冻结修正 Tool allowlist 后的 Skill Discovery 确认实验使用的候选 commit、Package tree、Pi Host、manifest 哈希和运行配置，保证结果可复现。 |
| `tests/fixtures/skill-discovery-direct-read-manifest.jsonl` | 定义直接读取 Skill 内容的 Skill Discovery 实验的固定任务、目标与干扰 Skill、提示词、期望 token、arm 顺序和 fixture 哈希。 |
| `tests/fixtures/skill-discovery-direct-read-run-lock.json` | 冻结直接读取 Skill 内容的 Skill Discovery 实验使用的候选 commit、Package tree、Pi Host、manifest 哈希和运行配置，保证结果可复现。 |
| `tests/fixtures/skill-discovery-isolated-confirmation-manifest.jsonl` | 定义隔离 Context worker 混淆因素后的 Skill Discovery 确认实验的固定任务、目标与干扰 Skill、提示词、期望 token、arm 顺序和 fixture 哈希。 |
| `tests/fixtures/skill-discovery-isolated-confirmation-run-lock.json` | 冻结隔离 Context worker 混淆因素后的 Skill Discovery 确认实验使用的候选 commit、Package tree、Pi Host、manifest 哈希和运行配置，保证结果可复现。 |
| `tests/fixtures/skill-discovery-startup-bounded-confirmation-manifest.jsonl` | 定义拆分冷启动与 RPC 时序后的 Skill Discovery 有界确认实验的固定任务、目标与干扰 Skill、提示词、期望 token、arm 顺序和 fixture 哈希。 |
| `tests/fixtures/skill-discovery-startup-bounded-confirmation-run-lock.json` | 冻结拆分冷启动与 RPC 时序后的 Skill Discovery 有界确认实验使用的候选 commit、Package tree、Pi Host、manifest 哈希和运行配置，保证结果可复现。 |
| `tests/fixtures/smoke-package/package.json` | 声明一个最小 Pi Extension 测试 Package，用于验证扩展发现、加载和打包 smoke。 |
