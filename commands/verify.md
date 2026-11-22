---
description: Run the gates and record tree-hash evidence
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" verify --json` in the task worktree or the project root.

It loads the config from the task worktree and requires an approval for that exact
config hash. Use `--full` for full gates. Use `--live` only with explicit human
permission and `--allow-live`. Report the gate results and every attention item from
the JSON. Never claim a gate passed unless the JSON says so.

A failed gate returns `ok: false` with `error.code` `E_GATE_FAILED` (or
`E_GATE_TIMEOUT`) and keeps the gate report in `data`; the exit code is 1. Report the
failing gate from `error.details` and the attention items from `data.attention`, then
stop.

After a rebase, re-run `verify` on the `verified` task to refresh evidence, then
rebuild and re-approve the self-review.

If a gate fails, fix the cause. Never weaken a test, skip a test, or add a
suppression to make it pass. If the task is blocked, stop and explain why.

Next: `/codeflow:self-review`.
