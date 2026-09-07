<!-- translation-source: DESIGN.md; translation-source-sha256: d7b789ab71a84d3928cc39bf8334580ecc96f8a493bec3b24e94e6ac58177fd2 -->

---
version: alpha
name: Pi Stuff
description: 一组以对话为中心、始终运行在 Pi 原生 Host 内的终端能力。
omitted:
  - section: colors
    reason: Pi Host 的语义主题 token 才是颜色标准；行内 Skill 命令配色是唯一固定 ANSI 色板例外。
  - section: typography
    reason: 字体、字号和字符单元格尺寸由 Host 与终端决定。
  - section: rounded
    reason: 终端界面使用字符单元格构图，不使用圆角。
  - section: components
    reason: 目前的组件 token 格式面向 CSS，无法准确描述 Pi TUI 的行为。
spacing:
  dialog-gutter-cells: 2
  section-leading-blank-rows: 1
  internal-divider-cells: 1
---

# Pi Stuff 设计系统

> 本文件是根目录 [`DESIGN.md`](../../../DESIGN.md) 的完整中文译本，供中文阅读和设计复核使用。根目录英文版
> 仍是 DESIGN.md 工具和工程流程读取的权威版本；两者如有差异，以英文版为准。

## 概述

**设计总方向："安静的终端工作台"。**

Pi Stuff 是 Pi 内部的一组工作界面，不是第二个终端应用。对话始终是工作的发生地。临时界面只在用户
主动查看或控制某项内容时出现。它们保留周围的 Host 界面，用完便退出，不在别处留下重复状态。

Claude Code 是可读层级、克制的信息密度和清楚生命周期的主要参考。Pi 则决定交互方式、焦点、主题、
编辑器归属和终端行为。我们借鉴有用的阅读顺序和安静的工作感，但不照搬 Claude 特有的颜色、标签、
路径或外壳结构。

界面要有足够的信息密度，适合日常工程工作，同时不能让人费解。用户首先应该看到自己来找的对象或
结果，然后看到状态和元数据，最后才是有明确上限的详情。内部协议概念只在能帮助用户采取行动时出现，
或者放在用户主动打开的原始数据或调试视图里。

## 颜色

颜色只能来自当前启用的 Pi 主题。使用 `text`、`muted`、`dim`、`border`、`accent`、`success`、
`warning`、`error` 等语义角色。唯一的终端色板例外是行内 Skill 命令装饰，按明确要求保留workflow 演示中的彩虹色。其他界面不得硬编码 ANSI 色板，也不得按照某个人的终端主题选定颜色值。

`accent` 只标出焦点或当前唯一活跃的交互。普通信息使用常规文本色或弱化文本色。成功、警告和错误色
用来辅助明确的图标和文字，不能成为判断状态的唯一依据。所有可见界面在 Host 的亮色和暗色主题下都
必须清楚可读。

## 排版

字体由终端决定。除了 Host 已经提供的能力，Pi Stuff 不规定字体、字号或字重层级。

层级通过简短的文案、必要位置的粗体、语义颜色、空行和稳定对齐来建立。粗体只用于身份或主要标题。
Agent 名称、Tool Activity 摘要、任务身份和当前 Context 占用量都应比板块标签和元数据更醒目。不要为了
装饰而使用大写，也不要把大量文字设成同样强的强调样式。

所有测量和截断都按终端里实际可见的字符单元格计算，不能使用 JavaScript 字符串长度。中文、日文、
韩文、emoji、ANSI 控制序列和换行后的续行都必须保持正确对齐。

## 布局

Conversation Transcript（对话记录）是主界面。需要聚焦的 Capability 界面使用全宽、非浮动的
Command Dialog。它们临时替换编辑器区域，同时让对话继续可见。设置使用 Pi 原生的 SettingsList。
普通界面里的 Todo 和 Agent roster 只占用自己负责的空间；没有内容时高度归零。

Command Dialog 使用两格宽的外层内容留白。在这两格留白以内，标题、正文、Agent 消息、Tool 行、结果
预览和换行后的续行共用同一条内容起始线。不要为每个板块或事件再增加一层缩进。

在同一个 Dialog 里查看同级条目时，外部尺寸要保持稳定，不能因为切换选择而推动编辑器或周围对话。
长内容在内部内容窗口中滚动。终端高度不足时，优先保留 Header、当前选择或第一条重要详情、相关错误和
Escape 返回路径，然后才考虑次要数量、描述、提示和周围条目。

终端变窄时，按以下顺序删减信息：装饰性文案、数量与时间、可选描述、目标与预览，最后是次要元数据。
无论多窄，都要保留主要身份、有意义的摘要、生命周期状态、当前选中的操作和返回方式。文字换行不能增加
额外缩进，也不能在续行中重复板块标题。

宽屏双栏仍然是一块 Dialog 区域。顶部结构线必须贯穿完整宽度，中间只用一条竖线分隔导航和详情。它
不能看起来像两张并排的卡片。只有需要在同级条目与详情之间反复切换的 `/tools` 和 `/tasks` 使用这种
形状；当任意一栏已经无法正常阅读时，应切换为单栏。`/agents`、`/diagnostics` 和 `/btw` 在任何宽度下
都保持单栏。当前栏的焦点通过栏标题的语义强调色表达，不要另外增加一根短竖线。

## 层级与深度

Pi Stuff 使用平面界面。没有阴影、模糊、浮动卡片或装饰性层级。界面的深浅关系来自归属和阅读顺序：
先是对话，然后是临时聚焦界面、当前选中行，最后是详情。

层级通过一条结构分隔线、克制的间距、语义对比和紧凑板块标题表达。不要给每个板块再套一个框。可滚动的
Welcome 身份卡是目前唯一确认可以使用完整边框的例外，因为它属于对话文档，不属于临时 Dialog 系统。

## 形状

Pi Stuff 的形状语言来自终端，以直线结构为主。Dialog 的结构线使用粗体框线字符；宽屏双栏在一条连续
的 `━` 顶部粗线下使用一条粗体 `┃` 中间分隔线。板块标题不使用图标。普通标题使用强调色粗体，Error
使用错误色粗体，Rejection 与 Cancellation 使用警告色粗体。板块前保留一行空白，正文从下一行开始，
并与 Dialog 的两格 gutter 对齐。不要增加替代符号、冒号、全大写、下划线或板块边框。

`›` 只表示当前获得焦点、可以选择的行，没有其他含义。生命周期和严重程度使用另外一套单字符安全图标。
Conversation Transcript 已经确定使用小圆点 `•`，本次保持不变。普通 Goal 生命周期信息通知也使用它作为
Transcript 记录标记，但完整动作词和语义颜色才表达生命周期。Dialog 沿用 Transcript 克制、按语义表达
状态的语言，但不能把这个通用消息标记当作生命周期图标。

图标要按照同一套含义使用：`●` 表示正在活动，`○` 表示排队或未活动，`◐` 表示正在停止等过渡状态，
`↻` 表示正在恢复，`✓` 表示成功，`!` 表示需要注意，`×` 表示失败，`■` 表示已经停止或被明确停用。
紧凑列表可以省略状态词；详情页的 Header 必须保留完整状态词。

## 组件

### Command Dialog

界面由一条贯穿全宽的顶部线引出。Header 先回答这个界面最主要的问题，然后再展示元数据。Escape 每次
只返回一层，最终关闭 Dialog，并恢复此前保存的编辑器草稿、Footer、工作状态行、Todo 和 Agent roster。

### 列表

除非负责该界面的 ADR 另有规定，列表行应保持稳定的业务顺序。实时更新只修改原位置的行，不能抢走焦点。
每行先放可选的 `›`，接着是主要身份或容易理解的摘要，生命周期图标以及低优先级的时间或数量放在后面。
内容超出可见窗口时，在焦点窗口两侧使用 `… 前面/较新还有 N 项` 和 `… 后面/较旧还有 N 项`。

`/tools` row 依次使用 Tool identity、有界 operation identity、可选且已验证的非状态 evidence，以及明确的
图标加文字 state。若 `done`、`completed`、`finished`、`running`、`success` 或 `error` 等通用 outcome 只是
重复该 state，则应省略。

标准选择操作必须通过 Pi 注入的按键管理器处理。Up 和 Down 每次移动一行，只读界面还支持
Ctrl+P/Ctrl+N。PageUp 和 PageDown 每次移动一个可见页面，紧凑键盘可用 `b`/Space；Home 和 End
跳到第一项和最后一项。这些别名只用于自定义只读列表和详情，不能拦截文本输入、Settings 或确认界面的
按键。只有确实发生溢出时才显示翻页提示；完整的当前界面按键说明放在 `?` 帮助页里，避免 Footer 过满。

### 详情板块

使用 `Task`、`Activity`、`Output` 或 `Details` 等简洁标题，并遵循上述层级规则。每个界面根据自己的
任务选择板块：`/agents` 围绕 Agent 身份、Task、可选结果和 Activity 组织；`/ctx` 先显示 Context
占用量；`/diagnostics` 先说明问题；`/tools` 先显示容易理解的 Tool Activity。不要强迫所有 Dialog
使用同一套字段模板。

`/btw` 是有意保留的参考复刻例外：问题后面直接显示 Markdown 答案，不增加通用状态行或 `Answer`
板块。历史操作放在 Footer，不另造第二栏或卡片。

相关事件的完整顺序必须保留，但高成本预览要有明确上限，并说明省略了多少内容。原始标识符、参数和协议
内容应放在用户主动打开的原始数据或调试操作后面，不能进入默认阅读路径。
`/tools` 的 Formatted 文件修改详情只有在清理 Tool 文本后，才可使用语法与语义 diff 颜色；行号槽保持低
对比度，Raw 协议详情保持无样式。

### 宽屏工作检查

终端宽度达到 96 格且列表非空时，`/tools` 和 `/tasks` 可以同时显示列表和当前选中项的详情。每个界面
都是固定 18 行的一块 Dialog，顶部只有一条连续粗线，中间只有一条粗体竖向分隔线。切换条目时外部尺寸
不变。空页面和窄屏版本仍使用单栏的列表与详情流程。
Tab 和 Shift+Tab 用于切换当前栏；Enter 从列表进入详情，Escape 每次返回一层。

### 常驻界面与对话记录界面

Todo、Agent roster、Statusline、Conversation Transcript 和 Command Dialog 各自承担不同任务。同一
状态只能有一个可见的权威来源，不能在常驻仪表盘里重复显示。共享 Statusline 中按条件出现的 Goal 段是
当前 Goal 唯一的紧凑常驻权威；Goal 生命周期通知仍是按时间排列的 Transcript 事件，Command Dialog 则负责
检查和控制。已接受的终止 Goal Tool row 只显示机器结果；随后出现的 Goal Final Response 是唯一详细结果，
不会再由终止通知重复。Ponytail 遵循同一边界：`󱖿 <mode>` 是唯一的常驻模式权威，Host 运行指示器仍是 Agent 活动的唯一
权威，`/ponytail` 负责控制。它的 Dialog 会临时隐藏组合后的 Footer、保留编辑器草稿，并显示环境变量覆盖，
但不会把这些覆盖项伪装成可写设置。

原生 Vibe Line Spinner 与运行提示只在编辑器顶部边框出现一次，使用 Pi 的 thinking 等级配色、裁剪和动画。
Conversation UI 通过输入包装器保留这项 Host 能力，不增加第二条运行行、计时器或状态存储。完成、取消、
Command Dialog 恢复与 reload 保留 Host 生命周期所有权；现有输入高亮、补全与草稿行为保持不变。

Statusline 只使用 Nerd Font。固定语法依次为：`󱙺` model、`` Thinking、`` Fast、`󰉋` directory、
``/``/`` branch tracking、``/``/`󰏫`/`󰝒` Git state、`󰌨` Context、`󰆼` cache、
`󰊚` weekly allowance、`` cost、``/``/``/`` Goal state、`󱖿` Ponytail 和 `` Prompt。
分支跟踪和 Git 文件状态构成一个用空格分隔的视觉组；该 Git 组与相邻 Statusline 组之间使用中点。两行中
的每个语义图标和状态标记都必须是 Nerd Font glyph；不要添加 Unicode/ASCII fallback、终端探测或图标模式
设置。`·`、`…` 等分隔和截断符号只是标点，不是语义图标。Capability 的身份图标（如 Ponytail 的 `󱖿`）
应在它自己的 Dialog 中复用，而不是另造第二个视觉身份。重做 Dialog 时，不能顺手改变 Transcript 标记或
Tool 渲染。

User Message 保留原生全宽 `userMessageBg` 卡片、横向内边距和上下留白。单个 `` 位于 Tool 标记列；
在认证的 `outputPad=1` 配置下，正文和折行续行与 Tool 正文对齐。标记表示 Provider Prompt，包括自动提交的
用户角色消息，不声明由人类输入。其他 Host 内边距仍可设置，但不新增对齐保证。

普通 prompt 和 Skill invocation 共用这张卡片。Host 识别的 Skill 在 prompt 前以固定的 workflow 演示中的静态彩虹配色显示为
`/skill:<name>`，没有独立背景、边框、标题或展开提示。纯 Skill 使用相同布局。User Message 中各处的行内 `/skill:<name>` 文本采用相同配色，
不改变调用语义，也不为文字提及添加 instructions。块级 Markdown 在 Skill 标识
下方开始；换行保留原生 Markdown 层级和终端单元格对齐。原生 `Ctrl+O` 与 Host 当前展开状态保持权威。
Skill 前缀在 Pi 换行前加入第一个原生段落，保留硬换行。展开的 instructions 使用相同的行内 Skill
装饰，位于同一卡片的 prompt 后面，使用低强调的 `Skill instructions` 标签，不重复标记或
prompt。实时及恢复后的 regular/fullscreen TUI 共用此呈现；HTML 保持原生行为。

Thinking 始终位于 Host 拥有的 Transcript 内。显示时，每个 Host Thinking run 只占一行：`• thoughts: `
后面接当前原生 Markdown 渲染的最后一条终端行。流式更新会替换这一行，run 结束后则保留最终行。隐藏时，
该 run 显示为 `• thoughts`。标签使用 Host 的 `thinkingText` 颜色与斜体样式，内容保留原生 Markdown
样式；整行过宽时保留内容尾部。相邻的 Assistant prose 与 Thinking run 无论顺序如何都由一行空白分隔，
包括二者属于同一条 Host Assistant message 时。Pi Stuff 不合并 run、不把源码解析成语义片段、
不增加计时器，也不拥有可见性；Pi 设置和 `Ctrl+T` 始终是权威。这个与版本绑定的 component adapter
在认证 Host 布局之外会明确失败，且绝不改变规范消息。

同一 Transcript 消息里的有效 `chart` 或 `tree` fence 可以变成 Fenced Visualization Projection。结果必须
保持平面、单色且符合终端习惯：使用无边框、不可交互的 code-block 文本与 Unicode 图表或树形 glyph，不加
frame、ANSI 或新的焦点界面。所有行按终端字符单元格测量。图表只能在有界语法内缩减；树形标签绝不截断，
如果完整一行放不下，就保留原始 fence。外层 Assistant `• ` 仍是唯一消息权威，Thinking 不会变成可视化。

## 应做与不应做

### 应做

- **应当**先显示用户能认出的内容：Agent 名称、工作身份、Tool Activity 摘要、问题或 Context 占用量。
- **应当**在实时更新期间保持焦点、顺序、滚动位置和外部尺寸稳定。
- **应当**让状态颜色和固定图标同时出现；详情或风险较高的场景还要保留完整状态词。
- **应当**尊重 Pi 可配置的选择按键，保留 PageUp/PageDown，并在只读界面提供 `b`/Space 作为紧凑键盘
  的等价翻页方式。
- **应当**在真实 Pi Host 中，以宽屏、窄屏和低高度终端尺寸分别检查已经接受的界面，同时覆盖亮色和暗色
  主题；最终视觉效果以原生终端为准。
- **应当**在修改显示方式时保持内容归属和安全边界不变。

### 不应做

- **不要**创建另一套 CLI、TUI 外壳、浮动模态系统或常驻的 Package 仪表盘。
- **不要**硬编码颜色、字体或某个人的终端主题。
- **不要**让双栏看起来像两个独立 Dialog；它们必须处于同一块连续的结构区域里。
- **不要**给单个板块套框，也不要用多层缩进假装存在层级。
- **不要**把 `›` 或 Transcript 的 `•` 当作生命周期状态，也不要让所有状态共用一个圆点。
- **不要**在负责该状态的界面之外重复展示 Todo、Agent、BTW、Permission、Tool 或诊断状态。
- **不要**照搬与 Pi 原生行为或 Pi Stuff 领域术语冲突的 Claude 界面细节。

