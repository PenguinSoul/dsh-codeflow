---
description: Render the PR body and create or update the pull request
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" pr --json`.

It requires a task worktree on `task.branch`, fresh evidence, an approved self-review
whose hash matches the packet, and a PR head equal to the verified HEAD. It fetches the
base, rebases the task branch, pushes it, and creates or updates the PR through `gh`, or
prints a compare URL when `gh` is unavailable.

A rebase conflict marks the task `blocked` with `E_REBASE_CONFLICT`; stop and ask the
human to resolve it. If the rebase changes the tree, `pr` refuses with
`E_APPROVAL_STALE`; run `/codeflow:verify`, `/codeflow:self-review`, and
`/codeflow:approve self-review` again.

`--no-push` renders only: it writes the body and never pushes, creates a PR, or marks
the task delivered.

Never merge and never approve the PR. Report the PR URL, the checks, and any
warning.

Next: `/codeflow:watch`.
