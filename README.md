# codeflow

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/PenguinSoul/dsh-codeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/PenguinSoul/dsh-codeflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

codeflow is a small CLI and [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
plugin that lets a coding agent work on a real repository without ever owning it.
The agent gets one task, one isolated worktree, and a set of checks you approved.
It hands back a plan, evidence, and a pull request. You hand back decisions.

```text
$ codeflow status
task   42-fix-login-redirect   active
step   3 of 5  —  guard the redirect when the token is present
next   codeflow verify   (fast gates: lint, unit)
```

Everything codeflow claims happened is recorded on disk while it happened — the
gates that ran, their exit codes, the tree they ran against. The PR body is
rendered from those records, not from the agent's recollection.

## Highlights

- **Human-gated** // You approve the spec, the plan, the self-review, and the merge. There is no merge command to remove.
- **Evidence, not memory** // A PR can only be opened from checks that actually ran against the exact tree being proposed. Rebases re-run them.
- **One task, one worktree** // Each task gets its own branch and worktree. Two agents never share a working tree, and the base branch is never touched.
- **Survives reloads** // State lives on disk, not in chat memory. A session can die, another can pick the task up; blocked tasks wait instead of guessing.

## Why this exists

codeflow is an agent-first software engineering process plugin. Its development
flow draws primarily on JetBrains' [ThinkRail](https://github.com/JetBrains/thinkrail),
and its goal is the process problem of many people — and many AI agents — working
around one repository: once you hand that repository to an agent, four things
easily get lost. Where the task stopped, which checks actually ran, what the PR
description is based on, and who decided what.

codeflow keeps those answers in files under `.codeflow/state/` —
a spec you approved by hash, a plan whose steps demand recorded results, and
evidence attached to the exact tree it was collected from.

A task moves through `created → designed → planned → active → verified →
pr_open → done`. Anything that goes wrong — a conflict, a failing gate — makes it
`blocked`, and it stays blocked until you resolve it. Nothing retries or
resolves conflicts on its own.

## Quick start

Install as a DSH bundle (requires [pnpm](https://pnpm.io) on your `PATH`):

```bash
dsh plugin --profile tui add "github:PenguinSoul/dsh-codeflow#main"
```

Or from a local checkout:

```bash
git clone https://github.com/PenguinSoul/dsh-codeflow.git
dsh plugin --profile tui add link:/absolute/path/to/dsh-codeflow
```

You get the `codeflow` skill and one `/codeflow-<verb>` command per CLI verb.
From the DSH prompt:

```text
/codeflow-init
/codeflow-trust
/codeflow-new "Fix the login redirect"
/codeflow-start
/codeflow-verify
/codeflow-pr
```

The CLI works without the agent at all — every command prints `--json`, so a
human or a script can drive the same flow:

```bash
bin/codeflow init          # write .codeflow/config.json, commit it
bin/codeflow trust --yes   # approve the exact gate commands
bin/codeflow new "Fix the login redirect"
```

When `gh` is absent, `pr` pushes the branch and prints a compare URL instead of failing.

## What you still approve

1. The exact gate commands codeflow may run (`trust`).
2. The task spec, before any code exists (`approve design`).
3. The plan, by hash over its immutable steps (`approve plan`).
4. The self-review packet (`approve self-review`).
5. The merge — on GitHub, with your own hands.

## Why trust it

- **Gates are code.** `trust` shows every command and records approval against
  the config hash. Changing the config invalidates trust and requires a new yes.
- **Evidence is bound to the tree.** Exit codes, durations, and logs are stored
  with the tree, config, and branch hashes. A rebase that changes the tree makes
  the evidence stale; `pr` refuses.
- **Nothing reports success that didn't happen.** A repository with no checks
  reports `none`. A pending check is not green.
- **State is local.** If git ever tracks `.codeflow/state/`, every command
  refuses to run.

## When not to use it

codeflow is deliberately small. It is not for you if you want autonomous merges,
a background daemon, multi-repo orchestration, or an agent that resolves its own
conflicts. It assumes WSL/Linux today, Node 20+, git, and a human who intends to
read the plan.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Detect the base branch, package manager, and candidate gates |
| `trust` | Show the exact gate commands and record approval |
| `new <title>` | Create a task and a task-spec |
| `approve <design\|plan\|self-review>` | Approve by hash |
| `plan` / `plan step` | Validate the plan; record step results |
| `start` | Create the task branch and worktree |
| `verify` | Run gates and record evidence |
| `self-review` | Build the review packet |
| `pr` | Rebase, render the body, push, and open the PR |
| `watch` / `comments` | Read PR checks and review threads, read-only |
| `status` | Show the current task and the next step |
| `resume` / `finish` / `abandon` | Unblock, retire a merged task, or discard one |
| `doctor` | Check git, gh, state, schema, and locks |

Options and exit codes: `codeflow <command> --help`, or see
[docs/contracts.md](docs/contracts.md).

## Documentation

- [docs/goal-and-requirements.md](docs/goal-and-requirements.md) — what codeflow is, and what it is not
- [docs/architecture.md](docs/architecture.md) — the decisions and invariants behind the state model
- [docs/contracts.md](docs/contracts.md) — the JSON shapes, exit codes, and artifact schemas
- [docs/DESIGN.md](docs/DESIGN.md) — the integrated design

## Development

```bash
npm test       # temporary repos, fake gates, fake gh; fully offline
npm run check  # node --check on every source file
```

CI runs both on Node 20 and 22.

## Contributing

`main` is protected. Every change goes through a pull request; docs-only PRs are
fine and can be small. Don't weaken a test or skip a human gate to get a change
through.

## License

[MIT](LICENSE)
