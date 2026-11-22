---
description: Review and approve the gate commands
---

Run `"${CODEFLOW_ROOT}/bin/codeflow" trust --json` first. It prints every command and the config hash
without recording trust.

Show the commands to the human and ask for explicit approval. Only after the
human says yes, run `"${CODEFLOW_ROOT}/bin/codeflow" trust --yes --json`. Never run `--yes` unprompted.
If a task branch changes `.codeflow/config.json`, approve that config separately;
state and trust stay in the project root, and tracked state is refused.
