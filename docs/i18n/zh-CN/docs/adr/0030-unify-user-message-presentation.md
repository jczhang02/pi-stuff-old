<!-- translation-source: docs/adr/0030-unify-user-message-presentation.md; translation-source-sha256: a24b57615740468eb91cb3ccc3fd263e8a22825e88380fbce36280e3cabdb231 -->

---
status: accepted
---

# 在原生 Host 内统一 User Message 呈现

## 背景

Pi 将带追加 prompt 的规范 Skill invocation 渲染成分开的 Skill 与 User Message 组件。
Conversation UI 将把这次提交显示为一条 User Message，同时保留 Pi 的 Session、消息角色、Provider 内容、
编辑器历史和原生 Markdown 语义。本决策记录已确认的 UI 与实现方向，不代表功能已实现或通过认证。

## 决策

### 已确认的呈现

- 普通 User Message、带 prompt 的 Skill invocation 和纯 Skill invocation 共用全宽 `userMessageBg`
  卡片，保留原生横向内边距和上下留白。
- 一个 `` 占据 Tool Transcript 的标记列。prompt 和折行续行从 Tool 正文列开始，保留 Markdown 列表、
  代码和引用的相对缩进。标记表示 Provider Prompt，包括自动提交的 `role:user` 消息，不声明由人类输入。
- Host 识别的 Skill invocation 显示为 ` /skill:implement <prompt>`。行内 Skill 标识保留原生调用形式，采用固定的 workflow 演示中的静态彩虹配色，prompt 保留正常正文样式。不增加独立 badge 背景、标题或卡片。
- 普通段落紧接 Skill 标识。块级 Markdown 在同一卡片内另起一行；窄终端自然换行。无需展开 Skill 即可阅读
  prompt。
- 原生 `Ctrl+O` 控制展开。完整 Skill instructions 在同一卡片的 prompt 后面展开，使用低强调的
  `Skill instructions` 标签。展开不把 prompt 移到 instructions 后面，也不重复 prompt。折叠行省略展开
  提示。Host 当前的展开状态仍是权威。
- 实时和恢复后的 regular/fullscreen TUI 共用此行为。对齐认证覆盖现有 `outputPad=1` 配置；其他 Host
  内边距仍可设置，但不新增对齐保证。HTML 导出保留原生呈现。

### 实现

由 Conversation UI 在 Host 消息插入位置拥有一个受版本约束的展示 patch。先调用原方法，再仅校验该调用
新增的组件。完整构造替代组件后，原子替换匹配的组件，保留原来的消息外部间距。不删除未经校验的固定数量
尾部子项，也不在每次消息到来时扫描完整 Transcript。

使用 Pi 的 Skill parser 产生的元数据和原生 User Message/Markdown 组件。优先采用 User Message 子类，保留原生卡片
几何、终端消息标记、主题失效处理和输出内边距更新，同时支持原生 `setExpanded()` 行为。不重新实现
Markdown 解析，不将文字中的 Skill 提及解释为调用，不引入平行的 custom-message 流。具体组合必须先通过真实 Host
验证；仅有继承关系不能证明这些行为得到保留。

通过卡片原生 Markdown token renderer 发出的首个非空白块类型决定 Skill 是否行内显示。仅观察当前
卡片实例的方法，向 Pi 原样传递全部 token 和参数；不修改 Markdown prototype，也不维护第二套块分类
规则。与消息插入位置一起预检这一受版本约束的组件信号，运行时信号不兼容仍走同一原生回退路径。

仅在 TUI 中通过现有 Session presentation 生命周期安装，沿用 Thinking 的所有权和幂等释放模式。
Session 切换、关闭和 `/reload` 释放 patch。仅在适配器仍拥有被替换方法时恢复原方法。不声明与其他修改
同一私有接入位置的 Extension 兼容。

Pi 0.85.1 在发出 `session_start` 前回放替换后的 Session。释放时仅保留对原生 InteractiveMode 的弱引用，
不保留 Session context 或诊断通道。下次 TUI 绑定时，通过同一 projection 补齐已经渲染的原生 User 和
Skill 组件，先确认所记住 Host 的当前 SessionManager 与本次绑定的 SessionManager 是同一实例；
仅执行一次，并跳过适配器已处理的卡片。这避免在释放后继续安装 patch，也无需重建其他
Transcript 状态。

### 可靠性与失败策略

目标是在 `docs/compatibility.md` 认证的精确 Host 上可靠工作，当前为 Pi 0.85.1。现有可执行文件认证仍是
权威；仅版本字符串相同不构成支持依据。启用适配器前校验必需的 Host 方法和组件契约。初始化不兼容必须
向上传播，不能留下部分加载的 Suite。

工作期间若发生展示适配自身的结构或渲染故障，保留原生呈现，停用该 Session 后续的 User Message
projection，并通过现有诊断通道报告一次。不打断 Agent，不重写先前成功显示的消息。显式 `/reload` 可重新
尝试安装。恢复必须覆盖插入之后的失败以及替代组件构造失败；不能吞掉 Host 原方法的异常，也不能把失败变成
空消息。

回退是异常保护，不是正常输入的受支持行为。认证验收场景出现任何非预期回退都阻塞完成。另行通过故意注入
不兼容情况的测试证明恢复安全。

### 实现完成前所需证据

扩大实现前，在认证可执行文件中验证实际共享的 Host 类实例与消息插入位置。覆盖普通消息、Skill＋prompt、
纯 Skill、块级 Markdown、CJK/emoji、长 prompt、窄屏、明暗主题、展开、主题和内边距变化、重放、Session
切换及 `/reload`。确认规范 Session 内容和 Provider 消息不变，展开时 prompt 位置稳定，重复安装和释放不
累积包装层或过期 Session 所有权。

复用聚焦组件测试和真实 Host PTY 验证。仅有 mock 证据不能认证此私有 Host 接入位置。针对最终实现运行仓库
要求的检查和独立完成审查。

## 后果

公开 Markdown transformer 无法移除 Host 独立的 Skill 组件与 spacer。复制完整 Host 消息分支会重复历史和
布局行为；重写规范消息则会为展示需求改变语义。狭窄 patch 避免这两种代价，但每次 Host 变化都需要重新
认证。ADR 0001 允许这个受限的展示例外；`DESIGN.md` 和 Conversation UI 所有的文档定义视觉契约，
并保留中文镜像。

行内命令着色观察卡片自身的原生 `renderInlineTokens` 输出，在原生换行前应用配色。参数原样转发，
返回值验证为字符串，保留终端超链接控制序列，并在每个命令后恢复先前的前景色。围栏代码保持原生呈现。
这只是装饰，不新增 Skill 调用、instructions 或 Provider 内容。固定 ANSI 256 色环来自 `pi-dynamic-workflows` 的 `56489683` 提交中
`src/workflow-editor.ts`。每个命令从紫色（色环索引 26）开始，每个字符前进一色；Transcript 保持静态，
不安装动画计时器。

修复后的呈现只装饰完整的最外层行内输出，按跨 ANSI 控制序列的可见文字匹配，再映射回原控制流，
避免嵌套强调产生错误边界。prompt 和展开的 instructions 共用该装饰。Skill 前缀在原生换行前加入
第一个顶层段落结果，块级内容保留独立标识行；所有参数（包括嵌套样式上下文）原样转发。恢复历史时，
一旦投影失败禁用适配器，立即停止循环，保留后续原生组件。
