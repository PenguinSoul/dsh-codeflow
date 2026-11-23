import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.mjs";
import { writeEvidence } from "../src/evidence.mjs";
import { planPath } from "../src/plan.mjs";
import { findRepo } from "../src/repo.mjs";
import {
  approveSelfReview,
  buildReviewPacket,
  readReview,
  selfReviewFresh,
} from "../src/selfreview.mjs";
import { ensureState, statePaths, taskFile } from "../src/state.mjs";
import { writeJsonAtomic } from "../src/util.mjs";
import { cleanup, git, tempRepo } from "./helpers.mjs";

function setup(t) {
  const dir = tempRepo();
  t.after(() => cleanup(dir));
  const repo = findRepo(dir);
  const config = defaultConfig(repo);
  const paths = statePaths(dir, config);
  ensureState(paths);
  const task = {
    schemaVersion: 1,
    id: "2026-10-26-self-review",
    title: "Fix login",
    status: "verified",
    approvals: { design: null, plan: null, selfReview: null },
  };
  const evidence = {
    schemaVersion: 1,
    taskId: task.id,
    result: "pass",
    dirty: false,
    gates: [
      {
        name: "test",
        tier: "fast",
        required: true,
        exitCode: 0,
        durationMs: 10,
        timedOut: false,
        flaky: false,
      },
    ],
    attention: {
      testFiles: [],
      skips: [],
      suppressions: [],
      configChanges: [],
      lockfileChanges: [],
      largeDiff: {
        files: 0,
        lines: 0,
        thresholdFiles: 25,
        thresholdLines: 1200,
      },
    },
  };
  writeEvidence(paths, task, evidence);
  const plan = {
    schemaVersion: 1,
    taskId: task.id,
    steps: [],
  };
  writeJsonAtomic(planPath(paths, task.id), plan);
  return { dir, repo, config, paths, task, evidence, plan };
}

test("buildReviewPacket writes the packet and approveSelfReview signs it", (t) => {
  const { dir, config, paths, task, evidence, plan } = setup(t);
  const review = buildReviewPacket({
    paths,
    task,
    cwd: dir,
    base: config.baseBranch,
    plan,
    evidence,
    notes: "Looks good",
    scopeDrift: ["renamed a helper"],
    closestLook: ["the redirect guard"],
  });

  assert.ok(readReview(paths, task.id));
  assert.equal(review.reviewedBy, null);
  assert.equal(
    selfReviewFresh(paths, task, { cwd: dir, base: config.baseBranch }).fresh,
    false,
  );

  const approved = approveSelfReview(paths, task, {
    cwd: dir,
    base: config.baseBranch,
    by: "Test <t@t>",
  });
  assert.equal(approved.review.reviewedBy, "Test <t@t>");
  assert.ok(approved.task.approvals.selfReview.hash.startsWith("sha256:"));
  assert.equal(
    selfReviewFresh(paths, task, { cwd: dir, base: config.baseBranch }).fresh,
    true,
  );
});

test("the review packet names the zero-gate case", (t) => {
  const { dir, config, paths, task, evidence, plan } = setup(t);
  writeEvidence(paths, task, { ...evidence, gates: [] });
  buildReviewPacket({
    paths,
    task,
    cwd: dir,
    base: config.baseBranch,
    plan,
    evidence: { ...evidence, gates: [] },
  });

  const packet = readFileSync(
    taskFile(paths, task.id, "REVIEW.md"),
    "utf8",
  );
  assert.match(packet, /\| _\(none\)_ \| — \| no gates ran \| — \|/);
});

test("editing an approved review packet invalidates the sign-off", (t) => {
  const { dir, config, paths, task, evidence, plan } = setup(t);
  buildReviewPacket({
    paths,
    task,
    cwd: dir,
    base: config.baseBranch,
    plan,
    evidence,
  });
  approveSelfReview(paths, task, {
    cwd: dir,
    base: config.baseBranch,
    by: "Test <t@t>",
  });

  const review = readReview(paths, task.id);
  review.notes = "changed after approval";
  writeFileSync(
    taskFile(paths, task.id, "review.json"),
    `${JSON.stringify(review, null, 2)}\n`,
  );

  const fresh = selfReviewFresh(paths, task, {
    cwd: dir,
    base: config.baseBranch,
  });
  assert.equal(fresh.fresh, false);
  assert.equal(fresh.reason, "review changed");
});

test("a changed diff invalidates the self-review", (t) => {
  const { dir, config, paths, task, evidence, plan } = setup(t);
  git(dir, ["switch", "-c", "codeflow/test"]);
  buildReviewPacket({
    paths,
    task,
    cwd: dir,
    base: config.baseBranch,
    plan,
    evidence,
  });
  approveSelfReview(paths, task, {
    cwd: dir,
    base: config.baseBranch,
    by: "Test <t@t>",
  });

  writeFileSync(join(dir, "README.md"), "# changed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "change"]);

  assert.equal(
    selfReviewFresh(paths, task, { cwd: dir, base: config.baseBranch }).fresh,
    false,
  );
  assert.throws(
    () =>
      approveSelfReview(paths, task, {
        cwd: dir,
        base: config.baseBranch,
        by: "Test <t@t>",
      }),
    (error) => error.code === "E_APPROVAL_STALE",
  );
  assert.ok(taskFile(paths, task.id, "REVIEW.md"));
});
