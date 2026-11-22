---
description: Read the pull request checks without merging
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" watch --json` for a one-shot snapshot. Use `--wait` only when the
human explicitly asks to wait for checks. Bound the wait with `--timeout <seconds>`
and `--interval <ms>`; a timeout is reported, not treated as a failure.

Report the check state. Never merge and never rerun an unrelated failing job
without the human's request.
