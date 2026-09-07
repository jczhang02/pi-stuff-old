<!-- translation-source: docs/readme-style.md; translation-source-sha256: e871aabaee7e32a777c5526d9ad180ced21ef995b6d890570dfa1683ae4b748f -->

# README 规范

[English](../../../../docs/readme-style.md)

本指南用于保持所有 Pi Stuff README 简洁、易于导航且视觉统一。根目录 README 采用
[Best README Template](https://github.com/othneildrew/Best-README-Template) 的结构；Package、Capability
和索引 README 使用适合其范围的精简变体。

## README 职责

| README | 用途 | 章节 |
| --- | --- | --- |
| 根目录 | 介绍 Suite，并引导新用户 | Hero、About、Preview、Getting Started、Usage、Documentation、Contributing、Security、Acknowledgments、License |
| Package | 说明安装的 Package | 名称与用途、Preview、Capabilities、Installation、Documentation |
| Capability | 介绍一项用户可见能力 | 名称与用途、Preview、Quick Start、Highlights、Documentation |
| 索引 | 帮助读者选择去向 | 名称与用途、视觉索引、分类链接 |

没有有效内容时省略对应章节。Acknowledgments 只出现在根目录 README。

## 内容边界

README 是入口页。只保留安装步骤、最小可用示例、主要结果和详细文档链接。

以下内容移到对应文档：

- 完整命令语法放入[命令参考](reference/commands.md)；
- 设置字段与默认值放入[设置参考](reference/settings.md)；
- 终端和集成恢复放入[故障排查](troubleshooting.md)；
- Capability 详细行为放入 `docs/capabilities/`；
- 所有权术语放入 `CONTEXT.md`；
- 共享视觉规则放入 `DESIGN.md`；
- 持久取舍放入 ADR；
- 定期证据放入 research、report 和 release note。

不要在用户文案中讲述文档编写过程。避免“根据某 ADR……”、证明式的生命周期说法、内部维护免责声明，
以及已由其他文档负责的重复理由。

## 根目录徽标

使用两行居中徽标，顺序如下：

1. CI、MIT License、GitHub stars、GitHub forks、last commit。
2. Pi `0.85.1`、Bun `1.4.0`、TypeScript `5.9.3`、Linux x64。

徽标分别链接到 workflow、license、仓库活动、兼容性参考或相关上游项目。不要加入 npm、release 或 issue
数量徽标。

`tests/` 下的 README 是纯文字工程导览，介绍测试目录、命令及 benchmark 边界，不要求截图。

## 截图

除 `tests/` 下的工程导览外，每份 README 至少包含一张独有截图。简体中文镜像复用同一个 PNG，只翻译周围的 alt text 和 caption。

每张 README 图片都使用以下完全一致的代码块：

```html
<p align="center">
  <a href="docs/assets/readme/root/hero.png">
    <img src="docs/assets/readme/root/hero.png" alt="Ghostty 中的 Pi Stuff" width="100%">
  </a>
  <br>
  <em>Pi Stuff 让活动工作保持可见，同时不挤占 conversation。</em>
</p>
```

根据所属 README 调整相对路径、alt text 和 caption。每张图片使用独立的纵向代码块。不要把独立粗体标签、
表格、`<figure>` 或烘焙到图片中的标注与这一模式混用。

### 拍摄标准

- 拍摄 Ghostty `1.3.1` 中真实的 Pi `0.85.1` Session。
- 使用 Catppuccin Latte 和 JetBrainsMono Nerd Font Mono。
- 使用英文 UI 和人工构造的一次性 demo 数据。
- 排除凭据、用户 Session、私有路径和无关桌面内容。
- 隐藏 OS chrome，并把终端放在统一的浅薰衣草背景、圆角与阴影中。
- 以高于目标的分辨率拍摄，再缩小为最终 `1600×900` PNG。
- 原生 Ghostty 拍摄完成后，使用 `different-ai/openwork@agent-first-screenshots` 做视觉检查、裁切和构图。
- README 预览统一使用 PNG。必须用动态才能讲清的演示放入详细 Capability 指南。

面向图表的 README 在 Pi 内渲染真实 `chart` 或 `tree` fence，再拍摄该终端状态。图表标签属于内容；
编辑性箭头和标注不得烘焙到图片中。

### 资源布局

资源存放在 `docs/assets/readme/<readme-slug>/`：

| README | 必需资源 |
| --- | --- |
| 根目录 | `root/hero.png`、`root/workflow.png`、`root/architecture.png` |
| 工程文档索引 | `docs/index.png` |
| 研究索引 | `research/index.png` |
| 报告索引 | `reports/index.png` |
| Package | `package/suite.png`、`package/commands.png` |
| 主题 | `themes/latte.png` |
| Capability Module | `capabilities/<module>.png` |
| MCP runtime | `runtime/mcp.png` |
| Web runtime | `runtime/web.png` |

## 链接与翻译

仓库文件使用相对链接，外部项目使用 HTTPS 链接。中文镜像在存在镜像文档时链接到镜像，并共享英文原文的图片资源。

编辑英文 Markdown 原文后：

1. 更新 `docs/i18n/zh-CN/<repository path>` 下的镜像。
2. 把镜像的 `translation-source` 设为英文仓库路径。
3. 把 `translation-source-sha256` 设为英文原文件的小写 SHA-256。
4. 运行仓库文档检查。

## Review 清单

- 第一屏说明组件做什么，并展示它在 Pi 中的样子。
- Quick Start 只包含最短成功路径。
- 详细行为只有一份所属文档，其他位置通过链接引用，不重复叙述。
- 命令、设置、名称和版本与当前源码一致。
- 每张图都使用标准代码块，是 `1600×900` PNG，包含有效 alt text 和 caption，并可点击。
- 英文与简体中文导航能够到达对应内容。
- 链接、翻译 header、截图和索引文档都没有过期。
