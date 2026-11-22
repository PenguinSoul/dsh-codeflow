---
description: Discard a task that will not ship
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" abandon --confirm --json` only when the human has explicitly decided
the task will not ship.

It removes the task worktree, optionally deletes the local branch, and marks the task
`abandoned`. It refuses a task with an open or merged pull request; use
`/codeflow:finish` for those. `--force` only bypasses a dirty worktree.

Never abandon a task to avoid a failing gate or a review decision. Stop and ask the
human first.
