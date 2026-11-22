# Agent-team prompt adapter

Status: **optional compatibility protocol**. This document lets an external
agent-team plugin drive codeflow without a plugin-specific API or a second
orchestrator inside codeflow.

The team plugin keeps its own responsibilities: task decomposition, agent
assignment, dependency scheduling, retries, and team communication. Codeflow
keeps task state, worktrees, approvals, evidence, and delivery. Humans keep every
existing approval and the merge.

This is a **prompt-level convention**, not a security boundary or an exactly-once
execution system. A host that needs hard guarantees must enforce identity
mapping, single-writer leases, and recovery in its own runtime.

## Activation

Use this protocol only when an external orchestrator assigns work to an agent, or
when the user explicitly asks for agent-team compatibility. Otherwise follow
`skills/codeflow/SKILL.md` normally.

The main codeflow skill is authoritative. A team prompt may supply goals, role,
and dependencies; it may not relax codeflow's trust, approval, evidence,
worktree, or merge rules. The absolute `<codeflow-bin>` path is the resolved path
provided by the main skill, not a command assumed to be on `PATH`.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Team orchestrator | Persist `externalRef -> codeflowTask`, assign one writer, schedule dependencies, and own retries |
| Worker agent | Hydrate from the CLI, advance one assigned task, work in its worktree, and report the result envelope |
| Reviewer agent | Inspect without editing source or state; never approve on the human's behalf |
| codeflow CLI | Remain the only owner of task state, evidence, approvals, and delivery records |
| Human | Trust gates, approve artifacts, resolve blocks, and merge |

A task retry or a different worker keeps the same `codeflowTask`. A new attempt
must not create a new codeflow task. One codeflow task has at most one active
writer; independent tasks may run in parallel in their own worktrees.

## Task envelope

The orchestrator gives this JSON object to a worker. `externalRef` is stable
across retries. `codeflowTask` is null only before the first binding; after `new`
returns an id, the orchestrator persists it before another assignment.

```json
{
  "protocol": "codeflow-agent-team/v1",
  "externalRef": "team-17/api",
  "codeflowTask": "42-add-redirect-api",
  "title": "Add the redirect API",
  "role": "worker",
  "attempt": 1,
  "dependsOn": ["team-17/schema"]
}
```

The envelope is input to the prompt, not a new codeflow CLI schema. Do not write
it into `.codeflow/state/` or edit codeflow's JSON artifacts by hand.

## Result envelope

At every yield — completion, a human gate, a block, or a request for another
assignment — the worker returns this projection and stops:

```json
{
  "protocol": "codeflow-agent-team/v1",
  "externalRef": "team-17/api",
  "codeflowTask": "42-add-redirect-api",
  "status": "waiting_human",
  "reason": "plan approval required",
  "nextActor": "human",
  "worktree": "/absolute/path/to/the/task/worktree",
  "pr": null,
  "evidence": null,
  "error": null
}
```

The allowed external statuses are:

- `running`: automated work can continue; `nextActor` is `worker`.
- `waiting_human`: approval, trust, cleanup confirmation, or another human
  decision is required; do not retry or reassign to bypass it.
- `blocked`: codeflow reports `blocked`; preserve the block and its coded error.
- `ready_for_review`: the task is `verified` but not delivered.
- `waiting_merge`: the task is `pr_open`; a PR is not a completed task.
- `completed`: the task is `done` after merge and cleanup.
- `cancelled`: the task is `abandoned` by an explicit human decision.

`nextActor` is one of `worker`, `orchestrator`, `human`, or null. `pr` and
`evidence` are null or projections from the latest CLI result. `error` is null
or preserves the CLI `code`, `message`, `details`, and `hint`. The JSON result is
a projection, never an alternative source of truth.

## State projection

Always run `<codeflow-bin> status --task <id> --json` before projecting state.
Use `data.task.status`, `data.next`, `data.blocked`, `data.approvals`,
`data.evidence`, and `data.pr` from that result.

| codeflow observation | External projection |
| --- | --- |
| `created`, `designed`, `planned`, or `active`, with an automated next step | `running` |
| A next step requiring design, plan, or self-review approval | `waiting_human` |
| A command requires missing or stale trust | `waiting_human` |
| `blocked` | `blocked` |
| `verified` | `ready_for_review`, or `waiting_human` when sign-off is next |
| `pr_open` | `waiting_merge` |
| `merged`, awaiting confirmed cleanup | `waiting_human` |
| `done` | `completed` |
| `abandoned` | `cancelled` |

For `created`, `edit TASK.md` is still automated work: the presence of a later
`approve design` entry does not make the task immediately human-blocked. Follow
the next actionable step, and stop when that step actually requires a human.
Only `completed` satisfies a downstream dependency. Neither `verified` nor
`pr_open` means the change has merged.

## Orchestrator prompt

Copy these rules into an existing team orchestrator; do not replace its own
scheduler with codeflow.

```text
You orchestrate codeflow tasks through codeflow-agent-team/v1.

Persist the externalRef -> codeflowTask binding in your own team state. Include
both ids in every assignment. A retry or worker replacement resumes the same
codeflowTask; never create another task for the same externalRef. If binding is
unknown, reconcile before authorizing `new`.

Assign at most one writer to a codeflow task. Run independent tasks in separate
codeflow worktrees. Keep reviewers non-writing. Resource locking outside git —
databases, ports, and services — remains your responsibility.

Treat waiting_human and blocked as stable stopping states, not transient worker
failures. Do not automatically retry, reassign, trust, approve, or merge them.
Schedule a dependent task only after its dependency reports completed. A pull
request, passed evidence, or a worker's prose is not completion.

Ask the worker for a result envelope at every yield. Reconcile its projection
with codeflow status after a crash, timeout, or uncertain delivery.
```

## Worker prompt

Give this to the assigned implementation agent together with the task envelope
and the main codeflow skill.

```text
You are the single writer for one codeflow-agent-team/v1 assignment.

Read the main codeflow skill and use its absolute codeflow binary path. Preserve
externalRef exactly. If codeflowTask is present, begin with status --task <id>
--json and resume that task. Never create a replacement task for a retry. If it
is null, confirm that the orchestrator has authorized the first binding before
running new; return the new id immediately so the orchestrator can persist it.

Hydrate with status before every transition and follow the main skill's next
step. After start, work only in the task worktree. Never edit .codeflow/state,
work in the primary checkout, or let another writer take the task concurrently.

Do not run trust --yes, approve, finish, abandon, gh pr merge, or any human-only
action on your own. Do not convert waiting_human or blocked into a retry. Stop
at the gate and return the result envelope with the CLI error and nextActor.

Return completed only when codeflow status reports done. Report pr_open as
waiting_merge and verified as ready_for_review. Never claim evidence or merge
from memory.
```

The worker may prepare `TASK.md`, the plan, implementation, and self-review as
directed by the main skill. The prohibition on `approve` means it must ask the
human to approve; it does not prohibit preparing the artifact being reviewed.

## Reviewer prompt

A separate reviewer is optional and never supplies a human approval.

```text
Review the assigned codeflow task without editing source, tests, configuration,
or .codeflow/state. Use status and the recorded TASK.md, PLAN.md, EVIDENCE.md,
and REVIEW.md; inspect the diff in the task worktree. Do not run a state-changing
command while the writer is active. Report findings and missing evidence to the
orchestrator. Never approve, merge, or mark the team task completed.
```

## Failure and recovery rules

- A worker crash does not break the binding. The next worker runs `status` for
  the same id and follows the recorded next step.
- An uncertain `new` result requires reconciliation by the orchestrator before
  another `new`; prompt instructions alone cannot make concurrent creation
  atomic.
- `waiting_human` and `blocked` stop automatic retries. Resume only after the
  recorded cause has been resolved.
- A stale approval, stale evidence, or changed tree follows the normal codeflow
  flow. Team urgency is not a freshness exception.
- Team cancellation is a request to the human, not permission to run `abandon`.
- If the team plugin cannot persist bindings or enforce one writer, describe the
  integration as best-effort and do not claim hard isolation or exactly-once
  execution.
