---
description: Create the task branch and worktree
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" start --json`.

It requires `.codeflow/config.json` committed on the base branch, creates the task
branch and an isolated worktree, and checks that the worktree is on the task branch.
Do not edit the base branch; work inside the printed worktree. codeflow commands work
from the project root or the task worktree.

Next: implement the plan, then `/codeflow:verify`.
