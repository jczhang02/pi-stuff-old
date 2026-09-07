<!-- translation-source: docs/adr/0035-own-codex-account-selection.md; translation-source-sha256: ad83ac08295c2391b0db8275e58b3d5331a648f1093c924a0ffdd01c76317155 -->

---
status: accepted
---

# 通过版本绑定的认证适配器管理 Codex 账户选择

本设计已接受，但功能尚未实现或认证。Beads feature `ps-4o1` 拥有完整 spec；规划任务 `ps-4o1.1`
交付文档和仅使用模拟数据的 TUI 预览。现有 Codex 行为保持不变。

## 背景

维护者需要手动切换 Codex 订阅账户，同时保持所选 provider 和模型不变。Pi 的内置凭据库按 provider ID
只保存一份凭据。复制并覆盖该文件会耦合并发 Session，也可能覆盖已轮换的凭据。Provider 别名可以提供
独立槽位，但会把账户选择变成模型身份的一部分，维护者已拒绝这条路线。

Pi 0.85.1 公开原生 Provider 注册和可复用的 Codex 请求函数，但面向 Extension 的模型 registry 没有公开
运行时凭据覆盖入口。源码核查和纯内存 resolver 检查确认：已保存的 OAuth 优先于环境账户解析器；移除
OAuth handler 也不能绕过已保存凭据。显式请求认证覆盖具有更高优先级。这些观察不构成真实账户验收。

## 决策

Codex 拥有命名 OAuth 账户及仅在空闲时允许的显式账户切换。保持 `openai-codex` 和所选模型不变。
将 Pi 原生登录保留为单独可选来源。命名账户分别完成 OAuth 登录，不导入原生 token 快照，也不覆盖 Pi
的认证文件。

维护者明确接受 [ADR 0001](0001-keep-pi-as-the-host.md) 公共 API 边界的一个狭窄例外：由 Codex 拥有、
绑定版本的适配器可以访问已认证 Pi 0.85.1 Host 现有的 Session runtime 认证操作。组合必要的公开 Provider
认证适配，保留原生模型目录和请求实现。不引入另一套 Runtime、Models collection、Session 层、代理、
transport 实现或别名 provider；不修改或分发 Pi Host。

私有访问集中在一个适配器中。检查受支持版本、所需接口结构和实际生效认证，不为其他版本添加猜测式
兼容路径。不兼容时拒绝激活命名账户；若 Session 已选择命名账户，则阻止 Codex 请求，不回退到原生登录、
环境凭据或其他账户。Pi 将来提供合适的公开接口时，应移除此例外。版本相同不等于已认证。

### 状态归属

| 状态 | 所有者与作用域 |
| --- | --- |
| Saved Codex Account | Codex 拥有的共享身份与可刷新凭据记录，通过稳定、非秘密的引用访问 |
| Codex Account Selection | 一个 Session 选择的账户来源，独立于模型选择和启动默认值 |
| Codex Startup Default | 新 Session 的用户级起始选择，初始为 Pi 原生登录 |
| 账户展示 | Conversation UI 投影 Codex 拥有的选择和额度，不拥有认证 |
| 子 Agent 继承 | Agents 只在启动时快照父 Session 的非秘密选择引用 |

启动默认值保存在 [ADR 0012](0012-merge-pi-stuff-settings-file.md) 规定的现有 Codex Settings Namespace。
私有 OAuth 凭据库属于凭据存储，不是另一份设置文件。复用适合的 Suite 持久化原语，保留私有权限，通过
跨进程锁和原子替换执行刷新与写入。Session 记录、子 Agent 启动元数据、诊断、模型上下文和预览产物都
不能包含凭据。导入保持纯净，不能仅因 Package 被加载就启动账户操作。

Resume 和 reload 恢复该 Session 的选择；tree 导航保持一个 Session 级选择。普通新 Session 快照启动默认值。
Fork、clone 和新 Codex 子 Agent 只继承一次来源选择，随后独立；现有或恢复的子 Agent 不重新快照已变化的
父 Session。不得使用影响其他 Session 的进程全局当前账户变量。Pi 原生登录的全局语义仍由 Host 拥有，
本功能不重新定义它。

### 切换事务与失败

主 Agent 忙时拒绝切换，不排队延迟切换，不中止工作，也不自动重放任务。提交前重新检查空闲状态和
Session 边界。解析目标账户，必要时刷新凭据；暂存其运行时认证；验证实际身份；使账户绑定的 Codex
连接和续接状态失效；随后提交 Session 选择并发布新账户状态。

切换失败时，先恢复并验证原账户，再报告原账户仍被选中。若不能验证恢复成功，则阻止 Codex 请求，不能
显示未经验证的账户。成功切换后的刷新失败也会阻止请求，绝不静默恢复原生登录或另一个命名账户。
刷新必须覆盖各个所属请求路径，包括跨越 token 过期时间的工作，而不只是切换后的第一个请求。

切换保留普通对话和 Tool 历史。已有可见上下文可能发送给新账户，因此账户切换不等于对话数据隔离。
账户绑定的加密 reasoning 和连接缓存需要单独验证续接兼容性，不能错误跨越身份。Session 所属 Codex
消费者使用相同的选中身份；显式查看其他账户额度不会选中该账户。丢弃过时的异步结果，不能把另一账户的
额度发布在当前名称下。

### 管理与呈现

在现有 `/codex` 界面中提供切换、添加或重新登录账户、删除及启动默认设置。打开账户管理时按需查询
可用的五小时和每周额度，不增加定时轮询，也不移除已有的当前账户额度行为。额度失败明确显示，但不
禁用管理操作。

现有每周额度 Statusline 组扩展为 `󰊚 work 82%`：先显示短账户名，再显示本周剩余额度。原生来源使用
`Pi login`，不用 `Default`。保留现有行数和 Host 语义主题色，默认不显示邮箱。额度缺失不能隐藏账户
身份；完整名称和详细额度由对话框展示。[预览证据](../reports/codex-account-selection-preview.md) 只是模拟
设计产物，不是认证功能证明。

重新登录必须保持保存账户的真实身份，不同身份使用新记录。删除前必须让当前 Session 切到其他账户，
并先移除启动默认引用。确认共享影响后，只删除本地保存的凭据，不远端撤销授权。其他 Session 保留引用，
在下一次依赖凭据的操作中明确失败，而不是自动切换账户。

## 验收

主要验收边界是真实 Pi Host 的 Codex 命令、Session 生命周期和 Provider dispatch。复用现有 Codex Host、
usage/settings、原生 Tool 和图像生成测试，以及共享 dialog/Statusline fixture。针对存储故障的测试补充
这个边界；断言适配器私有字段不能认证功能。

先证明私有适配器，再构建完整账户 UI。必须取得真实双账户和并发 Session 证据，包括命名账户在原生登录
并存时的优先级、原生恢复、刷新竞争、回滚失败、不兼容 Host 处理、子 Agent 继承和续接、fork/clone/new
默认值、resume/reload、跨账户 Codex 回放、Tool/图像认证和过时额度拒绝。若某个受支持的共享 runtime
配置不能保持隔离，应明确阻止该配置，不能削弱 Session 契约。

在宽、窄、低高度终端和明暗主题中验证长名称、CJK、取消、焦点及编辑器恢复。真实 PTY fixture 使用
启用 CSI-u extended keys 的隔离 tmux socket；并发 native-supervisor fixture 使用隔离 runtime 目录，
并清理继承的父级 selector。保留的证据中不能出现私有值或机器特定路径。缺少真实账户证据时，验收仍为阻塞。

## 影响

- Provider 别名：账户选择必须独立于模型/provider 身份，因此拒绝。
- 覆盖共享认证文件：可能影响其他 Session 并覆盖已刷新凭据，因此拒绝。
- 先修改 Pi Host：未选择；维护者接受了面向当前 Host 的明确、受限私有访问例外。
- 通用多 provider 账户管理器、自动轮换和跨工具同步：不在已接受范围内。

所选路线承担 Host 升级维护和真实账户认证成本。它不是私有 API 的通用例外，不是上游 fork 的质量豁免，
也不授权在发布 spec 的阶段开始功能实现。
