# codeflow

[English](README.md) | **简体中文**

[![CI](https://github.com/PenguinSoul/dsh-codeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/PenguinSoul/dsh-codeflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

codeflow 是一个很小的 CLI 和 [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
插件：让 coding agent 在真实仓库上干活，但仓库永远不属于它。agent 拿到的是一个任务、
一个隔离的 worktree、一组你批准过的检查；交回来的是 plan、证据和一个 PR。你交回的是决策。

```text
$ codeflow status
task   42-fix-login-redirect   active
step   3 of 5  —  guard the redirect when the token is present
next   codeflow verify   (fast gates: lint, unit)
```

codeflow 声称发生过的事，都发生在磁盘上、发生在当时——实际运行了哪些 gate、退出码、
跑在哪个树上。PR 描述从这些记录渲染出来，而不是靠 agent 回忆。

## 亮点

- **人工把关** // spec、plan、self-review 和 merge 都由你批准。根本没有 merge 命令可删。
- **证据，不是记忆** // PR 只能从"对当前这棵树真实跑过的检查"里开出来。rebase 过就重新跑。
- **一个任务一个 worktree** // 每个任务独立的分支和 worktree。两个 agent 永不共享工作树，base 分支永不被碰。
- **扛得住重载** // 状态在磁盘上，不在聊天记忆里。会话可以死，另一个会话接着干；blocked 的任务原地等待，不瞎猜。

## 为什么有这个项目

codeflow 是一个面向 Agent-First 的软件工程流程插件。它的开发流程主要借鉴了 JetBrains 的
[ThinkRail](https://github.com/JetBrains/thinkrail)，目标是解决多人（多 AI）围绕一个仓库
协作开发时的流程问题：把仓库交给 agent 之后，有四件事容易丢——任务停在哪、哪些检查真的
跑过、PR 描述的依据是什么、谁拍板了什么。

codeflow 把这些答案放进 `.codeflow/state/` 下的文件里——一份按哈希批准的
spec，一份步骤必须留有结果的 plan，一份绑定在具体树上的证据。

任务沿着 `created → designed → planned → active → verified → pr_open → done` 走。
出任何岔子——冲突、gate 失败——就变成 `blocked`，在你解决之前一直阻塞。没有任何东西会
自动重试或自行解决冲突。

## 快速开始

作为 DSH bundle 安装（需要 [pnpm](https://pnpm.io) 在 `PATH` 上）：

```bash
dsh plugin --profile tui add "github:PenguinSoul/dsh-codeflow#main"
```

或从本地检出安装：

```bash
git clone https://github.com/PenguinSoul/dsh-codeflow.git
dsh plugin --profile tui add link:/absolute/path/to/dsh-codeflow
```

装好后会得到 `codeflow` 技能，以及每个 CLI 动词对应的 `/codeflow-<verb>` 命令。
在 DSH 提示符里：

```text
/codeflow-init
/codeflow-trust
/codeflow-new "修复登录跳转"
/codeflow-start
/codeflow-verify
/codeflow-pr
```

CLI 本身不依赖 agent 也能用——每条命令都支持 `--json`，人或脚本可以驱动同一套流程：

```bash
bin/codeflow init          # 写 .codeflow/config.json，然后提交它
bin/codeflow trust --yes   # 批准确切的 gate 命令
bin/codeflow new "修复登录跳转"
```

没有 `gh` 时，`pr` 会推分支并打印 compare URL，而不是失败。

## 你仍然要批准的东西

1. codeflow 允许运行的精确 gate 命令（`trust`）。
2. 任务 spec，在任何代码存在之前（`approve design`）。
3. plan，按不可变步骤的哈希批准（`approve plan`）。
4. self-review 包（`approve self-review`）。
5. merge——在 GitHub 上，用你自己的手。

## 为什么可以信它

- **Gate 命令就是代码。** `trust` 展示每一条命令，并按配置哈希记录批准。改了配置，
  trust 即失效，需要重新说 yes。
- **证据绑定在树上。** 退出码、耗时、日志和树、配置、分支的哈希存在一起。改变树的
  rebase 会让证据过期；`pr` 直接拒绝。
- **没发生过的事不会报成功。** 没有检查的仓库报 `none`。pending 的检查不是绿的。
- **状态是本地的。** 一旦 git 跟踪了 `.codeflow/state/`，所有命令拒绝运行。

## 什么时候不适合用

codeflow 刻意保持很小。如果你想要自动 merge、后台守护进程、多仓库编排，或者一个能自己
解决冲突的 agent——那它不适合你。它目前假设 WSL/Linux、Node 20+、git，以及一个打算
亲自读 plan 的人。

## 命令

| 命令 | 作用 |
| --- | --- |
| `init` | 检测 base 分支、包管理器和候选 gate |
| `trust` | 展示确切的 gate 命令并记录批准 |
| `new <title>` | 创建任务和任务 spec |
| `approve <design\|plan\|self-review>` | 按哈希批准 |
| `plan` / `plan step` | 校验 plan；记录步骤结果 |
| `start` | 创建任务分支和 worktree |
| `verify` | 运行 gate 并记录证据 |
| `self-review` | 生成 review 包 |
| `pr` | rebase、渲染描述、推送、开 PR |
| `watch` / `comments` | 只读查看 PR 检查和评审线程 |
| `status` | 显示当前任务和下一步 |
| `resume` / `finish` / `abandon` | 解除阻塞、归档已合并任务、或放弃任务 |
| `doctor` | 检查 git、gh、状态、schema 和锁 |

选项和退出码：`codeflow <command> --help`，或看
[docs/contracts.md](docs/contracts.md)。

## 文档

- [docs/goal-and-requirements.md](docs/goal-and-requirements.md) — codeflow 是什么、不是什么
- [docs/architecture.md](docs/architecture.md) — 状态模型背后的决策与不变量
- [docs/contracts.md](docs/contracts.md) — JSON 形状、退出码、artifact schema
- [docs/DESIGN.md](docs/DESIGN.md) — 整体设计

## 开发

```bash
npm test       # 临时仓库、假 gate、假 gh；完全离线
npm run check  # 对每个源文件跑 node --check
```

CI 在 Node 20 和 22 上跑这两项。

## 参与

`main` 已开启分支保护。所有改动都走 PR；文档类 PR 可以很小。不要为了让改动通过而
弱化测试或跳过人工闸。

## 许可

[MIT](LICENSE)
