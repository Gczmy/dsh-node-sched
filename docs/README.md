# 文档索引

本仓库的使用说明与实现契约在这里维护，不依赖私有研究仓库的本地路径。

| 文档 | 用途 |
| --- | --- |
| [仓库 README](../README.zh-CN.md) | 安装、配置、运行平台和看板操作 |
| [开发与提交检查](../CONTRIBUTING.md) | 本地测试、隐私规则、提交钩子与公共 CI |
| [Implementation notes](implementation-notes.md) | 加载、传输、身份校验与 sched 接口定案 |
| [UI 包说明](../packages/node-sched-ui/README.md) | 已实现界面与构建入口 |
| [示例 profile](../profile/cordis.patch.yml) | 插件挂载和 writer 配置示例 |

调度器的 CLI、JSON 和状态机由配套 `sched` 仓库的 `docs/reference.md` 定义。
真实配置、SSH 凭据、生产任务、租约、会话和部署记录保存在仓库外；本仓库只放
通用示例。忽略规则不会清除已提交内容，历史提交、标签和 PR 中的隐私信息
需要另行处理，不能通过删除当前文档声称历史已净化。
