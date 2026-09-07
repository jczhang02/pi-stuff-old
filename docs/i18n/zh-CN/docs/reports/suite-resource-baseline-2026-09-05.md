<!-- translation-source: docs/reports/suite-resource-baseline-2026-09-05.md; translation-source-sha256: 8029b93ea901ad629b1edbf8961c5262f06c8c1c777d74c098e45187488e06cb -->

# Pi 0.85.0 Suite 资源基线

这是优化前基线，不是修复结果或兼容性认证。2026-09-05 的小规模配对离线测量显示，Suite 有明显的启动、
CPU 和内存成本。另一组静态等待 Provider 的探针仍可交互。这两项结果既没有判定哪些成本属于重复工作，
也没有覆盖已知的长 Session Execution Ledger 卡顿。决策见
[ADR 0034](../adr/0034-remove-redundant-suite-work-without-feature-cuts.md)。

## 精确环境

| 项目 | 记录值 |
| --- | --- |
| Suite 源码 | `6d0507c165acc5056b7e4bf4aedddef326ab915b`，生产源码未修改 |
| 官方 Host 发布 | [Pi v0.85.0](https://github.com/earendil-works/pi/releases/tag/v0.85.0)，Linux x64 |
| 上游源码 | `107d79f11072bbc8a3a757ed7fd69596bee7d68c` |
| 归档 SHA-256 | `a7e7c65f1dc528d2e17e7d946ad2b61df0e2b0f9952faee77807c2484b464d6e` |
| 可执行文件 SHA-256 | `0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072` |
| 可执行文件大小 | 105,764,992 字节 |
| 内嵌运行时 | `Bun v1.3.14 (0d9b296a) Linux x64 (baseline)`，标记位于第 2,995,056 字节 |
| 仓库工具链 / Pi 开发类型 | Bun 1.4.0 / Pi 0.84.4 |
| 机器 | Intel Core i9-13900H，20 个逻辑 CPU，约 31 GiB RAM，Linux 6.19.10-jc-xanmod1 |
| 终端 | 全屏，120 列 × 40 行 |

解压前，归档摘要与官方发布资产元数据一致；解压后又独立计算了可执行文件哈希。没有仅凭版本输出判定
构建身份。官方[构建流程](https://github.com/earendil-works/pi/blob/v0.85.0/.github/workflows/build-binaries.yml)
固定使用 Bun 1.3.14。没有替换已安装的 Pi、用户配置，也没有替换或重启正在运行的用户进程。

机器为共享环境，没有做 CPU 隔离，也未控制频率和后台负载；当时有 swap 使用。这些是探索性的本机测量，
不是跨机器性能保证。仓库仍按[兼容性契约](../compatibility.md)认证 Pi 0.84.4；在 0.85.0 上跑通这个夹具
不会自动升级认证。

## 配对生命周期测量

复用现有[夹具](../../../../../scripts/lifecycle-benchmark-fixture.ts)和
[样本执行器](../../../../../scripts/lifecycle-benchmark-sampling.ts)，分别启动真实 Pi 进程，各自使用
独立的 home、Settings、缓存和 Session 目录。两组使用相同的确定性进程内 Provider，只有 Suite 组加载
Pi Stuff。没有使用凭据或模型网络请求。

每个组合有一次预热和三个正式样本，交替采用 Host 先运行、Suite 先运行的顺序。预热不意味着后续进程
共享已加载的 Suite：每次都有新的配置和缓存目录。每次提交首个 prompt，再提交两个后续 prompt。
长 Session 含 240 轮用户/Assistant 对话和 1,000 个历史 Tool 结果，每个结果 4,096 字节。
16 次完整运行都通过了 Session 完整性、预期 Tool 注册、编辑器就绪和终端恢复检查。

按现有离线夹具配置，Context 启用，embedding 关闭，Dreamer、Sidekick、TodoWrite 禁用，fail-closed
阻塞关闭。没有从 Suite 删除命名和用量功能，但无凭据夹具并未执行它们的完整线上行为。没有启动 Agent，
也没有预置 Code Mode 账本历史。这不是全功能或完整 Capability 测量。

下表是三个非预热样本的中位数。CPU 是整个运行期间累计的进程 CPU 时间，不是墙钟时间。峰值 RSS 来自
Bun 子进程 `resourceUsage()` 返回的进程高水位，包含进程内 Worker，但不是整个进程树同一时刻的 RSS
总和。外部观察包装器未计入该 CPU/RSS，但它给两组启动耗时都增加了共同的启动成本。

| Session / 组别 | 启动 ms | 首次响应 ms | 后续响应 ms | 运行 CPU 秒 | 峰值 RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 新会话 / 原生 Host | 717.50 | 19.62 | 5.48 | 0.947 | 158.1 |
| 新会话 / Suite | 5,353.12 | 736.36 | 699.85 | 10.494 | 984.8 |
| 长会话 / 原生 Host | 2,379.13 | 73.86 | 8.07 | 3.848 | 463.9 |
| 长会话 / Suite | 6,924.57 | 1,519.06 | 680.48 | 14.220 | 930.2 |

现有执行器先对每次运行的两个后续响应取 nearest-rank p50，即较小值，再在三次运行间取中位数。
该指标不能用作最慢交互或卡顿门槛。首次响应延迟包含到达 Provider 之前的工作，不只是渲染。
这些差值说明存在额外成本，不能说明其中多少可以在不改变功能的情况下消除。

[数值样本](../../../../../docs/reports/suite-resource-baseline-2026-09-05.json)保留了预热、每个生命周期样本、
资源计数和独立探针结果。最初的环境错误——缺少计时工具、worktree 依赖未安装——在这些运行前已纠正；
失败的环境准备不计入性能样本。

## 静态等待与观察限制

另一组原生/Suite 对照使用独立 tmux server 和 16 秒后完成的离线 Provider。编辑器就绪并等待一秒后，
每个进程空闲观察五秒。只有看到 Working spinner 后，才开始 12 秒活跃窗口。观察器每隔 25 ms 加截图
耗时采样一次，期间输入三个标记，并切换三次命令自动补全选项。

| 观察项 | 原生 Host | Suite |
| --- | ---: | ---: |
| 5 秒空闲期间进程 CPU | 20 ms | 30 ms |
| 空闲窗口结束时 RSS | 129.7 MiB | 521.9 MiB |
| 活跃窗口进程 CPU | 910 ms | 1,610 ms |
| 观察到的 spinner 单帧中位数 | 84.1 ms | 83.9 ms |
| 最长可见 spinner 单帧 | 92.9 ms | 122.1 ms |
| 最慢输入 / 菜单选择反馈 | 31.0 ms | 31.4 ms |
| 最长截图调用 | 5.2 ms | 5.9 ms |
| 最大采样间隔 | 64.5 ms | 65.2 ms |

CPU 来自 `/proc` 进程计数，每秒 100 ticks。RSS 是时点快照，不是保留对象大小或内存泄漏证据。
资源窗口起止时没有子进程，但不能据此证明中间没有短暂子进程。活跃窗口 CPU 包含响应探针交互的成本。
上下文切换数不等于准确的定时器唤醒数。

Pi 0.85.0 将默认 Working 指示器放入编辑器边框。观察器允许它出现在那里或 Suite 自定义编辑器界面，
并要求确实出现变化的符号。找不到 spinner 不算通过。输入和选择结果约含一个采样间隔的观察延迟，
不是精确的原生事件延迟。这里的选择是自动补全选择，不是鼠标文本选择。菜单准备也扩大了最大采样间隔。
探针没有观察 spinner 首次出现前的区间、任何 Tool 调用或长历史重放，因此不能认证 Tool 前卡顿已解决、
不能校准最终阈值，也不能证明没有偶发卡顿。

## 复现与实现交接

在隔离 checkout 中使用记录的源码提交与冻结依赖，将精确官方发布下载、验证到临时目录。
直接复用 `prepareFixture(root, project, 1000, 4096)` 和 `runSample()`，参数为
`acceptance: false`、`contextEnabled: true`、`trace: false`、`promptRepetitions: 2`，组别为 `host` 与
`suite`，场景为 `fresh` 与 `resume-long`，动作为 `prompt`，终端为 120×40。运行 0–3 次，第 0 次为预热，
奇数次反转两组运行顺序。`packagePath` 指向该 checkout 的 Package，`piBinary` 指向精确发布。
不要为了运行探索性测量而修改现有认证 CLI 的允许列表。

资源列使用外部 Bun 包装器：继承 PTY 标准流启动该 Pi，等待退出，将 `resourceUsage().cpuTime` 换算为秒，
将 `maxRSS` 换算为 MiB。夹具生成使用仓库的 0.84.4 Session API；真正接受测量的 Host 是已核验哈希的
0.85.0 发布。临时探针属于探索工具；保留在仓库中的连续 Tool 前观察器和完整负载矩阵属于后续实现工作，
不属于这次小基线。

已接受的工作图为 `ps-yon`。清点必须覆盖全部 16 个 Capability、共享生命周期路径、完整功能配置、
进程树成本、分配/GC、I/O、唤醒和单次活性失败。本报告没有冻结任何阈值。既有账本失效问题仍是一个
独立、已确认的优化目标；短静态等待结果既没有复现它，也没有否定它。该修复须与修改重叠保留和生命周期
行为的 `ps-j3v` 协调。
