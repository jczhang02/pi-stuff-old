<!-- translation-source: docs/reports/suite-lifecycle-comparison-2026-09-06.md; translation-source-sha256: fb1ca94f16e39955fec73d449ff6404829708a430e51036c42b2787fe28e99be -->

# Suite 生命周期资源前后对照

在同一个 Pi 0.85.0 可执行文件上，`b0a637fc` Package 的六种生命周期工作负载均比原始 `6d0507c1` Package
少用 CPU。CPU 中位数下降 21.4–33.6%；每个候选 CPU 样本都低于对应基线的全部样本。含预热的 48 次运行
全部通过现有生命周期功能检查。这些证据覆盖启动、普通提示、未变更重载和空闲退出，不代表整个 Suite 已完成。

[数值记录](../../../../../docs/reports/suite-lifecycle-comparison-2026-09-06.json)保留全部样本、最小值/中位数/最大值、
完整 commit 与 Package 树身份、锁文件哈希，以及私有原始报告和读取器的哈希。两棵树的 Package 依赖声明相同。
基线开发 SDK 为 0.84.4，候选为 0.85.0；双方均使用当前 benchmark/fixture 和精确的 0.85.0 Host。
没有改动用户安装或正在运行的 Pi。

原始基线也早于 Work Continuity、Goal 终态回复改动及 0.85.0 适配。这些总量包含期间的其他变更，不能
单独归因于 `ps-yon` 优化。后续完整功能对照改用 `40101bb2`：这是已集成上述改动的最后一个优化前 Package，
其依赖锁文件也与候选相同。下列观测对于各自注明的源码树仍然有效。

## 可比运行

测量于 2026-09-06 17:07:36 至 17:11:13 UTC 串行执行，机器为 Intel i9-13900H，20 个在线逻辑 CPU，
Linux `6.19.10-jc-xanmod1`。期间未并发运行本地测试、子代理或其他本任务基准；未控制机器上的其他活动、
CPU 频率或内核页缓存。

现有 `benchmark-lifecycle.ts` 在 120×40 终端上运行新 Session 和恢复的长 Session。长 Session 包含 240 轮
用户/助手对话，以及 1,000 个历史 Tool 结果，每个负载为 4,096 字节。每个版本/单元各保留一次预热和三次
正式测量；批次顺序为基线/候选、候选/基线、基线/候选、候选/基线。每次采样都在用户、网络和 PID 命名空间
中创建新的 Pi 进程与私有配置，进程内 Suite 缓存为空。重载则复用同一进程的导入缓存。

prompt 动作完成首轮和重复提示；reload 执行 `/reload` 后，再通过 Suite surface 验证一次提示。
双击 Ctrl-C 从空闲编辑器退出，不测试取消活跃 Agent。退出后，现有验证器检查 Session 持久性、历史负载
标记和终端设置恢复。

| Session / 动作 | CPU 中位数，秒：基线 → 候选 | 等待退出的 Pi maxRSS 中位数，十进制 MB：基线 → 候选 |
| --- | ---: | ---: |
| 新 Session / prompt | 4.913 → 3.469 | 994.402 → 790.553 |
| 新 Session / reload | 5.456 → 3.965 | 1,034.322 → 863.326 |
| 新 Session / 双击 Ctrl-C | 4.305 → 2.857 | 839.881 → 713.724 |
| 长 Session / prompt | 6.388 → 4.843 | 1,035.514 → 878.858 |
| 长 Session / reload | 8.295 → 6.519 | 976.396 → 880.329 |
| 长 Session / 双击 Ctrl-C | 6.281 → 4.701 | 998.724 → 831.869 |

新 Session 的启动至编辑器可用时间中位数，基线为 3.881–3.969 秒，候选为 2.537–2.718 秒；长 Session
分别为 4.743–4.816 秒和 3.405–3.416 秒。每个正式测量单元的输出操作记账值在两个版本间相同。
输入操作数有波动，不能据此声称节省了存储 I/O。

## 测量边界与失败探针

外部 Bun 1.4.0 读取器继承终端描述符，启动认证 Pi，等待退出，再读取 `child.resourceUsage()`。
Pi 仍使用内嵌 Bun 1.3.14。夹具临时增加一行读取器调用；移除后，文件恢复为 SHA-256
`6b63259cb4d78429de8311bf8d49fec01fb84d834fad1872f9f1e6c7e5799144`。
读取器自身与 Expect 不在 CPU 统计边界内。[Bun API](https://bun.sh/docs/runtime/child-process#resource-usage)
以微秒报告 CPU，以字节报告 maxRSS；[Linux 等待子进程记账](https://man7.org/linux/man-pages/man2/getrusage.2.html)
可能包含已等待的后代。maxRSS 不是进程树合计峰值 RSS，文件系统计数是操作数而非字节数，上下文切换数也不是
调度器唤醒数。进程寿命包含夹具交互等待和读取器发起 spawn 的开销。

第一个探针成功加载，但进程退出回调没有生成 Suite 资源文件，其六次功能运行没有资源证据。
替代读取器最初把原生统计对象序列化为 `{}`，对应六次功能运行也被排除。显式提取数值字段后采集正常。
两个失败尝试均保留在私有证据目录中，不计入正式测量或预热批次。

两个版本使用相同的离线夹具。Context 保持启用，但夹具禁用了 dreamer、embedding、sidekick 和 Context Todo
服务。本轮不认证自动 Naming/Usage 或活跃远程服务；样本中未运行连续 Spinner 观察器、allocation/GC 计数、
唤醒跟踪或活跃恢复负载。没有启用生命周期基准自身的验收/确认策略，该策略也不能替代锁定的单次事件门槛。
完整 Agent/Context 功能测量及其他待界定项仍在[资源清单](suite-resource-inventory-2026-09-05.md)中保持开放。
