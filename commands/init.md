---
description: Initialize codeflow in the current git repository
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" init --json`.

Show the detected gates and the config path. Do not run any gate. If the repo
already has a config, show the warning and ask before using `--force`.

Next: ask the human to review the commands, then `/codeflow:trust`.
