---
description: Collect review comments and resolution state without changing code
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" comments --json`.

Read `COMMENTS.md` and summarize unresolved threads with file and line. If
`resolutionAvailable` is false, say the resolution state is unknown and summarize the
inline comments instead of guessing. Do not reply, resolve threads, or change code
without the human's explicit request.
