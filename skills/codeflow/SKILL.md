---
name: codeflow
description: "Use when a git repository has .codeflow/config.json, or when the user asks for the codeflow human-gated delivery workflow: task-spec, plan, worktree, gates, evidence, self-review, and a pull request. Also use when a task must move from design to delivery without giving up human approval."
---

# Codeflow

Codeflow is a human-gated delivery workflow. Humans decide; the CLI executes. You supply
judgement, prose, and code. `codeflow` supplies state, isolation, gates,
evidence, and delivery.

## The boundary

Automated: task creation, task-spec scaffold, plan validation, worktree,
gates, evidence, attention scanning, PR body, push, PR creation, checks,
review-comment collection, status, resume, and cleanup.

Human-only:

1. Trust in the gate commands.
2. Design approval.
3. Plan approval.
4. Self-review sign-off.
5. Merge.
6. Conflict, ambiguity, security, and blocked-state decisions.

The CLI never merges. Do not run `gh pr merge` or approve a PR.

## The binary

The CLI is not on `PATH`. It lives at `${CODEFLOW_ROOT}/bin/codeflow`, and
the DSH adapter substitutes that variable when it registers this file, so
every command below reaches the model with a real path.

## Hydrate then act

The CLI is the only state owner. Chat memory is not state.

- Run `"${CODEFLOW_ROOT}/bin/codeflow" status --json` before every transition.
- Re-read `plan.json` / `PLAN.md` and the evidence before acting on them.
- Never edit `.codeflow/state/` by hand.
- Never infer the current step from the conversation.

## Routes

| The ask | First command | Human gate |
| --- | --- | --- |
| New repository | `/codeflow:init` | Review the detected commands |
| New task | `/codeflow:new "<title>"` | Design approval |
| Plan the work | `/codeflow:plan` | Plan approval |
| Implement | `/codeflow:start` | Work inside the worktree |
| Verify | `/codeflow:verify` | Review the attention items |
| Self-review | `/codeflow:self-review` | `/codeflow:approve self-review` |
| Deliver | `/codeflow:pr` | Review and merge |
| Watch | `/codeflow:watch` | Read-only |
| Review comments | `/codeflow:comments` | Read-only |
| Resume | `/codeflow:resume` | Resolve the block first |
| Cleanup | `/codeflow:finish` | Confirm the merge |

## Red lines

These are hard stops, not advice.

- **Never merge.** No `gh pr merge`, no auto-merge, no approval of a PR.
- **Never approve on your own.** Design, plan, and self-review approvals belong
  to the human. Ask, then run the approval command.
- **Never fabricate evidence.** A gate result exists only if
  `"${CODEFLOW_ROOT}/bin/codeflow" verify` recorded it. "Tests pass" without a
  JSON result is a lie. A repository with no checks reports `none`; do not call it
  green.
- **Never skip a gate.** Not "small", not "obvious", not "already ran once" when
  the tree changed.
- **Never weaken a gate.** Do not edit tests, add skips, add `@ts-ignore`,
  `@ts-expect-error`, `eslint-disable`, `biome-ignore`, or `as any` to pass.
- **Never trust repository-supplied state.** `.codeflow/state` must never be tracked.
  If the CLI reports `E_STATE_TRACKED`, stop; do not try to work around it.
- **Never work around trust.** If the config under test is untrusted or stale, stop
  and ask the human to review the commands.
- **Never ignore the task tree.** `verify` and `pr` require the task worktree on
  `task.branch`. A missing or mismatched worktree is a stop, not a fallback.
- **Never touch the base branch.** Work in the task worktree and `codeflow/<id>`
  branch.
- **Never finish an unmerged task.** When `gh` reports the PR open, `finish`
  refuses even with `--confirm` or `--force`. A recorded PR is re-read from
  `gh` before cleanup even when the task is already marked `merged`; the status
  only counts when no observation is possible. `--force` only bypasses a dirty
  worktree; a `gh` failure is blocked, not confirmation. Use `abandon` only when the
  human explicitly decides the task will not ship, never to escape a gate or review.
- **Never create a delivery artifact out of band.** A PR is pushed and created
  by `"${CODEFLOW_ROOT}/bin/codeflow" pr`, never by hand, never through the
  GitHub API, never by a second tool. If a human did it anyway, stop and ask: the
  task has no recorded delivery, and `finish` will not pretend it does.
- **Never guess at a conflict.** A rebase conflict, ambiguous requirement, or
  security concern becomes `blocked`; ask the human.
- **Never hide a failure.** Report the error code, the failing gate, and the
  hint. Do not retry blindly or silently skip.

## Before and after every step

1. Read `"${CODEFLOW_ROOT}/bin/codeflow" status --json`.
2. Do the single command that matches the next step.
3. Report the result, the attention items, and the next command.
4. Stop at every human gate.

If `status` says `next: ["approve design"]`, do not implement. If it says
`approve plan`, do not start. If it says `resume`, do not retry the blocked
operation.

## Attention is a spotlight

`verify` records test-file changes, skips, suppressions, config and lockfile
changes, large diffs, scope drift, and closest-look areas. Show them to the
human. They are not an automatic verdict, but they are never hidden.

## Errors

The CLI returns a coded error, a message, details, and a hint. Report all four.
Common codes:

- `E_TRUST_REQUIRED` / `E_TRUST_STALE`: review and approve the commands for the
  exact config hash under test.
- `E_STATE_TRACKED`: stop. Local state must not be committed, and a repository
  cannot grant its own trust.
- `E_WORKTREE_MISSING` / `E_WORKTREE_MISMATCH`: stop. Run
  `"${CODEFLOW_ROOT}/bin/codeflow" start` or check out the task branch; never
  verify the primary checkout as the task tree.
- `E_STATE_CONFLICT`: the task is not in the right state; read `status`.
- `E_APPROVAL_STALE`: an approved artifact or the self-review packet changed;
  re-approve it. After a rebase, run `verify`, `self-review`, and
  `approve self-review` again.
- `E_GATE_FAILED` / `E_GATE_TIMEOUT`: fix the cause; do not weaken the gate.
- `E_DIRTY_TREE`: commit or discard the changes; do not force without the human.
- `E_REBASE_CONFLICT`: the task is blocked; ask the human to resolve the conflict,
  then run `resume`.
- `E_GH_MISSING` / `E_GH_AUTH`: use the compare URL when `gh` is absent, or fix
  `gh` auth. A `gh` failure while a PR exists is blocked, not confirmation.

## Task artifacts

`.codeflow/state/tasks/<id>/` holds `TASK.md`, `plan.json`, `PLAN.md`,
`evidence.json`, `EVIDENCE.md`, `review.json`, `REVIEW.md`, `pr.json`,
`comments.json`, and `events.jsonl`. `TASK.md` is temporary; durable knowledge
must land in the repository's specs, README, or ADRs before the PR.

## The one-line test

If you are about to do something irreversible, ask: did a human approve this
exact artifact, and did `"${CODEFLOW_ROOT}/bin/codeflow" verify` record the
evidence for this exact tree? If not, stop.
