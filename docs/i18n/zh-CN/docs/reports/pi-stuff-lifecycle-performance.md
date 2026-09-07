<!-- translation-source: docs/reports/pi-stuff-lifecycle-performance.md; translation-source-sha256: d2b0ed066684a1a088610ae968a4b1d8cb762982e73d9b7c8fcd0c20b8b0093d -->

# Pi Stuff 生命周期性能

> **历史性能跟进。** 这份报告保留 Pi 0.84.2 的 schema 6 结果和仍可执行的 lifecycle contract。它曾支持
> 2026-08-31 的 Effect 中期接受结论，但不构成当前主线认证；[2026-09-01 预注册对比](./effect-v4-mainline-decision-2026-09-01.md)
> 已取代其采用结论。当前 Host 身份见[兼容性指南](../compatibility.md)。

## 测量契约

每个样本都启动一个真实 fullscreen Pi 进程，并隔离 Settings、home、cache 和 Session 目录。本地确定性
Provider 让整个运行保持离线，也不需要凭据。

| 维度 | 必须覆盖的范围 |
| --- | --- |
| 变体 | 只加载 Host fixture；加载 Pi Stuff 和同一 fixture |
| Session | `fresh`、`resume-short`、`resume-long`、`degraded` |
| 操作 | `exit`、`ctrl-c`、`reload`、`reload-change`、`prompt`、`background-exit`、`agent-exit` |
| 终端 | 100×32 和 64×28 |
| 采样 | 每个普通 cell 一次 warmup，至少三个测量样本 |
| 长历史 | 至少 6,000 个 Tool result，每个至少 8,192 bytes |
| 检查 | Lifecycle trace、终端恢复、有效 Session JSONL、Prompt marker 和子进程退出 |

运行认证矩阵：

```bash
bun run benchmark:lifecycle --output .artifacts/lifecycle-benchmark/final.json
```

缺少覆盖或超出 p95 预算时，命令会失败。首次超预算的 cell 会使用相同 warmup 和样本数再运行一个独立
确认批次。两批结果都会留在 JSON 中；只有再次超出同一绝对预算或配对 Host 开销预算才判定失败。直接调用
脚本不构成认证。

可执行契约位于 [`benchmark-lifecycle.ts`](../../../../../scripts/benchmark-lifecycle.ts) 及其
[测试](../../../../../tests/unit/repository/lifecycle-benchmark.test.ts)。

## 记录的 schema 6 结果

原始 JSON 曾存放在 `.artifacts/lifecycle-benchmark/ps-9t2-1-4-final.json`，没有纳入 Git。这里保留结果摘要：
292 个隔离 Pi 0.84.2 进程、6,500 个 8 KiB Tool result、`acceptance.passed: true`，没有 finding，也没有
confirmation cell。

| 两种终端尺寸下的 Suite p95 | 记录范围 |
| --- | ---: |
| 6,500-Tool reload | 1,997.18–2,053.80 ms |
| 第一次确定性响应 | 465.75–488.09 ms |
| 同一进程中的第二次响应 | 54.53–68.28 ms |
| 活跃 Background Shell 关闭 | 198.84–201.99 ms |

## 当前 schema 6 预算

Benchmark 强制以下 p95 上限：

| 测量 | 普通 / 长 Session 预算 |
| --- | ---: |
| 已配置或降级 Suite 启动 | ≤ 2,700 ms |
| 长 Session Suite 启动 | ≤ 12,000 ms 且 ≤ 配对 Host + 2,250 ms |
| 其他 Suite 启动开销 | ≤ 配对 Host + 2,250 ms |
| 第一次输入确认 | ≤ 50 ms |
| 第一次 Provider boundary | ≤ 800 / 2,300 ms |
| 第一次确定性响应 | ≤ 1,100 / 2,600 ms |
| 同进程输入确认 | ≤ 15 ms |
| 同进程 Provider boundary | ≤ 100 / 350 ms |
| 同进程确定性响应 | ≤ 150 / 550 ms |
| 普通退出 | ≤ 150 / 550 ms |
| Ctrl-C | ≤ 250 / 550 ms |
| 未变化 reload | ≤ 200 / 2,500 ms |
| 活跃 Background Shell 或 Agent 关闭 | ≤ 250 / 375 ms |
| Agent interrupt | ≤ 1,000 ms |
| 源码变化 reload | ≤ 8,000 ms |

较高的启动上限允许已配置 Context 在 editor ready 前初始化，但不授权创建或迁移配置。旧 `ps-5bw` 诊断、
schema 5 测量和已经失效的预算留在 Git 历史中，不在这里重复。
