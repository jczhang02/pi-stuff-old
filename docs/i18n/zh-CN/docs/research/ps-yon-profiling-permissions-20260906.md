<!-- translation-source: docs/research/ps-yon-profiling-permissions-20260906.md; translation-source-sha256: 90bb803d3fa886cfb0ba407b14eccb9a908ccc0e444750466ffd135ccdb47f1e -->

# ps-yon 性能测量权限核查

日期：2026-09-06

本机的权限错误不足以证明维护者必须授予更高权限才能完成 `ps-yon`。据此停止整个任务过于仓促。
普通用户探针已在批准的 Host 上运行成功，仓库也已经使用支持免密 sudo 的 GitHub 托管虚拟机。
后续 CI 探针已经确认可读取内核事件。

## 验收要求

[ADR 0034](../../../../../docs/adr/0034-remove-redundant-suite-work-without-feature-cuts.md) 要求报告 CPU、
常驻内存、分配与 GC、I/O、唤醒和操作耗时，并说明测量限制。它没有要求追踪每一次独立内存分配。
缺失维度仍须满足 `ps-yon.3` 和 `ps-yon.5` 要求的、有直接证据支持的边界；堆快照不能替代分配量，
上下文切换也不是唤醒。本次纠正不豁免任何验收要求。

## 普通用户探针

探针使用固定的 Pi 0.85.0 Linux x64 可执行文件，SHA-256 为
`0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`，内嵌 Bun 1.3.14。
它清空继承的环境变量，使用新建的私有配置和独立网络/PID 命名空间，并在发出任何 Provider 请求前，
从只用于测量的 Extension 退出。命名空间中的 root 身份映射到宿主机的一个普通 UID，并非以宿主机 root
运行。主进程、Worker 和子进程均完成并退出。

| 测量 | 实测结果 | 限制 |
| --- | --- | --- |
| 主进程与子进程 CPU profile | 分别有 269 和 266 个样本，报告采样间隔均为 1 ms | 未证明每个 Worker 都有独立 profile；采样不能界定每个任务的耗时上限 |
| `bun:jsc` 堆统计 | 主进程、Worker、子进程均返回堆大小和对象数 | 是快照，不是累计分配字节数 |
| `bun:jsc` 内存用量 | 三者均返回进程当前及峰值内存 | Worker 与主进程共享进程；不能相加它们的 RSS，也不能把各进程峰值之和当作进程树同时峰值 |
| `JSC_logGC=1` | 主进程/Worker 以及子进程均输出 GC 诊断 | 日志行数不是 GC 周期数，也不是完整的停顿或分配记录 |
| `MIMALLOC_SHOW_STATS=1` | 此可执行文件未输出原生堆汇总 | 未取得原生分配总量；未发现权限错误 |

结果记录的 SHA-256 为 `ff264ab29ac512f08c9375cf635623fa39252c04fea8d063b6acfc905a5f2daa`。
这是不加载 Suite 的测量能力检查，不是资源节省或验收基准。执行分配 20,000 个对象的练习前后，堆大小
未变；不能据此把分配量记为零。较早的组合 profiler 探针和 Worker `close()` 探针失败，已排除。
另一个独立的前期探针触达真实 Provider；已披露，且不计入离线证据。

Bun 文档说明了 JavaScript/原生堆的区分、堆统计，以及通过 `BUN_OPTIONS` 启用 CPU profiling 的方法。
这些 API 无须内核跟踪权限。参见固定版本的
[Bun 1.3.14 基准测量文档](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/project/benchmarking.mdx)
和 [`bun:jsc` 声明](https://github.com/oven-sh/bun/blob/bun-v1.3.14/packages/bun-types/jsc.d.ts)。

## GC 诊断的含义

Bun 1.3.14 的[构建定义](https://github.com/oven-sh/bun/blob/bun-v1.3.14/scripts/build/deps/webkit.ts#L1-L5)
固定使用 WebKit `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b`。实测日志格式与该源码一致；仅凭
可执行文件中的 Bun 版本号，不能证明构建者没有覆盖 WebKit 版本。

调度器将 JSC 本周期分配计数除以 1,024 后输出为 `ca=`。这是浮点数，不是按整 KiB 截断；
[调度器](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/StochasticSpaceTimeMutatorScheduler.cpp#L65-L75)
与 [`PrintStream`](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/WTF/wtf/PrintStream.cpp#L216-L219)
给出了换算方式和六位小数格式。计数器相加的是向 JSC 报告的普通分配和超大分配，参见
[`Heap.h`](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/Heap.h#L653)。
两个计数器都在回收完成时归零。`p=` 记录实际暂停，包括转入并发回收前的中间暂停；`tp=` 是调度目标。
一个回收周期可以有多次实际暂停。参见
[`Heap.cpp`](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/Heap.cpp#L1533-L1537)、
[最后一次暂停](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/Heap.cpp#L1659-L1661)
和[计数器归零](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/Heap.cpp#L2382-L2386)。

只使用能明确关联到一个进程及 VM 的完整周期。实测发现主进程和 Worker 的文本会在同一行内交错；
把整行归给第一个 VM 会混合两者的数据。丢弃有歧义、截断和缺少起始记录的内容，并报告有多少起始记录
未被接受。对接受的周期，在限定数值范围内累加 `max(0, floor(ca * 1024) - 1)`，可得到所捕获
JSC 计入分配子集的保守下界，预留小数舍入余量。它不包含各次起始时刻之后的并发分配、尚未回收的尾部、
缺失记录，以及没有向 JSC 报告的原生分配。累加每一个被接受的 `p=`，但将最大值标为观测最大值，
不能视为未观测暂停的上界。日志也会扰动工作负载，不能用于认证普通响应性门禁。

## 范围较窄的内核限制

本机 `sched_wakeup` tracepoint ID 无法读取。包含内核的 `perf_event_open` 软件上下文切换事件返回
`EACCES`；仅用户态的版本可以打开，但短探针读数为零。`/proc` 和进程资源用量中的上下文切换计数仍可读。
它们不能证明唤醒次数或其上限。Linux 允许唤醒尚未停止调度的任务，参见
[Linux 调度器源码](https://github.com/torvalds/linux/blob/v6.12/kernel/sched/core.c) 中的 `ttwu_runnable`
和 `ttwu_do_wakeup`。该源码用于提供语义反例，不是本机内核的精确构建。访问控制见
[`perf_event_open(2)`](https://man7.org/linux/man-pages/man2/perf_event_open.2.html)。

通过本机这一路径精确采集内核事件，需要跟踪访问权限。这不意味着所有性能测量都需要提权，也不意味着
维护者必须修改自己电脑的权限。

## 已有路径与剩余工作

仓库的 [CI workflow](../../../../../.github/workflows/ci.yml) 已经使用 `ubuntu-24.04`、sudo 安装依赖，
以及隔离命名空间检查所需的特权设置。这些步骤在
[运行 34038726153](https://github.com/jczhang02/pi-stuff/actions/runs/34038726153) 中通过，对应提交
`6d4d1a27dae633a1e1141f162de668c9f9a38037`。GitHub 的
[runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 明确说明，此类 runner
使用新建虚拟机，Linux 虚拟机支持免密 sudo。因此已有环境可用于验证这项局部内核要求，无须请求本机
管理员权限。后续[运行 34043925911](https://github.com/jczhang02/pi-stuff/actions/runs/34043925911) 对应
`0c6687eed45910f06253d040522fd61dfce0f905`，完整验收和独立的内核探针均通过。在
`6.17.0-1022-azure` 上，一次 0.1 秒 sleep 产生三次唤醒、一次新任务唤醒、一次 fork 和一次 exit，
丢失事件计数为零。独占 tracefs 实例已删除。这是正控计数，不是 Pi 测量。

工作负载采集器复用已有 observer，并保留用户、网络和 PID 隔离。内核事件 PID 属于宿主机全局空间，
因此通过唯一暂存 Pi 可执行文件的 exec 记录识别被测父进程，不把命名空间内的夹具 PID 当作内核身份。
解析器在内核退出清理期间保留任务归属，并区分后续 PID 复用。Linux 在内存和文件清理之前发出 exit
事件，参见 [`do_exit`](https://github.com/torvalds/linux/blob/v6.17/kernel/exit.c) 和
[事件输出格式](https://github.com/torvalds/linux/blob/v6.17/include/trace/events/sched.h)。未知格式、事件
丢失、缺少 exit、根 PID 复用或归属任务发生非主线程 exec 都会使测量失败。后续的
[配对工作负载报告](../../../../../docs/reports/suite-comparable-resources-2026-09-06.md#completed-scheduler-comparison)
记录了运行 `34052545498` 的 28 个 Pi 跟踪工作负载，报告的丢失事件为零，观测任务均已退出。
优化前后的唤醒比较来自这些工作负载计数，而非正控。

继续使用已有 observer，推进普通权限可完成的资源与历史卡顿调查。响应性 observer 已有独立的
`--cpu-profile` 诊断模式；不得把 profiling 与冻结的活性门禁混跑。在已验证的 CI 环境中运行匹配的工作负载。
不要把本机 baseline 和 CI candidate 混为配对样本，不要
新建 profiler 框架，也不要仅为回答权限问题重跑未改动的完整验收。完整资源覆盖、长 Session/恢复证据
和历史卡顿归因仍未完成；探针成功或 CI 全绿均不能关闭 `ps-yon`。
