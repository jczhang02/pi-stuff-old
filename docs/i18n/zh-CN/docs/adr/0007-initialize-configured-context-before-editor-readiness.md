<!-- translation-source: docs/adr/0007-initialize-configured-context-before-editor-readiness.md; translation-source-sha256: 5688befabee06896a1c5f2e8559681482cd6dcb3acf15a7c73f27a7f26ffdf2d -->

---
status: accepted
---

# 在编辑器就绪前初始化已配置的上下文

下文有关 Context 兜底、请求准入和恢复的条款已由
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md) 取代，其余决策保持不变。

## 背景

延迟初始化把 Magic Context 模块、数据库和合成帧处理推迟到了第一次普通的 Enter 到 Provider 路径。已配置的会话需要接近原生的提交延迟，同时不能削弱启动纯净性。

## 决策

如果一个会话已经拥有可识别的 Magic Context 配置，且没有待处理的文件迁移，Pi Stuff 会在编辑器报告就绪前完成官方模块加载、工厂初始化、SQLite 设置和 `session_start` 处理。缺失或旧版配置会让上下文保持休眠，直到用户直接操作授权创建或迁移。启动过程可以初始化可重建的派生上下文状态，但不得创建、重写或迁移用户配置。失败时继续开放 Pi 原生上下文，并可在之后被接受的工作中重试。

## 后果

- 已配置的会话会有意承担更长的进程启动时间，使普通消息提交无需等待上下文初始化。
- 未配置和旧版会话在启动时保持只读。
- 上下文失败时把所有权交还给 Pi 原生行为，而不是阻塞宿主。
