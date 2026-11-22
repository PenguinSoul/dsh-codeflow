---
description: Build the self-review packet
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" self-review --json`.

Read `REVIEW.md` and summarize the verification table, attention items, scope
drift, and closest-look areas for the human. Add `--scope-drift` and
`--closest-look` when you know something the packet does not.

Do not approve your own review.

Next: the human runs `/codeflow:approve self-review`.
