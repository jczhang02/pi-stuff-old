<!-- translation-source: packages/pi-stuff/src/context-management/UPSTREAM.md; translation-source-sha256: 03de2fbf2183a29244c842377b171f1778738576f253602907faabdf9712b1cc -->

# 捆绑上下文引擎来源

Pi Stuff 通过本适配器集成官方 Magic Context Package，不内嵌 Magic Context Core。仓库为固定 Package 应用一个临时且经过审查的依赖补丁，处理 tokenizer 兼容性、Pi 重试时的稳定消息身份，以及通过公开压缩钩子实现的真实 Magic 恢复。

精确发布的 Package 在 Pi Stuff Context Engine Worker 中执行。适配器只在激活时生成一个内存 bundle，使
官方模块图可从已认证的独立 Pi 二进制文件解析；它不修改上游源码，也不持久化派生产物。

- 上游：`https://github.com/cortexkit/magic-context`
- 上游发布：`v0.41.1`
- 已发布源码提交（`gitHead`）：`cbfac49fa88b3eb86074b9499c38e993cc447f34`
- Package：`@cortexkit/pi-magic-context@0.41.1`
- npm integrity：`sha512-FYl1IH4KOCXkt4UOI6ZswwI/p3YO9+eP2hrfOtgjlsYjp8UHI+OM7fRY6Z6PGOcaf5+kn0PM1CeHY9j3mjL9TQ==`
- npm tarball SHA-1：`877ae8c6d055bc8af7e7fa5f1d180724c18d2dfb`
- 已审查 tarball SHA-256：`5a227889dd91ed952a7403390b463e3e1ac705f837b8f055ffba62eb659229de`
- 许可证：MIT，与官方 Package manifest 和上游仓库声明一致。

## 临时 tokenizer 兼容补丁

- 补丁：[`patches/@cortexkit%2Fpi-magic-context@0.41.1.patch`](../../../../../../../patches/@cortexkit%252Fpi-magic-context@0.41.1.patch)
- 补丁 SHA-256：`9c8361ee3bea8f4667f5aa298a85dc55cbfc0c0ba241eddcaff3f1b4ee120a9a`
- 范围：
  - 把已发布模块的 `import.meta.url` 祖先路径和 Bun isolated-linker 的 `node_modules` 根目录加入现有
    `ai-tokenizer` 回退搜索；
  - 在引擎初始化期间预加载 tokenizer，而不是等到第一个提交轮次；
  - 哈希图像草稿时复用已有图像 token 估算，避免对不属于哈希结果的 base64 执行精确 BPE 工作。
- 保留的行为：真正不可用的 tokenizer 仍使用 Magic Context 现有启发式回退。补丁不会抑制或拦截诊断。
- 证据：强制 frozen-lockfile 安装能够应用补丁；已认证 Pi Host 从无关用户项目运行时可直接解析
  `preloadTokenizer()`；4 MiB 异常图像 PTY 用例保持响应；真实 Context PTY 门槛拒绝原始
  `[magic-context]` 输出。
- 删除触发条件：只有某个精确官方 Magic Context 产物通过相同的全新安装、首次输入、异常图像、schema
  和真实 Host 检查后，才替换该补丁。

### 2026-09-02 上游审计与升级

本次审计时 npm 最新版本是
[`v0.41.1`](https://github.com/cortexkit/magic-context/releases/tag/v0.41.1)。此前的
[`v0.41.0`](https://github.com/cortexkit/magic-context/releases/tag/v0.41.0) 增加 cache 稳定性修复、Pi RPC
与多 Session 支持、可适配不同布局的 Pi 模块解析，以及存储迁移 v82。补丁版本修复了首日发现的 Historian、
捆绑 Pi subagent、可选 ONNX、Todo 渲染和诊断回归。

官方 0.41.1 产物仍缺少三项本地 tokenizer 与图像哈希行为：tokenizer 回退路径只从 `process.argv[1]`
开始遍历，tokenizer preload 仍不在 factory 初始化内，part hash 也不能接收已经计算好的 token 估算。因此
删除触发条件尚未满足，等价的已审查补丁继续保留。

Schema v82 新增 `memory_verifications.mapping_origin`。认证会创建真实 v82 数据库，将它精确回退成 v81
形状，验证 v81 到 v82 自动迁移，再让只支持 v81 的 Worker 面对 v82 存储启动。旧 Worker 不暴露命令或
Tools，只保留 `session_shutdown`，因此不能写入更新版本的存储。

上游 0.41.1 还会读取 `pi.events` 以接收 child-subagent 生命周期通知。Pi 不会在 Context Engine Worker
里初始化 child Extensions，因此隔离适配器提供无操作 EventBus：Worker 内根本没有需要转发的 publisher，
前台 Pi 与 Agents 仍保留原有生命周期所有权。

Package 声明的 Pi peer 是 `^0.80.2`，不包括 Suite 已认证的 Pi 0.84.4 Host。Pi Stuff 不从这个范围推断
兼容性。真实 Pi 0.84.4 PTY 与 Provider 门槛会单独认证激活、取消恢复、在线 Session 替换与恢复、冷恢复、
仅 Magic compaction、项目隔离、启动/降级期间的 fail-open 行为，以及活跃 Host 管理 Provider 处理的 fail-closed
行为。详情见[优化报告](../../../../docs/reports/magic-context-effect-optimization-2026-09-02.md)。

## Pi Stuff 适配器政策

- 已配置启动不修改用户配置。直接首次使用授权遵循上游 XDG 和 JSON/JSONC 发现规则，默认纯词法检索，保留显式 embedding 配置。
- 启用 Magic 后，前台投影和压缩（包括故障恢复）均由 Magic 独占。只有未配置或显式禁用 Magic 时保留原生行为。
  本地估算不阻断有效请求。
- 每次前台 Context 事件调用 Magic。Pi 负责持久化、重试和队列交付，包括显式取消后的队列继续。
  不增加前台调度器或传输策略。
- 固定官方产物加审计补丁在内部 Worker 中运行，使用不可变 Host 快照及绑定会话的副作用。
  普通生命周期事件不继承当前 Agent 取消信号；压缩钩子、工具和支持信号的命令接收各自调用所属信号。
- 保留 BTW 和 Agents 的有界引用投影。只暴露五个 Context 工具和状态、清理、重建、收尾、升级命令；
  不增加竞争性的 Todo、状态栏、公告、Dreamer 或 Sidekick UI。

## 保留旧摘要时的重试身份修复

Pi 适配器现在每次投影都使用 Magic 已有的对象引用与唯一指纹匹配。消息数量相同不能证明位置对应：Pi 会保留旧压缩摘要，同时从重试消息中移除已经持久化的失败回复；两处数量差异可能相互抵消，使删除记录套用到错误消息。未再使用的位置对齐实现已删除。

回归测试使用真实 Pi Session 投影和真实 Magic Worker，保留旧摘要、持久化失败回复，然后重试同一输入，要求投影消息和标签完全相同。这是 ps-eck 下 ps-5r4 的修复，不能单独证明 Magic 独占的超限恢复已经完成。精确上游版本通过同一回归和真实 Host 差分验收后，移除此补丁部分。

## 真实超限压缩与持久化完成状态

同一固定依赖补丁把 `session_before_compact` 的超限和手动请求连接到既有 Historian、边界解析器、compartment 租约和
重试机制，返回持久化 compartment 摘要及经核验的 `firstKeptEntryId`；Pi 持久化结果并负责后续重试。
不增加存储 schema 或完整历史重建。Historian 发布前立即检查取消，阻止取消后迟到发布。

恢复严格读取待提交完成状态：状态损坏时停止，并保留证据。Worker 回执丢失后，重启复用已提交 compartment，
不重新运行 Historian。待提交标记保留到 Pi 持久化压缩结果，再由现有比较并清除流程删除。
超限操作受十分钟期限约束；Suite 将唯一允许的 Worker 重启也纳入同一期限。手动压缩不继承故障期限。
实际超限使用 Magic 既有紧急保留尾部策略，保留当前输入。恢复连续处理可运行分块，每步核验 ordinal 进展，之后才交回 Pi。
每次边界计算单独绑定短期原始消息读取器，避免 Historian 清理后看不到剩余历史。

`tests/acceptance/context-management/magic-recovery-host.test.ts` 在认证 Pi 可执行文件上对比直接运行的带补丁 Magic 和 Suite，
并在工作开始前或发布后注入真实 Worker 终止。还覆盖工具结果复用、Historian 瞬时失败、回执不确定、无进展、
重复超限，以及原生取消/队列语义一致性。夹具 Provider 错误证明控制流程，不证明真实远端容量。
只有精确官方产物通过相同的持久化完成及真实 Host 差分用例，才移除此补丁部分。每次上游升级重新审计信号读取、
租约/发布原子性和摘要边界。


Pi Historian 的三个分块前 no-op 返回现记为 `noop`，与原有日志及分块过滤/额度不足时的 no-op 契约一致。
此前这些返回保留默认 `failed` 统计状态，使真实验收拒绝本已成功的运行。变更只修正结果记账，不增加压缩或重试行为。
真实 Provider 门槛继续检查没有真正的 Historian 失败。

### 2026-09-06 child pressure differential

`bun test test/agents/child-context-pressure-host.test.ts test/context/magic-recovery-host.test.ts` 在认证 Pi 0.85.1 上通过 14 个测试、116 个 assertions，耗时 73.21 秒（日志：`.artifacts/ps-8ew-acceptance/context-host.log`）。测试使用生产 `buildPiArgs`、真实 Magic Worker/Historian、新建及分支 child history、两次真实超限恢复、八次 Tool 调用、最新 steering，以及检查既有 findings、completed-check ID 和最终报告。首次运行发现 Magic 的 `clearOldReasoning` 在回放时删除 signed reasoning；补丁现已在两个现有 clear 路径保留签名块。随后发现压缩摘要成功后 retry 仍使用旧缓存投影；在公开 `recoverPiCompaction` hook 前清除 Pi cache 修正了顺序。该修复复用既有 cache seam，没有新增 child projector。确定性 Provider fixture 证明生产控制流和 protocol 完整性，不证明远程实时容量；background teardown/stale-result 仍是独立验收证据。
