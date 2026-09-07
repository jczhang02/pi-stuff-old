<!-- translation-source: packages/pi-stuff/src/rtk/UPSTREAM.md; translation-source-sha256: bd4963bc50265ecedc87d2e22598e15933433982df722d261acbb229396d11a6 -->

# 上游来源

本模块包含派生自固定 MIT 许可证 `pi-rtk-optimizer` 0.9.0 快照的源码。

| 字段 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/MasuRii/pi-rtk-optimizer` |
| 自有分叉 | `https://github.com/jczhang02/pi-rtk-optimizer` |
| 发布标签 | `v0.9.0` |
| 源码提交 | `d155d253cb2f1358e34e717d47a82ebccb08cb8e` |
| 源码 Git 树 | `6ce01843a6b3edb7e63c8547d411387ec5ee8e04` |
| 自有来源提交 | `489bf5f3c7ce619071c00fb0275cd4123e52a439` |
| 许可证 | MIT，Copyright (c) 2026 MasuRii |
| 许可证 SHA-256 | `7d9473dcd84975a7191bc13dcc744f3b4d6578c937c879cc73e31e0107fa4d46` |
| npm 归档 SHA-1 | `f43bec4bc7385b8c045266abf95c6f87bfb5ea95` |
| npm 归档 SHA-256 | `4f7c6d98ed90a999deee7b5a4f8315bd0fd17f99d21022b0d0b64f77bc11d3c8` |
| npm 完整性 | `sha512-yj5DEdutRco5WvYEMEO0krZJP5Z6CpuNZoxlXSGmHEi2srB5Gao1xah/RnmVDn2se1FcqlmtS8+K/nzzkq0Pug==` |

上游 `LICENSE` 逐字节保留。`upstream/techniques/` 下文件保留固定算法，但作为仓库负责的源码，按 Pi Stuff 的格式、Lint 和严格 TypeScript 基线维护。

## 固定上游技术 SHA-256

| 文件 | SHA-256 |
| --- | --- |
| `ansi.ts` | `95f36fab801338a849bab6ea3131f7e22ed630a341f62b4d5c5c75967558b28e` |
| `build.ts` | `0d61121a9d5d9dac5672ffab7a58dc29d21eb101e858e5ccfff3036fc1e5cbd1` |
| `command-detection.ts` | `677daa210328058bc63c540733077b37bb52c7f492cbc3d931747de5bc727fd4` |
| `git.ts` | `04fa0348934f1da5c76c312fea5c6bbec5d5b87087e4807ae841daa9c8c71abe` |
| `index.ts` | `f5bd633431d437b5e360c8811d2e15e6f8039fa4d570515d3e46b120be110b65` |
| `linter.ts` | `b65329f4b0010ebd0f3e2862fce7d11b5f84a7a4af51b519c5960d11a24687b4` |
| `path-utils.ts` | `f5b43486a1d5657650f10a8b9fe7ae266a9b7823922dc8ae4e0a43e04f572c9f` |
| `search.ts` | `9e97ee0de833ecb8f7c740ecd996e5d755c933792477dd7b75a92556decdb9d5` |
| `source.ts` | `a06a884bebccfca099b5d208bdee9af7c4298b2cadf8ab79ea6f09f760e9d9ad` |
| `test-output.ts` | `858b5a73b59738981a9b14c643de60a3e730b2ee73da17f6c67e59249e54ec33` |
| `truncate.ts` | `9e532d4c450e58ba94a1d5b3ff47e219879935b7c742d04b7302967d86670ad4` |

## 外部 RTK 运行时验证

可选可执行文件不捆绑，也不自动安装。受支持的 Linux x64 profile 使用 RTK `v0.45.0`，包括通过版本检查与真实行为验证的本地源码构建和 PATH shim。固定可执行文件哈希不再作为兼容性准入门槛。源码提交 `b34be37caf3796b69a50952a28e60e32b5daad43` 的官方发布构建保留为 CI 下载来源证据：

| 构建 | SHA-256 |
| --- | --- |
| 官方 `rtk-x86_64-unknown-linux-musl.tar.gz` 归档 | `c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4` |
| 官方归档中的 `rtk` 二进制文件 | `99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535` |

## Pi Stuff 差异

- 在套件负责的投影适配器后，只保留上游纯压缩算法。
- 格式化并严格类型化保留算法，不削弱其输出约定。
- 用 Pi 面向模型的 `context` 接缝替换上游 `tool_result` 修改，使对话记录和会话 JSONL 保持原始。
- 保持 `read` 与源码投影禁用；失败结果和非文本块始终保持精确。
- 用共享非浮动 Command Dialog 中唯一的交互式 `/rtk` control surface，替换上游配置模态框、通知、状态栏指标、启动配置创建、Shell Hook 假设和生命周期。
- 按版本和真实行为验证已安装的 RTK 0.45.0。运行期身份检查与该本地文件自身已验证的状态比较，而非官方发布哈希；路径、二进制、超时或可用性变化时保留原命令。
- 把完整重写注册表委派给 RTK。官方 v0.45.0 仍拒绝复合 `find` 谓词和操作；Pi Stuff 记录该约束，而不是增加命令解析器或分叉。
- 只暴露一个小型 `ContextProjectionAdapter`，用于与套件 Context 能力组合。
- 不包含或派生自 `jczhang02/pi-agent` 实现代码；该仓库只提供行为证据。

源码已吸收到 Pi Stuff，没有独立软件包或发布生命周期。未来吸收上游时，必须更新上述每项身份和镜像校验和，保留上游 MIT 声明，并重新运行真实宿主与本地 RTK 验证。
