<!-- translation-source: docs/capabilities/rtk.md; translation-source-sha256: 7bcea826e35c5a296a1d1a0101874e25d46b2e9cfbe42304565d36d5753d3f9c -->

# RTK

[English](../../../../../docs/capabilities/rtk.md)

RTK 在执行前缩短符合条件的 shell 命令，并把成功 Bash 与 Grep 输出的紧凑投影加入 model context。

## 安装

复用 `PATH` 中已安装的 RTK `0.45.0`。接受同版本源码构建与 PATH shim；受支持 profile 仍为 Linux x64。Pi Stuff 不下载或重装 RTK。兼容性由版本检查与真实命令行为建立；[上游参考](../../../../../packages/pi-stuff/src/rtk/UPSTREAM.md) 中的官方发布哈希只记录 CI 下载来源，不作为运行时准入要求。

## 快速开始

启动 Pi Stuff，然后打开：

```text
/rtk
```

Dialog 显示 runtime 状态、Command rewriting、Model projection 和当前 Session savings。`/rtk` 不接受子命令。

## 两项独立行为

| 行为 | 默认值 | 作用 |
| --- | --- | --- |
| Command rewriting | 开 | 在 Pi 执行前，允许 RTK 替换符合条件的 Bash 命令 |
| Model projection | 开 | 为下一个 provider request 压缩成功 Bash 与 Grep 文字 |

Runtime 不可用时会关闭 rewriting，但 Model projection 仍可在本地压缩受支持结果。

## Runtime 验证

启动阶段不执行 RTK 进程工作。第一次符合条件的 Bash rewrite，或 dialog 中的显式验证，会：

1. 解析 `PATH` 中第一个 `rtk`；
2. 解析 real path，并为普通文件生成 fingerprint；
3. 运行 `rtk --version`；
4. 检查受支持版本并记录本地可执行文件身份。

执行使用选中的 PATH 名称，保留普通 shim 的调用行为。

之后每次 rewrite 都会重新检查 path、real path、fingerprint、SHA 与报告版本。Binary 发生变化时进入 `drifted` 状态，
显式验证前保持禁用。这些检查检测已验证本地文件的变化，不与官方发布哈希比较。重复的版本探测也会拒绝未改变的 shim 背后切换出的不受支持版本；验证不声称识别 shim 私有分派配置对应的二进制身份。

Dialog 状态为 `✓ ready`、`○ unchecked`、`! drifted` 与 `× unavailable`。按 `v` 验证，按 `c`
清除 Session savings。

## 命令改写

空命令和已经调用 RTK 的命令保持不变。Rewrite discovery、version 与 rewrite call 的 timeout 分别为
600 ms、1 秒与 2.5 秒。

RTK exit code 1 和 2 表示不改写。Code 0 和 3 可以返回替换命令。其他结果、timeout、缺少
executable 或验证失败都会保留原命令。

最终 Bash call 仍由 Pi 执行，权限、生命周期与结果也由 Pi 负责。

## Model 投影

投影只处理 Bash 与 Grep 的成功文字结果：

- 移除 ANSI 控制序列；
- 可以压缩 build、test、Git 与 linter 输出；
- 对 Grep 结果分组；
- 投影文字默认最多 12,000 个字符。

失败结果、Read 输出、非文字 block、未知 Tool 和源 message 保持不变。投影通过 copy-on-write 只用于 provider
context；Session JSONL 与 transcript 输出保留原 Tool result。

重复 provider projection 是幂等的，并按 Tool-call ID 复用 cache。

## 设置与 savings

`rtk` 命名空间保存 `rewriteCommands` 与 `outputProjection`，默认都是 `true`。只有在 `/rtk` 中直接修改
才会持久化。

Session savings 比较原始与投影后的字符数。它是进程内呈现指标，不代表 billing 或准确 token 数量。清除 savings
不会改变 Tool result。

## 恢复

如果 rewriting 没有按预期工作，运行 `/rtk` 并验证 runtime。Binary 缺失、移动、过慢或未通过认证时，会安全
使用原命令。见[故障排查](../troubleshooting.md#rtk)。

## 相关文档

- [RTK Module README](../../packages/pi-stuff/src/rtk/README.md)
- [设置参考](../reference/settings.md#rtk)
- [命令参考](../reference/commands.md#codex-与-rtk)
- [上游参考](../../packages/pi-stuff/src/rtk/UPSTREAM.md)

