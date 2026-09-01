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
| [`packages/node-sched-ui`](packages/node-sched-ui) | client 插件 | 全屏看板：分段进度条批次网格、GPU 面板、实时事件流、dry-run 门控提交 |

## 功能特性

- **批次网格** — 每批次一张卡片：名称、项目徽标、分段进度条（完成/跳过/运行/排队/失败）、任务计数；支持下拉按项目过滤。
- **GPU 面板** — 逐卡状态（free / assigned / unmanaged / quarantined）及占用任务。
- **实时事件流** — dispatcher 决策经 WebSocket 推送（对 `scheduler.log` 做 `tail -F`）。
- **任务日志查看器** — 点击任意任务即可流式查看其 stdout/stderr。
- **dry-run 门控提交** — 粘贴 `batch.json`，先预览任务展开与 SKIP 判定再正式提交；高危操作（cancel / resubmit / GPU 释放 / daemon stop）需键入确认词。
- **多项目感知** — 展示 sched B11c 多项目模式配置的每项目 GPU 配额、优先级与硬亲和隔离。

### Screen 注入边界

插件的 `screen -X stuff` 仅是 host 侧受控传输实现，不是要求运维人员手工 attach 或向基础设施 screen 输入命令。它只用于白名单 sched 操作，并受 loopback/写操作门与审计日志保护，每个命令都有独立结果标记。运维人员**禁止** attach、注入命令或退出 `3323979.ambior1`；应使用插件或 `sched` CLI。sched 与插件同机部署时，**应**配置 `transport: "local"`，完全绕开 screen 注入。

## 快速开始

### 前置条件

- Node.js ≥ 22
- 一台可经 SSH 访问、已部署 [sched](https://github.com/Gczmy/sched) 的主机
- 版本匹配的 dsh

### 安装

```bash
# 将两个包加入 dsh profile
dsh plugin --profile nodesched add ./packages/node-sched ./packages/node-sched-ui
```

在 profile 的 `package.json` 中声明 bundle 顺序：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@zzc/dsh-node-sched",
        "@zzc/dsh-node-sched-ui"
      ]
    }
  }
}
```

在 `cordis.patch.yml` 中配置 SSH 入口（完整示例见 [`profile/cordis.patch.yml`](profile/cordis.patch.yml)）：

```yaml
- insert:
    - id: node-sched-proxy
      name: "@zzc/dsh-node-sched"
      config:
        sshEntry: "my-cluster"      # ssh config 的 Host 别名——显式配置，绝不自动切换
        connectTimeoutSec: 20
        pollFallbackSec: 30

    - id: node-sched-ui
      name: "@zzc/dsh-node-sched-ui"
```

### 运行

```bash
dsh --profile nodesched
# 打开 http://127.0.0.1:<端口>，点击侧栏底部的 ⚡ sched 入口
```

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
| `/sched/ws/events` | WS | dispatcher 实时事件流 |

### SSH 服务器信任

浏览器设备信任、SSH 服务器身份和 SSH 用户认证是三件不同的事；`kelvin2_key.pub` 这类客户端公钥不能作为服务器 host pin。SSH 面板会先从 owned、非 group/other writable 的 `~/.ssh/known_hosts`/`known_hosts2` 复用精确匹配（包括 hashed host、多算法和 `HostKeyAlias`）。当前 pin 若与 `@revoked` 指纹精确相交则拒绝继续；CA、通配符、畸形或不安全文件不会被静默信任。

没有可复用记录时，“建立信任”只做 SSH 密钥交换，待确认节点不会收到密码、私钥、passphrase、agent 签名或动态验证码。页面显示端点、算法和 SHA256 指纹，用户确认后才持久化；这是 TOFU，不能独立证明第一次网络路径未被劫持。取消会终止当前探测并撤销短期 challenge；点击“确认并信任”进入同步耐久写入后，取消按钮会禁用。ProxyJump 按目标上的显式扁平 alias 链逐段确认，嵌套链 fail-closed。

## 安全模型

- **SSH 入口与身份显式化** — 集群别名固定写在配置中；每个目标和 ProxyJump hop 都必须有精确服务器 host key，缺失、撤销或不匹配时 fail-closed。
- **并发安全的主机存储** — 主机编辑携带 per-host revision；写入持有跨进程私有锁，在锁内安全 reload 并比较完整旧 generation，过期进程只能得到冲突，不能覆盖新 pin。
- **写操作门** — 写操作经单飞（single-flight）门串行执行；结果未知时不自动重试。
- **键入确认** — cancel、清产物的 resubmit、GPU 释放、daemon stop 均需键入显式确认词。
- **审计日志** — 每条转发操作记录调用方、参数与结果。
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
