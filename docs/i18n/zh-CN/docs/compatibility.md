<!-- translation-source: docs/compatibility.md; translation-source-sha256: e281772e1250a0ec73fcf910ec248b8389fba5b3c9ed9530e30afd6913f25bca -->

# 兼容性

## 受支持的 Host

| 契约 | 已认证版本 |
| --- | --- |
| Pi standalone Host | `0.85.1`，上游 `d981de1229ef899957bbe968bc8dcda02a21f477`，Linux x64 |
| 仓库 Bun 工具链 | 1.4.0 |
| Pi Stuff Package | 0.3.3 |
| 仓库开发 Package | 0.0.0 |
| 系统工具基线 | Ubuntu 24.04，包含 Bash、Python 3（adapter 语法检查）、curl、tar、gzip 和标准 Unix 工具；不含 `pwsh` |
| PTY 验证工具 | Ubuntu 24.04 的 Expect 与 tmux package |
| TypeScript checker | 5.9.3 |
| Code Mode Host | OpenAI Codex `rust-v0.145.0`，Linux x64 |
| Code Mode Host Release archive | SHA-256 `ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e` |
| Code Mode Host executable | SHA-256 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8` |
| 可选 RTK runtime | `0.45.0`，发布源码 `b34be37caf3796b69a50952a28e60e32b5daad43`，Linux x64 |
| RTK CI 下载 archive | SHA-256 `c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4` |
| RTK CI 下载 executable | SHA-256 `99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535` |

受支持的 Host profile 是 Linux x64 上的 Pi `0.85.1`。上述上游源码提交作为来源参考保留。验收会在真实 Host 上
通过 Pi 的公开 API 覆盖完整 Suite 契约，包括公开的 `registerMarkdownTransformer()`、常规与 fullscreen UI 行为，
以及保留空格的原生设置搜索。仅匹配版本还不够：Host 还必须通过适用的真实 Host 能力验收。Pi Stuff 不重建或
分发 Pi Host。

本地验证通过 `PI_BIN` / `RTK_BIN` 或 `PATH` 复用已安装的 Pi、RTK，不自动下载或重装。兼容性准入检查版本与真实行为，不要求固定二进制哈希；RTK 源码构建和 PATH shim 可以满足该契约。CI 下载哈希标识干净 runner 准备的产物，不限制已有本地可执行文件。

CI 使用 `Plan`、`Checks`、独立的 `Tests (shard N/M)` 和 `Verify`。Plan 在 PR、`main` push、手动触发与夜间计划中运行：PR/push 选择受影响离线测试，手动触发选择完整清单与完整矩阵；夜间仅复用同一 main SHA 的成功全量证据，否则运行全量。Plan 把必要范围与矩阵写入 artifacts。Checks 独立验证冻结依赖、格式、anti-slop lint、类型、未使用代码、生成组合和公开 Release 安全。每个必要 Tests 分片获取认证 Pi、Code Mode、RTK，在网络隔离 namespace 中逐文件使用全新 Bun/Node 进程。分片只等待 Plan，失败后停止剩余工作。Verify 始终检查计划、必要 job 状态、完整且唯一的文件覆盖、矩阵身份和完整结构化报告；只有明确的 no-tests 计划才允许跳过 Tests。计划、逐分片及汇总报告分别保留。仅取消同一 PR 的过时运行，不同 main-push 范围继续保留。认证需要当前 revision 的适用检查及真实 Host 证据，workflow 配置本身不构成证据。

仓库工具链使用 Bun 1.4.0。Host 自带的 runtime 和 Release 打包属于 Host 细节，不是 Pi Stuff 的兼容性准入标准。

Bun 依赖升级必须由维护者明确执行，因为冻结 Bun lockfile、精确仓库工具链、`@types/bun`、CI 和可执行文档
必须协调移动。Dependabot 仅覆盖固定版本的 GitHub Actions；它不会创建遗漏或绕过仓库 Bun lockfile 的 npm pull request。

受支持的 Host profile 标识 Release 版本、审核过的上游源码提交和 Linux x64 平台。仓库工具链行单独标识仓库
命令和 CI 使用的 Bun。升级 Pi 必须一起审查受支持版本、公开 API 接缝和真实 Host 能力证据；本仓库不声称能复现
上游编译过程。

Pi core import 保持 wildcard peer dependency，因为它们由 Host 提供。开发依赖固定到已发布的 `0.85.1` 类型
接口。`0.85.1` 发布的 `pi-coding-agent` SDK 不再包含实验性的 remote harness，因此移除了显式开发
`pi-server` 依赖及其 Knip 豁免。公开 SDK 与 stdio RPC 契约保持不变。

User Message 呈现适配 Pi 0.85.1 的原生消息插入和重放方法，保留原生卡片与 Markdown 组件。
行内 Skill 放置观察卡片实例的原生 Markdown token renderer，不使用第二套解析器。精确的 standalone Host 必须通过 Skill＋prompt、纯 Skill、`Ctrl+O`、resize、重放和 reload 验收。结构预检和运行时异常保护保留
原生消息；正常认证输入发生回退不能算通过。Tool 对齐认证限于 `outputPad=1`；其他值仍可设置。

输入增强编辑器暴露 Pi 0.85.1 的原生内嵌运行状态能力。Host spinner 与运行提示使用顶部边框和原生 thinking
等级配色，不再重复显示独立运行行。真实 Host PTY 覆盖普通／全屏、深色／浅色、窄窗口缩放、弹窗恢复、取消、
reload、完成，以及既有的 500 ms Vibe Line Spinner 活性限制。

Pi 0.85.1 将 Thinking 内容放在原生可点击 `MouseRegion` 内。经过版本校验的 Thinking 适配器只投影该容器的
子组件，保留 Host 的可见性回调和点击路由。真实 Host PTY 验收覆盖鼠标与键盘展开/收起、最新行呈现，以及
canonical Session 内容保持不变。

版本敏感验证脚本读取共享的认证 Host 契约，不维护各自的 Pi 版本常量。PowerShell 会作为 Pi 内置 Tool
参与生命周期、MCP 名称冲突和 Child Agent 可用性策略，但认证 Linux 基线不包含 `pwsh`，因此不声明
PowerShell 执行或 Windows 行为。真实 RPC Provider fixture 按 Pi 0.85.1 RPC 序列化契约的要求，在
`toolcall_start.partial` 中填充每个 Tool call。Pi 0.85.1 还拥有实时 compaction replay，以及 Tool result 与下一次
Assistant 请求之间的原生阈值检查：它验证持久化边界，通过 `buildContextEntries()` 重建，并只渲染一次摘要。
Suite 不拦截这两条 Host 路径。打包验收证明，大型 Tool result 会触发一次原生阈值压缩，而活跃 Goal 只安排一次
continuation。

Pi 0.85.1 负责 RPC `clear_queue`、终端设置、非触发 Custom Message 排序、Session 与 Provider。Pi Stuff 不包装或
遮蔽这些契约。`clear_queue` 会返回移除的队列，但不发出 Extension event，所以 Conversation UI 无法同步修剪其
观察性归属镜像。下一次无法判定的 user/automatic 混合投递会清空该镜像并 fail closed 为 automatic；真实 RPC
验收覆盖了这个缺口。Host 也会把 Tool 执行期间排入的 `sendMessage({ triggerTurn: false })` 内容推迟到该轮所有
Tool result 持久化之后。

Codex 生成图像的内联使用 Pi 0.85.1 公开 `detectSupportedImageMimeTypeFromFile()` 接缝，从文件字节识别 JPEG、
PNG、GIF、WebP 与 BMP。原有最多四张、每张 25 MiB、仅普通文件和 best-effort 文本回退限制保持不变。内联图像
结果认证的是模型可见媒体和 Host 渲染行为，并不证明 tmux 内能显示图像；实际显示仍取决于 Host、终端协议与
multiplexer passthrough。Pi Stuff 不改终端设置，也不声称 tmux 自身能够渲染这些图像。

Pi 0.84 会为独立加载的 Extension 提供不同的 `ExtensionAPI.events` facade 对象，但它们位于同一个 Host event
bus 上。因此 Suite-wide registry 使用同步 event-bus discovery handoff，只把以 facade 为键的 WeakMap 当作本地
缓存；任何单个 facade 的对象身份都不能当作 Host 身份。真实 PTY 和 cross-facade 单元测试覆盖 Command Dialog
恢复、Tool Activity 元数据、Context 所有权、`/ui` 设置、status channel、Current Work source 和重复生命周期
抑制。

升级 Pi 必须作为一次专门变更：审查相关 Extension 和 Package 接口，同时更新固定开发依赖和来源参考，并通过真实
Host 能力验收。完成这些工作前，不声明兼容其他 Pi 构建。

changelog、归档验收报告、研究笔记和已捕获 prototype 中的旧版本字符串描述的是产生这些历史证据的 Host。
不得改写它们来暗示旧证据来自当前 Host。当前源码、Package manifest、CI、fixture 与验证脚本遵循上表中适用
的 Host 或仓库工具链行。`CERTIFIED_PI_BUN_VERSION` 仅在明确使用仓库工具链时描述该工具链，不是 Pi 兼容性门槛。

Codex Capability 只为认证 Linux x64 profile 打包保留的原生 helper。在其他目标上，命令和普通 Pi turn 仍然
可用，不可用的 Tool 会返回有界恢复错误。

PTY 验证器会探测可选 tmux 服务端设置；Ubuntu 基线不依赖 `extended-keys-format`。同一版本的必需 CI 证据按照[验证策略](../../../../docs/code-quality.md#risk-based-verification)复用；[交付发布器](../../../../docs/agents/issue-tracker.md#verified-ci-evidence)会在报告交付前验证这些结果。独立的每周上游检查会报告 npm `latest` 超过支持版本的情况，不会自动更改支持范围。
