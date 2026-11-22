import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readSkill } from "../dsh/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const installed = readSkill();
const protocol = readFileSync(join(root, "docs/agent-team.md"), "utf8");
const prose = protocol.replace(/\s+/gu, " ");

test("the DSH skill points team agents at the packaged protocol", () => {
  assert.match(installed.content, /Agent teams \(optional\)/u);
  assert.ok(
    installed.content.includes(`${root.replace(/[\\/]+$/u, "")}/docs/agent-team.md`),
  );
  assert.match(installed.content, /never overrides the human boundary/u);
});

test("the team protocol has one versioned task and result convention", () => {
  const occurrences = protocol.match(/codeflow-agent-team\/v1/gu) ?? [];
  assert.ok(occurrences.length >= 3);
  for (const field of [
    "externalRef",
    "codeflowTask",
    "dependsOn",
    "nextActor",
    "worktree",
    "evidence",
    "error",
  ]) {
    assert.ok(protocol.includes(`\"${field}\"`), `missing envelope field ${field}`);
  }
  assert.equal(protocol.includes("${CODEFLOW_ROOT}"), false);
});

test("every codeflow task status has an external projection", () => {
  for (const status of [
    "created",
    "designed",
    "planned",
    "active",
    "verified",
    "pr_open",
    "merged",
    "done",
    "blocked",
    "abandoned",
  ]) {
    assert.ok(protocol.includes(`\`${status}\``), `unmapped status ${status}`);
  }
  assert.match(protocol, /Only `completed` satisfies a downstream dependency/u);
  assert.match(protocol, /`pr_open` is not a completed task|a PR is not a completed task/u);
});

test("team prompts preserve ownership, recovery, and the human boundary", () => {
  assert.match(protocol, /at most one active\s+writer/u);
  assert.match(protocol, /A retry or worker replacement resumes the same/u);
  assert.match(protocol, /waiting_human and blocked/u);
  assert.match(protocol, /Do not automatically retry, reassign, trust, approve, or merge/u);
  assert.match(protocol, /Never create a replacement task for a retry/u);
  assert.match(prose, /Never claim evidence or merge from memory/u);
  assert.match(protocol, /Team cancellation is a request to the human/u);
  assert.match(protocol, /not a security boundary or an exactly-once/u);
});

test("the protocol leaves orchestration and shared resources to the host", () => {
  assert.match(protocol, /not a new codeflow CLI schema/u);
  assert.match(protocol, /Do not write[\s\S]*?into `\.codeflow\/state\/`/u);
  assert.match(protocol, /Resource locking outside git/u);
  assert.match(protocol, /remains your responsibility/u);
  assert.match(protocol, /best-effort/u);
});
