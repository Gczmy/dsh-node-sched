# 实现笔记 — 踩坑与定案

> 按 M 里程碑滚动记录。每条 = 现象 / 根因 / 定案，供后续开发避坑。

## M1：host 插件 + agent 工具（2026-08-24）

### 加载契约（对照 @deepseek-ai/dsh-tool-jobs 0.1.0-rc.7 核实）

| 契约点 | 结论 |
|---|---|
| 导出形态 | `{ name, inject, Config, apply }`；生命周期函数是 **`apply(ctx, config)`** 不是 `install` |
| Config | 必须是 **schemastery** schema（`z.object`），裸 JSON-schema 对象不行 |
| 返回值 | apply 可返回 disposer（同步函数） |
| logger | cordis 内建，不进 inject |
| 服务暴露 | **不能** `ctx.foo = ...`（报 "cannot set property without provide"）；正式服务须继承 cordis `Service` 子类。M1 选择闭包内直接注册工具，服务化推迟到跨插件需要时 |

### 三条硬约束（都实际踩过）

1. **apply 必须全同步**——preset 挂载在 composition 内调用 apply，await 之后
   再碰 scoped service 报 `cannot get required service "tools" in inactive context`。
   → 探活等异步操作放后台，失败降级（logger.error）不炸挂载。
2. **模型可见的工具必须在 agent preset 里注册**——全局 tools 层对 agent 为空
   （dsh-agent-presets README 明示 "the tool registry's global layer is empty"）。
   → 用户级 preset：`~/.dsh/.agent-presets/<id>/agent.cordis.yml`，
   内容 = 内置 minimal 全文 + 我们的插件行（无需 realm，与 tool-jobs 同机制）。
3. **无 `dsh.bundle` 清单的包不会自动激活**——`dsh plugin add` 只装为普通依赖，
   需在 profile 的 cordis.patch.yml 用 `- insert:` 行挂载。

### ssh / 远程环境坑

| 坑 | 根因 | 定案 |
|---|---|---|
| `$HOME` 展开成**本地**家目录 | `child_process.exec` 经本地 shell | 用 `spawn` argv 数组传 ssh，不经本地 shell |
| 远程 `sched: command not found` | 非交互 ssh 不加载 rc | 所有命令走 `schedBin` 配置（默认 `$HOME/bin/sched` 全路径），插件侧统一加前缀 |
| WS tail 收不到日志 | 校外入口落在**网关**，远端 `hostname` 是网关名；state 目录按**计算节点**分区（`~/.sched/ambiorix/`），网关自己的同名目录是空的 | 从远程 `~/.sched/config.json` 读 `node` 字段解析目录名，绝不用 `hostname` |

### sched CLI 事实核实（ambiorix 实测）

- `list-gpus` **不支持** `--json`（文本输出）
- `status --json` 全量 ~1.1MB / 2409 job —— 插件侧必须摘要
  （结构：`{batches[], jobs[], gpus[], cpu:{used,total}}`；`cpu.total=0` 表示无上限）
- `markers` 只覆盖新机制批次，历史批次无 marker（返回"(无 marker)"是正常语义）
- B6 的 `~/.sched/events/` 目录上游未实现——WS 流的实际数据源是
  `~/.sched/<node>/scheduler.log`（逐行、LAUNCH/done/fail 事件齐全）

## M2：dashboard 管道（2026-08-24）

- HTTP 快照路由（webserver `register({kind:'prefix', path, handler})`）：
  - `GET /sched/api/status` → `{ok, summary(摘要), raw(原始JSON)}`
  - `GET /sched/api/gpus` → 文本
  - `GET /sched/api/log?task=<b>:<t>&lines=N` → 纯文本
- WS 升级路由 `/sched/ws/events`（`registerUpgrade` + `ws` 库 noServer 模式）：
  - 帧 `{type:'log', line}`：ssh `tail -n 50 -F ~/.sched/<node>/scheduler.log`，断线自动重连（5s backoff，仅在有客户端时）
  - 帧 `{type:'status', summary, ts}`：每 pollFallbackSec 心跳（有客户端才查）
- 注意：`heartbeat` 变量声明必须在 `if (ctx.webServer)` 外（清理路径引用，避免 TDZ ReferenceError）

## 验证方法（可复用）

- headless 端到端：`nodesched-hl` profile（bundles=[base, headless] 同插件）+
  用户 preset，一条命令让真实模型调工具：
  `dsh --profile nodesched-hl "调用 sched_status …"`
- WS 冒烟：Node 24 内建 `new WebSocket(url)` 即客户端，无需依赖
