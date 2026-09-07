<!-- translation-source: docs/adr/0015-certify-the-upstream-release-binary.md; translation-source-sha256: 2370d8bf07deadd53bd58257b3d898197927568b8787a3d44b3bc5ad0db00641 -->

---
status: accepted
---

# 验证上游发布二进制文件

## 背景

Pi Stuff 是 Pi 软件包，不是 Pi 宿主发行版。从固定的源码检出重新构建 Pi，需要仓库负责模型数据、源码准备、构建记录和防崩溃的二进制发布，而这些工作并不产生软件包行为。

## 决策

支持 Linux x64 上的 Pi `0.85.1`，保留已审查的上游源码提交作为来源参考，并通过 Pi 公开 API 与真实 Host 能力
验收验证兼容性。验收必须在实际 Host 上覆盖适用的 Capability Contract Catalog；可执行文件哈希、归档哈希、文件大小、
内嵌 Bun banner 和字节偏移都不是准入门槛。精确版本的开发依赖继续提供已发布的类型表面。

Pi Stuff 不重新构建、发布或保留 Pi 宿主的生成模型数据。

## 后果

- Host 支持取决于受支持版本、公开 API 行为和真实 Host 验收证据。
- 升级 Pi 时，需要一起更新源码来源、开发依赖和能力验收证据。
- Release 产物观察结果可以作为历史来源保留，但不阻塞通过版本与行为契约的受支持 Host。
- 仓库不再声称能够从源码复现上游二进制文件。
