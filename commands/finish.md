---
description: Remove the task worktree after the human confirms the merge
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" finish --json` only after the human confirms the merge.

`finish` only accepts a task with an open or merged pull request. For a task that will
not ship, use `/codeflow:abandon` instead. When `gh` is available and the task has a
GitHub PR, `finish` reads the live PR state and refuses unless it is merged —
including when the task is already marked `merged`.
`--confirm` only substitutes for merge detection when it is unavailable. If `gh` is
installed but cannot read the PR (auth or network), `finish` fails with `E_GH_AUTH`;
do not retry with `--confirm`. `--force` only bypasses a dirty worktree; it never
bypasses the merge check.

Use `--delete-branch` only when the human asks. Use `--force` only when the human
explicitly accepts losing uncommitted work.
