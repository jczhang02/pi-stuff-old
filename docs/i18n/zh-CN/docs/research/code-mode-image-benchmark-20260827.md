<!-- translation-source: docs/research/code-mode-image-benchmark-20260827.md; translation-source-sha256: e1c0a5348f82cde4aa40179c8104fcfdbb36b6126b769a70fb7a54462f99955f -->

# Code Mode 图像基准测试预注册

日期：2026-08-27

V1/V2 部分保留其原始预注册内容和结果。已退役运行器当时仅推进至下方单独预注册的 V3 Luna 研究；Git 历史保留确切的 V1/V2 运行器。

本文档在观察到任何基准测试结果之前，冻结真实模型基准测试。其已退役的运行器是
[`scripts/benchmark-code-mode-image.ts`](https://github.com/jczhang02/pi-stuff/blob/4e517e771b54489eee3c57d0ec696bc312d945c9/scripts/benchmark-code-mode-image.ts)，Provider 边界观察器是
[`test/fixtures/code-mode-image-benchmark-observer.ts`](https://github.com/jczhang02/pi-stuff/blob/4e517e771b54489eee3c57d0ec696bc312d945c9/test/fixtures/code-mode-image-benchmark-observer.ts)。

## 问题与不可变输入

该基准测试考察 Code Mode 图像兼容性与发现补丁是否能在不允许损坏图像或增加常驻 Provider 上下文的情况下，改善图像处理成功率。

- Host：经过认证的 Pi 0.84.3 发布构件。
- Provider/模型：`openai-codex/gpt-5.6-sol`，medium Thinking，已启用图像输入。
- 基线 Package 提交/tree：`65b676474cc73411b62bf2cab1c910e2e359a6b9` /
  `24cab67c6893732155ad113747b7f8830335d5c9`。
- 候选 Package 提交/tree：`4487a063d1e2693e00e5fbe12ff523366d670baa` /
  `480dcad7f133d4eee1d13ed243620b3111561a96`。
- 提示词：“使用可用的图像 Tool 检查 challenge.png。只回复其中显示的六位数字，不要回复其他内容。不要使用 shell 命令，也不要将文件编码为文本。”
- 每个 arm 使用二十个固定的六位数 fixture，顺序如下：`731905`、`284167`、`609352`、`418730`、`952641`、
  `367824`、`805219`、`146593`、`573086`、`920475`、`238761`、`694028`、`351972`、`782436`、
  `469105`、`817354`、`205687`、`936412`、`542809`、`173648`。
- 配对顺序交替：奇数编号 fixture 先候选后基线，偶数编号 fixture 先基线后候选。

每个 fixture 都由已签入的确定性灰度 PNG 生成器渲染。每次运行都会获得全新的项目、Session 目录、临时目录、运行时目录和 Session ID。上下文文件、提示词模板、已发现的 Extensions 和已发现的 Skills 均被禁用。Ponytail 设置为 `off`；继承的子 Agent 和冻结的 Code Mode 环境值均被清除。通过项目设置启用 Code Mode。运行按顺序执行，以避免并发和速率限制不对称。

共有 40 个独立的主 Session：20 个基线，20 个候选。Tool 使用和强制的恢复检查可能使每个 Session 产生不止一个 Provider 请求；报告记录实际请求数。不重试、替换或排除任何运行。任何 instrumentation、进程、Provider、解析或恢复失败都计为失败样本。

## 度量与门槛

对于每个 Session，运行器记录以下布尔值：

1. **Tool 选择：**嵌套 Code Mode 操作包含 `view_image`，既不包含 `read` 也不包含 `bash`，且 Code Mode 程序不调用显式的 `image(...)` helper。
2. **精确传输：**完整 Provider payload 在内存中被遍历；每个观察到的图像都是规范 PNG，且至少一个图像与 fixture 文件具有相同的 SHA-256。
3. **理解：**第一次最终回答恰好是六位 fixture 数字。
4. **Session 安全性：**Session JSON 恰好包含一个可由解码器读取且 SHA-256 与 fixture 相同的图像；新的真实 Pi 进程恢复该 Session，其完整 Provider payload 包含相同的有效图像，并且模型恰好回答 `SESSION_SAFE`。
5. **端到端：**instrumentation、Tool 选择、精确传输、理解、Session 安全性和成功的 Code Mode 状态全部通过。

完整 payload 会被检查，但从不归档。观察器只归档 payload SHA-256、字节数、遍历节点数、Tool 名称、Code Mode 和 Provider Tool 定义总字符数，以及图像字节数/hash/有效性元数据。Session 和 fixture 目录会在运行后删除。报告不包含凭据或特定机器的临时路径。

候选接受要求：

- 精确传输：20/20；
- Session 安全性和恰好一次图像持久化：20/20；
- 不存在损坏、截断、不支持或无法解码的持久化图像：20/20；
- Tool 选择：至少 18/20；
- 理解：至少 18/20；
- 端到端：至少 18/20；
- 每个候选样本都有有效 instrumentation，且没有 Code Mode 错误；
- 候选 Provider Tool 定义总大小不大于基线。

报告给出两个 arm 的原始分数以及 Wilson 95% 二项区间。基线仅作描述，不受候选接受门槛约束。单独匹配的真实 Pi Host 截图比较 Code Mode 的嵌套
`view_image` 行与直接调用 `view_image`；该行为基准测试不会从模型文本或 PTY 字符串推断像素。Claude Code 比较不在本接受范围内。

从候选 worktree 运行，并提供仍保留预注册 Package tree 的基线仓库根目录：

```sh
PI_BIN=<absolute-certified-pi-release> \
bun run benchmark:code-mode-image --baseline-root <absolute-baseline-root> --output <absolute-report-path>
```

## 结果前澄清

记录于 2026-08-26T01:17:43Z，此时运行器已启动，但尚未检查任何运行输出、日志或结果：
`--no-skills` 会禁用普通的已发现 Skills，但 Pi 0.84.3 仍可公开由显式加载的 Pi Stuff Package 声明的 Skills。Ponytail 的常驻贡献仍为 `off`；两边的 Package 声明 Skill catalog 相同，并属于真实已安装 Package 的目标表面。没有改变任何基准测试输入、顺序、度量、阈值或失败策略。

记录于 2026-08-26T01:22:25Z，此时尚未产生任何基准测试 Session 或 Provider 请求：第一次命令调用在强制 Host 来源预检中停止，因为 `PI_BIN` 选择了一个非发布版本地构建。它产生了零个样本，也没有模型结果。随后从预注册的官方发布版本下载了经过认证的 v0.84.3 Linux x64 发布构件，并验证其大小为 104,487,040 字节，SHA-256 为
`ca858fde375ab91531353b22fac6ebdf29c0a153efe754f5f9b8a72a7423ed08`。通过 `PI_BIN`
提供该构件会启动第一组且唯一的一组样本；此次预检修正不会重试或替换任何样本。

## V1 结果与 V2 预注册

V1 于 2026-08-26T01:56:02Z 之前完成，并原样保留为
`docs/reports/code-mode-image-20260827/benchmark-v1.json`。它未通过预注册判定。基线产生了
20/20 次精确传输、18/20 次正确读取和 20 次 Code Mode envelope 错误。候选产生了 19/20 次精确传输、16/20 次正确读取、零次 Code Mode envelope 错误，并且在使用图像 Tool 的 19 次运行中，每一次图像和恢复 Provider payload 都包含一个有效且可由解码器读取的图像。19 次候选运行选择了 `view_image`，但其中 18 次仍调用了兼容性形式 `image(result)`；只有一次符合预注册的直接返回 Tool 选择。一次候选运行没有进行 Tool 调用。观察到的 Provider payload 中没有任何 malformed、截断或无法解码的图像。

V1 无法从其归档证据中认证此次变更，原因有三个且相互独立：

1. 两个 arm 复用了相同的 20 个生成 PNG，违反了 40 张不同挑战图像的已接受要求。
2. 其 Session 计数器遍历了自定义 UI 事件副本以及持久化的 Provider-message 条目，因此 `imagePersistedOnce` 硬门槛无效，尽管恢复时的 Provider payload 包含一个有效图像。
3. 每一次候选 OCR 误读都涉及生成的零字形，该字形在视觉上存在歧义；行为 fixture 没有将图像传输与字形质量隔离开。

V2 是新的基准测试，不是 V1 样本的重试或替换。它保留每一次 V1 运行和结果，不将任何 V1 结果用作 V2 排除条件，并保持相同的 Host、模型、提示词、每个 arm 20 个 Session、确定性交错、阈值、无重试规则、无排除规则、完整 Provider-payload 观察器以及图像完整性硬门槛。在任何 V2 运行或结果之前：

- 候选 Package 提交为 `7a3e753975cf54bfa6e2f3ee99e5242de5f8a731`，tree 为
  `ddc5e95dd6817abac6c131d36a6b5eb7d0497a4a`；
- 基线仍为 `65b676474cc73411b62bf2cab1c910e2e359a6b9`，Package tree 为
  `24cab67c6893732155ad113747b7f8830335d5c9`；
- 候选常驻规则现在指明确切禁止的兼容性调用 `image(result)`，同时 Provider Tool 表面仍不大于基线；
- 两个 arm 使用分开的预注册代码列表，40 个 PNG hash 全部不同；
- 零字形为空心且无歧义，并且全部 40 个 PNG 在执行前均通过真实解码器；
- Session 持久化只统计 durable `message` 条目下的图像块；自定义 UI 事件副本仍是可观察的 Session 诊断信息，但不是 Provider conversation history；
- V2 报告路径为 `docs/reports/code-mode-image-20260827/benchmark-v2.json`。

如果任何候选 Session 被重试或替换，任何候选 Provider 图像 malformed、截断、无法解码或 hash 不匹配，任何候选 durable Provider message 持久化了不止一张挑战图像，任何恢复后的 payload 未通过图像验证，或任何原始接受阈值未达到，V2 仍然算作失败。

## V2 认证结果

V2 于 2026-08-26T02:18:36.030Z 在经过认证的 Pi 0.84.3 构件上完成，并通过了所有预注册门槛。完整的已清理报告为
`docs/reports/code-mode-image-20260827/benchmark-v2.json`。

| 度量 | 基线 | 候选 | 候选门槛 |
| --- | ---: | ---: | ---: |
| 激活 `view_image` 并直接返回其结果 | 0/20 | 20/20 | 至少 18/20 |
| 挑战字节精确到达 Provider | 20/20 | 20/20 | 20/20 |
| 模型正确读取挑战内容 | 19/20 | 20/20 | 至少 18/20 |
| 端到端 | 0/20 | 20/20 | 至少 18/20 |
| Session 恢复后安全 | 20/20 | 20/20 | 20/20 |
| Code Mode envelope 错误 | 20 | 0 | 0 |

20/20 候选比例的 Wilson 95% 区间为 [0.8389, 1.0000]。全部 40 个挑战 PNG hash 均不重复且可由解码器读取。每个候选 durable Provider message 恰好包含一个有效挑战图像，每个图像和恢复后的 Provider payload 都保留其精确 SHA-256，并且未观察到 malformed、截断、无法解码或额外图像。所有候选运行均使用嵌套 `view_image`；没有调用 `image(result)`、超时、重试、替换或 instrumentation 失败。

候选完整 Provider Tool 表面为 2,135 个字符，其中包括 1,728 个字符的 Code Mode 定义；基线分别为 2,177 个字符和 1,748 个字符。因此，在添加直接返回规则的同时，常驻 Provider 上下文总计减少了 42 个字符，Code Mode 上下文减少了 20 个字符。V1 仍作为失败实验归档，不计入这些 V2 通过计数。执行后，两个归档报告中的临时基准测试路径都被替换为稳定占位符；没有改变任何结果、payload hash、度量或样本。已清理的 V1 和 V2 报告 SHA-256 值分别为 `3d1807dd304e7582535b5d8752b8f94bb42d7f62c93bf1f61d53e1b22a5b248f`
和 `4943cc1296d575f067221333c780bf9e4ca6866d07b1a6fb1a03d9ee1ae93297`。

## 真实 Pi View UI 接受测试

V2 之后确认了视觉范围：比较 Code Mode 与 Pi 的直接 `view_image` 路径；不要求 Claude Code 比较。两个全新的已认证 Session 在完全相同的经过认证的 Pi 0.84.3 发布构件上使用同一个可由解码器读取的 PNG。一个要求 Code Mode 返回 `tools.view_image`；另一个直接调用 `view_image`。

保留的 [Code Mode 截图](../../../../../docs/reports/code-mode-image-20260827/ui/pi-code-mode.png)和
[像素差异](../../../../../docs/reports/code-mode-image-20260827/ui/diff-pi-code-vs-direct.png)来自两个独立的
`100 × 32` tmux Session，使用 `extended-keys=on` 和 `extended-keys-format=csi-u`。Freeze 渲染真实 ANSI
Tool 行，而不是重新绘制 UI。两条路径都显示一行 `View pixel.png · loaded`、图像 fallback 和
`UI_COMPLETE`；Code Mode 没有增加外层记录。

直接调用 Session 产生的 ANSI、纯文本和 PNG hash 与保留的 Code Mode capture 完全相同。ImageMagick 在
`1886 × 451`、共 850,586 个像素的结果中报告 0 个绝对误差像素。重复的 direct 文件已从当前 tree 删除，
可从 Git commit `94849d94ac23239d7f522bc3c40feb9b2822e61e` 恢复。
[metadata.json](../../../../../docs/reports/code-mode-image-20260827/ui/metadata.json)记录两组 hash、Host 来源和
像素指标。

`Image preview unavailable` 行是经过认证的 Pi tmux fallback，并不表示缺少 Provider 图像。基准测试的完整 payload hash 和解码检查仍是图像传输与 Session 安全性的权威依据；此次匹配截图验证了可见 Tool 的权威性和布局。

## V3 Luna 预注册

记录于 2026-08-29T09:53:12+08:00，此时尚未产生任何 V3 Provider 请求或结果。V3 使用规范所选的 `openai-codex/gpt-5.6-luna` 配置和 medium Thinking，为最终的 `ps-8z1` Package tree 提供认证。它是新的研究，不是 V1 或 V2 的重试或替换。

V3 保留 V2 的 Host、观察器、提示词、恢复提示词、每个 arm 20 个 Session、40 个不同的固定挑战代码、交替配对顺序、隔离的新项目和 Session、顺序执行、度量、阈值、完整 Provider-payload 验证，以及无重试/无替换/无排除规则。不可变的 Package 输入为：

- 基线提交/tree：`65b676474cc73411b62bf2cab1c910e2e359a6b9` /
  `24cab67c6893732155ad113747b7f8830335d5c9`；
- 候选提交/tree：`59742b386c8926cb8db05a8c2fd50e41a8692624` /
  `f8fa74268f41ac0877ded9eb650dd39d9a8334e4`。

输出路径为 `docs/reports/code-mode-image-20260827/benchmark-v3-luna.json`。任何进程、Provider、instrumentation、解析、图像完整性或恢复失败都计为原始样本失败。观察到结果后，不得重试、替换或省略任何 V3 Session。

## V3 Luna 结果

V3 于 2026-08-29T02:05:26.143Z 完成，并未通过其预注册判定。完整且保留内容的仓库格式报告为
`docs/reports/code-mode-image-20260827/benchmark-v3-luna.json`，SHA-256 为
`c2ba372ebc494f642e187cac46a1c1a3a0fe303915fb1223a3dcd875dbe4ab1e`。

候选在直接 `view_image` Tool 选择、精确图像传输、恰好一次且可由解码器读取的持久化、新进程 Session 安全恢复、有效 instrumentation 以及零 Code Mode 错误方面均达到 20/20。Luna 对小尺寸 304×80 点阵图像准确读取了 15/20，低于 18/20 的行为门槛；每一次误读都是在正确图像字节已到达 Provider 后发生的一位数字替换。基线 Package 在每次 Provider 请求之前就退出了，因为其全新 worktree 没有已安装依赖，因此这 20 次失败保留在 V3 中，常驻上下文比较无效。没有重试、替换或排除任何 V3 样本。

## V4 Luna 预注册

记录于 2026-08-29T10:07:45+08:00，此时尚未产生任何 V4 Provider 请求或结果。V4 是新的研究，不是 V3 的重试或替换。它保留经过认证的 Host、使用 medium Thinking 的 `openai-codex/gpt-5.6-luna`、Package trees、观察器、提示词、每个 arm 20 个 Session、交替顺序、隔离、顺序执行、度量、阈值、完整 payload 验证，以及无重试/无替换/无排除规则。

V4 使用 40 个新的固定六位数代码，按运行器顺序排列：

- 基线：`274906`、`581347`、`630285`、`947120`、`362748`、`715903`、`489261`、`826570`、`193684`、`504739`、
  `768312`、`250967`、`913475`、`647208`、`385621`、`729046`、`156830`、`894572`、`431709`、`570284`；
- 候选：`682930`、`145782`、`907463`、`358174`、`726591`、`410836`、`839205`、`264718`、`591024`、`773460`、
  `208675`、`964103`、`537920`、`681254`、`349806`、`812597`、`475130`、`926348`、`103769`、`754682`。

相同的确定性高对比度字形从 304×80 加倍至 608×160。这将 Tool 选择、传输、持久化和继续执行问题，与小型 Luna 模型已观察到的低分辨率数字读取错误隔离开来；提示词和成功阈值不变。基线 worktree 已根据其冻结 lockfile 安装依赖，并且运行器现在会在创建基准测试 Session 之前导入两个 Package 条目，使不可加载的 arm 在任何样本之前失败。输出路径为 `docs/reports/code-mode-image-20260827/benchmark-v4-luna.json`。

## V4 Luna 结果

V4 于 2026-08-29T02:31:10.098Z 完成，并未通过其预注册的总体判定。完整且保留内容的仓库格式报告为
`docs/reports/code-mode-image-20260827/benchmark-v4-luna.json`，SHA-256 为
`cfd4f754b87ea1537c63439ddbe7cf213d0194f2b6cc8042642e15866d462a2d`。没有重试、替换、排除或并发运行任何样本。

两个 arm 的全部 20 个 Session 都产生了有效 instrumentation、精确图像传输、恰好一次且可由解码器读取的 Session 持久化，以及安全的新进程恢复。候选在 20/20 中直接选择了嵌套 `view_image`，基线为 1/20，证明了提示词引导的贡献。候选 Code Mode 错误为 0，基线为 16，证明了完整 envelope 兼容性不变量。候选 Provider Tool 定义为 2,135 个字符，基线为 2,177 个字符，因此常驻上下文减少了 42 个字符。

Luna 对候选图像准确读取了 12/20，对基线图像准确读取了 16/20。尽管候选的每一个 Tool 选择、字节完整性、持久化、继续执行、instrumentation 和 Code Mode 错误门槛都通过了，但候选理解和端到端成功率仍未达到保持不变的 18/20 行为门槛。将确定性点阵 fixture 加倍并未改善 Luna 的精确数字读取，因此该结果不支持继续基于结果调整 fixture。

## 维护者接受处置

记录于 2026-08-29，在 V4 结果之后。预注册的 V4 判定和报告保持不变：该研究未通过原始的理解和复合端到端阈值。对于 `ps-8z1` 完成，这两个比率作为观察到的模型质量证据保留，而不是 Suite 兼容性门槛，因为精确数字识别属于已验证图像字节到达 Provider 之后的模型行为。

Suite 控制的兼容性门槛仍为硬性要求：Tool 选择、精确图像传输与完整性、恰好一次的 Session 持久化、安全的新进程恢复、有效 instrumentation、零 Code Mode 错误，以及常驻 Provider 上下文不增加。V4 通过了其中每一项门槛。
