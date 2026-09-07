<!-- translation-source: docs/reports/quality-assurance-migration-20260906.md; translation-source-sha256: 38861328a12234001004de744a53842b37629cf95f422fc96df4913163a32e3f -->

# 质量保障迁移——2026-09-06

## 第一批：命令和执行边界

基线：`cac0e79a866c3973a1515a5044441e136f30652e`。这是检查点证据，不是整个
[迁移设计](../adr/0032-organize-quality-assurance-by-verification-purpose.md)的最终验收。

| 证据 | 之前 | 第一批 |
| --- | --- | --- |
| `check` 范围 | 静态检查、全部测试、Tool Activity benchmark、归档／Host 聚合 | 只读静态检查，包括源码 Package 验证 |
| 普通测试 runner | Bun runner 加单独调用的 Goal runner；忽略参数 | 一个可选择的文件清单；Bun 与编译后的 Node 文件仍使用独立 OS 进程 |
| 重复 Host 验证器族 | Package 聚合再次调用十个已有测试的验证器族 | 删除十次调用；七个原先独有的调用有了主测试入口 |
| Package 聚合中的 Suite surface | 打包前后各一次 | 一个 inspector 场景；安装后的源码发现提供独立证据 |
| Package 交付证据 | 创建／提取归档 | 真实 `pi install`、隔离设置、checkout 外加载 |
| 变更涉及的实现／测试源码 | 4,525 物理行 | 4,856 物理行（+331） |

新增源码用于参数校验、报告、live profile 边界、真实安装证据和适量命令测试，没有新增依赖或第二套产品 runtime。
最大的变更文件仍低于 800 行门槛；独立审查评估了超过 500 行的文件，认为职责内聚。

本地 Linux x64、Bun 1.4.0 和 Pi 0.85.0 的聚焦执行结果：

- 命令预览、无效选择器、benchmark 发现、源码约束和选中的 Goal Node 测试通过。Node 执行前只编译一次；
  Node 测试报告三个用例共 6.64 ms。
- 源码安装耗时 3.29 秒。Suite inspector、Web fixture、Goal lifecycle、Notification PTY 和 Host seams 合计
  52.02 秒。MCP PTY 为 17.78 秒；RTK PTY 为 7.48 秒，均通过。
- Benchmark 命令测试 6.80 秒，源码 Package 测试 0.11 秒，Effect 比较工具测试 7.52 秒，均通过。
  Tool Activity 完成并写入本地 JSON 报告，比较耗时值不作为门禁。
- 集成后的 `bun run check` 通过。没有运行真实模型 benchmark。针对最终检查点源码，两轮连续独立
  Thermo-Nuclear 审查均无发现。

这些耗时的范围不同，不能相加当作完整测试耗时，也不代表迁移前后加速。基线与最终完整 CI 比较仍属于最终迁移证据。
本地 JSON 报告在忽略的 `.artifacts/tests/` 下，benchmark 报告独立存放。

## 第二批：测试分类与精简

基线为第一批检查点 `f506b4f1`；这是经过审查的第二批检查点。当前测试清单共 332 个文件（331 个离线文件、1 个显式在线文件）：Component 130、Component Integration 159、System 2、System Integration 10、Acceptance 31。目录采用 `level/capability/scenario`；helpers 保留在中性的 `test/<legacy-capability>` 位置。Goal smoke 已改名为 `test/component-integration/goal/goal-runtime.test.mjs` 并使用原生 Bun scenarios；其余 21 个 `.node.ts` 保留 Node 兼容边界，执行前只编译一次。

runner 支持 `--level`、`--capability`、`--file`、`--name`。同一维度的重复 selector 取并集，不同维度取交集；`--name` 是原生 regex candidate filter，不扫描源码名称。未知参数和空的显式选择失败。默认 profile 为 offline；live 必须显式使用 `--profile live`，唯一的 live Magic Context wrapper 是 `magic-context-live`。`--list` 只预览要求，不执行 setup。`.artifacts/tests/` 报告记录实际文件/process duration 与 setup duration；实际 tests 为零（包括 Node）时返回非零。

Code Mode RPC/TUI offline Acceptance wrapper 使用真实 Host 与 fixture Provider。Agent 执行结果：RPC 8.33 秒；TUI group/failure/media/cancel 113.48 秒，resume 宽度 100 和 64；Goal native name selection 0.52 秒；Unit selector 三个测试 1.2 秒；Node no-match 正确以零测试失败。Code Mode executable SHA-256 为 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`，已加入 compatibility。

真实 RTK 场景要求经过认证的可执行文件，显式缺失会失败。共享 test-environment helper 已实现前置检查。150 ms 首个 UI/input/selection 目标与 200 ms 不变 spinner 目标仍是显式 PTY 要求，ADR 0025 的 500 ms severe-stall 是独立 backstop，稳定 focused certification 尚未完成。本批未运行 full test suite、final CI/affected selection 或 live Magic Context；Batch 3 负责 affected selection 与 CI orchestration。


生成器测试删除了固定三个 wrapper 语句和 Goal 精确多行格式的断言。Capability 成员语义、Suite loader 行为与真实源码安装验收继续提供证据。

同机单次聚焦对比（含 Bun 启动）：生成器迁移前 `0.185 s`、迁移后 `0.168 s`；Suite loader 迁移前 `0.573 s`、迁移后 `0.504 s`。干净基线与当前 worktree 均通过；微小差异不能证明整体加速。本批涉及 JavaScript/TypeScript 源码的物理行数为迁移前 79,366、迁移后 79,824（+458），大部分源码随文件移动而保留。

Web 直接 Provider API 的重定向声明检查已归入 Static Checks，一个小型 Component 测试保护基于 AST 的声明计数；它保留旧有数量对应约束，不宣称证明请求数据流。Codex 原生工具检查不再因不支持或缺少可执行文件而跳过，真实本地二进制的三个场景已通过。缺少 Pi 的前置检查已验证：场景不执行，报告明确记录环境失败。静态检查、聚焦命令、原生工具、Node 兼容性和真实 Code Mode 验收检查已通过。针对完整 diff，两轮连续独立 Thermo-Nuclear 审查均无发现。

## 第三批：受影响测试选择与 CI 编排检查点

基线为第二批检查点 `35225c57`。第三批已有签名检查点与草稿 PR #230；最终离线和托管验收完成前，本节仍是检查点证据。当前清单为 334 个文件：333 个离线文件和 1 个显式在线文件。离线文件按 Component、Component Integration、System、System Integration、Acceptance 分别为 132、159、2、10、30 个。第二批记录的 332 个文件（331 个离线文件）保持不变；数量变化表示一个文件替换成了三个第三批规划、执行契约和 CI 聚合测试文件。

第三批实现了本地与 CI 的保守范围选择。本地 `verify` 默认使用 `origin/main` 与 `HEAD` 的 merge-base，合并已提交、暂存、未暂存和未跟踪路径，并接受 `--base <ref>`。规划器使用 AST 解析 TypeScript import，并沿测试 helper 的反向依赖遍历；`.js` import 可以解析到对应的 `.ts` 源文件。共享基础设施、未知路径、动态或不透明 import、无法解析的依赖以及删除路径都回退到全部离线 Tests。只有当当前文件、index、`HEAD` 和 comparison base 的内容都证明 Markdown 或 Beads 元数据不含 executable fence 或脚本材料时，才允许生成 narrow no-tests 计划。`--list` 预览 base、head、reason、选中文件和环境要求；`--help` 不执行工作，未知参数失败。普通运行只读执行 Checks，随后执行选中的 offline Tests，并写入包含 plan、状态、耗时和 evidence paths 的时间戳 summary。

CI workflow 拆为 `Plan`、`Checks`、`Tests`、`Verify`：Plan 选择 PR target range 或 main push 的 before/after range，manual dispatch 选择全部离线 Tests；Checks 独立运行，Tests 只依赖 Plan；Verify 校验 plan、每个必需 job 的结果、精确的选中文件覆盖和结构化 test report。Plan artifact 与 test report 分开上传，Verify 不重复执行实质工作。同一 PR 的 superseded run 可以取消，不同 main-push revision range 保留；branch protection 不变。

源代码规模比较使用 `35225c57` 到当前 worktree 的 git diff 路径集合中的 23 个 JS/TS 文件，包含新增未跟踪源码路径并排除 artifacts：物理行数由 4,275 增至 5,181（+906）。这是变更路径集合比较，不是完整仓库大小，也不是 speedup 证据。

最新完整 `bun run check` 已通过。此前聚焦证据记录了 31 个通过测试；随后六文件聚焦结果见下文。针对最终修复范围的连续两轮独立 Thermo-Nuclear 审查均未发现问题。第二次完整离线运行执行了全部 333 个文件、2,459 个原生用例，零跳过，用时 1,131.173 秒，setup 用时 5.670 秒。两个文件失败：Magic multi-step 预期 2 个请求但实际观察到 3 个；UserMessage regular/dark 场景等待 ACK 超时，输入仍停留在 editor。首轮完整运行的 3 个失败现已通过。保留日志证明 Magic 的第三次请求是 SessionNaming prompt，原因是无效 partial settings 错误启用了 fallback；已使用现有 `disableSessionNamingForTest` 修复 fixture，Goal retry 分支也用 `DEFAULT` spread 修复了同一无效配置。Magic 前后各重复 10 次：之前 5 通过／5 失败，用时 62.85 秒；之后 10 通过／0 失败，用时 65.65 秒，并保留精确的 2 请求断言。UserMessage 失败来自 inline Skill autocomplete 消耗了 Enter；在 Enter 前发送 Escape 可保留提交行为。随后的完整四种 mode/theme 结果见下文。

托管 CI 修复包括：为不支持的 tmux 3.4 Goal option 加 feature guard；MCP 断言等待 Host 完成标记 `Reloaded`，不再使用启动标记 `Welcome`；Code Mode CI 外层 deadline 从 180 秒提高到 300 秒，并加入每个 arm 的 progress；从 Acceptance 移除旧 envelope benchmark 及其 legacy fixture flags。ADR 0009 明确的当前 20% schema/input 与 cumulative gates 保留，32 个 TUI arm 也保留。托管运行 `34013094628` 基于较旧 HEAD，完成结果见下文。基线 main CI 跳过 Acceptance，范围仍不等价；不作 speedup 声称。

随后六文件聚焦运行中，Magic recovery、User Message 全部四种 mode/theme 组合、Goal lifecycle、Goal PTY 和 MCP PTY 通过。Code Mode 首次冷启动报告 Context adapter 缺失；验证器现改为等待界面显示 Context 百分比后再输入，替代固定 750 毫秒等待。之后三轮完整重复在 267.97 秒内通过全部 96 个 TUI arm。这证明了已观察的 fixture 行为；原始注册失败没有保留足够诊断信息，尚不能确认底层产品缺陷。

托管运行 `34013094628` 完成全部 333 个文件、2,459 个原生用例，零跳过，用时 1,693.223 秒，setup 12.878 秒。四处失败分别为 Code Mode 旧的 180 秒期限、Goal 的 tmux 选项、MCP reload 同步，以及 Tools liveness fixture 等待就绪事件。最后一处发生于响应时间测量前，仍未解决：旧验证器丢弃了请求日志和终端画面。验证器现在会在失败输出中包含这两项；原有 liveness 要求在本地 59.18 秒运行中通过。断网聚焦运行的两个完整文件均通过：Code Mode 95.86 秒，Tools 58.54 秒。更新后的托管 CI 仍待完成。聚合检查正确地将该轮判为失败。

## 可复用诊断

**RTK 环境身份：**维护者默认可执行文件未通过认证 SHA-256 检查。这是环境失败，不是耗时回退或偶发测试问题。
下载官方 0.45.0 Release 到本地 artifacts 并验证归档及可执行文件哈希后，通过显式 `RTK_BIN`，原场景无需修改即通过。
不要弱化身份检查，也不要把无关本地 RTK 版本当作认证证据。

**删除调用审计：**文件名相似不足以证明覆盖重复。MCP 和 RTK PTY 调用原本没有测试调用方，已在检查点之前恢复。
随后逐项将原聚合的全部 17 个调用对应到真实调用点及其终端尺寸／默认值；删除的十个验证器族已包含原场景。

**迁移根路径：**中间目录存在不足以证明路径正确：`test/` 存在，但不是仓库根目录。完整运行发现 UI Package 加载和 RTK 来源记录仍从旧位置解析；两处保留原断言并改为指向实际源码树。

**嵌入状态快照：**原始偶发失败没有保留 ANSI 原始证据，无法重建当时的具体帧切换。测试原本分别截取纯文本和 ANSI；现在等待并验证同一 ANSI 快照，从同一帧提取可见文本，并在失败时输出原始快照。没有把重跑通过当作修复；Host 渲染与颜色要求均未修改。

**重复重载同步：**下一次完整离线运行执行了 333 个文件、2,459 个原生用例，零跳过，用时 1,153.368 秒，另有 6.177 秒准备时间。只有 User Message fullscreen/dark 失败：重复 `/reload` 匹配了上一次的 `Reloaded` 快照，在本次重载完成前发送了新建 Session 操作。夹具现在先等待新的 Session inventory 记录，再等待完成提示，并在首次重载前等待第三次响应。四种模式/主题组合各重复五次，20 次通过、零失败，用时 118.65 秒。静态检查已通过；合入并行 main 改动及最终全量验证仍待完成。

**并行 main 整合：**将 `dfd0d209` 合入 QA 分支，保留原生 Context Worker 关闭、Work 空闲同步及绑定提交的交付证据。新增 Beads 交付测试迁入 Component/repository；合并后的清单共 335 个文件（334 个离线、1 个 live）。交付读取当前 Plan/Checks/Tests/Verify 结果；已验证的无测试计划明确显示为未运行。删除了已无用途的 PR 路径重分类请求。整合期间 15 个交付/发布用例和完整静态检查通过。最终绑定版本的 CI 证据记录在 PR #230 与 Beads 托管交付评论中。前文 334 个文件的清单为合并前 `9dd54c24` 检查点，源码比较对应 `c0403212`。

**CI 作业预算：**`9dd54c24` 上的运行 `34015134858` 在没有测试失败的情况下执行到 270/333 文件，随后被继承的 30 分钟 Tests 作业超时取消。该次运行中 Code Mode 与两种 Tools PTY 几何均通过，但没有生成最终测试报告，Verify 因此失败。根据实际完整范围成本，Tests 作业预算调整为 45 分钟；测试要求与各场景断言不变。这是环境/执行预算修复，不是提速。
