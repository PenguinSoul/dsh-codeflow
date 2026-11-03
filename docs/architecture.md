---
id: architecture
type: architecture-design
status: draft
title: codeflow — top-level architecture
parent: goal-and-requirements
covers: topology ownership modules decisions invariants state-machine trust evidence contracts errors concurrency versioning security testing
tags: [architecture, l1, workflow]
---

# codeflow — top-level architecture

## Drivers

- A Claude Code plugin must be installable as one unit and must not require a build
  step or a package install.
- The deterministic mechanics must be usable without Claude: a human can run the same
  CLI by hand, and CI can run it later.
- The system must survive reloads, multiple sessions, rebases, and upgrades without
  losing state or inventing results.
- Safety comes from explicit trust and human gates, not from trusting the model.
- The first platform is WSL/Linux; the code stays portable Node.

## Topology

```
Claude Code
  ├─ commands/*.md          thin UX; call the CLI and read its JSON
  ├─ skills/codeflow/       policy: human boundary, human gates, red lines
  └─ hooks/session-start    inject the active task summary
            │
            ▼
       bin/codeflow         deterministic CLI (Node ESM, no deps)
            │
      ┌─────┼──────────────┬────────────────┐
      ▼     ▼              ▼                ▼
    git   gh (optional)  .codeflow/      XDG worktrees
                         config+state    per task
```

DSH reaches the same core through a different door: `dsh/` is a bundle plugin
(`package.json` → `dsh.bundle.patch`) whose adapter registers the skill and the
commands with `ctx.skills.register()` and `ctx.commands.register()`. It reads the
same `skills/codeflow/SKILL.md` and `commands/*.md`, so the workflow has one
source, not two.

Three rings:

1. **Core** — the CLI modules. They own state, isolation, gates, evidence, and
   delivery. They never call an LLM.
2. **Contract** — the versioned JSON envelope and schemas in `docs/contracts.md`.
   Commands and tests consume this; human output is only a renderer of it.
3. **Shell** — Claude commands, the skill, the session hook, and the DSH adapter.
   They hold no state of their own and never recompute what the CLI reports.

There is no MCP server, no daemon, and no database.

## Ownership

| State | Owner | Location | Notes |
| --- | --- | --- | --- |
| Repository config | Repository (committed) | `.codeflow/config.json` | Shared by the team |
| Trust grant | Local state | `.codeflow/state/trust.json` | Bound to config hash |
| Active task pointer | Local state | `.codeflow/state/active.json` | Convenience only |
| Task artifacts | Local state | `.codeflow/state/tasks/<id>/` | Gitignored via `.git/info/exclude` |
| Worktree | Local state | `~/.local/state/codeflow/worktrees/<repo>/<id>` | Configurable |
| Branch / HEAD / index | Git | Worktree | Never base branch |
| PR / checks / comments | GitHub (read-through) | `pr.json`, `comments.json` | Cached with `lastReadAt`; never authority |
| Approvals | Human | `task.json` + `events.jsonl` | Hash-bound |
| Merge | Human | GitHub | codeflow never performs it |

## Module map

All modules are ESM under `src/`. `bin/codeflow` is a thin executable that imports
`src/cli.mjs`.

| Module | Responsibility | Allowed dependencies |
| --- | --- | --- |
| `cli.mjs` | Parse argv, dispatch, envelope, exit codes | all feature modules |
| `contracts.mjs` | Schema versions, validators, error codes | none |
| `util.mjs` | fs/json/spawn/time/strings | none |
| `repo.mjs` | Git root, common dir, base/remote, exclude file | `util`, `git` |
| `config.mjs` | Load, validate, detect, write config | `util`, `contracts` |
| `trust.mjs` | Trust grant/verify, command display | `config`, `util`, `contracts` |
| `state.mjs` | Task store, active pointer, locks, atomic writes, events | `util`, `contracts` |
| `task.mjs` | Create, approve, amend task-spec; hashes | `state`, `config`, `util`, `contracts` |
| `plan.mjs` | Plan schema, validation, render, step status | `task`, `util`, `contracts` |
| `git.mjs` | Worktree, branch, rebase, clean, diffstat, tree hash | `util` |
| `gates.mjs` | Gate selection, execution, timeouts, logs | `config`, `trust`, `util`, `contracts` |
| `attention.mjs` | Diff scan for risk and change kind | `git`, `util`, `contracts` |
| `evidence.mjs` | Build and validate evidence freshness | `git`, `config`, `gates`, `attention`, `util`, `contracts` |
| `selfreview.mjs` | Review packet and sign-off | `git`, `evidence`, `attention`, `plan`, `util`, `contracts` |
| `prbody.mjs` | Template parsing and body rendering | `task`, `plan`, `evidence`, `attention`, `util`, `contracts` |
| `github.mjs` | `gh` detection, PR create/update, checks, comments | `util`, `contracts` |
| `render.mjs` | Human-readable output; side-effect free | `contracts` |
| `doctor.mjs` | Environment and state diagnostics | `repo`, `config`, `trust`, `github`, `util`, `contracts` |

Rules:

- No feature module imports `cli.mjs`.
- `git.mjs` is the only module that executes `git`. `repo.mjs` may call it.
- `github.mjs` is the only module that executes `gh`.
- `render.mjs` has no side effects and never writes state.
- `contracts.mjs` has no imports from feature modules.
- Tests import modules directly; they do not go through `cli.mjs` unless testing the
  contract.

## Decisions

### D1 — The CLI is the only state owner

State transitions, evidence, approvals, and task metadata live in the CLI's task
store. Claude commands and the skill read `codeflow status --json`; they never edit
state files or infer state from chat.

**Why:** a reload, a second session, or a different machine must reconstruct the same
truth. Chat is not durable.

**Rejected:** storing state in the conversation or in a hidden agent scratchpad;
letting commands write JSON directly.

### D2 — Zero-dependency Node ESM, no build step

`bin/codeflow` is plain ESM run by Node. No TypeScript build, no bundler, no runtime
dependency. Tests use `node:test`.

**Why:** the plugin must work immediately after install; a build step is a failure
point and a supply-chain surface.

**Rejected:** TypeScript plus `tsc`/`tsx`; Bun; a bundled binary.

### D3 — No MCP in the first build

The plugin integrates through commands that invoke the bundled CLI, not through an
MCP server.

**Why:** the CLI is already a stable tool boundary; MCP adds lifecycle, schema, and
transport work without changing the workflow behavior.

**Rejected:** MCP-first design; a hybrid CLI plus MCP from day one. Revisit only when
Claude Desktop or non-Claude-Code clients become a requirement.

### D4 — Human gates; no merge

Trust, design approval, plan approval, self-review, and merge are human. The CLI
exposes no merge command and the skill forbids `gh pr merge`.

**Why:** The human-gated model means the machine executes, not decides. Merge is the irreversible point.

**Rejected:** auto-merge for low-risk paths; a `--merge` escape hatch.

### D5 — Trust is explicit and config-hash-bound

`init` writes configuration; `trust` displays every gate command and records approval
of the exact config hash. Approvals are kept per config hash so a project config and a
task-branch config can both be reviewed without losing history. `verify` refuses to run
when no approval exists for the config under test. State and trust live in the project
root, and any tracked `.codeflow/state` file is refused: a cloned repository must not be
able to supply its own trust or evidence.

**Why:** a cloned repository's config is untrusted input. Running its commands without
approval is remote code execution.

**Rejected:** trusting any committed config automatically; trusting by file path or
repository origin alone; storing commands outside the visible config.

### D6 — Evidence is the only proof; freshness is tree-based

Evidence records command, exit code, duration, logs, tree hash, config hash, gate-set
hash, and dirty state. A PR requires passing, fresh evidence and a clean tree.

Commit IDs alone do not invalidate evidence; tree content does. A rebase that leaves
the tree identical may reuse evidence; a content change requires re-verification.

**Why:** the final tree is what ships. Rebases are routine and must not force
unnecessary reruns or, worse, allow stale evidence after a content change.

**Rejected:** commit-hash freshness; trusting the agent's "tests pass" message;
rerunning everything on every rebase.

### D7 — Every command has a versioned JSON contract

`--json` returns a stable envelope and command-specific data. Human output is a
renderer. Commands and tests never parse prose.

**Why:** the plugin shell must be replaceable and testable; prose parsing is the
fragile seam that breaks on a log line.

**Rejected:** scraping human output; a separate RPC protocol.

### D8 — One project root, one task tree

A repository has a **project root** (the primary worktree) and any number of **task
trees** (linked worktrees). The project root owns `.codeflow/state` and trust, and
resolves them regardless of the current directory. A task tree owns the config, diff,
gates, and evidence under test. `verify`, `pr`, `self-review`, `status`, `watch`, and
`comments` read the task tree's config; `start` requires `.codeflow/config.json` to be
committed on the base branch.

**Why:** state is a property of the project, while the config and evidence are
properties of the tree that will ship. Putting state in each worktree splits the task
across checkouts; reading config only from the project root verifies the wrong gates.

**Rejected:** state per worktree (split brain); config from the project root (stale
gate set); worktrees inside the repository (recursive scan and editor noise).

### D9 — Multiple tasks; locks on every write

Any number of tasks may exist. Each task has its own worktree, branch, and lock. The
`active.json` pointer is only the default for commands that omit `--task`.

Every command that mutates task state holds the task lock for the operation:
`plan`, `plan step`, `approve`, `verify`, `self-review`, `pr`, `start`, `resume`, and
`finish`. `new` and `trust` hold a project-state lock so task ids, the active pointer,
and trust approvals cannot race. `watch` and `comments` hold the task lock only around
their state write, not while polling or fetching.

**Why:** worktrees exist to run work in parallel; a repo-wide single-task rule would
throw that away. Locks keep parallel sessions from clobbering evidence, PR state, or
each other's plan.

**Rejected:** one active task per repository; a global lock around all work; locking
only the git operations.

### D10 — The task-spec is temporary; durable knowledge is amended before the PR

`TASK.md` lives in the task's local state. Before `pr`, the task must record which
durable specs, README sections, or ADRs were updated, or explicitly mark the change as
not durable. `pr` refuses without a non-empty `## Durable updates` record. The PR body
carries that record in a `## Durable updates` section.

**Why:** otherwise the process looks disciplined while the repository learns nothing;
the next task re-derives the same decisions.

**Rejected:** treating `TASK.md` as a durable spec; copying the task-spec into the
repository; a spec graph requirement for every repository.

### D11 — The attention scan is a spotlight, not a verdict

`verify` scans the diff for test weakening, skipped tests, suppressions, config and
lockfile changes, and large diffs. It records findings and surfaces them in the
self-review packet. Scope drift and closest-look areas are recorded from explicit
self-review flags, because intent cannot be inferred from paths alone. The scan does
not silently fail the build or silently pass.

**Why:** an agent can satisfy a gate by weakening the evidence. A human needs the
spotlight; an automatic verdict would be both overconfident and easy to game.

**Rejected:** trusting the gate exit code alone; hard-failing on every test-file change;
an LLM judge as the pass/fail authority.

### D12 — Approvals are hash-bound

Design approval records a hash of `TASK.md`; plan approval records a hash over the
immutable fields of `plan.json` (step id, title, commit subject, and verification);
self-review approval records the hash of the approved review packet plus the diff and
evidence hashes. Editing an approved artifact invalidates the approval and blocks
`start` or `pr`. Step progress (status, summary, note) is mutable and does not
invalidate the plan approval.

**Why:** approval of an old version is not approval of what will ship, but recording
that a step finished is not a new plan.

**Rejected:** a boolean `approved` flag; approval by chat message; freezing progress
into the approved artifact.

### D13 — Gate tiers and change kinds

Each gate declares a tier (`fast`, `full`, `live`), the change kinds it applies to,
whether it is required, and a timeout. `verify` defaults to `fast` for the task's kind;
`--full` adds full gates; `--live` requires an explicit `--allow-live`.

**Why:** a typo should not run a live agent suite, and a real agent change should not
silently skip it.

**Rejected:** one flat gate list; always running everything; letting the agent choose
gates ad hoc.

### D14 — Fail closed; blocked state; no automatic conflict resolution

Ambiguous state, rebase conflicts, missing `gh` auth, lock contention, and repeated
gate failures move the task to `blocked` with a reason and a resume path. Conflicts
are never resolved by guessing.

A recorded PR is re-read from `gh` before cleanup, even when the local status says
`merged`; the status only counts when no observation is possible. Delivery
artifacts are created by `pr`, never out of band.

**Why:** an automated guess at a conflict is exactly the kind of change a human must
review.

**Rejected:** auto-resolving conflicts; infinite retry loops; silently skipping a
failed gate.

### D15 — `gh` is the only GitHub integration

PR creation, checks, and comments go through the user's authenticated `gh`. No tokens
are stored. When `gh` is missing, codeflow pushes the branch and prints a compare URL
plus the rendered body. An installed but unauthenticated `gh` fails closed with
`E_GH_AUTH`; it does not silently switch modes. If a PR is recorded and `gh` cannot read
it (auth or network failure), delivery and `finish` also fail closed; they do not
pretend merge detection is unavailable.

**Why:** no token storage, no OAuth app, and the user's existing permissions apply.

**Rejected:** the GitHub REST API with a stored token; a GitHub App; a custom OAuth
flow.

### D16 — Append-only events with a hash chain

Each task writes `events.jsonl`: every transition, approval, verification, PR action,
and block. Each event carries the previous event hash and its own hash.

**Why:** the review trail must be reconstructable and tamper-evident enough to notice
accidental edits.

**Rejected:** only the latest state; mutable logs.

### D17 — Schema versioning; migrations land with a version bump

Config, task, plan, evidence, review, PR, trust, active, and event artifacts carry
`schemaVersion`. Any unsupported version is a hard error (`E_SCHEMA_UNSUPPORTED`).
Only `schemaVersion: 1` exists today; a migration for an older version must land with
the first compatibility need, as a pure function with fixtures rather than a
best-effort read. `doctor` reports the versions it finds.

**Why:** the CLI will be upgraded while tasks are in flight.

**Rejected:** implicit migrations; reading unknown shapes best-effort.

### D18 — The CLI is the integration surface; commands invoke it from the plugin root

Claude Code does not put a plugin's `bin/` on the Bash tool's `PATH` (tested on
2.1.278: `command -v codeflow` finds nothing, and `CLAUDE_PLUGIN_ROOT` is not in the
session environment). Commands therefore invoke
`"${CLAUDE_PLUGIN_ROOT}/bin/codeflow" <verb>` and grant exactly that path with
`Bash(${CLAUDE_PLUGIN_ROOT}/bin/codeflow:*)`. Claude Code substitutes the variable in
command content, in skill content, and in `allowed-tools`; a probe plugin confirmed
all three.

**Why:** one implementation, testable without Claude, and commands stay thin.

**Rejected:** asking the human to export `PATH` (works only until the next shell, and
breaks under the versioned marketplace cache path); granting plain `Bash` and
calling the binary relatively (too broad for a tool that runs gates); a shim on
`PATH` (nothing installs it).

### D19 — PR template fidelity; tick only evidence-backed items

`pr` reads `.github/PULL_REQUEST_TEMPLATE.md`, preserves its sections and order, and
fills what it can from the task, plan, and evidence. A checklist item is ticked only
when evidence proves it. The body also carries a `Review attention` section with scope
drift, test changes, suppressions, and the closest-look areas.

**Why:** a fabricated checklist is worse than an empty one; reviewers need to see the
risks, not just the diff.

**Rejected:** a generic Summary/Changes/Testing body for every repository; auto-ticking
every box; hiding test changes.

### D20 — Tests never touch the network or a real GitHub

Unit and integration tests use temporary repositories, fake gates, and a fake `gh` on
`PATH`. `claude plugin validate` checks the plugin manifest. A real GitHub call is a
manual smoke test, never a CI dependency.

**Why:** deterministic, fast, and safe; a test suite that needs credentials is a test
suite that stops running.

**Rejected:** recorded HTTP cassettes as the primary test; live `gh` in CI.

### D21 — Delivery is bound to the task tree

`verify`, `self-review`, `approve self-review`, `pr`, `watch`, and `comments` refuse a
missing task worktree; they never fall back to the primary checkout. The worktree must
be on `task.branch`. Before a PR is recorded, the head returned by `gh` must equal the
verified local HEAD. `pr --no-push` writes `PR_BODY.md` and stops: it never pushes,
creates a PR, or marks the task delivered. Task IDs must match the documented pattern
before any path join, and the PR template must resolve inside the task worktree.

**Why:** evidence for one tree and a PR for another is not evidence. A fallback to the
base checkout can verify `main` and then push a stale task branch.

**Rejected:** best-effort worktree fallback; trusting the branch name without checking
the checkout; creating a PR without a matching head.

### D22 — DSH gets an adapter, not a fork

DeepSeek Harness loads a bundle through `package.json`'s `dsh.bundle.patch`.
`dsh/index.js` reads the same `skills/codeflow/SKILL.md` and `commands/*.md` that
Claude Code loads, registers the skill with `ctx.skills.register()`, and registers
one `/codeflow-<verb>` command per file whose handler queues the adapted body with
`agent.followup()`. Only two Claude-only spellings are rewritten:
`${CLAUDE_PLUGIN_ROOT}` becomes the installed package root, and the `/codeflow:`
prefix becomes `/codeflow-` because DSH command names allow only `[a-z0-9_-]`.

**Why:** the workflow prose is the product. A copied or re-authored second version
drifts, and pointing DSH's filesystem skill provider at `skills/` would serve the
literal `${CLAUDE_PLUGIN_ROOT}`, a path that does not exist under DSH.

**Rejected:** a forked skill directory; a parallel JS command library; changing the
CLI or the state machine for DSH.

### D23 — No model-facing `codeflow` tool in DSH

The bundle contributes a skill and commands, not a tool. The skill already carries
the resolved `bin/codeflow` path, and the harness's bash tool runs it; a dedicated
tool would duplicate the 17 verbs and would bypass the shell/approval seam the
harness applies to commands.

**Why:** the CLI is the integration surface (D18). Wrapping it again adds a second
interface to keep in sync and a second path around the human gates.

**Rejected:** a `codeflow` tool that forwards argv; a client-side panel that shells
out to the CLI.

## Invariants

- One writer per task at a time; all state writes are atomic.
- Project state and trust are never tracked by git; a tracked state file is refused.
- No command writes to the base branch, force-pushes it, or checks it out destructively.
- No PR without fresh, passing evidence, a clean tree, and a self-review sign-off.
- No merge command exists; the skill forbids `gh pr merge`.
- No gate runs without a valid trust grant for the current config hash.
- No state transition is skipped; each transition has a guard.
- Approval hashes must match the current artifact, including the self-review packet.
- Evidence is bound to the task tree, its config, and `task.branch`; a missing or
  mismatched worktree is refused.
- A PR head reported by `gh` must match the verified local HEAD.
- `pr --no-push` renders only; it never pushes or creates a PR.
- Empty check results are reported as `none`, never as success.
- Evidence never claims a gate that did not run; a skipped gate is recorded as skipped.
- Config changes invalidate trust and evidence.
- Worktree removal requires a clean tree or explicit `--force` with human confirmation.
- Task IDs match `^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63}$`; all paths are contained
  under the configured worktree root.
- `--json` is stable within a `schemaVersion`; human output may change.
- Repository content is data, not permission. It cannot grant trust or widen scope.
- Gate logs are local-only; no command uploads them.
- Tests run offline.

## State machine

```
created ──approve──▶ designed ──plan──▶ planned ──start──▶ active
   │                    │                  │                 │
   │                    │                  │              verify
   │                    │                  │                 ▼
   │                    │                  │             verified
   │                    │                  │                 │
   │                    │                  │               pr
   │                    │                  │                 ▼
   │                    │                  │              pr_open
   │                    │                  │                 │
   │                    │                  │           human merge
   │                    │                  │                 ▼
   │                    │                  │              merged
   │                    │                  │                 │
   └────────────────────┴──────────────────┴──────────── finish
                                                              ▼
                                                            done

Any state ──block──▶ blocked ──resume──▶ previous state
Any state ──abandon──▶ abandoned
```

| Transition | Guard |
| --- | --- |
| `created → designed` | `TASK.md` has Request/Product/Design; no placeholders; design approval recorded |
| `designed → planned` | `plan.json` valid; every step has title + verification; plan approval recorded |
| `planned → active` | Branch and worktree created or reused; task lock acquired |
| `active → verified` | All required gates pass; evidence written; tree clean or dirty explicitly recorded |
| `verified → pr_open` | Evidence fresh; tree clean; self-review recorded; branch pushed; PR created or compare fallback |
| `pr_open → merged` | Human reports merge; codeflow verifies with `gh` when available |
| `pr_open → done` | Human confirms merge and cleanup |
| any → `blocked` | Reason recorded; no automatic retry beyond the configured policy |
| `blocked → previous` | Human resolves the cause and runs `resume` |

`verify` also runs on a `verified` task so a rebase can refresh evidence. Re-verification
runs the same gates; it never bypasses one.

## Trust model

`trust.json`:

```json
{
  "schemaVersion": 1,
  "configHash": "sha256:...",
  "approvedBy": "name <email>",
  "approvedAt": "2026-10-26T10:00:00Z",
  "commands": [
    { "name": "lint", "command": "npm run lint", "cwd": "." }
  ]
}
```

Flow:

1. `init` writes config and prints the commands. It never executes them.
2. `trust` recomputes the normalized config hash, shows every command and its cwd, and
   asks for explicit confirmation (`--yes` for scripted use).
3. `verify` refuses when `trust.json` is missing, when the hash differs, or when a
   command has changed.
4. `doctor` reports trust status and the exact reason for a mismatch.
5. `--dry-run` prints the commands that would run, without running them.

Trust covers commands, their cwd, and the config hash. It does not cover repository
hooks or arbitrary commands the agent invents; the skill forbids those.

## Evidence model

`evidence.json` records:

- `treeHash` — `git rev-parse HEAD^{tree}` for the verified tree.
- `commit` and `branch` — provenance, not the freshness key.
- `dirty` — whether the working tree had uncommitted changes.
- `configHash` and `gateSetHash` — what was approved and what ran.
- `result` — `pass`, `fail`, or `blocked`.
- Each gate: name, command, tier, required, exit code, duration, timeout flag, log path,
  tail.
- `attention` — test files changed, suppressions, config/lockfile changes, large diff,
  scope drift.
- Environment: Node version, platform, start/finish timestamps.

Freshness for `pr`:

- `result === "pass"`.
- `dirty === false`.
- `treeHash === git rev-parse HEAD^{tree}`.
- `configHash` and `gateSetHash` match the current config and selected gates.
- No required gate is missing.

Rebase rule: a rebase may change the commit ID; if the tree hash is unchanged, the
evidence remains valid. If the tree hash changes, re-verify.

Retry rule: a failed gate may be retried once by `verify --retry`; the evidence records
the retry and marks a test that only passes on retry as flaky. No infinite loops.

## Operational flows

### Repo detection (`init`)

- Repository root: `git rev-parse --show-toplevel`; the common git dir is used for
  shared refs and worktree resolution.
- Base branch: `refs/remotes/<remote>/HEAD` when present, else the current branch,
  else `main` or `master`.
- Remote: `origin` when present, else the first remote; fail with `E_NOT_REPO` when
  there is no remote and no base branch can be resolved.
- State directory: `.codeflow/state`; add it to `.git/info/exclude` when absent.
- Package manager: lockfile precedence `bun.lock` → `pnpm-lock.yaml` → `yarn.lock` →
  `package-lock.json`; none means no Node gate proposals.

### Gate detection (`init`)

`init` reads marker files and proposes gates; it never executes them.

| Marker | Candidate gates |
| --- | --- |
| `package.json` | `lint`, `typecheck`, `test`, `e2e` scripts; package manager from the lockfile |
| `pyproject.toml` | `ruff check .`, `mypy .`, `pytest` when configured |
| `go.mod` | `go vet ./...`, `go test ./...` |
| `Cargo.toml` | `cargo clippy --all-targets -- -D warnings`, `cargo test` |

Rules:

- Propose only commands the repository already supports (a script, target, or tool
  config exists). Do not invent commands.
- Give every gate a tier, kinds, `required`, and timeout; the human edits the config.
- `init` prints the proposed commands and writes the config. `trust` is separate.
- If no marker matches, write an empty gate list and tell the human to edit it.
- Never run a gate during `init`, `trust`, or `doctor`.

### Change kind

`new --kind` overrides. Otherwise `verify` infers the kind from the diff:

- `docs`: only Markdown, docs, images, or license files.
- `test`: only test paths.
- `infra`: only CI, lockfiles, build scripts, or `.codeflow/config.json`.
- `mixed`: more than one of the above.
- `code`: the default.

If the inferred kind differs from the task kind, `verify` warns and uses the broader
gate set. It never silently narrows the gates.

### Attention rules

| Category | Patterns |
| --- | --- |
| Test files | `*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/` |
| Skips | `it.skip`, `describe.skip`, `test.skip`, `xit`, `xdescribe`, `pytest.mark.skip`, `t.Skip`, `#[ignore]` |
| Suppressions | `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`, `as any`, `# type: ignore`, `//nolint` |
| Config | `.codeflow/config.json`, CI workflow files, build scripts |
| Lockfiles | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `Cargo.lock`, `go.sum` |
| Large diff | Configured file and line thresholds |

`attention.failOn` can promote a category from warning to a required failure; the
default is warn.

### Self-review packet (`REVIEW.md`)

The packet contains:

1. Task title, kind, status, branch, and base.
2. Plan steps and their status.
3. A verification table from `evidence.json`: gate, command, tier, result, duration.
4. Attention items: test changes, skips, suppressions, config/lockfile changes, large
   diff.
5. Scope drift: files or behaviors touched beyond the approved task-spec.
6. Closest look: the areas that deserve the reviewer's attention first.
7. A sign-off block with `diffHash`, `evidenceHash`, reviewer, and time.

`codeflow approve self-review` writes `review.json`; `pr` refuses without it.

### PR body (`PR_BODY.md`)

- Read `.github/PULL_REQUEST_TEMPLATE.md`; preserve its sections and order.
- Map `Problem` ← the task-spec Request/Problem; `Approach` ← Design; `Changes` ←
  completed plan steps plus `git diff --stat`; `Screenshots` ← an explicit placeholder
  or a configured capture command; `Related issues` ← `task.issues`; `Checklist` ←
  evidence-backed items only.
- If the template has no review-attention section, append `## Review attention` with
  the attention, scope-drift, and closest-look content.
- Never tick a checklist item without evidence. Leave it unchecked and explain why.
- Write the body to `PR_BODY.md` and pass it with `gh pr create --body-file`.

### PR lifecycle

- `pr` is idempotent: exactly one open PR for `codeflow/<id>` is updated in place; none
  creates one; more than one is `E_PR_EXISTS`.
- Rebase onto the base branch before pushing; a conflict becomes `blocked` with
  `E_REBASE_CONFLICT`.
- Push only the task branch, using `--force-with-lease` when a rebase rewrote it.
- Record `headSha`, `lastReadAt`, and the check summary in `pr.json`.
- No merge, no auto-approval, and no review replies.

### Resume and finish

- `resume` requires a `blocked` task. It records the resolution, clears the block, and
  returns to the previous state. It does not rerun gates automatically.
- `finish` requires `merged`, or an explicit human `--confirm` when merge detection
  is unavailable. When `gh` and a GitHub PR are available, the live PR state wins:
  an open PR is refused even with `--confirm`. `--force` only bypasses a dirty
  worktree, never the merge check. It removes the worktree and optionally the
  branch, then marks the task done.
- `watch` defaults to a one-shot snapshot. `--wait` polls with an interval and
  timeout (`--timeout`, `--interval`); neither mode merges.

### `status --brief`

A single line for the `SessionStart` hook: task id, title, status, and next command.
Empty when there is no active task. The hook must never fail a session because codeflow
is not configured.

## Contracts

The wire is `docs/contracts.md`. Every command returns:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "ok": true,
  "data": {},
  "error": null,
  "warnings": [],
  "meta": {
    "generatedAt": "2026-10-26T10:00:00Z",
    "repoRoot": "/repo",
    "taskId": "2026-10-26-fix-login",
    "cliVersion": "0.1.0"
  }
}
```

Human output is a renderer over `data`. No command parses another command's prose.

## Error taxonomy

| Code | Exit | Meaning |
| --- | --- | --- |
| `E_USAGE` | 2 | Bad arguments or unknown command |
| `E_NOT_REPO` | 2 | Not inside a git repository |
| `E_CONFIG` | 2 | Missing or invalid config |
| `E_SCHEMA_UNSUPPORTED` | 2 | Artifact version newer than the CLI |
| `E_TRUST_REQUIRED` | 6 | No trust grant |
| `E_TRUST_STALE` | 6 | Config changed since trust |
| `E_STATE_CONFLICT` | 3 | Transition not allowed from the current state |
| `E_APPROVAL_STALE` | 3 | Approved artifact changed |
| `E_LOCKED` | 3 | Another process owns the task |
| `E_GATE_FAILED` | 1 | A required gate failed |
| `E_GATE_TIMEOUT` | 1 | A gate exceeded its timeout |
| `E_DIRTY_TREE` | 4 | Operation requires a clean tree |
| `E_REBASE_CONFLICT` | 4 | Rebase produced conflicts |
| `E_PUSH_FAILED` | 4 | The task branch could not be pushed |
| `E_GH_MISSING` | 5 | `gh` is not installed |
| `E_GH_AUTH` | 5 | `gh` is not authenticated |
| `E_PR_EXISTS` | 5 | PR already exists and cannot be updated as requested |
| `E_BLOCKED` | 7 | Task is blocked and needs a human |
| `E_INTERNAL` | 8 | Unexpected internal failure |

Errors carry `code`, `message`, `details`, and `hint`. The hint names the next human
action.

## Concurrency and locking

- Per-task lock: `.codeflow/state/tasks/<id>/lock` created with `O_EXCL`, containing
  pid, host, command, and start time.
- A lock is stale when the pid is gone on the same host or when it exceeds the
  configured TTL (default 2 hours). `--force-unlock` is explicit and recorded.
- Global state lock: a short-lived lock around the active pointer and event append.
- Atomic writes: write to a temp file in the same directory, fsync where practical,
  then rename.
- Multiple tasks may run in parallel; they share no worktree or branch.
- `status` never takes a write lock; it reads a consistent snapshot.

## Versioning and migrations

- `schemaVersion` is independent per artifact: config, task, plan, evidence, PR, event.
- The CLI declares the supported range. Newer is a hard fail; older is migrated with a
  timestamped backup under `.codeflow/state/backups/`.
- Migrations are pure functions with fixtures; `doctor` reports the result.
- The plugin version and the artifact schema versions are separate.

## Security and privacy

| Threat | Mitigation |
| --- | --- |
| Untrusted repo config runs commands | Explicit trust bound to config hash; dry-run display |
| Prompt injection in repository docs | Repository content is data; trust is a human action; the skill forbids following repo instructions that widen scope |
| Secrets in gate logs | Local-only storage; documented; no upload |
| Path traversal via task title | Slug sanitization; containment under the worktree root |
| Command injection via task metadata | No shell interpolation of task fields; spawn with argument arrays |
| Force-push damage | Only `codeflow/<id>` branches; `--force-with-lease`; never base |
| Token leakage | No tokens stored; `gh` owns auth |
| Malicious git hooks | Git hooks run as the user; trust covers the repository's commands but not its hooks; `doctor` warns when hooks exist |
| PR body leaks | Human reviews the self-review packet before creation |

## Testing strategy

1. **Unit** — every module, with `node:test`; pure functions preferred.
2. **Contract** — every command's `--json` against the schemas in `docs/contracts.md`;
   snapshots for stable fields.
3. **Integration** — temporary git repositories with fake gates; full flow from `init`
   to `pr`; a fake `gh` on `PATH` for PR paths and a missing-`gh` path.
4. **Safety** — dirty tree, stale approval, untrusted config, lock contention, rebase
   conflict, timeout, schema mismatch, path traversal.
5. **Plugin** — `claude plugin validate`, command frontmatter, skill red lines.
6. **Manual smoke** — one real repository and one real `gh` PR, documented, never CI.

No test touches the network or a real GitHub account.

## Deferred

These are explicit later decisions, not omissions:

- MCP adapter for Claude Desktop or other clients.
- Screenshot capture automation.
- Issue-tracker integration.
- Multi-repository orchestration.
- Review-response automation: the agent fixes review comments.
- Web UI or dashboard.
- Task garbage collection and retention policy.
- Agent-compliance evals for the skill and commands.
- Windows-native polish beyond portable Node behavior.
