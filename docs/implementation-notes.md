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

## M3a：client 插件（完整路线，2026-08-24）

### 浏览器包契约（解剖 @linxin666/dsh-web-ui-all + dsh-client-ui-task-board 得出）

- 包内 `exports["./client"]` 指向浏览器 bundle；`dsh.client: {inject:[], platform:"web"}` 声明 client 面
- bundle 格式：`window.__ModuleLoader__.load({id, factory(require){ ...; return module.exports }})`，
  factory 内 `exports.apply/inject` 即 cordis client 插件；react / client-runtime 由 harness
  运行时经 factory 的 require 供给（esbuild external）
- **构建**：esbuild `format:"cjs"`（顶层名落在 factory 作用域；iife 会封死作用域导致 footer 够不到 apply）
- **槽位**：生态面板槽 `web-ui.plugin.item`（来自 @linxin666/dsh-client-ui-web-ui-settings，
  profile bundles 需加 @linxin666/dsh-web-ui-all）；官方布局槽待后续研究

### 关键坑：exports 必须包含 "./package.json"

modules 服务用 `require.resolve('<pkg>/package.json')` 读元数据——exports map 不含
`./package.json` 时抛 ERR_PACKAGE_PATH_NOT_EXPORTED → resolveMeta 返回 null →
**行静默从浏览器 roster 消失**（无任何报错）。官方所有包都带此导出。

### 当前端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/sched/api/status` | GET | `{ok, summary, raw}` |
| `/sched/api/gpus` | GET | 文本 |
| `/sched/api/log?task=&lines=` | GET | 文本 |
| `/sched/api/op` | POST | `{op: cancel\|retry\|resubmit, id}`，白名单+并发门+审计 |
| `/sched/ws/events` | WS | `{type:'log',line}` + `{type:'status',summary,ts}` |

UI 侧 cancel 为两步确认（输入完整任务 id 才能点确认）；host 侧另有白名单+审计兜底。

### 坑：bundle 语法错误 → "loaded without registering"

esbuild footer 少闭合一个 `}` 时（factory 箭头块 + load 的对象字面量需要
`}` + `}` + `)` 三连闭），浏览器端脚本报 SyntaxError，但 script 元素仍触发
load 事件 → kernel 检查 factories 未注册 → 报 "loaded without registering"。
**验证方法**：构建后必须 `node --check lib/client.js`，再用桩 require 在 Node 里
模拟 `window.__ModuleLoader__` 跑一遍注册 + factory 调用（见 scripts 冒烟）。

### 坑：client 插件有两处 inject 语义不同，都要配

| 位置 | 内容 | 缺失后果 |
|---|---|---|
| bundle 内 `exports.inject` | **服务名**（如 `["slots"]`） | apply 里 `ctx.slots` 报 "cannot get property without inject" |
| package.json `dsh.client.inject` | **前置包名**（如 `["@deepseek-ai/dsh-client-runtime"]`），决定装载顺序 | 激活早于服务提供方（可能静默错序） |

slots 服务在 client plane 由 kernel/runtime 提供；task-board 的 client/index.ts
`inject = ["slots","sessions",...]` 是权威参照。

## M3b：写操作全量（2026-08-24）

- `/sched/api/op` 扩展：gpu-free/gpu-ignore/gpu-ok（id=卡号，纯数字校验）、
  daemon-start/daemon-stop（无 id）；per-op 声明 needsId/pattern
- 新端点：`/sched/api/dryrun`（POST {content}，ssh stdin 写远端 /tmp 临时文件 →
  `submit --dry-run` → 用后即删；本地不落盘）、`/sched/api/submit`（同管道，
  经 operate() 门+审计）、`/sched/api/daemon`（GET 状态）
- UI：submit tab（粘贴 batch.json → ① dry-run 预览 → ② 确认提交，预览不过禁用提交）、
  批次行级 cancel、失败任务 retry/resubmit（resubmit 需 ArmButton 二次确认并标注"删产物!"）、
  GPU 行 unmanaged→gpu-free / quarantined→gpu-ok、daemon start/stop（stop 需输入 "stop"）
- **坑：envelope() 曾丢弃 ok/code**——HTTP 路由依赖 r.ok 分支，undefined 被
  JSON.stringify 静默删除，表现为响应缺字段。修复：envelope 全路径保留 ok/code。
  教训：跨层复用的返回结构加字段时必须全链路核对消费方。
- **部署事实**：远端 config.venvs 的别名是 `k`（非 kronos_ft），UI 提交的 batch.json
  cmd 模板须写 `{VENV:k}`——dry-run 会透传 sched 的 schema 校验错误（含此提示）。

## M3b 事故补记：operate 未定义 + 两类"改了代码不生效"

1. **operate 丢失**：M1 同步化重写时 query 带回来了，operate 没带——op/submit 路由
   全部 ReferenceError。教训：重构后 grep 校验所有被调用符号都有定义。
2. **插入嵌套错误**：行号脚本把 operate 插进了 query 内部（第一个裸 `}` 是 if 的），
   外层作用域不可见。教训：函数级搬移用 AST 或完整花括号配对，别数行。
3. **重启后仍是旧行为**：两次由不同原因造成——①旧进程未被 pkill 杀掉仍占端口；
   ②新进程确实起来了但当时磁盘文件就是坏的。**决定性排查法：在响应里加版本标记
   （v:3/v:4）+ ps 确认进程启动时间晚于文件 mtime。**

## M4：独立面板 + 日志查看器（2026-08-24）

- 槽位盘点结论：官方 shell 无"额外页面"槽（三栏会话布局：sidebar/conversation/
  details）；生态可用槽 = `sidebar.footer.action`（侧栏底部按钮位，remote-web-ui
  同款模式）+ `web-ui.plugin.item`（设置页子卡）
- 最终形态：侧栏底部「⚡ sched 看板」按钮 → 全屏 overlay 面板（fixed 定位逃出
  sidebar 布局；点遮罩或 × 关闭）；设置子卡缩为状态摘要 + 入口提示
- 新增：任务日志查看器（批次行任务名可点击 → /sched/api/log 轮询弹层）、
  进度条（progress "27/33" 解析）、提交成功自动跳回 batches tab 并清空表单
- 依赖图降级为依赖 chips 文本（图可视化收益/成本比低，记为 deferred）

## M4 风格二轮：柔和色调（2026-08-24）

用户反馈：实底高饱和按钮"对比度太高吃力"，深色面板丑、文本不清。
- 按钮/徽章从**实底+反白文字**改为 **soft tint**：`color-mix(状态色 12%, transparent)`
  底纹 + 状态色同色文字 + 32% 同色描边——双主题自动柔和（官方 UI 的 chip/pill 风）
- 深色面板：bg-overlay → **bg-layer-1**（提亮）+ border-l2 + 更重阴影
- pre 块显式 label-primary（此前继承导致暗色发灰）；5 处 #888 次要文本 → label2
- 教训：`--dsw-static-*` 是固定值不随主题变，跨主题配色只用 alias 或 color-mix(alias)

## M4 交互细节：批次表格对齐 + 分段进度条（2026-08-24）

- 网格列固定：徽章(76px居中) | 名称(弹性) | 分段进度条(弹性) | 计数(右对齐) | cancel(84px)
- 分段进度条：红=出错(失败/超时) 绿=成功(完成/skip) 蓝=运行中 灰=排队/取消 —— 直观
- 徽章语义：active→绿色(ok) blocked→灰(label2) —— 符合用户预期
- 计数与 cancel 按钮分离 12px gap；cancel 列固定 84px

## M4 交互最终版：折叠 + 分段进度条（2026-08-24）

- BatchRow 默认折叠，点击徽章或批次名展开；展开显示依赖 + 失败任务列表（含 retry/resubmit/log 链接）
- 进度条容器加 `display: flex`，分段条正常渲染颜色：红=出错 绿=成功 蓝=运行中 灰=排队/取消
- 徽章语义：active→绿（成功色） blocked→灰（次要色）

## M4 最终交互：折叠 + 分段进度条（2026-08-24）

- BatchRow 默认折叠，点击徽章或批次名展开；展开显示依赖 + 失败任务列表（含 retry/resubmit/点击查看日志）
- 进度条容器加 `display: flex`，分段横杠正常渲染颜色：红=出错 绿=成功 蓝=运行中 灰=排队/取消
- 徽章语义：active→绿（成功色） blocked→灰（次要色）

## M4 最终修复：进度条蓝色显示修复（2026-08-24）

- 问题：浅色主题下分段进度条的"蓝=运行中"显示为白色/不可见
- 根因：`--dsw-alias-brand-primary` 语义变量在部分环境下未定义或值极浅
- 修法：给所有语义 token（brand/ok/warn/err/label/label2）加 **fallback 十六进制色**，确保 CSS 变量未定义时自动回退到安全色值
  - brand → `#3b82f6` (Tailwind blue-500)
  - ok → `#22c55e` (green-500)
  - warn → `#f59e0b` (amber-500)
  - err → `#ef4444` (red-500)
  - label → `#1f2937` (slate-900)
  - label2 → `#6b7280` (gray-500)

## B11c 多项目调度联调事故与教训（2026-08-24）

### 事故：selfdist 代理走错入口 → 任务滞留死库

**现象**：selfdist 代理提交 sd_chronos_etth1 后任务永远 queued 不派发，
且报错分析误导（声称"共享 config 缺 selfdist 项目"——实际早已配好）。

**根因**：代理沿用了旧双 daemon 方案的入口
（`SCHED_STATE=~/.sched_selfdist` + 独立 config），任务写进了**已停用的
daemon B 的状态库**——那里没有任何 daemon 在跑，永远不会派发。

**恢复**：旧库 cancel 僵尸批次 → 统一入口重新提交 → 指纹机制判定产物
有效自动 SKIP（此前已成功训练过）——skip 是防重复派发机制的正确行为。

**教训**：
1. **废弃入口必须物理清除**，仅靠文档标注不够——代理会话可能拿着旧指令
   运行数小时。后续将 `sched-sd`/`start_sd_daemon.sh` 改名停用（待用户确认）。
2. **代理必须重载纪律文档**。给代理下发新纪律后，要求其复述关键约束再继续。
3. 报错时先查"提交进了哪个 state"再分析其他——
   `sqlite3 <state>/ambiorix/state.db 'SELECT name,status FROM batches'`
   一眼分辨。

### sqlite3.Row 三连坑（dispatcher 崩溃事故）

| # | 坑 | 症状 |
|---|---|---|
| 1 | `ORDER BY j.rowid` 可用 ≠ 结果集含 rowid 列；排序 lambda 里 `j["rowid"]` KeyError | daemon 每 tick 崩溃、5 次后退出、零派发 |
| 2 | Row 无 `.get()` 方法 | `j.get("x")` AttributeError |
| 3 | Row 键必须显式出现在 SELECT 中 | 隐式假设 = 运行时 KeyError |

**修法**：SELECT 显式带出所需列（`j.rowid AS rid, b.project AS batch_project,
b.priority AS batch_priority`）；代码中全部用 `r["key"]` 显式访问。

### 补丁脚本写盘时机教训（会话内反复踩）

多次"修改成功但文件没变"：Python 补丁脚本在函数末尾才 write_text，
中途断言/正则崩溃 → 内存中已改内容全部丢失，且下一个脚本从磁盘重读的是
未修改版本 → 连锁困惑。**定案：每个成功替换立即写盘；
验证不只 py_compile（语法过但符号缺失照样崩），加运行时属性检查。**

### waiting_quota 死状态教训

给配额不足的任务标新状态 `waiting_quota` 后，派发 SELECT 只捞 pending →
任务永远不再被捞起（配额释放也无效）。**教训：引入新状态前必须核对所有
按状态过滤的查询路径；"本轮跳过 + 保持原状态" 通常优于 "发明新状态"。**
