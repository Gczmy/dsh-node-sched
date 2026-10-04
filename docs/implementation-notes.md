# 实现定案

本文记录仍适用的实现约定和必要原因。部署现状需另行查询，不以历史记录推断。

## Daemon 排空与恢复看板操作（2026-09-28）

看板提供 `drain`、`drain + stop`（空闲后退出）和 `resume`。`resume` 只解除排空；
daemon 已停止时需随后执行 `start`。`stop` 仍会取消未完成任务，保留原有输入确认。
查询 CLI 的新鲜 `daemon status --json` 必须公布对应的 `request_actions`，否则维护按钮
显示为不支持。查询和 writer 可以是不同目标，因此按钮显示不代表写入许可。

后端对每次维护写入先核验实际 writer 的 hostname、`config.node` 和配置的
`mutationExpectedNode`，收齐 writer 的完整状态分页，再在同一 writer 上新执行
`daemon status --json`，核验 `node`、`query_host` 和该操作的能力声明。旧 CLI、
无效响应、分页缺失或节点不一致都拒绝写入。操作沿用 `sched request`：
`--expect-revision 0`、独立持久化 request-id、完整命令绑定；结果未知时保留原请求，
不能换 ID 自动重发。此处只接入 CLI 控制，不在插件中模拟 daemon 生命周期。

## Daemon health indicators (2026-09-23)

网关心跳过期曾被本机 PID 检查误报为未运行；看板依赖“运行中”文本且查询失败保留旧绿灯。
`/sched/api/daemon` 改查 `sched daemon status --json`，通过 browser-safe 的
`lib/daemon-health.js` 校验 schema 1。旧 CLI 或坏 JSON 显示未知，不回退解析文字。
健康语义由 sched 给出；UI 仅映射颜色：healthy 绿、健康且 draining 蓝、delayed 黄、
stalled 红、unknown/stopped 灰，并明确显示文字和采样时间。通道徽章表示配置，保持中性色。

缓存失败立即撤销 fresh；服务端 TTL、采样/传输耗时和浏览器本地计时共同限制有效期。
浏览器每秒检查 TTL，即使新请求挂起也不会一直绿灯；健康证据超过心跳/tick 有效期时
先转未知，等下一次 CLI 判定。start 只在新鲜 stopped 时启用，未知不能启动；stop 保留
输入确认和既有 writer 前置检查。gateway 无法确认已停止时需要在计算节点复核，不自动启动。

发布需包含新 CLI、后端契约与重新构建的前端。修改仅涉及查询与展示，无需重启生产 daemon。
Python 验收在计算节点隔离目录进行；不得改写正在使用的不可变 release 目录。

## Host memory and drain status (2026-09-22)

schema 1 增加可选 `host_memory`，包含 `used_gib`、`total_gib`、`reserve_gib`、
`default_job_gib` 与可为 null 的 `available_gib`。CPU used 和内存 used 都表示
声明预留；看板不得将其标为实测利用率。available 来自计算节点 daemon 采样。
等待原因增加 `cpu`、`host_memory`、`gpu`、`parallel`、`draining`、`batch_blocked`；
仅解释 sched 返回值，不在插件中复刻准入算法。`daemon_health.draining` 显示暂停状态。
当时后端先接受新契约；看板 writer 后续接入见上节。

## Project GPU access (2026-09-07)

项目 GPU 开关使用 `projects.<name>.gpu_enabled`，布尔值、省略为 `true`；独立于
零值表示无限制的 `gpu_quota`。后端严格校验为 schema 1 的 `wait_reason` 增加
`project_gpu_disabled`，不修改 pending 状态或在插件内重新判定调度策略。

看板项目设置提供开关和禁用／无限制／配额标签，`projectSettingsPatch` 明确保留
`false` 和 `0`。任务分段提示、展开的批次显示等待启用原因。写操作仍通过既有
config set 转发与 writer 检查，禁用不改变 writer 目标。

sched 在提交和最终派发前检查最新配置：拒绝新 GPU submit/run/retry/resubmit，
已排队 GPU 暂停、运行任务继续、CPU-only 正常执行；重新启用恢复原排队版本。
配置更新与派发共用 submission gate；网关已投递但消费时遭拒绝的请求可通过
`sched verify <full-batch-id>` 查询原因。批量重跑不会只执行 CPU 子集后再拒绝 GPU。

部署时需配套升级：旧插件的严格枚举校验不接受新等待原因。本次仅修改本地代码和
运行本地测试，未连接、部署或操作远程集群。

验收：两包 `test/project-gpu.test.js` 覆盖新枚举、摘要、分页、快照写入资格、显示
文本和保存补丁；sched 的真实 daemon/fake GPU CLI 验收输出另经
`canonicalStatusDocument`、`collectStatusPages` 和 `taskWaitLabel` 联调通过。
前端生成文件由构建脚本生成，Windows 与 Linux 产物一致。

## 2026-09-07 联合代码审查修复

看板曾只保存未决请求的 ID，重试时用刷新后的 revision 重建前置条件；服务端又
在 `sched request` 读取回执前比较当前状态，导致成功操作无法重放。现在 IndexedDB
原子保存完整请求，重试沿用原始绑定；writer 保留身份与完整快照检查，最终状态比较
交给 CLI 在读取回执后原子执行。SSH `255`、信号退出、`75` 和不完整的成功响应
均保留请求与上传内容。旧 ID-only 未决记录缺少原绑定，必须人工核对结果，不能自动换 ID。

SSH 缓存连接和独立日志／终端连接在使用前重新读取主机配置代际；外部删除 alias 或
撤销旧 pin 后不再继续复用旧连接。本地传输限制消费者挂接前的日志缓冲，进程退出后
不再保留 PID 供超时或 dispose 发送信号。状态校验允许合法长任务 ID，依赖列表长度
不再受页面行数限制；前端拒绝没有后续 cursor 的截断响应。

Windows 的前端构建使用 `fileURLToPath`；host 运行边界见下文，使用 WSL2。
源文件统一 LF，设备过期测试使用固定时钟并显式保持模拟 WebSocket 的等待存活。
构建依赖 `esbuild` 升级至 `0.25.12`，消除 `GHSA-67mh-4wv8-2f99`；本仓库使用
build，未启用该公告涉及的开发服务器。升级后重新生成 bundle，并核对双平台构建一致。

## DSH 0.1.6-alpha.1 适配（2026-09-17）

本轮以已安装的 `0.1.6-alpha.1` 预发布版接口为适配目标。当前 UI 使用宿主布局与设置页接口；旧的
`web-ui.plugin.item` 和独立 overlay 方案已从操作文档中移除。
本节描述实现契约，不代表已经重启 DSH 或完成远程 2FA/集群生产验收。

- **加载**：`@zzc/dsh-node-sched` 和 `@zzc/dsh-node-sched-ui` 都没有 `dsh.bundle`，
  应作为普通 link 依赖安装，再由用户 profile 的 `cordis.patch.yml` 使用 `insert` 挂载。
  本仓库示例的 `dsh.profile.bundles` 只放官方 base/Web bundle；把双插件加入该数组
  会使加载器查找不存在的 bundle patch。安装时 `declares no dsh.bundle` 是预期提示。
- **启动**：`npx @deepseek-ai/dsh@0.1.6-alpha.1 --profile nodesched`，profile 参数是
  配置名称，不是 `cordis.patch.yml` 的文件路径，也不是 `web` 子命令的选项。
- **主面板与设置**：使用宿主原生布局注册 sched 主面板及侧栏入口，并通过新版设置页
  注册契约显示状态卡。会话切换与顶部 Logo 导航由宿主控制，不再依赖捕获 DOM 点击
  来关闭全屏覆盖层。旧 `web-ui.plugin.item` 不作为新版设置页的挂载点。
- **工具取消**：六个只读 `sched_*` 工具接收宿主调用的取消信号，并逐层传到查询与
  local/OpenSSH/内置引擎执行。取消不能被普通网络错误重试，也不能继续等到默认超时；
  释放的是该次查询的通道/子进程，不应关闭其他查询共用的已认证连接。
- **认证取消**：用户取消 challenge 后，停止当前尝试，并暂停对应主机的自动认证；
  轮询和事件流不重新开启密码/2FA。用户显式测试主机、重新绑定、执行命令或打开终端
  才恢复该主机的认证尝试。切换主机后旧请求不得重新接回旧主机。
- **事件流**：内置引擎只在已有的已认证池连接上开 `exec` 通道，不为 `tail -F` 新建
  一条可能再次要求 2FA 的连接。池为空、断线或认证暂停时等待用户显式恢复；关闭流时
  只关闭其通道，不能销毁仍被快照查询使用的共享 SSH client。
- **系统 OpenSSH**：仍只复用既有 `ControlMaster`，不缓存密码或 OTP，不因本次适配
  自动发起终端认证；找不到 master 时仍使用原有非阻塞提示。
- **样式属性**：按钮 CSS 类放在元素的 `className`，不放进 React `style` 对象，
  使 hover、active 和 focus-visible 状态能匹配样式表。

## SSH host key 信任

- 浏览器设备信任、SSH 服务器身份、SSH 用户认证是三层独立契约。客户端 `.pub`
  文件不能作为服务器 host pin。
- 正常连接继续 fail-closed；`hostKey` 保留为旧版本主 pin，同时新增有来源的
  `hostKeys[]` 精确集合。HostStore 顶层仍使用 version 1，避免部署回滚时旧代码拒绝
  version 2；`revision` 是兼容附加字段。
- `known_hosts` 只读且安全有界：owned regular、单硬链、非 group/other writable、
  `O_NOFOLLOW`、open 前后 inode/size 复核。支持 `|1|` hashed host；`@revoked`
  fail-closed，`@cert-authority` 不可误当具体服务器 key。
- 首次探测必须使用独立 config，绝不能先调用正常 `buildConnectConfig()`：待确认节点
  只收到 KEX，配置不含 password/privateKey/passphrase/agent/kbdint，并以
  `authHandler: () => false` 做第二层阻断。ProxyJump 只有已固定的前序 hop 可以使用凭据。
- 探测结果不是自动身份认证，而是 TOFU 候选。落盘前必须经过短 TTL、单次使用、
  浏览器 principal、目标 alias、完整 route digest 和指纹全部匹配的确认。
- 每个浏览器只允许一个当前探测 generation；新探测/显式取消会终止旧 controller，旧请求
  即使迟到也不能发布 challenge。探测另有每 principal 速率和全局/单 principal in-flight 上限。
- 取消既 abort 网络请求，也撤销 challenge；UI 用 epoch 丢弃迟到响应，不能只关闭弹层。
  用户点击“确认并信任”后开始同步耐久提交，此时取消按钮禁用，避免虚假撤销语义。
- known_hosts 可能只覆盖链中一部分；challenge 返回刷新后的 target revision，确认阶段同时
  校验完整 route digest。`@revoked` 只在其指纹与当前 pin 精确相交时硬拒绝，历史已撤销的
  其他 key 不会错误封禁同一 hostname 的新 key。
- HostStore 写入使用跨进程私有锁，锁内安全 reload 并比较完整旧文档；冲突时刷新内存并拒绝
  覆盖。SSH 路由使用前刷新外部 generation 并清理连接池。ProxyJump 契约保持显式扁平链；
  hop 自身再配置 ProxyJump 会 fail-closed，不能静默绕过中间节点。

## 复用终端 OpenSSH 认证

- 系统通道只复用用户已在终端完成密码/2FA 的 OpenSSH `ControlMaster`，不接收、复制或
  保存密码、passphrase、OTP。先用 `ssh -O check <alias>` 做有界检测，master 不存在时只返回
  `no_control_master`，由 SSH 页显示非阻塞横幅。
- dsh 先用有界、限量输出的 `ssh -G <alias>` 在本机解析 OpenSSH 最终配置，并只接受唯一、
  已展开且为绝对路径的 `ControlPath`；随后检测和 passenger 都显式传入该路径（`-S`）。
  resolver 不加入会改变 `%C` 结果的连接覆盖项；`ssh -G` 不建立 SSH 传输、也不进行远端
  身份认证，但用户配置中的 `Match exec` 仍可能执行本地命令，启用 hostname canonicalization
  时也可能进行 DNS 查询，因此同样受进程组超时与清理约束。
- `ControlMaster=no` 本身仍可能在 mux socket 不可用时建立新连接，因此命令、日志流和 PTY
  都额外固定 `BatchMode=yes`、`ProxyCommand=false`、`ClearAllForwardings=yes`。由于复用时
  已显式指定解析出的 socket，`ProxyCommand=false` 不会扰动 `%C` 查找；一旦复用失败就直接
  失败，不进入网络认证或内置 ssh2 回退。
- 同一 alias 的并发 master 探测在 transport 内合并；`no_control_master` 结果负缓存 30 秒，
  供 status、daemon、binding 与 event tail 共用，避免多个轮询同时 fork。用户点击“重新检测”
  会强制绕过负缓存，因此刚在终端完成 2FA 后无需等待缓存自然过期。
- passenger 还固定关闭 agent/X11/tunnel 转发、本地命令和后台脱离；命令/日志使用 `-T`，
  Web PTY 使用 `-e none` 禁用 `~C`/`~!`/`~^Z` 等 OpenSSH escape，避免浏览器输入升级成
  本地转发或本地命令控制面。
- 切换别名先用独立候选 transport 检测；只有检测与入口文件耐久写入都成功后才发布新通道。
  候选失败不得 dispose 当前 transport，也不得中断其查询、日志流或 Web 终端。
- Web 终端需要真实 PTY，使用懒加载的 `node-pty`；普通命令、上传和日志流不依赖它。
  host 当前限 macOS/Linux。2026-09-07 复查发现内置 engine 的凭据存储同样依赖
  POSIX 权限与目录 fsync，因此 Windows 应在 WSL2 的 Linux 文件系统中运行 dsh；
  原生 Windows 仅支持前端 bundle 构建，入口会在创建凭据前说明平台限制。

## 加载与传输约定

host 插件使用 `{ name, inject, Config, apply }`，`apply(ctx, config)` 同步注册
工具和路由，网络探测在后台执行。无 `dsh.bundle` 的 link 插件仍需 profile
显式 `insert`；配置与构建步骤见[仓库 README](../README.zh-CN.md)。

查询入口、writer 目标和实际节点分别配置，不写死部署账户、会话或目录。
SSH 命令用 argv 数组执行，不经本地 shell 展开远程 `$HOME`；非交互命令
通过 `schedBin` 定位 CLI。state 的节点目录由 `sched config get` 中的
`node` 决定，不能用查询网关的 hostname 代替。

状态、任务和历史查询使用 CLI JSON，并分别处理批次、任务、历史分页。
只读查询由 CLI 建立私有 DB/WAL 快照；不直接打开远程 `state.db`，也不把
历史部署记录中的路径、批次或任务数量当作当前状态。

看板写操作保留 request ID、完整命令与 revision/version 前置条件。不确定
结果不换 ID 重试；所有调度语义由 sched 判断。配额不足等等待仍使用
`pending` 和独立 `wait_reason`，不另造任务状态。

## 文档维护

本文件保留实现契约和必要原因，不保存生产任务、会话、租约、个人路径、
一次性迁移步骤或截图日志。旧里程碑中的 UI 迭代和事故流水已移出当前文档，
功能现状以源码、契约测试和[文档索引](README.md)为准。

## Public integration contracts

GET /sched/api/identity and /sched/api/request-status?request-id=ID use the
authenticated query target. They select documented fields, omit raw commands/output,
and never choose a writer or replay a request. Unknown is distinct from absence.

Optional mutationExpectedInstance binds task/batch/GPU/maintenance requests to a
persistent sched CLI identity. A conflicting request identity cannot be overwritten
by configuration. expectedProject is supported for batch/task expectations.
Defaults keep the original request command format.

With an explicit instance, submit negotiates identity/submit/request-status contracts
on the attested writer before upload, checks its current identity, and calls native
`submit --request-id ... --expect-instance ... --expect-project ... --json` directly.
It is not nested in sched request. This is distinct from the legacy compute writer
path. Query binding and mutation target remain separate; screen submit remains
unsupported. Each logical operation retains its original request ID and payload.
