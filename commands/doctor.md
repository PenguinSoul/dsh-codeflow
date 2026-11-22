---
description: Check the codeflow environment without changing the repository
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" doctor --json`.

Report each check. Do not install tools, change config, or modify the
repository. If trust is stale, tell the human to review the commands and run
`/codeflow:trust`.
