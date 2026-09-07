<!-- translation-source: docs/reports/agents-loading-and-projector-cost-2026-09-06.md; translation-source-sha256: 03fa8d1b993c8a73d22cbb6311f8f17eca9702cf211da58735329ac2d2fc7402 -->

# Agents 冷加载与投影器成本

2026-09-06，候选版本在三轮无探针、完整 Suite 的样本中通过冻结的响应门槛：
两轮直接前台调用，一轮经过 Code Mode 并带旧 Execution Ledger；每轮均启动两个 child Agent。
这是 `ps-yon.6` 和 `ps-yon.19` 的已验证阶段结果，不是
[16 个 Capability 资源审计](suite-resource-inventory-2026-09-05.md)的完成声明。

[数值记录](../../../../reports/agents-loading-and-projector-cost-2026-09-06.json)保留本次调查全部 25 个完整样本，
包括被否定的中间版本、诊断、源码与证据哈希、资源快照及测量限制。
原始 Session、Provider 日志、终端画面和追踪文件保持私有。

## 两类不同开销

基线为 `2428f1c1d1f24c6a91a3f26e387842e3259bffd3`。`8UraCb` 的外部调度采样包围了一次
224.319 ms 的冷启动 Spinner 停顿：窗口耗时 234.525 ms，parent 主线程消耗 221.773 ms CPU。
这支持继续调查 CPU 密集的冷加载。更早的 `5qyQdR` 诊断中，正确对齐后的 267.917 ms 停顿窗口包含
913 次被追踪的文件系统调用，合计仅 6.629 ms。最初分析使用了错误的时间原点，已丢弃的计数不能作为证据。
该追踪不覆盖其他系统调用或所有离开 CPU 的原因。

另一轮 10 ms CPU 采样 `ZvFFVd` 记录到跨前台 executor、child task/process/protocol 依赖链的
Babel/Jiti 转换；其中带标记的 task Module 导入耗时 98.293 ms。Profiler 使作用域 CPU 超过两倍，
内存也明显增加；采样占比不等于独占 CPU 自耗时。导入后的原生事件尾段仍未归因。

候选版本用一个 Agents 内部的 `deferredModule` helper 共享首次导入 Promise，
在加载前后各让出一个零延时 timer turn。导入失败会清除 Promise；热态和并发调用复用它，不增加 timer。
这些切口对应必要依赖，不是每次 Tool 前的固定等待，也不是推测性预加载。
公开 executor、准备／模型规划、启动生命周期、runner 控制／收尾、child engine 和 protocol 加载
仍由各自已有所有者负责。protocol 加载在 spawn child 之前完成。

简单的任务输入 helper 移到已有 executor contract；child-process 输入／控制类型进入仅供类型使用的 contract。
仅测试需要的 writer re-export 不再让前台执行加载 detached writer 实现。拒绝的启动输入不加载 builder。
目录 claim、初始状态所有权、恢复、取消、protocol 校验、终态排空及 writer 回收保持原有顺序。

更窄的导入切分不足以解决问题：`0bVOtq` 未通过 Spinner 门槛，`dyLBS2` 未通过 selection 门槛，
`NNlRE0` 的稳态输入耗时 40.990 ms，超过未调整的 40.465312 ms 门槛。
后续冷链切分又暴露 `9LkXjG` 的后段 270.053 ms 停顿：当时第一个 child 正等待响应，
尚未进入结算，也不是冷导入。一次重跑通过不能解决这项失败。

## 投影器反复刷新锁记录

500 ms 前台心跳先投影嵌套事件，再刷新 Current Agents。投影器虽然使用稳定 inode 锁，
却在每次获取锁时重写并同步刷盘一份无用的诊断 owner 记录。投影和退役调用方都不读取该记录；
互斥和进程退出后的释放已由内核保证。

定向诊断在替换前后使用相同的外部逐画面调度读取和回调计时，把四处投影／退役锁获取
换成现有 `tryAcquireKernelClaim`。锁路径、校验规则、获取重试、事务、status／registry 提交
以及退役 token 均未改变。

| parent 诊断 | 开始时间，UTC | 心跳次数 | 心跳合计／最大值，ms | 投影锁 owner fsync 次数／合计／最大值，ms |
| --- | --- | ---: | ---: | ---: |
| 对照 `7YhlYi` | 08:41:05.932 | 49 | 547.724 / 50.959 | 53 / 510.847 / 49.670 |
| 候选 `6CBaI8` | 08:45:53.836 | 48 | 26.894 / 0.955 | 0 / 0 / 0 |

嵌套投影本身从合计 531.871 ms／最大 50.602 ms 降到 16.059／0.832 ms。
对照中 Current Agents 投影最高为 1.096 ms，本次未修改它。三秒一次的结果安全扫描看到空目录，仍予保留。
心跳次数不同来自操作持续时间，不是降低刷新频率。

这些计时定位了已移除的同步 owner 记录 I/O，但不能证明历史 270.053 ms 停顿，
或更早 `U4SAr9` 的 489.594 ms 停顿，就是该 I/O 所致。
两次具体后段停顿都缺乏对应因果追踪；GC 归因尚未证实。两项失败继续保留。

## 无探针原生检查

全部运行使用精确认证的 Pi 0.85.0 二进制、内置 Bun 1.3.14、完整 Suite、120×40 终端、
隔离的 network／PID namespace，以及全新的私有 settings 和临时缓存。不清空内核 page cache。
无探针观察器与冻结门槛文件均未修改；不并发运行测试或 profiler。

| 样本 | 开始时间，UTC | 工作负载 | Spinner 最大值，ms | 稳态输入最大值，ms | Selection 最大值，ms | 门槛结果 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 基线 `16AYGL` | 07:38:47.524 | 直接调用两次 | 258.466 | 78.354 | 15.628 | FAIL |
| 最终 `PaHqrD` | 08:47:17.205 | 直接调用两次 | 126.409 | 25.686 | 13.820 | PASS |
| 最终 `Rpps9R` | 08:48:26.348 | Code Mode + 旧 Ledger，两次 | 126.019 | 37.909 | 14.159 | PASS |
| 最终 `i21pqi` | 08:49:48.824 | 直接调用两次 | 137.184 | 25.971 | 25.956 | PASS |

四轮均完成并回收两个 child，自动 Naming 各请求和持久化一次，Usage 各刷新一次。
最终样本的活动观察持续 37.0–37.4 秒，活动采集至少 3,088 次，活动 Spinner 无缺失，
采集间隔低于 23 ms。结束后逐个检查所属 scope，结果均为 not-found／inactive／dead。

三个最终样本的 19 文件源码 diff SHA-256 相同：
`0e88e8a44e454ce01ed241eed1a98dd6584cdfcea6b1e0f2556d709786c7a5ae`。
作用域 CPU 合计分别为 22.536、23.248、23.541 秒；最终总 RSS 快照为
611.377、653.545、603.226 十进制 MB。Code Mode 快照包含仍运行的 helper。
波动的总量和内存记账峰值都不能证明整个 Host 的资源稳定下降。
分配量、GC 和完整唤醒计数尚未测量；最终 RSS 不是进程树 RSS 峰值。

## 回归与剩余验收

现有嵌套投影回归在锁修改前失败，因为投影覆盖了已建立的 owner 记录。
现在测试检查：新事件投影、权威投影、未使用路由退役失败，以及仍有活动后代时的根终态提交，
都不改变锁内容或 inode。已有的竞争、排空、恢复与进程死亡测试也通过：
四个文件共 37 个测试、152 个断言。冷加载回归覆盖 timer turn、并发复用、重试和实际导入边界。
聚焦启动／生命周期测试与 `bun run check:fast` 通过；最终审查和同版本交付检查仍由 Beads 跟踪。

变更产品源码合计 4,225 → 4,272 行，测试 965 → 1,061 行；原生副作用清单增加一行。
child engine 从 799 降至 767 行；59 行的类型 contract 让调用方不必加载 engine。
571 行的 task runner 保留任务尝试／生命周期职责；527 行的 nested-event 测试文件保留共享公开路由 fixture
及竞争／退役场景。数值记录列出每个变更文件与哈希。

临时探针已全部移除。这些通过结果只认证所列工作负载及对应源码，
不证明偶发停顿消失、完整资源维度达标，也不覆盖全部 Capability 仍待验收的启动、空闲、
长 Session 和恢复路径。没有重启用户 Host、安装 Package、合并分支或宣告 epic 完成。
