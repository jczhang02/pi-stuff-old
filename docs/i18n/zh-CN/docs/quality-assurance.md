<!-- translation-source: docs/quality-assurance.md; translation-source-sha256: befdab094f145bc2a033775d8fb2e7f08f3ce1b3ee592e632077b82199ffd134 -->

# 质量保障

Static Checks 验证源码，不运行产品场景。Tests 通过声明的接缝证明行为；Capability Benchmarks 独立测量性能或效果；Reviews 评估需求、设计、安全、可维护性与证据质量。

[测试目录导览](../tests/README.md) 介绍五个测试层级、共享夹具和固定 benchmark 输入。

## 当前命令

```bash
bun run check
bun run fix
bun run test --list
bun run test --level acceptance --file repository/source-install.test.ts
bun run test --level component-integration --file goal/goal-runtime.test.mjs
bun run test --level acceptance --capability code-mode --matrix representative
bun run verify --keep-going
bun run benchmark:capability:ponytail --help
bun run benchmark:suite:terminal-bench --help
```

`check` 执行格式、lint、TypeScript、依赖和未使用源码、生成组合、仓库安全、Capability Contract Catalog 以及 Package/resource/license 静态验证；不会改写源码或运行 Benchmark。`fix` 才会执行格式和安全 lint 修复。

`test` 当前发现五个层级下的 340 个文件（334 个离线文件、1 个显式在线文件）：Component (`unit`)、Component Integration (`component-integration`)、System (`system`)、System Integration (`system-integration`) 与 Acceptance (`acceptance`)。离线清单按上述层级分别有 135、159、2、10、28 个文件。目录按 `level/capability/scenario` 组织，每个文件独立 OS process。Goal smoke 是原生 Bun test；其余 21 个 `.node.ts` 保留 Node 兼容边界，只编译一次后运行。同一维度的重复 selector 取并集，不同维度取交集。`--name` 使用原生 test runner 的 regex candidate filter，不扫描源码名称。`--help` 和 `--list` 不执行场景。报告默认写入 `.artifacts/tests/`，记录文件状态、process duration、setup duration 和 Acceptance 矩阵；失败或空选择返回非零。

Tests 在首个失败后停止剩余文件；缺少原生执行证据同样算失败。`--keep-going` 收集全部选中文件的结果，但不会把失败变成成功；`verify --keep-going` 也会在 Checks 命令失败后继续运行 Tests。每个文件开始前和结束后都持久化报告，区分已完成、尚未开始，以及执行中断时最后记录为进行中的文件。缺失、取消或未完成的证据不能通过 CI 汇总。

默认 profile 是 `offline`：使用 deterministic fixture Provider，不需要凭据，也不调用 live model。需要真实边界的场景仍要求 Real Pi、Node、Code Mode、RTK、Expect、tmux 和本地工具；缺失要求会使 preflight 或场景失败。Live Provider/Service 证据必须显式使用 `--profile live`；唯一的 live Magic Context 场景是 `magic-context-live`。`--list` 只报告工具要求，不执行 setup。

Pi、RTK 优先使用显式 `PI_BIN` / `RTK_BIN`，再查找 `PATH`（Pi 会排除 package manager 注入的 `node_modules/.bin`，避免开发 SDK 的 CLI 遮蔽已安装 Host）。复用已有受支持版本，包括 RTK 源码构建与 shim；本地命令不下载或重装。预检在依赖测试执行前报告选中路径，区分程序缺失、文件不可执行、版本不符和版本探测失败。固定 Pi/RTK 二进制哈希不是准入门槛。干净 CI runner 单独准备依赖，下载完整性检查不能代替真实行为测试。RTK PTY 夹具精确执行 `RTK_BIN` 选择的程序，即使其文件名不是 `rtk`。

## 源码安装与保留证据

`tests/acceptance/repository/source-install.test.ts` 在隔离 Settings 和 XDG 目录中运行认证 Pi 的 `install`，再从 checkout 外启动 Pi，观察已安装 Package 加载的命令，并清理临时环境。Distribution archive 不是交付要求。原 package-verification aggregate 重复的 Host/PTY 场景已移除；源码安装、Suite inspection、Host seam 和依赖互操作各自在相应层级与 Capability 下拥有主归属。

## Benchmarks

现有实验使用 `benchmark:capability:<name>` 命名，保留 Ponytail、Markdown、生命周期、Magic Context 和 Tool Activity。它们是 Capability 范围问题，不建立 complete-Suite public-task 结果。执行前使用 `--help` 或 `--list`；Ponytail 必须显式选择 `--profile live`。历史报告仍是 dated evidence，新报告默认写入本地 artifacts。已移除的 Effect/mainline、Code Mode 图片和 Skill Discovery 实验可从 Git 历史恢复；保留其带日期报告和锁定输入作为历史证据。

完成的实验即使结果较差也可成功；setup failure 或 incomplete experiment 仍失败。Tool Activity 过去的 250 ms 和 relative 25 ms benchmark 值仅保留为诊断报告值。显式 PTY 要求仍为首个 Tool UI/input/selection 反馈 150 ms，以及不变 Vibe Line Spinner 帧不超过 200 ms；ADR 0025 的 500 ms severe-stall 是独立 backstop。Tools PTY 验证器报告每种终端尺寸的测量值，未满足必需目标时失败。`benchmark:suite` 尚未注册。

Suite Outcome Evaluation 使用公开任务评测完整 Suite。具体入口是 `benchmark:suite:terminal-bench`；通用别名 `benchmark:suite` 仍未注册。

### 本地 Terminal-Bench 评测

```bash
bun run benchmark:suite:terminal-bench --help
bun run benchmark:suite:terminal-bench --list
bun run benchmark:suite:terminal-bench
bun run benchmark:suite:terminal-bench --worktree .worktrees/my-change --task regex-log
bun run benchmark:suite:terminal-bench --resume .artifacts/terminal-bench/<evaluation>
```

执行命令会显式启动使用 Harbor 0.22.0 和本地 Docker 兼容容器的真实评测，不上传结果、不使用 Runta。默认采用锁定的 Terminal-Bench 2.1 数据集，完整 89 题，每题一次尝试，两个并发容器。`--task` 接受准确题名，可重复传入该选项选择不同题目；`--repetitions` 和 `--concurrency` 接受正整数。单次重复是本地观察，不是官方每题五次的排行榜协议。帮助和任务预览无需凭据，不启动环境准备、容器或模型调用。`check`、`test` 和 `verify` 均不执行 benchmark。

评测源码默认来自本地 `main` 已提交版本，与执行命令所在 checkout 无关。`--worktree <path>` 选择同一仓库中已注册的 worktree，包含其未提交 Package 源码及依赖输入。执行前固定 `packages/pi-stuff`、根 package manifest、Bun lockfile 和 patches；排除无关工程文件，拒绝私密路径、越界或绝对符号链接。后续编辑不会影响剩余任务。`--output <directory>` 可指定新的本地 artifact 目录。

复用已安装且已认证的 Pi Host、Bun、RTK 和 Code Mode 可执行文件。Harbor、Docker CLI、Compose 依次从显式 `HARBOR_BIN`、`DOCKER_BIN`、`DOCKER_COMPOSE_BIN`、PATH、已有 mise 安装中解析；runner 不安装 Host 工具。显式准备示例为 `mise install pipx:harbor@0.22.0 docker-cli docker-compose`，仍需可工作的 Docker 兼容 daemon。`DOCKER_HOST` 优先于本机可用的 rootless Podman socket；Compose 插件配置仅属于当前调用。引擎、网络、镜像和任务资源故障仍属于基础设施失败；runner 不修改宿主防火墙，也不覆盖任务网络。

固定依赖通过 Bun frozen lockfile 安装，禁用生命周期脚本。每题先对挂载的 Package 执行真实 `pi install`，再启动 Pi。HOME、XDG 目录、Pi 设置和 Magic 存储相互隔离。固定配置提供一个通用委派 Agent，并启用 Suite 正常运行路径，包括 Goal、Agents、Magic historian/dreamer/sidekick 和 Session Naming。保留 Package Skills，不继承个人插件、Skills、模型覆盖或设置。所有可配置模型路径均为 GPT-5.6 Luna/max，没有 fallback model。观察器还将公共 simple-stream 请求固定为 max；Session Naming 等 Capability 配置不暴露推理设置的原生 API 调用保留 Provider 默认值，但仍计入用量。只把选定的 Pi 凭据复制到临时评测存储，调用结束后移除 staging 中的副本；每个容器使用其隔离副本。

保留 `protocol.json`、固定 assets、Harbor 原生配置和结果、原始 Agent 输出，以及每个 trial 的 `agent/usage.jsonl`。公共 Provider 观察器记录每次调用开始/完成、模型与定价、已报告用量以及进程/Agent 身份，覆盖委派和辅助调用。每五秒从运行中容器保存用量。`summary.json` 与进度行汇总所有记录，包括已归档中断尝试。美元金额是依据记录中模型价格计算的 Pi SDK 估算，不是账单；没有报告用量的调用保持未解决状态，不视为免费。分母始终为固定题数乘以重复次数，不以成功完成的子集为分母。

遵循上游任务时限，不额外设置全局美元上限，不自动重试。有效 reward-0 或 Agent timeout 属于已完成任务结果；setup/基础设施错误、缺失必需证据、未完成工作返回非零。Ctrl+C 请求 Harbor 停止并保留可获取证据。`--resume` 校验固定协议的摘要、assets 和配置，要求原始 Harbor job 状态存在，在 Harbor 可能删除未完成 attempt 目录之前将其归档，只在新容器中补做未完成 trials。不能与新的源码、任务或执行选项组合；不重跑已完成失败，也不暗中改变快照。中断请求未报告的用量可能在任务完成后仍未知，恢复不会补造缺失的费用证据。

TypeScript 接缝由离线测试覆盖；`check:terminal-bench` 使用 Python 3 检查 Python Harbor adapter 语法，无需 Harbor 或凭据。实际 benchmark 是维护者显式执行的操作，不作为实现完成的必需条件。

## 验证与迁移状态

第二批完成测试分类与精简、五层 Capability 目录迁移、稳定层级 aliases、过时 acceptance aliases 清理。Code Mode RPC/TUI 已有使用真实 Host 与 fixture Provider 的 offline Acceptance 归属；live Magic Context wrapper 仍单独存在且未运行。

第三批已实现受影响测试规划与 CI 编排。本地 `verify` 默认比较 `origin/main` 与当前 `HEAD` 的 merge-base，合并已提交、暂存、未暂存和未跟踪路径，并接受 `--base <ref>`。规划器从产品源码与离线测试文件出发，通过 TypeScript AST import 遍历共享辅助代码，并将 `.js` import 解析到 `.ts` 源码。验证依赖图中的未知导入触发全量。[动态依赖声明](../../../../config/verification-dependencies.json) 用导入文件的 SHA-256 绑定已审查的外部或本地加载边界；动态导入文件变化或没有声明时回退全量。未使用的 benchmark 脚本不会使每次局部修改都变成未知影响。共享脚本、配置、Suite 组合、Host 版本、删除路径及未知影响仍运行全套。仅当当前文件、index、`HEAD` 和 comparison base 的内容都证明 Markdown 或 Beads 元数据不含 executable fence 或脚本材料时，才可生成明确的 no-tests 计划。删除路径同样回退到完整离线套件。`--list` 只显示 base、head、reason、选中文件和环境要求，不运行 Checks 或 Tests；`--help` 不执行工作，未知参数严格失败。普通运行只读执行 `check`，随后运行选中的 offline Tests，并写入包含 plan、状态、耗时和 evidence paths 的时间戳 summary。

CI 使用 `Plan`、`Checks`、`Tests` 分片和 `Verify`。Plan 选择 PR target range 或 main push 的 before/after range。Checks 独立运行，Tests 只等待 Plan；每个分片在独立 runner 上串行运行其文件，保留逐文件进程隔离。矩阵遇到失败后停止其余分片。Verify 检查必要 job 结果、完整且不重复的文件覆盖、声明的矩阵及每份报告的完成状态；仅文件名并集完整不能证明成功。逐分片与汇总报告分别保留。同一 PR 的过时运行可取消，不同 main-push 范围保留；分支保护不变。

分片使用保留的[逐文件耗时](../../../../config/verification-timings.json)，按预计最长任务优先分配。在 1–16 个 runner 中选择预计完成时间最短的最小数量；新文件初始估计为一秒。独立 runner 并行准备环境，因此不把准备时间乘以分片数计入墙钟耗时。历史权重仅用于调度，不构成覆盖或超时门槛；必须报告实际 hosted 排队、准备和执行时间后才能声称提速。

手动触发始终选择完整离线清单与完整矩阵。夜间计划在 Asia/Shanghai 02:17（UTC 18:17）运行；只有同一 SHA 的 `main` 成功运行所保留的计划证明完整离线清单及完整矩阵时才复用。之前的局部或跳过运行不足以复用；证据缺失或过期时运行全量。复用计划记录 `previousFullRun`、相同的 base/head 和空 changedFiles。普通 PR 的合并前证据要求不变。

## Acceptance 代表组合

已知局部修改按五层选择所属 Capability 及相关连接；产品修改还保留仓库契约。Acceptance、System、System Integration 不再无条件增加无关成本。渲染、主题、终端或几何尺寸路径及相关修改文本使用完整矩阵，其他已知局部选择采用代表组合。共享、未知范围和完整清单计划保持全量。

`test` 默认 `--matrix full`，显式聚焦执行可以使用 `--matrix representative`。计划拥有矩阵选择，不能叠加覆盖参数。子进程通过 `PI_STUFF_ACCEPTANCE_MATRIX` 接收选择，环境变量不能削弱完整计划。`--list` 显示矩阵而不执行场景。仅减少重复尺寸和主题变体：

| Acceptance | 完整 | 代表组合及保留的独立行为 |
| --- | --- | --- |
| Code Mode TUI | 两种尺寸 | `100x32`；四种场景、Code/Direct、启动/恢复均保留 |
| Agents、Tools、BTW PTY | `100x32`、`64x28` | `100x32`；Tools 的工具配置对齐、正确性和响应性仍独立验证 |
| 综合 UI | 五种尺寸 | `100x32` 与 `64x28`，保留各自独有交互及缩放检查 |
| 主题生命周期 | 四种主题、两种尺寸 | Latte 与 Frappe（亮/暗）、`100x32`；真彩色、256 色及重载/恢复均保留 |
| User Message | 每种模式/主题五次缩放 | `64x28`、`24x16`、`100x32`；常规/全屏与暗/亮模式均保留 |

Agents 执行的八种情况、Magic 恢复的十二种情况及独有 Tool 分组场景保持不变。代表组合不认证未运行的变体。重复的 UI/Agents Host 加载检查复用 System 层 Suite Host 测试；Agent 路径身份及独有 Host peer/版本检查移到低层保留，仅删除重复 manifest/workspace 断言。

验证证据只适用于实际测试的 revision 和声明范围。应查看当前 CI `Verify` 结果及其 plan、test artifacts；历史通过记录不能认证后续修改。日期化的[迁移报告](reports/quality-assurance-migration-20260906.md) 记录检查点测量与可复用诊断，包括失败运行；交付 PR 记录最终验证。不同测试范围不能证明提速。已接受的边界见 [ADR 0032](../../../../docs/adr/0032-organize-quality-assurance-by-verification-purpose.md)。
