---
id: design
type: design
status: draft
title: codeflow — integrated design
parent: architecture
covers: summary l1-flow commands artifacts state trust evidence approval attention plugin modules milestones
tags: [design, l1, workflow, dsh]
---

# codeflow — integrated design

This is the readable integration of the design. The authoritative details live in:

- [`goal-and-requirements.md`](goal-and-requirements.md) — what codeflow is and is not.
- [`architecture.md`](architecture.md) — topology, decisions, invariants, safety.
- [`contracts.md`](contracts.md) — the JSON wire, schemas, and error codes.

## Summary

codeflow is a DeepSeek Harness (DSH) plugin that turns a git repository into an **human-gated delivery workflow**:
humans decide, and a deterministic CLI executes the mechanics from task-spec to pull
request, recording evidence at every gate.

- **The agent** supplies judgement, prose, and code.
- **codeflow** supplies state, isolation, gates, evidence, and delivery.
- **The human** supplies trust, design approval, plan approval, self-review, and merge.

The CLI is the only state owner. The plugin is a thin shell: commands call the CLI,
the skill carries the policy, and one session hook shows the active task.

## The workflow contract

| Automated | Human-only |
| --- | --- |
| Task creation and task-spec scaffold | Trust in gate commands |
| Plan validation | Design approval |
| Worktree and branch creation | Plan approval |
| Gate execution and evidence | Self-review sign-off |
| Attention scanning | Merge |
| PR body rendering, push, PR creation | Conflict and exception decisions |
| CI observation (read-only) | — |
| Review-comment collection (read-only) | — |
| Cleanup | — |

There is no merge command. The skill forbids `gh pr merge`. Review-response
automation (the agent fixes review comments) and autonomous merge are out of scope.

## A day in the life

1. **Onboard.** `/codeflow:init` detects the base branch and candidate gates, writes
   `.codeflow/config.json`, and prints the commands. Nothing runs. Commit the config
   before starting a task.
2. **Trust.** `/codeflow:trust` shows every command and its cwd; the human approves the
   exact config hash. State and trust live in the project root; tracked state is
   refused. Approvals are kept per config hash, so a task-branch config can be reviewed
   separately.
3. **Start a task.** `/codeflow:new "fix the login redirect"` creates a task and a
   lightweight `TASK.md`. The agent interviews the human, fills Request / Product / Design /
   Durable updates / Deferrals, and runs `/codeflow:approve design`.
4. **Plan.** `/codeflow:plan` writes commit-sized steps with a verification line and a
   Conventional Commit subject. The human approves the plan; progress is recorded
   separately.
5. **Implement.** `/codeflow:start` creates `codeflow/<id>` and a worktree under
   `~/.local/state/codeflow/worktrees/<repo>/<id>`. The agent implements step by step.
   Commands work from the project root or the task worktree.
6. **Verify.** `/codeflow:verify` loads the config from the task worktree, checks trust
   for that exact hash, runs the gates, captures branch-bound evidence, and scans the
   diff for test weakening, suppressions, config changes, and large diffs.
   `--full` adds full gates; `--live` needs explicit permission.
7. **Self-review.** `/codeflow:self-review` shows the packet: diff stat, plan status,
   evidence, attention items, scope drift, closest-look areas.
   `/codeflow:approve self-review` records the human sign-off and its hash.
8. **Ship.** `/codeflow:pr` requires fresh evidence, a clean tree, a task worktree on
   `task.branch`, and an approved self-review. It rebases onto the base (a conflict
   blocks the task), force-pushes with lease after a rewrite, renders the repository's PR
   template, and creates the PR with `gh` — or prints a compare URL and body path when
   `gh` is unavailable. The PR head must match the verified HEAD. If the rebase changes
   the tree, evidence must be refreshed. `--no-push` renders the body only.
9. **Watch.** `/codeflow:watch` reads CI once (snapshot) or with `--wait` and a bounded
   timeout; it also reports the merge state and review decision. A repository with no
   checks reports `none`, never success. `/codeflow:comments` collects review threads
   read-only.
10. **Finish.** After the human merges, `/codeflow:finish` verifies the PR state with
    `gh` when available, removes the worktree, and marks the task done. An open PR is
    refused even with `--confirm` or `--force`; a `gh` failure is blocked, not treated as
    absent merge detection. `--force` only bypasses a dirty worktree.

## Command surface

| CLI | Slash | Purpose |
| --- | --- | --- |
| `codeflow init` | `/codeflow:init` | Detect repo, base, gates; write config; exclude state |
| `codeflow trust` | `/codeflow:trust` | Approve exact gate commands |
| `codeflow new "<request>"` | `/codeflow:new` | Create task and `TASK.md` |
| `codeflow approve design\|plan\|self-review` | `/codeflow:approve` | Hash-bound approval |
| `codeflow plan` | `/codeflow:plan` | Validate, render, and track the step plan |
| `codeflow start` | `/codeflow:start` | Create branch and worktree |
| `codeflow verify` | `/codeflow:verify` | Run gates, capture evidence, scan attention |
| `codeflow self-review` | `/codeflow:self-review` | Build the self-review packet |
| `codeflow pr` | `/codeflow:pr` | Rebase, render body, push, create/update PR |
| `codeflow watch` | `/codeflow:watch` | Read-only CI snapshot or bounded wait |
| `codeflow comments` | `/codeflow:comments` | Read-only review threads |
| `codeflow status` | `/codeflow:status` | Human or `--json` status |
| `codeflow resume` | `/codeflow:resume` | Resume a blocked task |
| `codeflow finish` | `/codeflow:finish` | Verify the merge, then remove the worktree; requires an open or merged PR |
| `codeflow abandon` | `/codeflow:abandon` | Discard a task that will not ship |
| `codeflow doctor` | `/codeflow:doctor` | Environment and state diagnostics |

All commands support `--json` with the envelope in [`contracts.md`](contracts.md).
Mutating commands support `--dry-run` where a command has side effects.

## Artifact layout

Committed:

```text
.codeflow/config.json
```

Local, gitignored via `.git/info/exclude`:

```text
.codeflow/state/
  active.json
  trust.json
  state.lock
  tasks/<id>/
    task.json
    TASK.md
    plan.json
    PLAN.md
    evidence.json
    EVIDENCE.md
    review.json
    REVIEW.md
    pr.json
    PR_BODY.md
    comments.json
    COMMENTS.md
    events.jsonl
    lock
    logs/<gate>.log
```

Worktrees:

```text
~/.local/state/codeflow/worktrees/<repo-slug>/<task-id>/
```

`.codeflow/state/` is resolved from the project root (the primary worktree) even when
the command runs inside a task worktree. It must never be tracked; a tracked state file
is refused. The task worktree owns the config, diff, gates, and evidence under test.

`active.json` is a convenience pointer. Any command accepts `--task <id>`, so multiple
tasks can run in parallel.

## State machine

```text
created → designed → planned → active → verified → pr_open → merged → done
                          ↘ blocked ↗
```

- `created`: task and `TASK.md` exist.
- `designed`: the task-spec is approved and unchanged.
- `planned`: the plan is valid and approved.
- `active`: branch and worktree exist; the task lock is held.
- `verified`: required gates pass; evidence is fresh; attention is recorded.
- `pr_open`: the PR exists (or a compare URL is ready).
- `merged`: a human merged; `gh` confirms when possible.
- `done`: worktree removed and task closed.
- `blocked`: a reason and a hint; `resume` returns to the previous state.

Every transition is guarded. Approvals are hashes; editing an approved artifact
invalidates the approval and blocks the next transition.

## Trust, evidence, approval, attention

**Trust.** `.codeflow/state/trust.json` binds a human approval to the normalized config
hash. `verify` refuses without it. A cloned repository cannot execute its own gates
until a human approves the exact commands.

**Evidence.** `evidence.json` records every gate, exit code, duration, log, tree hash,
config hash, gate-set hash, and dirty state. A PR requires passing, fresh evidence and a
clean tree. Rebase may change the commit ID; the tree hash decides freshness.

**Approval.** Design approval hashes `TASK.md`; plan approval hashes `plan.json`;
self-review hashes the diff and evidence. A change invalidates the approval.

**Attention.** The diff scan surfaces test-file changes, skips, suppressions,
config/lockfile changes, large diffs, and the closest-look areas. It is a
spotlight for the human, never an automatic verdict.

## Plugin surface

```text
codeflow/
  package.json                 # dsh.bundle.patch → the adapter
  dsh/index.js                 # registers the skill and commands with DSH
  bin/codeflow                 # invoked via ${CODEFLOW_ROOT}
  src/*.mjs                    # zero-dependency Node ESM
  commands/*.md                # thin wrappers over the CLI
  skills/codeflow/SKILL.md     # workflow policy, gates, red lines
  test/*.test.mjs              # node:test
  docs/                        # this design
  README.md
```

`package.json` declares `main` (the adapter) and `dsh.bundle.patch`; it declares no
MCP server. Every command has `description` and, where useful, `argument-hint`; its
body only calls the CLI and renders the JSON. The adapter registers both seams at
profile boot; nothing runs outside a session.

The skill is the policy layer. It states:

- Hydrate then act: read `codeflow status --json` before every transition.
- Never merge, never approve a PR, never fabricate evidence.
- Never skip design/plan/self-review gates.
- Never weaken a gate, add a suppression, or edit tests to pass.
- Never run repository-defined commands without trust.
- Stop and escalate on conflicts, ambiguity, auth failures, or repeated gate failures.

## Module map

| Module | Responsibility |
| --- | --- |
| `cli` | Parse, dispatch, envelope, exit codes |
| `contracts` | Schema versions, validators, error codes |
| `repo` / `git` | Git root, base/remote, worktree, tree hash |
| `config` / `trust` | Detect, validate, write config; trust grant |
| `state` | Task store, active pointer, locks, events, atomic writes |
| `task` / `plan` | Task-spec, approvals, step plan |
| `gates` / `evidence` | Gate execution, logs, freshness |
| `attention` | Diff risk scan |
| `selfreview` / `prbody` | Review packet, PR body |
| `github` | `gh` create/update, checks, comments |
| `render` / `doctor` | Human output; diagnostics |

The detailed dependency rules and invariants are in
[`architecture.md`](architecture.md).

## Implementation order

This is the plan skeleton; the detailed plan comes after this design is approved.

- **M0 — Docs and skeleton.** This design, a README, `bin/codeflow`, module stubs.
- **M1 — Contracts, config, state, repo.** `init`, `doctor`, `status --json`, tests.
- **M2 — Task and plan.** `new`, `approve`, `plan`, templates, hash invalidation.
- **M3 — Trust, gates, evidence, attention.** `trust`, `verify`, `review` data.
- **M4 — Git isolation.** `start`, `resume`, `finish`, locks, worktree safety.
- **M5 — Delivery.** `self-review`, `pr`, `watch`, `comments`, fake `gh` tests.
- **M6 — Plugin shell.** Bundle manifest, commands, skill, README.
- **M7 — End-to-end and validation.** Temp-repo golden path, safety tests,
  manual smoke.

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| MCP server first | Adds transport and lifecycle work without changing workflow behavior |
| TypeScript + build step | Install friction; zero-dep Node is enough |
| Pure skills/commands | No durable state, no deterministic evidence |
| Auto-merge | Violates the human boundary |
| Single active task per repo | Throws away worktree parallelism |
| Commit-hash evidence | Rebases invalidate valid evidence |
| Parsing human output in commands | Fragile seam; JSON contract is cheaper |
| Trusting committed gate commands | Cloned repository = arbitrary code execution |
| Storing tokens | Adds a secret-management surface; `gh` already owns auth |
| Auto-fixing review comments | That is review-response automation, not the delivery workflow |

## Deferred

MCP adapter, screenshot automation, issue-tracker sync, multi-repo orchestration,
review-response automation, web UI, task GC, agent-compliance evals, Windows-native
polish.

## Review checklist

Before implementation starts, confirm:

- [ ] The goal and non-goals are right.
- [ ] The human boundary is exactly where you want it.
- [ ] The trust model is acceptable.
- [ ] The evidence freshness rule is correct.
- [ ] The command surface is complete enough for the first build.
- [ ] The artifact layout and state machine are acceptable.
- [ ] The plugin shell is the right shape.
- [ ] The implementation order is sensible.
