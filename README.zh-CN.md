# dsh-node-sched

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | **中文**

一套 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件，将节点级 GPU/CPU 批量调度器 [sched](https://github.com/Gczmy/sched) 变成可完整操作的 Web 看板与 agent 工具面。

设计原则是**严格的适配器架构**：调度智能全部留在远程 `sched` daemon，插件不重新实现任何调度逻辑——只负责传输（SSH）、展示与操作转发。

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  dsh (浏览器)               │         │  远程计算节点                    │
│                             │         │                                  │
│  ┌───────────────────────┐  │  HTTP   │  ┌────────────┐   ┌───────────┐  │
│  │ node-sched-ui         │  │◄────────┼─►│ sched CLI  │◄──│ sched     │  │
│  │ 全屏看板              │  │  /WS    │  │ (--json)   │   │ daemon    │  │
│  └──────────┬────────────┘  │  + SSH  │  └────────────┘   └─────┬─────┘  │
│             │ RPC           │         │                         │        │
│  ┌──────────▼────────────┐  │         │                  ┌──────▼─────┐  │
│  │ node-sched (host)     │──┼─────────┼─────────────────►│ state.db   │  │
│  │ 代理 · 审计 · 写门    │  │         │                  └────────────┘  │
│  └───────────────────────┘  │         │       GPU 0..N                   │
└─────────────────────────────┘         └──────────────────────────────────┘
```

## 包结构

| 包 | 类型 | 说明 |
|---|---|---|
| [`packages/node-sched`](packages/node-sched) | host 插件 | 远程 `sched` CLI 的 SSH 代理、只读 agent 工具、看板 RPC/WS 管道、写操作并发门 + 审计日志 |
| [`packages/node-sched-ui`](packages/node-sched-ui) | client 插件 | 原生主面板看板：分段进度条批次网格、GPU 面板、实时事件流、dry-run 门控提交 |

## 功能特性

- **批次网格** — 每批次一张卡片：名称、项目徽标、分段进度条（完成/跳过/运行/排队/失败）、任务计数；支持下拉按项目过滤。
- **GPU 面板** — 逐卡状态（free / assigned / unmanaged / quarantined）及占用任务。
- **实时事件流** — dispatcher 决策经 WebSocket 推送（对 `scheduler.log` 做 `tail -F`）。
- **任务日志查看器** — 点击任意任务即可流式查看其 stdout/stderr。
- **dry-run 门控提交** — 粘贴 `batch.json`，先预览任务展开与 SKIP 判定再正式提交；高危操作（cancel / resubmit / GPU 释放 / daemon stop）需键入确认词。
- **多项目感知** — 展示 sched B11c 多项目模式配置的每项目 GPU 配额、优先级与硬亲和隔离。

### 项目 GPU 访问

项目设置提供 `projects.<name>.gpu_enabled` 布尔开关，省略为 `true`，与配额独立；
`gpu_quota:0` 仍为无限制。禁用后拒绝新 GPU 提交与手动 GPU retry/resubmit，暂停
排队 GPU 派发；运行中任务正常结束，CPU-only 不受影响。重新启用后原排队版本
继续运行。看板保存补丁保留显式 `false` 和零配额，并展示禁用／无限制／限额与
任务暂停原因。

使用开关前需同步更新支持项目 GPU 开关的 sched 和本插件。状态 JSON 仍为 schema 1，
但 pending GPU 任务新增 `wait_reason: "project_gpu_disabled"`；旧插件严格校验
会拒绝新值。策略判断与写入仍由 sched 实现，详见
[实现笔记](docs/implementation-notes.md#project-gpu-access-2026-09-07)。

### 查询传输与写入目标

只读查询和写操作采用相互独立的路径。`transport` 与当前看板绑定共同选择查询通道和目标；`mutationMode`、`mutationTarget`、`mutationSession`、`mutationExpectedNode` 则只选择一个写入端。切换看板绑定不会改变写入端，`sshEntry` 是显式配置的 OpenSSH `Host` 别名，不会通过失败回退猜测另一台主机。

看板提供三种查询通道：

- **系统 OpenSSH**（`system-openssh`）复用 `sshEntry` 已完成认证的 OpenSSH `ControlMaster`。在 macOS/Linux 上，如果用户已经在终端完成密码或 2FA 登录，这是推荐模式。
- **内置引擎**（`engine`）保留现有 ssh2 连接池、host pin 与网页内认证流程，作为显式可选方案。
- **本地**（`local`）用于 dsh 与 sched 运行在同一节点的情况，直接执行 sched CLI。

写操作默认禁用。可选的 `screen` writer 仅是兼容传输：它没有内置会话名，必须同时显式配置 SSH 目标与会话才能工作。运维人员应通过插件或 `sched` CLI 操作，不应手工向基础设施 screen 注入命令。

### 复用终端 SSH 登录

系统 OpenSSH 模式只复用认证结果，不复制或缓存任何认证材料。请为 `sshEntry` 使用的同一个别名配置 OpenSSH 多路复用，例如：

```sshconfig
Host my-cluster
    ControlMaster auto
    ControlPersist 30m
    ControlPath ~/.ssh/cm-%C-%n
```

先在本机终端运行 `ssh my-cluster` 并完成一次密码/2FA，再到 SSH 面板点击**复用终端登录**。dsh 通过 `ssh -O check` 检测现有 master，不会读取、接收或保存密码、私钥 passphrase 或 OTP。原终端退出后还能复用多久由 `ControlPersist` 决定。

终端与 dsh host 进程必须使用同一个本机操作系统账号，并能看到同一个 `ControlPath` 文件系统。若 dsh 以另一个用户运行、处于隔离容器中或运行在另一台机器上，就无法复用这个 socket。

`ControlPath` 应按原始 Host 别名保持唯一（上例中的 `%n`），特别是两个别名通过不同网关到达同一个最终主机时；同时要让展开后的路径足够短，不超过系统 Unix socket 路径上限。也可以为每个 Host 手工指定不同的短路径。

命令、实时日志和 Web 终端都以非交互 `BatchMode` 复用同一个 master。如果找不到匹配的 master 或它已经过期，相关操作会 fail-closed，SSH 面板显示不遮挡内容的横幅，提示先运行 `ssh <别名>` 再重新检测；不会静默发起新认证、换连接重试写操作或回退到内置引擎。需要在网页中进行 SSH 认证时，必须显式选择内置引擎。

复用出的 passenger 会话还会禁用本地/远程/动态、agent、X11 和 tunnel 转发，禁止本地命令及自行转入后台。普通命令与日志强制关闭 TTY；Web 终端虽分配 PTY，但禁用 OpenSSH escape command，因此浏览器输入只会进入远端 shell，不能变成本机 SSH 控制命令。

host 插件运行于 macOS 或 Linux。Windows 用户需在 WSL2 内运行 dsh，并将凭据数据保存在 Linux 文件系统：当前存储实现依赖 POSIX 私有权限和目录 fsync，选择内置引擎也需要这些能力。原生 Windows 可以构建浏览器 bundle，但不能运行 host 插件。Web 终端通过 `node-pty` 为系统 `ssh` 提供真实 PTY；普通命令和日志复用不依赖终端模拟。

## 快速开始

### 前置条件

- Node.js ≥ 22
- 一台可经 SSH 访问、已部署 [sched](https://github.com/Gczmy/sched) 的主机
- macOS 或 Linux（Windows 使用 WSL2，并将凭据数据放在 Linux 文件系统）
- dsh `0.1.6-alpha.1`（本轮适配目标，为预发布版本）

### 安装

```bash
# 在本仓库根目录执行，将两个插件链接到指定 profile
npx @deepseek-ai/dsh@0.1.6-alpha.1 plugin --profile nodesched add \
  link:./packages/node-sched link:./packages/node-sched-ui
```

本示例的 `dsh.profile.bundles` 只保留官方 base 和 Web bundle。将以下字段合并到 profile 的现有 `package.json`（通常为 `~/.dsh/profiles/nodesched/package.json`），保留其 dependencies 和其他配置：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

两个 sched 包是普通的 link 插件依赖，没有声明 `dsh.bundle`，不能加入 `dsh.profile.bundles`，否则加载器找不到 bundle patch 并拒绝启动。安装时出现 `declares no dsh.bundle` 提示是预期行为。将下面的 `insert` 条目合并到该 profile 的 `cordis.patch.yml` 才会挂载插件，同时配置 SSH 入口（完整示例见 [`profile/cordis.patch.yml`](profile/cordis.patch.yml)）。只修改本仓库的示例文件不会更新实际生效的 profile：

```yaml
- insert:
    - id: node-sched-proxy
      name: "@zzc/dsh-node-sched"
      config:
        sshEntry: "my-cluster"      # 远程查询使用的显式 OpenSSH Host 别名
        schedBin: "$HOME/bin/sched" # 非交互执行使用的完整路径
        probeCommand: "status"
        connectTimeoutSec: 20
        pollFallbackSec: 30
        transport: "auto"           # auto；dsh 与 sched 同节点时设为 local

        mutationMode: "disabled"    # 选择并完整配置 writer 前保持 fail-closed
        mutationTarget: ""
        mutationSession: ""
        mutationExpectedNode: ""

    - id: node-sched-ui
      name: "@zzc/dsh-node-sched-ui"
```

### 运行

```bash
npx @deepseek-ai/dsh@0.1.6-alpha.1 --profile nodesched
# 打开 http://127.0.0.1:<端口>，点击侧栏的 sched 入口
```

如果 `dsh` 命令已经指向该版本，也可以用 `dsh --profile nodesched`。`--profile` 接收 profile 名称，不是 YAML 路径；`dsh web --profile ...` 不是支持的启动方式。该 profile 中的 Web bundle 负责加载网页界面。

在适配目标版本中，sched 接入 DSH 原生主面板与设置页。点击会话或顶部 Logo 新建会话时，DSH 会切走 sched 主面板，不会留下遮挡对话的独立覆盖层；设置页显示 sched 状态及看板入口。聊天中的“停止”会把取消信号传到正在执行的 sched 查询，终止其等待及对应通道或子进程。

加载外围 DSH 页面不会触发 sched 认证、轮询或 WebSocket。打开看板但没有可用浏览器会话时，只显示不遮挡内容的横幅；点击横幅上的连接按钮后才打开令牌表单。取消表单会回到横幅，并且不会启动受保护的看板请求。首次连接从 `~/.dsh/node-sched-access-token` 粘贴 master token；默认情况下浏览器只持久化 origin 内不可导出的 P-256 设备密钥，后续可在设备信任有效期内静默换取短期会话，master token 本身不会保存在浏览器中。

内置 SSH 引擎中，取消认证会结束当前尝试并暂停该主机的自动认证，后台轮询不会重新弹出验证。需要恢复时，在 SSH 面板显式测试主机、重新绑定、执行命令或打开终端。实时事件流只在已有的、已认证连接池连接上打开通道；没有可复用连接时等待显式连接，不另建密码/2FA 登录。

## HTTP API

所有端点由 host 插件挂在 `/sched/api/*` 下。响应由后台刷新器服务端缓存，浏览器轮询即时返回，上游网络抖动对前端完全透明。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/sched/api/status` | GET | 全量快照：批次、任务、作业、GPU、项目（含摘要文本） |
| `/sched/api/gpus` | GET | GPU 表格文本 |
| `/sched/api/log?batch=&task=` | GET | 任务日志尾部 |
| `/sched/api/daemon` | GET | daemon 存活状态 |
| `/sched/api/dryrun` | POST | batch spec 的 dry-run 预览（无副作用） |
| `/sched/api/op` | POST | 白名单操作：`cancel` / `retry` / `resubmit` / `gpu-free` / `gpu-ignore` / `gpu-ok` / `daemon-start` / `daemon-stop` |
| `/sched/ssh/hosts` | GET/POST | SSH 主机摘要及带 revision 的主机管理 |
| `/sched/ssh/import` | POST | 导入 `~/.ssh/config` 并安全复用本机 known_hosts |
| `/sched/ssh/host-key` | POST | 准备、确认或取消服务器 host key 信任 |
| `/sched/ssh/test` | POST | 使用已固定服务器身份执行正常 SSH 连通测试 |
| `/sched/ssh/binding` | GET | 查看当前查询通道及 ControlMaster 就绪状态 |
| `/sched/ssh/use-system` | POST | 仅在找到匹配的活动 ControlMaster 后选择系统 OpenSSH |
| `/sched/ssh/unbind` | POST | 清除内置引擎绑定并回到配置的系统 OpenSSH 入口 |
| `/sched/ws/events` | WS | dispatcher 实时事件流 |
| `/sched/ws/ssh-terminal` | WS | 使用显式选择的 SSH 通道打开有界 PTY 终端 |

### SSH 服务器信任

浏览器设备信任、SSH 服务器身份和 SSH 用户认证是三件不同的事。系统 OpenSSH 模式由本机 OpenSSH 应用 `~/.ssh/config` 与 `known_hosts`，dsh 只检测并复用已有 `ControlMaster`。内置引擎模式则由 dsh 的 host-key 存储确认远端服务器身份；`kelvin2_key.pub` 这类客户端公钥不能作为服务器 host pin。

内置引擎从 owned、非 group/other writable 的 `~/.ssh/known_hosts`/`known_hosts2` 复用精确匹配（包括 hashed host、多算法和 `HostKeyAlias`）。当前 pin 若与 `@revoked` 指纹精确相交则拒绝继续；CA、通配符、畸形或不安全文件不会被静默信任。

没有可复用记录时，“建立信任”只做 SSH 密钥交换，待确认节点不会收到密码、私钥、passphrase、agent 签名或动态验证码。页面显示端点、算法和 SHA256 指纹，用户确认后才持久化；这是 TOFU，不能独立证明第一次网络路径未被劫持。取消会终止当前探测并撤销短期 challenge；点击“确认并信任”进入同步耐久写入后，取消按钮会禁用。ProxyJump 按目标上的显式扁平 alias 链逐段确认，嵌套链 fail-closed。

## 安全模型

- **SSH 入口与身份显式化** — 集群别名固定写在配置中；系统 OpenSSH 只接受该精确别名的活动 master，绝不回退到新认证。内置引擎的每个目标和 ProxyJump hop 都必须有精确服务器 host key，缺失、撤销或不匹配时 fail-closed。
- **并发安全的主机存储** — 主机编辑携带 per-host revision；写入持有跨进程私有锁，在锁内安全 reload 并比较完整旧 generation，过期进程只能得到冲突，不能覆盖新 pin。
- **写操作门** — 写操作经单飞（single-flight）门串行执行；结果未知时不自动重试。
- **键入确认** — cancel、清产物的 resubmit、GPU 释放、daemon stop 均需键入显式确认词。
- **审计日志** — 每条转发操作记录调用方、参数与结果。
- **认证生命周期** — 内置引擎只有在可见网页中才接受显式认证回答；取消、超时或断线会销毁连接并清除 challenge。系统 OpenSSH 不提供网页认证通道，只复用终端创建的 master，并始终使用 `BatchMode`。
- **服务端缓存** — 读路径由后台刷新器供数；SSH 链路抖动只会增加数据陈旧度，不会破坏既有观测的正确性。

## 开发

```bash
pnpm install
pnpm build          # 重新构建客户端 bundle（esbuild → __ModuleLoader__ 工厂格式）
node --check packages/*/lib/*.js
```

实现笔记与踩坑记录见 [`docs/implementation-notes.md`](docs/implementation-notes.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
