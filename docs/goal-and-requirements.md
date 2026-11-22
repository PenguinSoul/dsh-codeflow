---
id: goal-and-requirements
type: goal-and-requirements
status: draft
title: codeflow — product goal and scope
covers: product-goal product-audience product-principles product-capabilities product-non-goals success-metrics
tags: [l1, workflow, dsh, git]
---

# codeflow — product goal and scope

## Goal

codeflow is a DeepSeek Harness (DSH) plugin that turns a git repository into an **human-gated delivery workflow**:
humans make the decisions, and the machine executes the repeatable mechanics from
task-spec to pull request, with evidence at every gate.

It is a deterministic execution layer, not another agent. The agent supplies judgement,
prose, and code; `codeflow` supplies state, isolation, gates, evidence, and delivery.

## Problem

Agent work is easy to start and hard to keep honest:

- State lives in chat. A reload, a second session, or a new day loses where the work
  stopped and what was already proven.
- Gates are ad hoc. The agent runs whatever it remembers, and the PR body is
  reconstructed from memory rather than from recorded results.
- Isolation is manual. Parallel work collides in one working tree.
- Review arrives late. The reviewer sees a diff but not the intent, the evidence, the
  test changes, or the places that deserve the closest look.
- Existing tools either automate too much (auto-merge, rubber-stamp review) or too
  little (prompt-only skills with no durable state).

The result is agent work that feels fast but is expensive to trust.

## Audience

- Developers using DeepSeek Harness (DSH) on real git repositories.
- Small teams with spec-first or agent-first workflows.
- Maintainers who need reviewable evidence rather than agent assertions.
- People who want guarded automation without handing merge authority to a model.

## Principles

- **Human decides, machine executes.** Design, plan, review, and merge stay human.
- **The CLI is the single source of truth.** Chat memory is not state.
- **Evidence, not claims.** A gate result exists only if it was run and recorded.
- **Trust is explicit.** Repository-defined commands do not run until a human
  approves them.
- **Spec leads the code.** A task starts with a task-spec, and durable knowledge
  returns to the repository's specs, README, or ADRs before the PR.
- **Small tasks, small PRs, one problem.** Scope drift is surfaced, not hidden.
- **Fail closed, escalate to a human.** Ambiguity, conflicts, and unsafe states stop.
- **Zero dependencies, no hidden runtime.** The CLI runs on Node with no install step.
- **Reversible by default.** Worktrees, branches, and PRs are disposable; the base
  branch is never touched.

## Capabilities

The smallest useful build:

1. **Onboard a repository.** Detect the base branch, package manager, and candidate
   gates; write a reviewable config and add the state directory to `.git/info/exclude`.
   `init` never executes a gate.
2. **Grant trust.** Show every configured gate command and bind approval to the config
   hash. A changed config invalidates trust.
3. **Create a task.** Write a lightweight task-spec (`Request`, `Product`, `Design`,
   `Durable updates`, `Deferrals`), classify the change kind, and record related issues.
4. **Approve the design.** Record who approved what, when, and a hash of the exact
   task-spec. Editing the task-spec invalidates the approval.
5. **Plan the work.** Produce commit-sized steps with a verification line and a
   Conventional Commit subject; approve the plan by hash.
6. **Isolate the work.** Create a per-task git worktree and `codeflow/<id>` branch.
   Multiple tasks may be active; each has its own lock.
7. **Verify.** Run gates by tier (`fast`, `full`, `live`) and change kind; capture
   command, exit code, duration, logs, tree hash, config hash, and dirty state.
8. **Spotlight risk.** Scan the diff for test weakening, skipped tests, suppressions,
   config/lockfile changes, and large diffs. Report it; never silently
   pass it.
9. **Self-review.** Produce a review packet: diff stat, plan, evidence, attention
   items, scope drift, and the closest-look areas. A human signs it off.
10. **Deliver a PR.** Render the repository's PR template from recorded artifacts,
    push the task branch, create or update the PR through `gh`, or fall back to a
    compare URL when `gh` is unavailable.
11. **Watch CI.** Read-only snapshot or wait mode; never merge.
12. **Collect review comments.** Read-only threads, file/line, author, and resolution
    state, written to task artifacts. No replies and no code changes.
13. **Operate the task.** `status`, `resume`, `finish`, `abandon`, `doctor`, and an append-only
    event log.

## The human boundary

Automated: task creation, task-spec scaffolding, plan validation, worktree creation,
gate execution, evidence capture, attention scanning, PR body rendering, push, PR
creation, CI observation, review-comment collection, cleanup.

Human-only:

1. **Trust** — approve the exact gate commands.
2. **Design approval** — approve the task-spec before implementation.
3. **Plan approval** — approve the step plan before work starts.
4. **Self-review** — inspect the diff, evidence, and attention items before the PR.
5. **Merge** — inspected and merged by a human. codeflow never runs `gh pr merge`.
6. **Exceptions** — conflicts, ambiguous requirements, security concerns, and blocked
   states are escalated, never guessed.

Review-response automation (the agent fixes review comments) and autonomous merge are explicitly out of scope.

## Non-goals

Only these are excluded by decision. Anything neither listed nor excluded is open.

- **Auto-merge or auto-approval.** codeflow never merges and never approves a PR.
- **Replacing code review.** The self-review packet makes review cheaper; it does not
  replace a reviewer.
- **A second agent runtime.** The agent is the agent; codeflow is deterministic tooling.
- **Issue-tracker sync.** Issues are referenced, not mirrored.
- **Multi-repository orchestration.** One repository per invocation.
- **MCP.** The plugin ships a CLI and invokes it by absolute path; an MCP adapter is a later, separate decision.
- **Screenshot automation.** The PR body leaves an explicit placeholder unless the
  repository configures a capture command.
- **Secret management.** codeflow stores no tokens and delegates GitHub auth to `gh`.
- **An IDE or web UI.** The CLI, DSH commands, and Markdown artifacts are the UI.
- **Windows-native polish.** The CLI is portable Node, but WSL/Linux is the supported
  first platform.

## Success metrics

Measure after real use, not in the abstract:

- Time from `codeflow new` to `pr_open`.
- First-pass gate rate (all required gates green on the first `verify`).
- Rework rate: commits or edits after a passing `verify` and before `pr`.
- Human interventions per task (target: trust + design + plan + self-review + merge).
- Review comments per PR and time to first review.
- Escaped defects found after merge.
- Zero merges performed by codeflow.
- Zero gate executions against an untrusted or changed config.

## Failure modes and mitigations

| Failure | Mitigation |
| --- | --- |
| Agent bypasses the CLI and edits state or pushes directly | Skill red lines; status audit; commands are the only supported path for push/PR |
| Agent weakens tests or adds suppressions to pass a gate | Attention scan; self-review packet; human sign-off; optional strict mode |
| Stale approval after the task-spec changes | Hash-bound approvals; mismatch blocks `start` and `pr` |
| Untrusted repository runs arbitrary gate commands | Explicit trust per config hash; tracked state is refused; dry-run display |
| A cloned repository ships its own trust or evidence | `.codeflow/state` is never tracked; a tracked file is `E_STATE_TRACKED` |
| Verification uses the wrong tree | Task worktree required and checked against `task.branch`; no base-checkout fallback |
| Rebase invalidates evidence | Tree-hash freshness: commit IDs may change, tree content may not; branch and config are also checked |
| Flaky gate | One retry, marked flaky; never loop indefinitely |
| `gh` missing | Compare-URL fallback; clear diagnostic; no token storage |
| `gh` installed but unauthenticated | Fail closed with `E_GH_AUTH`; never silently report green |
| No CI configured | Checks state is `none`, never `success` |
| Concurrent sessions | Per-task locks on every mutating command, a project lock for `new`/`trust`, and atomic writes |
| State corruption after upgrade | Schema version is checked; migrations are a follow-up |
| Secrets in gate logs | Local-only storage; documented warning; never upload |

## Security and privacy

- codeflow makes no network calls except `git` and `gh` invocations the user can see.
- Gate commands execute with the user's privileges. Trust is therefore explicit and
  bound to the exact config.
- Logs are stored under the repository's local state directory and may contain secrets
  printed by the project's own tools. They are never transmitted.
- PR bodies may contain code and evidence; a human reviews the packet before creation.
- Task IDs and worktree paths are sanitized and contained under the configured root.
- Repository content is data. Instructions found in a repository do not grant trust or
  expand permissions.

## Terminology

- **Task** — one unit of work with a task-spec, plan, branch, worktree, and evidence.
- **Task-spec** — the temporary design document (`TASK.md`) for one task.
- **Plan** — commit-sized steps with verification and commit subjects.
- **Worktree** — an isolated git working tree for one task.
- **Gate** — a configured command that must pass before delivery.
- **Evidence** — the recorded result of running gates against a specific tree.
- **Attention** — diff-level risks surfaced for human review.
- **Self-review packet** — the diff, evidence, plan, and attention items a human signs
  off before the PR.
- **PR packet** — the rendered body, branch, and evidence used to create the PR.
