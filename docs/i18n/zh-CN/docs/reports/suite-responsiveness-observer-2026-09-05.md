<!-- translation-source: docs/reports/suite-responsiveness-observer-2026-09-05.md; translation-source-sha256: 3452ed1495710b643cda4d38fc45705c1726e2beecdf6cbd98a1f288d9d968b4 -->

# 连续响应观察器与 Ledger 首次加载复现

2026-09-05，仓库内的观察器复现了首次 Code Mode/Bash Tool UI 出现前约 198.672 ms 的 Spinner 停顿。
同样开启 Suite、但不带旧 Ledger 的对照通过了锁定门槛；原生 Pi 加载相同结构的合成历史也通过。
这证明仍有可复现的问题，不代表已经修复或完成了整个 Suite 的资源验收。

生产源码未改动，版本为 `c6b20efb599a953b0b03bc439aa0bee9ab5ea97e`，实现与 `main` 的
`42ceceb8` 相同。该版本已经在普通分支推进时增量处理新 Ledger 条目。此次复现针对首次冷加载，
不能据此声称已有的热路径修复不存在。

## 观察结果

各行都使用精确[认证的 Pi 0.85.0 可执行文件](../compatibility.md)、120×40 全屏终端、全新的私有配置和缓存
目录，以及一次被测 Tool 调用。没有 profiler 或人为阻塞。Suite 样本在隔离网络命名空间中，使用合成的
回环账户，执行了自动 Session Naming 和一次真实 HTTP 用量刷新。没有读取用户 Session、凭据、设置，
也没有操作正在使用的 Pi 进程。

所有原生父进程样本（数值证据中的 `suite: false`）都使用 `PI_OFFLINE=1`、`--offline` 和确定性 Provider。
这些样本排除了自动 Session Naming 和用量刷新，不能认证这两条路径。Suite 父进程使用 `PI_OFFLINE=0`，
不传 `--offline`；其 Naming／Usage 证据来自样本记录的合成请求，不是真实账户访问。Ledger 准备阶段是
另一个离线进程，无论被测父进程是否加载 Suite，都位于交互测量与资源 scope 之外。

| 样本 | 历史与执行方式 | 最长 Spinner 帧 ms | 最慢输入/补全准备 ms | 最慢选择 ms | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| `gjIpTt` | Suite，24 次历史执行，Code Mode → Bash | 198.672 | 39.360 | 14.410 | Spinner 门槛失败 |
| `3QdOLF` | Suite，无旧 Ledger，Code Mode → Bash | 113.392 | 14.770 | 13.886 | 锁定门槛全部通过 |
| `8wCzGe` | 原生 Pi，24 次历史执行，Bash | 117.565 | 16.099 | 16.049 | 锁定门槛全部通过 |

合成 Session 包含 96 条规范 Ledger 记录，24 次执行各自成功返回 800,000 个字符，**没有保存任何 snippet**。
准备阶段由另一个原生 Pi 进程通过 `CodeModeSessionLedger` 写入；被观察的进程重新打开该 Session。
即使没有保存 snippet，Suite 仍会在执行前读取 `ledger.snippets()`。原生对照保留相同历史结构；
无历史的 Suite 对照保留 Code Mode 执行路径。

在 `gjIpTt` 中，最长停帧位于观察器启动后 +8,500.742 至 +8,699.414 ms；第一帧
`Bash(sleep 2; printf PSYON_TOOL_RESULT)` 在 +8,751.383 ms 出现。因此停顿发生在 Tool UI 之前。
这三个样本的活动 Spinner 观察均连续完整，最大采样间隙低于 26 ms。

[数值证据](../../../../../docs/reports/suite-responsiveness-observer-2026-09-05.json)也保留了未纳入对照的尝试。
更早的双 Tool Suite 样本 `lBK0DC` 出现 47.225 ms 观察间隙和 60.353 ms 启动反馈，只能判为无结论，
不能算通过，也不能据此归因启动缺陷。原生样本 `qHKlIG` 与前一个故意卡顿测试有重叠，只作为诊断数据。
没有仅因结果不利而丢弃样本。

## 锁定门槛与观察器检查

[锁定门槛](../../../../../docs/reports/suite-responsiveness-gates-2026-09-05.json)于 2026-09-05 00:51:32 UTC
记录，早于生产优化。30 个全新原生样本轮换使用 64×28、120×40、180×50。原生最长停帧加两倍观察间隙，
得到 164.767521 ms；原生输入/选择最大值加一次间隙，得到启动输入 38.124123 ms、后续输入
40.465312 ms、选择 38.311641 ms。这些是本机固定 Host 的对照门槛，并不保证低于它们的延迟都无法感知。

观察器从启动持续采集到收尾后的输入和选择，间隔为 10 ms 加采集/交互耗时。第一帧原生编辑器可见时就开始
输入，不等待 fixture 的就绪通知。输入与命令补全选择使用同一个采集循环，等待反馈不会暂停采集。
统计包含最后一个停帧区间及采集耗时的不确定性。Working 出现前的启动阶段与 `agent_end` 之后，不要求
Spinner 存在。这里的选择指命令补全选项，不是鼠标文本选择。

空或无效记录、活动覆盖不足 9 秒或 600 次采集、间隙超过 40 ms，或者应有的 Spinner 缺失，都会使样本无结论。
只要一次超过锁定门槛就失败。即使验证失败，脚本也会输出摘要，并在私有产物目录保留原始帧、动作、
源码快照和门槛。

原生负对照分别在启动、发出 Tool 调用前和收尾时注入 350 ms 阻塞。回归测试要求**注入阻塞的那个阶段**
出现超过 100 ms 的反馈；Tool 前的用例还要求 Spinner 停帧超过 350 ms。这些是观察器检测下限，
不是产品验收门槛。纯函数测试保护最后停帧的统计，以及无效/缺失观察的处理。

## 运行检查

使用兼容性契约中准备好的可执行文件：

```bash
bun test test/pty-observation.test.ts test/responsiveness-pty.test.ts
bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

复现 Ledger 首次加载问题时，将 `PI_STUFF_CODE_MODE_HOST` 指向准备好的 Code Mode helper，然后运行：

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --code-mode --ledger \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

去掉 `--ledger` 得到 Suite 对照；去掉 `--suite --code-mode` 得到带合成 Ledger 历史的原生 Pi 对照。
每次运行自行创建 Session，不接受现有 Session 路径。加 `--snippet` 保存一个 snippet；加 `--repeat-tool`
比较同一进程的首次和后续调用。`--columns` 与 `--rows` 控制终端尺寸。脚本记录复制后的 helper 哈希，
但这不等于重新认证其发布归档。

`--block-ms 350 --block-phase startup|pre-tool|settlement` 是显式故意卡顿对照。`--cpu-profile` 是独立诊断模式，
不能与 `--gates` 同用。上表没有启用 profiler。

## 尚未完成的范围

本检查点保留复现脚本和门槛，没有实现 Ledger 冷加载修复。观察器 CPU 单独报告，不能当成 Pi 或 Suite 的 CPU。
完整进程树 CPU/RSS、分配/GC、I/O、唤醒及最大主线程任务统计仍待完成。
[全部 16 个 Capability 的源码清单](suite-resource-inventory-2026-09-05.md)已记录所有者和待测对象；
完整 Context 和恢复工作负载仍待覆盖。下文的前台、后台 Agent 场景覆盖成功执行，未覆盖所有 Agent
生命周期或完整资源成本。默认加载了 Capability，不等于执行过其路径。
本次使用共享机器，没有隔离 CPU；完整响应验收还需要更长的重复工作负载。
后续工作由 Beads `ps-yon.3`、`ps-yon.4`、`ps-yon.5` 按
[ADR 0034](../adr/0034-remove-redundant-suite-work-without-feature-cuts.md)持续跟踪。

## 前台 Agent 扩展

观察器现支持 `--suite --agent foreground`。它创建私有命名 Agent 定义，以 fresh context 调用公开 `subagent`
Tool，在真实子 Pi 执行 Bash 时持续采集父 TUI。子进程必须返回预期工具结果和结束标记。每个子 Provider
请求绑定 PID；观察器校验请求顺序，并根据记录的出生身份核验进程退出。
父进程自动命名和用量刷新保持开启，且各执行一次。`--code-mode` 使父、子 Tool 都经过 Code Mode；
`--repeat-tool` 顺序启动第二个子 Agent。场景超时为 60 秒，以覆盖子进程启动，不改变任何输入或 Spinner 门槛。

2026-09-05，首个无 Code Mode、无旧历史的前台样本在 Agent 行出现前停帧 888.131 ms，输入反馈耗时
779.337 ms。生命周期测试通过是因为观察器捕获了完整运行，不是响应性通过。
独立锁定门槛调用再次失败，停帧 188.750 ms、启动输入 40.660 ms。两个子进程均完成并退出；
活动 Spinner 无缺失，采样间隙均未超过 23 ms。[Agent 数值证据](../../../../../docs/reports/suite-responsiveness-agents-2026-09-05.json)
保留这两次失败。

| 样本 | 工作负载 | 最长 Spinner 帧 ms | 最慢输入/补全准备 ms | 结论 |
| --- | --- | ---: | ---: | --- |
| `zmHdBv` | Suite 前台 Agent → 子 Bash | 888.131 | 779.337 | 观察器测试；事后比对门槛失败 |
| `KHWw6O` | 相同前台工作负载，全新进程 | 188.750 | 40.660 | 锁定门槛失败 |
| `ewiJgE` | Code Mode → 前台 Agent → 子 Code Mode/Bash，带旧 Ledger | 194.857 | 97.208 | 锁定门槛失败 |
| `JN8MPG` | Suite Bash，无 Agent 或旧 Ledger | 111.590 | 15.067 | 锁定门槛全部通过 |

这些样本缩小了调查范围，但尚未确定新停顿的根因，也没有认证所有 Agent 生命周期。
普通 Bash 对照缺少子进程负载，不能单独区分父进程启动开销与资源争用。诊断样本 `hQfUTb` 开启 CPU
profiling，完成两个顺序前台 Agent；它不是响应验收样本。父、子 profile 分开。
父进程样本包含启动阶段的 tokenizer 初始化，但这不能证明它导致 Agent UI 前的停顿。
观察器也保留自身时间原点和首个 Agent 行的时间，供后续诊断对照。

沿用前述隔离网络设置复现前台场景：

```bash
unshare --user --map-root-user --net \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --agent foreground \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

## 后台 Agent 扩展

将同一命令改为 `--agent background`，即可观察父 Agent 收尾后、子 Agent 仍在工作时的父 TUI。
观察器等到可见完成行、自动命名/用量刷新及之后的一次输入和选择均完成才停止采集。
父响应完成到最后一个子响应完成之间，必须实际完成输入和选择反馈。采集结束后，观察器读取合成父 Session
的原生文件，确认每个子 Agent 恰有一条身份不重复、状态为 completed 的规范 `pi-stuff-agent-outcome`。
Provider 请求数量检查排除观察期间未经请求的父回合；出生身份检查核验各子 Pi 退出，但不认证所有 helper 的清理。

后台 fixture 的父、子最终 Provider 响应等待六秒，而非四秒，以保证父活动期和父空闲/子活动期均足够完成
已有观察要求。这没有改变生产调度或响应门槛。只有后台子 Agent 活动时，不要求父 TUI 存在活动 Spinner。

| 样本 | 后台工作负载 | 最长 Spinner 帧 ms | 最慢输入/补全准备 ms | 结论 |
| --- | --- | ---: | ---: | --- |
| `eh1S2n` | 一个 Agent → 子 Bash | 177.973 | 63.629 | 观察器测试；事后比对门槛失败 |
| `H1NZud` | 相同工作负载，全新进程 | 183.665 | 17.929 | Spinner 门槛失败 |
| `O2afCg` | Code Mode 启动两个 Agent，子 Code Mode/Bash，带旧 Ledger | 232.401 | 53.915 | Spinner 和输入门槛失败 |

三个样本均在父 Agent 收尾后继续观察 11.8–13.3 秒，应有的 Spinner 无缺失，最大采样间隙低于 22 ms。
每个子 Agent 均完成 Tool 并退出；规范完成记录分别为一、一、两条。父进程命名和用量刷新各执行一次。
双子 Agent 场景验证了 `--repeat-tool`、`--code-mode`、`--ledger` 与后台观察在 120×40 下的组合，其他尺寸待测。
[Agent 数值证据](../../../../../docs/reports/suite-responsiveness-agents-2026-09-05.json)保留每次源码快照身份。
这些失败将调查扩展至后台委派，但不证明它与前台停顿具有相同根因。

## 原生资源 scope

在具有 cgroup v2 且已配置 `DBUS_SESSION_BUS_ADDRESS` 的 Linux 上，为原生或 Suite 命令添加 `--resource-scope`。
现有观察器只把合成 Pi 命令放进新建的临时 scope。scope 与 service 不同，会保留调用者的终端和网络
命名空间。启动器取得用户 bus 环境；Pi 及其子进程保持原有隔离环境。观察器、tmux 和回环 Usage 服务均在 scope 外。

采集及子进程完成检查结束后，观察器核验父 PID 属于该 scope，再于关闭 Host 前读取 `cpu.stat`、
`memory.current` 和 `memory.peak`。摘要的 `resourceScope` 记录用户态/内核态/总 CPU 微秒数、当前及峰值
**记账内存**字节数，以及观察器时钟上的读取区间。累计 CPU 包含已经退出的 scope 内子进程。
这些是 scope 计数，不是仅父进程 CPU、进程树 RSS、累计分配量或包含关闭阶段的测量；各计数也不是原子快照。
必需计数缺失或无法访问 bus 时直接报错，不记录为零成本，也不静默改用其他方法。

正常清理会停止这个精确的私有 scope，并核验它已不活动。90 秒 scope 生命周期用于观察器死亡时限制合成
进程树存活，不改变任何生产 Agent 限制或响应门槛。该方法先用短命忙循环子进程验证：子进程退出后，scope
累计 CPU 增加 155,364 µs，其中子进程为 154,361 µs；继承终端及隔离命名空间均保持不变。之后确认临时 scope
已卸载。这验证了计量接口，不代表 Suite 资源效率已经通过验收。

| 样本 | scope 内工作负载 | CPU 秒 | 当前 / 峰值记账内存 MB | 最长 Spinner 帧 ms |
| --- | --- | ---: | ---: | ---: |
| `mw5lh2` | Suite Bash | 7.520007 | 445.739 / 989.221 | 117.332 |
| `VjRlYe` | 原生 Bash 对照 | 1.848497 | 138.158 / 154.403 | 115.950 |
| `xGbqRM` | Suite 后台 Agent → 子 Bash | 18.242948 | 434.053 / 1477.685 | 177.025 |

前两行顺序运行，Bash 命令、120×40 尺寸、全新私有目录、隔离网络命名空间及最终观察器源码一致，均通过
锁定响应门槛。差额是加载 Suite 的总成本，包含必要功能，不是可删除浪费的测量。后台行早于这组对照，
使用更早的计数读取器快照；子 Agent 完成并退出，但 Spinner 门槛失败。这里 MB 采用十进制。
[数值证据](../../../../../docs/reports/suite-responsiveness-agents-2026-09-05.json)保留精确计数、源码哈希，
以及最初的原生接入样本 `Wq9PYe`。每个 scope 均在清理后核验不活动且已卸载。
这些单次运行证明测量方法可用，不构成重复的优化前后基线，也未完成资源效率验收。

## 通过原生 Provider 请求验证活动 Context

`--suite --context` 现在通过 `ctx_memory` 写入一条项目记忆，再用 `ctx_search` 检索，并在接收请求的回环
服务端检查三次真实原生 Responses 请求。每次都必须包含简版 Magic Context 指令、投影历史块和带标记的
用户输入。第三次必须在 Tool 结果里包含检索证据，而不是仅复述先前的写入参数。公开 Tool-result 事件另行
拒绝错误；观察器要求请求和完成顺序精确匹配、检索一次、自动命名和用量刷新，以及连续输入和选择观察。
`--code-mode` 包装同样两个 Tool；`--ledger` 加入已有的旧历史种子。服务端在 Pi 之外运行，合成请求正文只
保存在私有证据目录。每次响应等待四秒以提供观察时间，没有增加生产等待或修改调度。

这暴露了原 fixture 的两个覆盖缺口。自定义 `streamSimple` 从未调用 Pi 的最终 Provider-payload 钩子，
因此不能认证这一接口。换成原生序列化后，又发现 Context 已降级：即使数据库在全新私有目录，固定版本的
引擎仍因宿主机进程命名空间中存在其他 Pi 而拒绝迁移。上游缓冲日志明确记录了拒绝原因；临时诊断等待和
状态读取 import 随即移除。没有绕过数据库保护，也没有停止任何现有 Pi。此前加载 Suite 的样本仍只证明
其记录的实际工作负载，不能据此认定已测得活动 Context 成本。

运行时除网络隔离外，还需独立 PID 命名空间及其 procfs。shell 让观察器 PID 大于 1，`setsid` 建立本地
进程组，以保留现有基于出生身份的 watchdog 校验。命名空间退出会终止剩余后代进程。Suite 回归测试采用
这一启动方式；每次观察还使用私有 `TMPDIR`，临时缓存和引擎日志不再共用机器默认目录。

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --context \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

基于 `a065ef14` 的最终观察器源码，120×40 样本 `9QTHUI` 通过所有锁定门槛：Spinner 136.050477 ms，
输入/补全准备 26.604012 ms，选择 15.464966 ms，最大采样间隙 17.825732 ms，应有的活动 Spinner 无缺失。
活动期 12.281 秒，共 1,005 次采集。`VazQZM` 加入 Code Mode 和旧 Ledger 后，Context、命名和用量刷新
均完成，但 Spinner 停了 275.024555 ms，未通过原门槛。其采样间隙为 18.455237 ms，因此这是实际捕获的
停顿，不是缺失观察被误算为通过。
下一次 `dQOsBi` 保留 Code Mode、只去掉旧 Ledger，以 Spinner 116.146204 ms、输入/补全准备
26.595219 ms、选择 16.145855 ms、采样间隙 20.577305 ms 通过。各样本均完成三次请求及检索。
这把冷 Ledger 对照扩展到了活动 Context 工作负载，并没有修复停顿。

[数值证据](../../../../../docs/reports/suite-responsiveness-observer-2026-09-05.json)保留这些源码身份及更早的
功能样本 `oxxuCd`；后者早于私有 `TMPDIR` 和最终 wire Tool 结果断言。缓存和隔离条件已经变化，不能将
与旧样本的差值称为资源节省。本次改动没有生产优化。完整 Historian/压缩、中断/恢复、其他已配置功能、
更长的重复运行和其他终端尺寸仍待测。在 `a1e4f9ae` 中，直接在新 PID 命名空间内试用资源 scope 时，
用户 bus 连接失败；已确认尝试的 scope 未加载。下面的改动解决了这个测量问题，没有改变 Context。

## 活动 Context 的 scope 资源统计

观察器现在只在 `systemd-run` 和 `systemctl` 命令中移除 `XDG_RUNTIME_DIR`，从而使用已有的会话 bus。
设置该变量时，systemd 选择管理器的私有 socket；子 PID 命名空间看不到对端 PID，因此校验失败。
移除后，已有的 `DBUS_SESSION_BUS_ADDRESS` 会选择受支持的会话 bus 路径。参见固定版本的
[连接选择](https://github.com/systemd/systemd/blob/v261.1/src/shared/bus-util.c#L468-L496)和
[对端身份检查](https://github.com/systemd/systemd/blob/v261.1/src/basic/socket-util.c#L786-L806)。
Pi 环境、PID/网络隔离、数据库迁移保护、被统计的进程树和计数校验均不变。

同一条 `--suite --context --resource-scope --gates ...` 命令，改动前以 `No data available` 失败，改动后通过。
曾尝试 `--machine=<用户>@.host`：它在继承环境的简单探针中通过，但实际 fixture（`bkb41L`）超时，因此
已移除该路径。引擎的测试数据目录开关也未采用，因为它还会改变 embedding provider 初始化，并非只隔离数据库。

在上面的 PID 隔离 Context 命令中添加 `--resource-scope` 即可运行。以下样本按顺序执行，均使用基于
`a1e4f9ae` 的同一最终观察器源码、120×40 尺寸和全新私有目录，没有 profiler 或注入等待：

| 样本 | 工作负载 | CPU 秒 | 当前 / 峰值记账内存 MB | Spinner ms | 输入/补全准备 ms | 选择 ms | 锁定门槛 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `iJapzZ` | Context 记忆写入/检索 | 17.197857 | 633.942 / 1092.932 | 117.574 | 27.504 | 14.959 | 通过 |
| `9Llhi7` | Code Mode 调用 Context，带旧 Ledger | 19.729707 | 671.678 / 1042.964 | 224.959 | 40.879 | 40.681 | Spinner、输入、选择失败 |
| `oQNzsy` | Code Mode 调用 Context，不带旧 Ledger | 18.615428 | 653.771 / 1040.478 | 120.522 | 15.870 | 15.465 | 通过 |
| `IXK028` | 原生 Bash，不加载 Suite | 2.433290 | 167.727 / 194.744 | 118.313 | 15.229 | 15.335 | 通过 |

每次 Context 运行均完成三次已核验的原生请求、一次记忆检索、一次自动命名请求和一次用量刷新。活动观察
超过 12 秒、970 次采集；最大采样间隙低于 19 ms，应有的活动 Spinner 无缺失。原生行验证不加载 Suite 时
相同资源统计路径可用；它只调用一次 Bash，不能视为等价的 Context 工作负载。四个精确 scope 均在清理后
核验不活动且已卸载。[数值证据](../../../../../docs/reports/suite-responsiveness-observer-2026-09-05.json)
保留计数、时序和源码哈希。

这些都是优化前的测量。Code Mode 配对只改变旧 Ledger 种子；单次配对不能确定多少 CPU 属于重复工作。
记账内存仍不是 RSS 或分配量，关闭阶段也不在计数边界内。冷 Ledger 仍未通过锁定响应门槛。完整资源维度、
重复工作负载、其余 Capability/恢复路径仍由 `ps-yon.3` 跟进。

## 进程 RSS 与 I/O 快照

`--resource-scope` 现在还会在交互观察结束后，记录 cgroup 当前直接成员各自的 `/proc/<pid>/io` 和
`smaps_rollup` RSS。[HostResourceScope](../../../../../scripts/host-resource-scope.ts) 统一负责原生启动、
计数读取和清理。UI 观察器不再负责 bus 命令或内核计数解析，文件从 785 行缩减为 713 行；资源所有者为
138 行。新增源码用于采集和校验 I/O、RSS。

每条记录均绑定进程出生身份，并在读取前后核验。采集前后的 scope 成员必须相同，每个记录的 PID 必须
属于该 scope；计数缺失或格式错误直接使运行失败。`rssSnapshotBytes` 是所记录 RSS 的和，表示收尾后的
快照，不是同时发生的进程树 RSS 峰值。读取区间仍明确保留，采样循环没有新增周期性资源轮询。

Linux 的进程 I/O 包含已经等待回收的子进程，进程记录也包含其线程。`rchar`、`wchar` 是包含非存储 I/O
在内的读写字节计数，`syscr`、`syscw` 是调用次数。存储相关计数为 `read_bytes`、`write_bytes` 和
`cancelled_write_bytes`，分别保留。参见[proc I/O 语义](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html)
和[线程组读取实现](https://github.com/torvalds/linux/blob/v6.19/fs/proc/base.c#L2855-L2914)。独立的仓库 Bun/Linux
探针让子进程读写 1,048,576 字节，再等待它退出。父进程的 `rchar`、`wchar`、`syscr`、`syscw` 增量均包含
子进程记录的计数。这验证操作系统记账规则；下面的固定 Pi 样本验证真实 Host 接口。

| 样本 | 工作负载 | 存活进程 | RSS 快照 MB | rchar / wchar 求和 MB | Spinner ms | 输入/补全准备 ms | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `2FkYA6` | 原生 Bash | 1 | 154.579 | 0.746 / 0.147 | 117.865 | 16.403 | 资源接入检查，未传 `--gates` |
| `ajuSTf` | Code Mode 调用 Context | 2 | 621.543 | 53.158 / 24.712 | 117.425 | 25.963 | 锁定门槛通过 |
| `BDfa4J` | 相同 Context 工作负载，带旧 Ledger | 2 | 665.633 | 72.228 / 24.410 | 356.042 | 97.789 | Spinner、输入失败 |
| `VK9AFF` | 前台 Agent → 子 Bash | 1 | 634.978 | 162.115 / 26.622 | 865.904 | 586.320 | Spinner、输入失败 |

这些样本按顺序运行，均使用基于 `9d892c4b` 的同一最终源码、全新私有目录、PID/网络隔离、固定 Host 和
120×40 尺寸。Context 配对均完成三次原生投影、一次检索、命名和用量刷新，并记录仍存活的 Code Mode
辅助进程的独立计数。Agent 完成子 Tool，核验子进程与出生身份绑定的退出；它的自定义 Provider 不认证
原生 Context payload 钩子。采集均完整，最大间隙低于 26 ms，四个 scope 均已核验卸载。
[数值证据](../../../../../docs/reports/suite-responsiveness-observer-2026-09-05.json)保留逐进程计数和源码哈希。

下面的公开 CLI 检查在改动前因缺少进程记录而失败，改动后通过。保留管道失败传播，避免生产端失败却被
消费端断言算成通过：

```bash
set -o pipefail
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --resource-scope |
  bun -e 'import assert from "node:assert/strict";
    const {resourceScope: s} = await Bun.stdin.json();
    assert(Array.isArray(s.processes) && s.processes.length > 0);
    assert(s.processes.every(p => p.rssBytes > 0));
    assert(s.processes.some(p => p.io.rchar > 0 && p.io.wchar > 0));'
```

表格只对记录的进程 I/O 求和，不是原子快照，也不是任意进程树的完整累计总量。未等待回收、重新托管的
后代进程，以及未枚举的嵌套 cgroup 可能遗漏 I/O，这些记录不能认证那些情况。进程树 RSS 峰值、分配/GC、
唤醒和完整的逐所有者工作负载归因仍待完成。固定的
[Bun 1.3.14 V8 兼容实现](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/v8.ts#L54-L79)
没有累计 `total_allocated_bytes`，且若干 V8 形状的字段只是占位值，不能据此补齐分配量缺口。
本次检查点没有优化生产代码。

## 保留自动 Naming 和 Usage 的 Goal 续跑

2026-09-05 07:38 UTC，现有观察器完成了 `/goal PSYON_MEASURE`：先返回一次未完成的 Assistant 回复，
再自动续跑并调用 `goal_complete`，最后输出一次 Goal Final Response。各次请求看到的已完成 Tool 数为
`[0, 0, 1]`。观察器看到了成功的 Goal Tool 行，并验证规范 `goal-state` 完成记录早于唯一持久化的最终回复。
自动 Naming 和 Usage 各执行一次。中间的 Goal 轮次不发布夹具的最终收尾标记，连续观察覆盖整个续跑过程。

| 样本 | CPU 秒 | 当前 / 峰值记账内存 MB | RSS 快照 MB | Spinner ms | 输入/补全准备 ms | 选择 ms | 门槛 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `l2x3bg` | 20.398637 | 669.692 / 934.756 | 651.649 | 125.562 | 17.232 | 19.450 | 通过 |
| `XRUCuA` | 19.062306 | 641.815 / 940.691 | 622.404 | 111.639 | 15.768 | 15.630 | 通过 |

两个样本均使用固定 Host、全新目录、120×40 终端、隔离 PID／网络命名空间，以及基于 `4f9f92f4` 记录的
源码快照，没有 profiler 或人为阻塞。07:53 UTC 的最终源码样本 `XRUCuA` 还直接核验了规范完成状态与
最终回复之间唯一成功的持久化 `goal_complete` Tool result；这一断言在 `l2x3bg` 之后加入。
`XRUCuA` 的活动观察覆盖 12.206 秒、962 帧，没有缺失 Spinner；完整轨迹的最大观察间隙为 25.783 ms。
成功 Goal Tool 行在启动后 18,763.326 ms 出现，其中包含启动和两次合成的四秒 Provider 等待，不能把这段
总时长当成 Goal 的重复工作。捕获结束后资源读取耗时 35.448 ms；两个对应 scope 均已卸载。私有缓存全新，
但共享的内核页缓存没有重置。这些是重复基线，不是优化前后差值。

数值证据的 `goalSamples` 保留进程计数、请求次数和源码哈希。该自定义 Provider 不认证原生 Context
载荷投影或真实账户访问。Goal 重放、压缩和恢复的资源成本仍未测量。此处没有原生 Goal 对照，
也不声称记录的全部 CPU 或内存都是多余开销。

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --goal --resource-scope \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

Goal 目前是独立工作负载，不能与 Agent、Context、Code Mode 或旧 Ledger 组合。实现前，公开 CLI 回归因
不支持 `--goal` 而失败。夹具开发还发现了完成证据不充分、错误检查 `objective` 字段（规范字段是 `text`），
以及旧补全选项仍可见时就提交输入的问题。观察器现在等选项消失后才提交任何被测提示，没有加入固定延迟。
这些失败的夹具尝试不能认证 Goal 性能。复用已有捕获、Provider 流和 Session 读取，没有新建基准平台：
观察器 713→774 行，Provider 316→369 行，回归文件 118→125 行。生产行为未改变。

聚焦回归组中八项通过；Context 样本 `v3bIJA` 因 62.069 ms 捕获间隙未通过观察器校验，其中单次捕获调用
耗时 51.963 ms，该样本仍为无结论。同一源码的独立 Context 复跑通过；数值证据保留两次结果。
这些回归运行不应用产品性能门槛。
加入持久化 Tool result 断言后，最终源码的 Goal 回归再次通过（一项测试、四条断言）。

## 前台 Agent 执行隔离，2026-09-06

共享子执行引擎移入现有 Pi 进程中的单次运行 Worker 后，最终的直接 Agent 样本通过了锁定交互门槛。
同基线提交的进程内执行样本在 171.120 ms 处违反 Spinner 门槛，最终 Worker 样本为 128.513 ms。
最终生产源码上的 Code Mode 加旧 Ledger 场景也通过。这些是在共享机器上的单次样本，不能保证统计性能，
也不能证明总资源消耗下降。

[Agents 契约](../../packages/pi-stuff/src/subagents/README.md) 拥有这条边界。Pi 保留输入、渲染和父 Session 提交；
Worker 执行现有前台／后台共享子引擎，保留停止通道、写入进程身份、已提交的初始状态和完成文件。
父进程等待 Worker 真正触发 close 后，恢复流程才回收子写入进程。没有新增运行时、持久 Worker 池或依赖。

| 样本 | 负载与版本 | Spinner ms | 输入／准备 ms | 选择 ms | CPU 秒 | RSS 快照 MB | 峰值计费 MB | 锁定门槛 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `sXzhdc` | 进程内基线，直接调用 | 171.120 | 15.022 | 14.786 | 26.227454 | 593.441 | 1255.727 | Spinner 失败 |
| `9h9eie` | 等待实际关闭前的 Worker 候选 | 115.963 | 15.444 | 14.455 | 25.021220 | 679.383 | 1544.212 | 通过 |
| `6udvaY` | 同一候选，Code Mode 加旧 Ledger | 119.283 | 15.319 | 16.115 | 28.699533 | 705.307 | 1517.773 | 通过 |
| `1fTkNY` | 最终 Worker，直接调用 | 128.513 | 25.853 | 14.774 | 26.826419 | 658.158 | 1575.174 | 通过 |
| `gjH5mJ` | 最终 Worker，Code Mode 加旧 Ledger | 126.176 | 15.946 | 15.211 | 29.905843 | 724.828 | 1571.779 | 通过 |

MB 为 1,000,000 字节。CPU 覆盖原生资源 scope，包括线程与子进程，不是主线程 CPU。最终直接样本相对基线
多用 2.28% CPU，结算后 RSS 增加 64,716,800 字节，峰值计费内存增加 319,447,040 字节。执行隔离有实测内存
代价。计费内存不是峰值 RSS；此次改动没有测量分配、GC 和唤醒。Code Mode 没有同基线提交的前置对照。

每行都完成两个真实子 Bash Tool，回收两个经过出生身份验证的子进程，并持久化两个成功的父 Session Tool 结果。
自动 Naming 请求一次、持久化名称一次，Usage 刷新一次。最终直接样本和 Code Mode 样本分别覆盖 38.075、
39.098 秒活动区间，捕获 3,149、3,191 次；最大观察间隙为 16.263、16.182 ms，Spinner 无缺失。
所有资源 scope 均已确认卸载。

运行使用精确 Pi 0.85.0、内置 Bun 1.3.14、全新私有配置、120×40 几何和隔离的 PID／网络 namespace，
没有 profiler、GC 标记或注入停顿。共享机器与内核页缓存未受控。
[数值证据](../../../../../docs/reports/suite-responsiveness-agents-2026-09-05.json) 的 `foregroundWorkerIsolation` 保留原始工件 SHA-256、
源码补丁及观察器快照的哈希、精确指标和失败候选。两个最终样本都匹配基于签名提交 `c9582271` 的最终生产补丁；
后续测试和文字编辑不改变该生产补丁。较早候选没有最终的关闭等待，不能认证其清理行为。

三个失败候选保留为证据，不算验收：`SX6bwV`、`iMPKpo` 在完整 Suite 中构建时无法解析 `effect/Effect`；
`0E4M6y` 因 Worker argv 不再标识编译后的 Pi，选中了 PATH 包装器。Host 适配层现在解析 Package 的 Effect
子路径，并传递已有 Pi 启动元数据。回归测试还发现 `Worker.terminate()` 在线程关闭前返回；最终实现等待
`close`，对应测试在加入等待前失败、之后通过。另一项中断回归证明释放先于写入进程回收，并检查持久的 owner
退出标记和失败状态。

最终 Code Mode 捕获后，现有生命周期验证器在相同生产源码上通过 Ctrl-C 与关闭检查：返回编辑器 122.67 ms，
关闭 111.16 ms。它验证被跟踪的 Agent、shell 和孙进程均退出，规范 Session 保留被取消的 Tool 调用回执；
不要求取消后的 Tool 结果。随后，现有精确 Host 执行矩阵的八个单次／并行、fresh／fork、前台／后台场景全部通过。
这些功能检查不替代上面单独的交互和资源测量。

```bash
bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --agent foreground --repeat-tool \
  --resource-scope --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
# 第二个最终负载加 --code-mode --ledger；保留上文的隔离包装。
bun scripts/benchmark-lifecycle.ts --variants suite --scenarios fresh --actions agent-exit \
  --sizes 120x40 --samples 1 --warmups 0
bun scripts/verify-agents-execution-matrix.ts
```

本检查点处理前台执行边界，不关闭整个 Suite 的资源标准，也不认证 Pi 0.85.1。变更代码仍需交付版本上的 CI；
不代表已合并或在本机安装。
