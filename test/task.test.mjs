import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../src/util.mjs";
import { defaultConfig } from "../src/config.mjs";
import { planApprovalHash, planPath } from "../src/plan.mjs";
import { findRepo } from "../src/repo.mjs";
import {
  ensureState,
  readActive,
  readTask,
  statePaths,
  taskFile,
  writeTask,
} from "../src/state.mjs";
import {
  approvalState,
  approveTask,
  createTask,
  durableUpdates,
  hashFile,
  missingTaskSections,
} from "../src/task.mjs";
import { cleanup, tempRepo } from "./helpers.mjs";

const SPEC = [
  "# Fix login",
  "",
  "## Request",
  "Stop the redirect loop.",
  "",
  "## Product",
  "A user lands on the dashboard after login.",
  "",
  "## Design",
  "Guard the redirect when the token is already present.",
  "",
  "## Durable updates",
  "Not durable — test fixture.",
  "",
].join("\n");

const PLAN = (taskId) => ({
  schemaVersion: 1,
  taskId,
  steps: [
    {
      id: "1",
      title: "Add the redirect guard",
      status: "pending",
      commitSubject: "fix(auth): add the redirect guard",
      verification: "`npm test` → pass",
      summary: "",
      note: "",
    },
  ],
});

function setup(t) {
  const dir = tempRepo();
  t.after(() => cleanup(dir));
  const repo = findRepo(dir);
  const config = defaultConfig(repo);
  const paths = statePaths(dir, config);
  ensureState(paths);
  const task = createTask(paths, repo, config, {
    title: "Fix login",
    kind: "code",
    issues: ["#123"],
  });
  return { dir, repo, config, paths, task };
}

test("createTask writes the task, spec, active pointer, and event log", (t) => {
  const { dir, paths, task } = setup(t);

  assert.equal(task.status, "created");
  assert.equal(task.kind, "code");
  assert.match(task.branch, /^codeflow\//);
  assert.ok(task.worktree.endsWith(task.id));
  assert.equal(readActive(paths).taskId, task.id);
  assert.equal(readTask(paths, task.id).title, "Fix login");
  assert.ok(readFileSync(taskFile(paths, task.id, "TASK.md"), "utf8").includes("# Fix login"));
  assert.ok(readFileSync(taskFile(paths, task.id, "events.jsonl"), "utf8").includes("task.created"));
  assert.ok(dir);
});

test("design approval refuses an unfilled template", (t) => {
  const { paths, task } = setup(t);

  assert.deepEqual(
    missingTaskSections(readFileSync(taskFile(paths, task.id, "TASK.md"), "utf8")),
    ["request", "product", "design"],
  );
  assert.throws(
    () => approveTask(paths, task, "design", { by: "Test <t@t>" }),
    (error) => error.code === "E_STATE_CONFLICT",
  );
});

test("a repeated heading appends instead of wiping its section", (t) => {
  const { paths, task } = setup(t);

  // A duplicated empty heading used to reset the section buffer, so a filled
  // Request looked empty and design approval refused a valid TASK.md.
  const duplicated = `${SPEC}\n## Request\n\n## Design\n`;
  writeFileSync(taskFile(paths, task.id, "TASK.md"), duplicated);

  assert.deepEqual(missingTaskSections(duplicated), []);
  assert.equal(durableUpdates(duplicated), "Not durable — test fixture.");
  assert.equal(
    approveTask(paths, task, "design", { by: "Test <t@t>" }).status,
    "designed",
  );
});

test("design approval is hash-bound and goes stale after an edit", (t) => {
  const { paths, task } = setup(t);
  writeFileSync(taskFile(paths, task.id, "TASK.md"), SPEC);

  const approved = approveTask(paths, task, "design", { by: "Test <t@t>" });
  assert.equal(approved.status, "designed");
  assert.equal(approved.approvals.design.hash, hashFile(taskFile(paths, task.id, "TASK.md")));
  assert.equal(approvalState(paths, approved).design.stale, false);

  writeFileSync(
    taskFile(paths, task.id, "TASK.md"),
    `${SPEC}\n## Deferrals\nNone.\n`,
  );
  assert.equal(approvalState(paths, approved).design.stale, true);
});

test("re-approving a revised plan keeps a started task active", (t) => {
  const { paths, task } = setup(t);
  writeFileSync(taskFile(paths, task.id, "TASK.md"), SPEC);
  approveTask(paths, task, "design", { by: "Test <t@t>" });
  writeJsonAtomic(planPath(paths, task.id), PLAN(task.id));
  assert.equal(
    approveTask(paths, task, "plan", { by: "Test <t@t>" }).status,
    "planned",
  );

  const started = readTask(paths, task.id);
  started.status = "active";
  writeTask(paths, started);

  const again = approveTask(paths, readTask(paths, task.id), "plan", {
    by: "Test <t@t>",
  });
  assert.equal(again.status, "active");
});

test("plan approval requires a fresh design approval and a valid plan", (t) => {
  const { paths, task } = setup(t);
  writeFileSync(taskFile(paths, task.id, "TASK.md"), SPEC);

  assert.throws(
    () => approveTask(paths, task, "plan", { by: "Test <t@t>" }),
    (error) => error.code === "E_STATE_CONFLICT",
  );

  approveTask(paths, task, "design", { by: "Test <t@t>" });
  writeFileSync(planPath(paths, task.id), `${JSON.stringify(PLAN(task.id), null, 2)}\n`);

  const planned = approveTask(paths, task, "plan", { by: "Test <t@t>" });
  assert.equal(planned.status, "planned");
  assert.equal(
    planned.approvals.plan.hash,
    planApprovalHash(PLAN(task.id)),
  );
  assert.equal(approvalState(paths, planned).plan.stale, false);

  const edited = PLAN(task.id);
  edited.steps.push({
    id: "2",
    title: "Add a regression test",
    status: "pending",
    commitSubject: "test(auth): cover the redirect guard",
    verification: "`npm test` → pass",
    summary: "",
    note: "",
  });
  writeFileSync(planPath(paths, task.id), `${JSON.stringify(edited, null, 2)}\n`);
  assert.equal(approvalState(paths, planned).plan.stale, true);
});
