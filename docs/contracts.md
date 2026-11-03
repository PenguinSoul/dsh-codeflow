---
id: contracts
type: contract-design
status: draft
title: codeflow — CLI contracts
parent: architecture
covers: envelope exit-codes errors config trust task plan evidence attention self-review pr event status commands
tags: [contracts, json, cli]
---

# codeflow — CLI contracts

Every command supports `--json`. The JSON is the wire; human output is a renderer of
the same data. Commands, tests, and the plugin shell must never parse prose.

## Envelope

```json
{
  "schemaVersion": 1,
  "command": "status",
  "ok": true,
  "data": {},
  "error": null,
  "warnings": [],
  "meta": {
    "generatedAt": "2026-10-26T10:00:00Z",
    "repoRoot": "/home/user/code/repo",
    "taskId": "2026-10-26-fix-login",
    "cliVersion": "0.1.0"
  }
}
```

Rules:

- `ok: false` implies a non-null `error`. `data` is `null` unless the command
  completed and produced a report that stays valid after the failure — currently
  only `verify`, which keeps its gate report so the caller can render the failure.
- `ok` describes the command outcome, so it agrees with the exit code: `ok: true`
  is exit `0`, and a failed required gate is `ok: false` with exit `1`.
- `warnings` is always an array; a warning never changes the exit code.
- `meta.taskId` is `null` when no task is selected.
- Unknown fields are ignored by consumers; producers may add fields within the same
  `schemaVersion`.
- Timestamps are ISO 8601 UTC (`2026-10-26T10:00:00Z`).
- Hashes are `sha256:<64 hex chars>`.
- Absolute paths (`repoRoot`, `worktree`) use native separators.
- Repository-relative paths (`taskPath`, `bodyPath`, `logPath`) use POSIX `/` and are
  relative to the project root (the primary worktree), not the current task worktree.

## Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Success |
| `1` | A required gate failed or timed out |
| `2` | Usage, config, repository, or schema error |
| `3` | State conflict, stale approval, or lock |
| `4` | Git conflict or dirty-tree refusal |
| `5` | GitHub/`gh` missing, unauthenticated, or PR conflict |
| `6` | Trust missing, stale, or state tracked by git |
| `7` | Task blocked; human action required |
| `8` | Unexpected internal failure |

### Selected error codes

| Code | Exit | Meaning |
| --- | --- | --- |
| `E_STATE_TRACKED` | `6` | `.codeflow/state` is tracked by git and cannot be trusted |
| `E_SCHEMA_UNSUPPORTED` | `2` | An artifact has an unsupported `schemaVersion` |
| `E_WORKTREE_MISSING` | `3` | The task worktree is required but missing |
| `E_WORKTREE_MISMATCH` | `3` | The worktree is not on `task.branch` |
| `E_TRUST_REQUIRED` | `6` | No approval exists for the current config hash |
| `E_TRUST_STALE` | `6` | The config hash has no matching approval |
| `E_APPROVAL_STALE` | `3` | An approved artifact or the self-review packet changed |
| `E_LOCKED` | `3` | A task or project lock is held |
| `E_PUSH_FAILED` | `4` | Push failed or the PR head does not match the verified HEAD |

## Error object

```json
{
  "code": "E_GATE_FAILED",
  "message": "Gate \"test\" exited 1",
  "details": {
    "gate": "test",
    "exitCode": 1,
    "logPath": ".codeflow/state/tasks/2026-10-26-fix-login/logs/test.log"
  },
  "hint": "Fix the failing test, then run `codeflow verify --retry`."
}
```

## Common types

| Type | Shape |
| --- | --- |
| `TaskId` | `^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63}$` |
| `TaskStatus` | `created`, `designed`, `planned`, `active`, `verified`, `pr_open`, `merged`, `done`, `blocked`, `abandoned` |
| `TaskKind` | `code`, `docs`, `infra`, `test`, `mixed` |
| `GateTier` | `fast`, `full`, `live` |
| `Hash` | `sha256:<64 hex>` |
| `GitTreeHash` | `git:<40 hex>` for SHA-1 or `sha256:<64 hex>` for SHA-256 |
| `IsoTime` | ISO 8601 UTC |
| `RepoPath` | POSIX path relative to the project root |
| `AbsPath` | absolute native path |

## Config

`.codeflow/config.json`, committed.

`stateDir` is resolved from the project root (the primary worktree), never from the
current task worktree. Commands that inspect the task (`verify`, `pr`, `self-review`,
`status`, `watch`, `comments`) load the config from the task worktree, so a config
change on the task branch is the config under test. `pr.template` must be
repository-relative and stay inside the task worktree.

```json
{
  "schemaVersion": 1,
  "baseBranch": "main",
  "remote": "origin",
  "worktreeRoot": "~/.local/state/codeflow/worktrees",
  "stateDir": ".codeflow/state",
  "gates": [
    {
      "name": "lint",
      "command": "npm run lint",
      "cwd": ".",
      "tier": "fast",
      "kinds": ["code", "test", "infra"],
      "required": true,
      "timeoutSec": 300,
      "env": {}
    }
  ],
  "verify": {
    "retryFlaky": true,
    "maxRetries": 1
  },
  "pr": {
    "template": ".github/PULL_REQUEST_TEMPLATE.md",
    "screenshots": "manual",
    "titlePrefix": "",
    "sections": {}
  },
  "attention": {
    "largeDiffFiles": 25,
    "largeDiffLines": 1200,
    "failOn": []
  }
}
```

Rules:

- `gates[].command` is a shell string, executed through the platform shell.
- `gates[].env` may not contain secrets; it is committed.
- `gates[].kinds` limits the gate to those task kinds. An empty array means all kinds.
- `pr.screenshots` is `"manual"` (render the capture TODO), `"none"` (render
  `Not applicable — no frontend changes.`), or `{ "command": "npm run screenshots" }`
  (render that command).
- `pr.sections` maps template headings to artifact fields when the template is custom.
- `attention.failOn` accepts attention codes (`skip`, `suppression`, `config`,
  `lockfile`, `large-diff`); empty means warn only.

## Trust

`.codeflow/state/trust.json` lives in the project root, is local, and is never committed.

```json
{
  "schemaVersion": 1,
  "configHash": "sha256:...",
  "approvedBy": "Name <email>",
  "approvedAt": "2026-10-26T10:00:00Z",
  "commands": [
    { "name": "lint", "command": "npm run lint", "cwd": "." }
  ],
  "approvals": [
    {
      "configHash": "sha256:...",
      "approvedBy": "Name <email>",
      "approvedAt": "2026-10-26T10:00:00Z",
      "commands": [
        { "name": "lint", "command": "npm run lint", "cwd": "." }
      ]
    }
  ]
}
```

`configHash` is computed over the normalized config with stable key ordering and no
whitespace variance. A command change, cwd change, or gate addition invalidates that
approval. `approvals` keeps one entry per reviewed hash, so the project config and a
task-branch config can both be approved without erasing each other; the top-level fields
mirror the most recent approval for compatibility.

If any file under `.codeflow/state` is tracked by git, every command refuses with
`E_STATE_TRACKED`. A cloned repository must not be able to supply trust, task, evidence,
or review state.

## Task

`.codeflow/state/tasks/<id>/task.json`.

```json
{
  "schemaVersion": 1,
  "id": "2026-10-26-fix-login",
  "title": "Fix login redirect",
  "kind": "code",
  "status": "created",
  "branch": "codeflow/2026-10-26-fix-login",
  "worktree": "/home/user/.local/state/codeflow/worktrees/repo/2026-10-26-fix-login",
  "baseBranch": "main",
  "remote": "origin",
  "createdAt": "2026-10-26T09:00:00Z",
  "createdBy": "Name <email>",
  "issues": ["#123"],
  "approvals": {
    "design": {
      "hash": "sha256:...",
      "approvedBy": "Name <email>",
      "approvedAt": "2026-10-26T09:30:00Z",
      "note": ""
    },
    "plan": null,
    "selfReview": null
  },
  "blocked": null,
  "lastEventHash": "sha256:..."
}
```

`blocked` is `null` or:

```json
{
  "code": "E_REBASE_CONFLICT",
  "reason": "origin/main conflicts in src/auth.ts",
  "at": "2026-10-26T11:00:00Z",
  "from": "active",
  "hint": "Resolve the conflict, commit, then run `codeflow resume`."
}
```

## Plan

`.codeflow/state/tasks/<id>/plan.json`.

```json
{
  "schemaVersion": 1,
  "taskId": "2026-10-26-fix-login",
  "steps": [
    {
      "id": "1",
      "title": "Reproduce the redirect loop",
      "status": "pending",
      "commitSubject": "test(auth): reproduce the login redirect loop",
      "verification": "`npm test -- auth` → failing test added",
      "result": "",
      "summary": "",
      "note": ""
    }
  ]
}
```

Rules:

- `status` is `pending`, `in_progress`, `done`, or `blocked`.
- `verification` is the planned check and is immutable under plan approval.
- `result` is the actual outcome, in `check → result` form, and is mutable.
- `summary` explains what changed and why; `note` is working detail.
- `commitSubject` matches the repository's commit style; Conventional Commits by
  default.
- A step that changes code must have a `commitSubject`.
- Plan approval hashes only `id`, `title`, `commitSubject`, and `verification`.
  Progress fields do not invalidate it. `codeflow plan step <id>` updates progress;
  marking a step `done` requires `--result`. `pr` refuses while any step is not
  `done`.

## Evidence

`.codeflow/state/tasks/<id>/evidence.json`.

```json
{
  "schemaVersion": 1,
  "taskId": "2026-10-26-fix-login",
  "treeHash": "git:...",
  "commit": "abc1234",
  "branch": "codeflow/2026-10-26-fix-login",
  "dirty": false,
  "configHash": "sha256:...",
  "gateSetHash": "sha256:...",
  "nodeVersion": "v26.11.1",
  "platform": "linux",
  "startedAt": "2026-10-26T10:00:00Z",
  "finishedAt": "2026-10-26T10:02:00Z",
  "result": "pass",
  "kind": "code",
  "inferredKind": "mixed",
  "effectiveKind": "mixed",
  "gates": [
    {
      "name": "lint",
      "command": "npm run lint",
      "tier": "fast",
      "required": true,
      "exitCode": 0,
      "durationMs": 1200,
      "timedOut": false,
      "flaky": false,
      "logPath": ".codeflow/state/tasks/2026-10-26-fix-login/logs/lint.log",
      "tail": "…last 20 lines…"
    }
  ],
  "attention": {
    "testFiles": [],
    "skips": [],
    "suppressions": [],
    "configChanges": [],
    "lockfileChanges": [],
    "largeDiff": {
      "files": 4,
      "lines": 120,
      "thresholdFiles": 25,
      "thresholdLines": 1200
    },
    "scopeDrift": [],
    "closestLook": []
  }
}
```

`treeHash` is the GitHub-style tree object name from `git rev-parse HEAD^{tree}`,
prefixed with `sha256:` only when the hash algorithm is SHA-256. For SHA-1 repositories
it is `git:<40 hex>`; the prefix makes the algorithm explicit.

`configHash` is `sha256` over the normalized config with stable key ordering.
`gateSetHash` is `sha256` over the ordered selected gates' name, command, cwd, tier, and
`required` flag. Both are recomputed on every `verify` and `pr`.

Freshness for `pr`:

```text
result == "pass"
dirty == false
treeHash == current HEAD tree
configHash == current config hash
gateSetHash == current selected gate set
branch == task.branch
```

## Self-review

`.codeflow/state/tasks/<id>/review.json`.

```json
{
  "schemaVersion": 1,
  "taskId": "2026-10-26-fix-login",
  "diffHash": "sha256:...",
  "evidenceHash": "sha256:...",
  "planHash": "sha256:...",
  "reviewedBy": "Name <email>",
  "reviewedAt": "2026-10-26T10:10:00Z",
  "notes": "Closest look: redirect loop guard.",
  "acknowledged": ["attention:suppression:src/auth.ts:42"]
}
```

`diffHash` is `sha256` over `git diff --binary <base>...HEAD` in a clean tree.
`evidenceHash` is `sha256` over the canonical `evidence.json` bytes. `planHash` covers
the full plan, including progress, so updating a step after sign-off invalidates the
review. `pr` requires a self-review whose `diffHash`, `evidenceHash`, and `planHash`
match the current tree, evidence, and plan, and whose recorded approval hash matches
the packet.

## Attention

Embedded in evidence and rendered in the self-review packet:

```json
{
  "testFiles": [{ "path": "src/auth.test.ts", "change": "modified" }],
  "skips": [{ "path": "src/auth.test.ts", "line": 42, "pattern": "it.skip" }],
  "suppressions": [{ "path": "src/auth.ts", "line": 10, "pattern": "@ts-ignore" }],
  "configChanges": [".codeflow/config.json"],
  "lockfileChanges": ["package-lock.json"],
  "largeDiff": {
    "files": 30,
    "lines": 1500,
    "thresholdFiles": 25,
    "thresholdLines": 1200
  },
  "scopeDrift": ["also renamed a helper in src/util.ts"],
  "closestLook": ["the rollback path in src/auth.ts"]
}
```

## PR

`.codeflow/state/tasks/<id>/pr.json`.

```json
{
  "schemaVersion": 1,
  "taskId": "2026-10-26-fix-login",
  "mode": "gh",
  "number": 42,
  "url": "https://github.com/org/repo/pull/42",
  "state": "open",
  "title": "fix(auth): stop the login redirect loop",
  "bodyPath": ".codeflow/state/tasks/2026-10-26-fix-login/PR_BODY.md",
  "headSha": "abc1234",
  "baseBranch": "main",
  "compareUrl": null,
  "createdAt": "2026-10-26T10:20:00Z",
  "lastReadAt": "2026-10-26T10:25:00Z",
  "checks": {
    "state": "pending",
    "total": 5,
    "passed": 3,
    "failed": 0,
    "pending": 2
  }
}
```

`mode` is `gh` or `compare`. In `compare` mode, `number`, `url`, and `checks` may be
`null`; `compareUrl` is present.

## Event

`.codeflow/state/tasks/<id>/events.jsonl`, one JSON object per line.

```json
{
  "schemaVersion": 1,
  "at": "2026-10-26T09:00:00Z",
  "taskId": "2026-10-26-fix-login",
  "type": "task.created",
  "actor": "Name <email>",
  "data": {},
  "prevHash": "sha256:...",
  "hash": "sha256:..."
}
```

Event types: `task.created`, `task.approved`, `plan.approved`, `task.started`,
`verify.started`, `verify.finished`, `review.approved`, `pr.created`, `pr.updated`,
`pr.checks`, `comments.read`, `task.blocked`, `task.resumed`, `task.finished`,
`task.abandoned`, `config.trusted`.

## Status data

```json
{
  "repo": {
    "root": "/home/user/code/repo",
    "baseBranch": "main",
    "remote": "origin"
  },
  "task": {
    "id": "2026-10-26-fix-login",
    "title": "Fix login redirect",
    "kind": "code",
    "status": "verified",
    "branch": "codeflow/2026-10-26-fix-login",
    "worktree": "/home/user/.local/state/codeflow/worktrees/repo/2026-10-26-fix-login"
  },
  "next": ["self-review", "pr"],
  "trust": {
    "trusted": true,
    "configHash": "sha256:..."
  },
  "evidence": {
    "fresh": true,
    "result": "pass",
    "treeHash": "git:...",
    "branch": "codeflow/2026-10-26-fix-login",
    "finishedAt": "2026-10-26T10:02:00Z"
  },
  "pr": {
    "mode": "gh",
    "number": 42,
    "state": "open",
    "checks": { "state": "pending", "total": 5, "passed": 3, "failed": 0, "pending": 2 },
    "mergeStateStatus": "BLOCKED",
    "reviewDecision": "REVIEW_REQUIRED"
  },
  "blocked": null
}
```

`next` is an array of suggested commands, never an automatic action. `evidence.fresh`
is true only when the task worktree exists, is on `task.branch`, the tree and config
hash match, and the recorded tree was clean. No checks are reported as `none`, never
as success.

## Command data

### `init`

```json
{
  "repoRoot": "/repo",
  "baseBranch": "main",
  "remote": "origin",
  "configPath": ".codeflow/config.json",
  "excludePath": ".git/info/exclude",
  "detected": [
    { "name": "lint", "command": "npm run lint", "reason": "package.json script" }
  ],
  "trustRequired": true
}
```

### `trust`

```json
{
  "configHash": "sha256:...",
  "commands": [{ "name": "lint", "command": "npm run lint", "cwd": "." }],
  "approvedBy": "Name <email>",
  "approvedAt": "2026-10-26T10:00:00Z"
}
```

### `new`

```json
{
  "taskId": "2026-10-26-fix-login",
  "taskPath": ".codeflow/state/tasks/2026-10-26-fix-login",
  "taskSpecPath": ".codeflow/state/tasks/2026-10-26-fix-login/TASK.md",
  "kind": "code",
  "next": ["edit TASK.md", "approve design"]
}
```

A task id is the date plus an ASCII slug of the title. A title with no ASCII word
characters (for example a CJK title) keeps the same shape with a stable digest instead
of collapsing to `task`: `2026-11-02-t-9e6b521c`. The suffix is derived from the title,
so the same title always maps to the same base id and repeats get the usual `-2`.

### `approve`

```json
{
  "target": "design",
  "hash": "sha256:...",
  "approvedBy": "Name <email>",
  "approvedAt": "2026-10-26T09:30:00Z"
}
```

`target` is `design`, `plan`, or `self-review`.

### `plan`

```json
{
  "planPath": ".codeflow/state/tasks/2026-10-26-fix-login/plan.json",
  "steps": 4,
  "approved": true,
  "next": ["start"]
}
```

### `plan step`

```json
{
  "taskId": "2026-10-26-fix-login",
  "step": {
    "id": "1",
    "title": "Reproduce the redirect loop",
    "status": "done",
    "result": "`npm test -- auth` → 1 failing test added"
  },
  "next": ["verify"]
}
```

`plan step` requires an approved plan and an `active` or `verified` task. It updates
only progress fields, writes `PLAN.md`, and records a `plan.step` event. A `done` step
requires a non-empty `--result`.

### `start`

```json
{
  "taskId": "2026-10-26-fix-login",
  "branch": "codeflow/2026-10-26-fix-login",
  "worktree": "/home/user/.local/state/codeflow/worktrees/repo/2026-10-26-fix-login",
  "baseCommit": "abc1234"
}
```

### `verify`

```json
{
  "result": "pass",
  "kind": "code",
  "inferredKind": "mixed",
  "effectiveKind": "mixed",
  "gates": [
    { "name": "lint", "exitCode": 0, "durationMs": 1200, "required": true }
  ],
  "attention": {
    "testFiles": [],
    "suppressions": [],
    "largeDiff": false
  },
  "evidencePath": ".codeflow/state/tasks/2026-10-26-fix-login/evidence.json",
  "next": ["self-review", "pr"]
}
```

`verify` infers the change kind from the diff. When it differs from `task.kind`, it
uses the broader `mixed` gate set and returns `W_KIND_INFERRED`. A docs-only task with
no configured docs gate records zero gates, passes on attention, and returns
`W_NO_GATES`; a non-docs task with no applicable gate is `E_CONFIG`. Evidence records
all three kinds.

A failed verification is a failure envelope that keeps the report: `ok: false`,
`error.code` is `E_GATE_FAILED` (or `E_GATE_TIMEOUT` when a required gate timed out),
`data.result` is `"fail"`, and `data` still carries the gate table, attention, and
`evidencePath`. The exit code is `1`. `error.details` names the failing gate, its exit
code, the per-gate log paths, and the attention categories that failed `failOn`.

`W_ATTENTION` covers the two categories that weaken verification — skipped tests and
suppressions. Test-file changes and diff size are recorded in `data.attention`, the
evidence, and the review packet, but they do not raise a warning; use
`attention.failOn` to gate on them.

### `pr`

```json
{
  "mode": "gh",
  "number": 42,
  "url": "https://github.com/org/repo/pull/42",
  "bodyPath": ".codeflow/state/tasks/2026-10-26-fix-login/PR_BODY.md",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "checks": { "state": "pending", "total": 5, "passed": 3, "failed": 0, "pending": 2 },
  "mergeStateStatus": "BLOCKED",
  "reviewDecision": "REVIEW_REQUIRED",
  "rebased": false,
  "baseCommit": "def5678"
}
```

`pr` fetches and rebases the task branch onto `<remote>/<base>` before pushing. A
conflict aborts the rebase, marks the task `blocked` with `E_REBASE_CONFLICT`, and
leaves the worktree clean. If the rebase changes the tree, the existing evidence
is stale: `pr` refuses with `E_APPROVAL_STALE` (`details.rebased: true`) until
`verify`, `self-review`, and `approve self-review` are run again. A rewritten
branch is pushed with `--force-with-lease`.

The task worktree is required and must be on `task.branch`. The `headSha` reported by
`gh` must equal the verified local HEAD; a mismatch is `E_PUSH_FAILED`. `pr` also
refuses while any plan step is not `done`.

With `--no-push`, the command is render-only:

```json
{
  "mode": "gh",
  "title": "Fix login redirect",
  "bodyPath": ".codeflow/state/tasks/2026-10-26-fix-login/PR_BODY.md",
  "rendered": true,
  "pushed": false
}
```

It writes `PR_BODY.md`, never pushes, never creates a PR, and leaves the task unchanged.

In `compare` mode, `number`, `url`, and `checks` are `null`, and `compareUrl` is the
pull-request compare link.

### `self-review`

```json
{
  "reviewPath": ".codeflow/state/tasks/2026-10-26-fix-login/REVIEW.md",
  "diffHash": "sha256:...",
  "evidenceHash": "sha256:...",
  "attention": {
    "testFiles": 0,
    "skips": 0,
    "suppressions": 0,
    "configChanges": 0,
    "largeDiff": false
  },
  "signed": false,
  "next": ["approve self-review"]
}
```

`approve self-review` stores a hash of the approved review packet in
`task.json.approvals.selfReview`. `pr` requires that hash to match the current
`review.json` in addition to the diff and evidence hashes. Editing notes, scope drift,
or closest-look fields after sign-off invalidates the approval.

### `watch`

```json
{
  "state": "pending",
  "checks": { "total": 5, "passed": 3, "failed": 0, "pending": 2 },
  "mergeStateStatus": "BLOCKED",
  "reviewDecision": "REVIEW_REQUIRED",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "lastReadAt": "2026-10-26T10:25:00Z",
  "waited": false,
  "polls": 0,
  "timedOut": false
}
```

`state` is `none`, `pending`, `success`, `failure`, or `skipped`. `none` means the
repository reported no checks; it is never success. Unknown conclusions are pending.
`mergeStateStatus` and `reviewDecision` are advisory snapshots; only a human merges.

`watch --wait` polls only while checks are pending. `--timeout <seconds>` (default
300) and `--interval <ms>` (default 5000) bound the wait; a timeout returns
`timedOut: true` with `W_CHECKS_PENDING` and exit code 0.

### `comments`

```json
{
  "threads": 3,
  "reviews": 2,
  "resolutionAvailable": true,
  "resolved": 1,
  "unresolved": 2,
  "path": ".codeflow/state/tasks/2026-10-26-fix-login/COMMENTS.md"
}
```

Thread resolution comes from the GitHub GraphQL `reviewThreads` query. If that query
is unavailable, `resolutionAvailable` is `false` and `resolved`/`unresolved` are
`null`; the command does not guess that every thread is open.

### `finish`

```json
{
  "taskId": "2026-10-26-fix-login",
  "removedWorktree": true,
  "deletedBranch": false,
  "mergeConfirmedBy": "gh",
  "activeCleared": true,
  "status": "done"
}
```

`mergeConfirmedBy` is `gh`, `status`, or `confirm`. `finish` only accepts a task whose
status is `pr_open` or `merged`; a task that will not ship uses `abandon`. Both clear
`active.json` when the pointer still names that task (`activeCleared` reports it), so
`status` falls back to `task: null`; the archived task stays reachable with `--task`. When `gh` is
available and a GitHub PR is recorded, `finish` trusts the live PR state: an open PR is
refused even with `--confirm` or `--force`. `--confirm` only substitutes for merge
detection when it is unavailable (no `gh`, no GitHub PR, or a compare-mode fallback).
If `gh` is installed and a PR is recorded but the state cannot be read (auth or
network), `finish` fails with `E_GH_AUTH`; it does not treat that failure as permission
to confirm.

### `abandon`

```json
{
  "taskId": "2026-10-26-spike",
  "removedWorktree": true,
  "deletedBranch": false,
  "activeCleared": true,
  "status": "abandoned"
}
```

`abandon` requires `--confirm`, refuses `pr_open`/`merged`/`done`, removes the worktree
(clean or `--force`), optionally deletes the local branch, and marks the task
`abandoned`. It never touches the base branch.

### `resume`

```json
{
  "taskId": "2026-10-26-fix-login",
  "previousStatus": "blocked",
  "status": "active",
  "next": ["verify"]
}
```

### `doctor`

```json
{
  "checks": [
    { "name": "node", "ok": true, "detail": "v26.11.1" },
    { "name": "git", "ok": true, "detail": "2.56.0" },
    { "name": "gh", "ok": true, "detail": "/usr/bin/gh" },
    { "name": "ghAuth", "ok": true, "detail": "authenticated" },
    { "name": "worktreeRoot", "ok": true, "detail": "/home/user/.local/state/codeflow/worktrees" },
    { "name": "trust", "ok": true, "detail": "config hash matches" },
    { "name": "schema", "ok": true, "detail": "config 1; supported: task, plan, evidence" },
    { "name": "locks", "ok": true, "detail": "no active locks" }
  ]
}
```

`doctor` checks: Node version, git repository, config parse, trust hash, `gh` presence
and auth, worktree root writability, state writability, artifact schema versions, and
stale locks. A failed check never changes repository state.

## Schema evolution

- Additive fields are allowed within a `schemaVersion`.
- Removing or renaming a field, changing its type, or changing semantics requires a
  version bump.
- The CLI rejects any artifact whose `schemaVersion` is not supported
  (`E_SCHEMA_UNSUPPORTED`).
- Only `schemaVersion: 1` exists today. A migration for an older version must land
  with the first compatibility need; migrations are pure functions with fixtures, not
  best-effort reads. `doctor` reports the versions it finds.
