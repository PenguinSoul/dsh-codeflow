---
description: Create a task and a lightweight task-spec
argument-hint: "<task title>"
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" new "$ARGUMENTS" --json`.

Then interview the human and fill the generated `TASK.md` with Request,
Product, Design, Durable updates, and Deferrals. Durable updates must name the
specs, README sections, or ADRs that changed, or say `Not durable — <reason>`;
`pr` refuses without it. Do not write code before the design is approved. Keep the
task-spec short and concrete.

Next: `/codeflow:approve design`.
