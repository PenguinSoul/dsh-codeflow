# codeflow design docs

Status: **implemented; design record**. The review gates below remain the
approval checklist for the current design.

| Document | What it answers |
| --- | --- |
| [`goal-and-requirements.md`](goal-and-requirements.md) | What codeflow is, who it serves, the human boundary, non-goals, success metrics, failure modes |
| [`architecture.md`](architecture.md) | Topology, ownership, module map, numbered decisions, invariants, state machine, trust, evidence, safety, testing |
| [`contracts.md`](contracts.md) | The JSON wire: envelope, exit codes, errors, and every artifact schema |
| [`DESIGN.md`](DESIGN.md) | The readable integrated design: flow, commands, artifacts, plugin surface, implementation order |
| [`agent-team.md`](agent-team.md) | Optional prompt protocol for external agent-team orchestrators; no second scheduler or state owner |

## Reading order

1. `goal-and-requirements.md` — confirm the product boundary.
2. `architecture.md` — confirm the decisions and invariants.
3. `contracts.md` — confirm the CLI surface and schemas.
4. `DESIGN.md` — confirm the whole design and the implementation order.

## Review gates

Implementation starts only after these are accepted:

- [ ] Goal, audience, and non-goals.
- [ ] Human boundary and human gates.
- [ ] Trust model (explicit, config-hash-bound).
- [ ] Evidence freshness (tree-based, rebase-safe).
- [ ] Command surface and JSON contracts.
- [ ] Artifact layout and state machine.
- [ ] Plugin shell (commands, skill, `bin/`).
- [ ] Implementation order.

## Design principles in one line

Humans decide; the CLI executes; the agent supplies judgement; evidence is the only proof;
the base branch is never touched; nothing merges without a human.
