<!-- translation-source: packages/pi-stuff/src/code-mode/README.md; translation-source-sha256: 805c8d21b1b2e9762e51c12a4cc76456dbfbb8bd31ef29b703e49f7c22a7766d -->

# Code Mode

[English](../../../../../../../packages/pi-stuff/src/code-mode/README.md)

在隔离 V8 host 中通过 JavaScript 组合活动 Pi Stuff Tool。

<p align="center">
  <a href="../../../../../../assets/readme/capabilities/code-mode.png">
    <img src="../../../../../../assets/readme/capabilities/code-mode.png" alt="Code Mode 项目控制与本地目录" width="100%">
  </a>
  <br>
  <em>Code Mode 在同一界面中展示项目策略和本地操作目录。</em>
</p>

## 快速开始

```text
/codemode on
```

Model 随后可以发现本地 catalog，并从 `codemode({ code })` 调用 `tools.*`。打开 `/codemode` 查看
有效策略、catalog、approval 与 Session ledger。

## 亮点

- 显式解析受信项目、全局、进程与 child-Agent policy。
- 阻止 sandbox 直接访问 Node、filesystem、process、network、module 与 credential。
- 保留每个 nested Tool 的 validation、permission、lifecycle、renderer 与 media behavior。
- 让有界 Tool Discovery 保持可调用；契约放不下时明确要求 `codemode.describe`，而不暴露不完整 signature。
- 在 append-only Session ledger 中记录稳定 execution 与 nested-call ID，不让保留字节数成为工作配额。
- 正常分支推进只折叠新增的 Session 条目；分支发生分歧时从 Pi 重建。
- 冷加载时先根据事件声明的 kind 选择清理与校验规则。保留一次 TypeBox 克隆，以维持危险属性名过滤
  和 Host 记录隔离，不再反复尝试无关事件类型。
- 已校验的标量结果直接恢复，不再经过第二轮 JSON 序列化和解析。对象与数组结果仍通过存储 codec 解码。
- 副作用之后的序列化或持久化失败会将执行标记为 incomplete，并阻止后续嵌套调用与自动重放。
- 支持持久 approval、replay policy、rollback、checkpoint 与保存的 snippet。
- 只在第一次显式 execution 时安装和验证 pinned V8 helper。

## 文档

- [Code Mode 指南](../../../../docs/capabilities/code-mode.md)
- [命令参考](../../../../docs/reference/commands.md#code-mode)
- [设置参考](../../../../docs/reference/settings.md#codemode)
- [故障排查](../../../../docs/troubleshooting.md#codex-与-code-mode)
- [上游参考](UPSTREAM.md)
