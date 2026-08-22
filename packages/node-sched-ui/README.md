# @zzc/dsh-node-sched-ui

dsh client 插件：sched 看板。**当前为占位骨架（计划 M3/M4 实现）**。

规划页面（见调研文档 §4.2）：

- 总览页：daemon 心跳 / 批次卡片（依赖图+进度）/ GPU 状态灯
- 批次详情：任务表（状态机着色、GPU 归属、耗时、进度）
- GPU 面板：free/assigned/releasing/unmanaged/quarantine + gpu-ignore/free/ok/set-mem 操作
- 日志查看器：WebSocket 流式追加（host 插件桥接远程 `sched log -f`）
- 提交表单：batch.json 上传或 `sched run` 快捷形态，强制先 `--dry-run` 预览

技术要点：

- React 组件经 `@deepseek-ai/dsh-client-ui-slots` 的 `register()` 挂入声明槽位
- 数据：首屏 RPC 快照 → host 插件 tail 远程 events 目录经 WS 推增量帧；断线降级轮询
- 前端 dist 必须预构建（dsh-web-app 无 source-serving fallback），本包后续引入
  Vite/esbuild 构建链；styling 只用 tokens，文案走 locale namespace（对齐官方 ui 插件纪律）
