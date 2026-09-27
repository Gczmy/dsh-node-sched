# 开发与提交检查

插件运行时要求 Node.js >= 22；本仓库固定的 pnpm 11.19.0 要求 Node.js >= 22.13。
隐私与文档检查另需 Python >= 3.10 和 Git。完整测试使用 Linux／WSL，
覆盖 POSIX 权限和进程组行为；Windows 可以执行仓库检查和客户端构建。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

公共 CI 在 Node.js 22 和 24 上安装锁定依赖、运行 host／UI 测试、重建客户端，
并要求生成的 `lib/client.js` 与 source map 和已提交内容一致。CI 不连接 HPDC，
也不要求私有凭据、部署目录、运行中的 dsh 服务或配套 sched checkout。

`pnpm-workspace.yaml` 显式允许 `esbuild` 的安装脚本，拒绝 `node-pty`、`ssh2`
和 `cpu-features` 的安装脚本；保持项目既有的预编译 PTY 用法和可选加速策略。
新增依赖若需要构建脚本，须审查具体依赖后更新该清单，不允许所有脚本或关闭检查。
只修改前端源码且已有依赖时，可运行 `node scripts/build-client.mjs`。

## 提交前检查

以下入口仅依赖 Python 标准库和 Git，Windows 也可用 `python` 执行：

```bash
python3 scripts/check_repository.py --all
git add <files>
python3 scripts/check_repository.py --staged
```

`--all` 检查已跟踪文件的当前工作区内容；新文件先 `git add` 才纳入。
`--staged` 读取 Git index 中的原始 blob，不会用工作区的新内容替换暂存内容；
删除或重命名目标时，也检查未修改 Markdown 的引用。两种模式都检查本仓库
Markdown 文件／目录链接与 AGENTS 中的文档路径，不请求外部网站或校验标题锚点。
暂存模式检查暂存差异空白；全量模式检查工作区差异，CI 另传 `--base <full-sha>`
检查提交范围。返回码 `0` 为通过、`1` 为发现问题、`2` 为无法完成检查。

可启用版本控制内的提交钩子，在提交前自动检查暂存内容：

```bash
git config core.hooksPath .githooks
```

若已有其他 hooks，先合并调用，不覆盖已有配置。CI 在 push／pull_request 时运行
同一检查；它发生在上传之后，因此提交前的本地检查仍有必要。

## 隐私规则与例外

检查个人绝对家目录、常见服务令牌、私钥头、带密码的 URL、固定 screen 会话，
以及误入 Git 的本地配置、运行日志、状态数据库和生产诊断目录。测试、示例和
已跟踪生成文件同样检查；`user`、`example`、`tester`、`test`、`runner` 是通用
路径占位名称。超过 8 MiB 的文件和子模块不会被静默跳过，而会报告需处理。
输出只有文件、行号和规则名，不打印命中的内容。

任意任务名称、任意格式秘密以及编码后的内容无法仅凭这些规则可靠判断，仍需
审查新增配置和记录。本检查不扫描或净化 Git 历史。部署绑定、诊断输出和凭据保留在仓库外。

确需保留的虚构测试数据可以添加 `.repository-check.json`，顶层固定为
`schema_version: 1` 与 `exceptions: []`。每条例外必须指定已有的完整 `path`、
单条内容 `rule`、该行 UTF-8 字节（不含换行）的 `line_sha256` 和具体 `reason`。
不支持文件夹、通配符或关闭整个规则；改变样例内容会使旧摘要失效。
不要把真实敏感值写入例外说明，也不要为真实部署资料增加例外。

```bash
python3 -m unittest discover -s scripts -p test_repository_check.py -v
```

检查器、测试和 `.githooks/pre-commit` 在 `sched` 与 `dsh-node-sched` 中保持逐字节
一致；修改时同步两份，并在各自独立 checkout 验证。两个仓库的公共 CI 不要求
另一仓库或私有研究仓库存在。GitHub Actions 固定到已核对的提交，只有读取权限。
