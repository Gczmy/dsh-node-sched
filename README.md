# dsh-node-sched

[dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：为 [sched](../../sched/)（节点级
GPU/CPU 资源调度器）提供 agent 工具面与 Web 看板。适配器架构——调度智能全部留在远程
sched daemon，插件只做「传输（ssh）+ 展示 + 操作转发」。

## 结构

```
packages/node-sched      host 插件：ssh 代理 sched CLI（JSON 接口）、审计、写操作并发门
packages/node-sched-ui   client 插件：看板 UI（M3/M4，现为占位）
profile/                 nodesched profile 模板（bundles 声明 + cordis.patch.yml 示例）
docs/                    文档索引与实现笔记
```

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库骨架 | ✅ |
| M1 | 只读打通：schedProxy + agent 工具 + 最小只读看板 | 🚧 schedProxy 骨架已落，工具待接 dsh-tools API |
| M2 | 事件流：events tail → WS 推送；日志流式查看器 | |
| M3 | 写操作：dry-run 预览流 + submit/cancel/retry/resubmit + GPU 管理 | |
| M4 | 打磨：依赖图、历史过滤、notify webhook 对接 | |

## 安装（目标形态）

```sh
dsh plugin --profile nodesched add ./packages/node-sched ./packages/node-sched-ui
dsh --profile nodesched   # 启动 web surface，打印本地 URL
```

## 纪律红线（来自 AGENTS.md，实现必须遵守）

1. **ssh 入口显式配置**（HPDC / HPDC_outside），绝不自动切换；探活失败报错提示检查网络环境
2. **写操作不自动重试**——结果未知时报告并请人工核实 `sched status`
3. **高危操作**（cancel/resubmit 清产物/gpu-free/daemon stop）UI 必须二次确认；
   resubmit 文案明示"将删除已声明产物"
4. **状态权威在远程 SQLite**，本地只缓存展示；查状态走 CLI JSON 接口，
   不 ssh 进节点 ps/nvidia-smi 猜
