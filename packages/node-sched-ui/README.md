# @zzc/dsh-node-sched-ui

dsh 的 sched 看板插件，已实现批次与任务列表、GPU 状态、日志查看、提交预览、
项目设置、SSH 认证提示和 daemon 健康展示。调度逻辑与状态判定由 sched 提供。

界面通过宿主 `main`、`sidebar.panellist` 和 `settings.section` 接口注册；
通过 host 插件的 `/sched/api/*` 与 `/sched/ws/events` 查询。写操作受设备认证、
writer 目标和新鲜完整快照约束；完整使用说明见[仓库 README](../../README.zh-CN.md)。

源码位于 `src/`。在仓库根目录运行 `node scripts/build-client.mjs`，生成
`lib/client.js` 和 source map；不要直接修改生成文件。构建使用 esbuild，
UI 契约测试位于 `test/`，实现约定见[实现定案](../../docs/implementation-notes.md)。
