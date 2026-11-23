import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { run } from "../src/cli.mjs";
import {
  acquireLock,
  releaseLock,
  statePaths,
} from "../src/state.mjs";
import { capture, cleanup, fakeGhEnv, tempRepo } from "./helpers.mjs";

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
  "Guard the redirect when the token is present.",
  "",
  "## Durable updates",
  "Not durable — test fixture.",
  "",
].join("\n");

const SPEC_NO_DURABLE = SPEC.replace(
  /\n## Durable updates\nNot durable — test fixture\.\n/,
  "\n",
);

async function invoke(args, cwd, env) {
  const out = capture();
  const err = capture();
  const code = await run(args, {
    cwd,
    env,
    stdout: out.stream,
    stderr: err.stream,
  });
  let json = null;
  try {
    json = JSON.parse(out.text());
  } catch {
    json = null;
  }
  return { code, out: out.text(), err: err.text(), json };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoWithRemote(t) {
  const bare = mkdtempSync(join(tmpdir(), "codeflow-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], {
    stdio: "ignore",
  });
  const dir = tempRepo({ remotes: { origin: bare } });
  git(dir, ["push", "-u", "origin", "main"]);
  t.after(() => {
    cleanup(dir);
    rmSync(bare, { recursive: true, force: true });
  });
  return { dir, bare };
}

async function setupPlanned(dir, t, options = {}) {
  const { kind = "code", durable = true, worktreeRoot: rootOption } = options;
  let worktreeRoot = rootOption;
  if (!worktreeRoot) {
    worktreeRoot = mkdtempSync(join(tmpdir(), "codeflow-lifecycle-wt-"));
    t.after(() => rmSync(worktreeRoot, { recursive: true, force: true }));
  }

  assert.equal((await invoke(["init", "--json"], dir)).code, 0);
  const configFile = join(dir, ".codeflow/config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.worktreeRoot = worktreeRoot;
  config.gates = [
    {
      name: "test",
      command: 'node -e "process.exit(0)"',
      cwd: ".",
      tier: "fast",
      kinds: ["code"],
      required: true,
      timeoutSec: 30,
    },
  ];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  git(dir, ["add", ".codeflow/config.json"]);
  git(dir, ["commit", "-m", "test: commit codeflow config"]);
  assert.equal((await invoke(["trust", "--yes", "--json"], dir)).code, 0);

  const created = await invoke(["new", "Fix login", "--kind", kind, "--json"], dir);
  assert.equal(created.code, 0);
  const taskId = created.json.data.taskId;
  writeFileSync(
    join(dir, created.json.data.taskSpecPath),
    durable ? SPEC : SPEC_NO_DURABLE,
  );
  assert.equal((await invoke(["approve", "design", "--json"], dir)).code, 0);

  assert.equal((await invoke(["plan", "--init", "--json"], dir)).code, 0);
  writeFileSync(
    join(dir, ".codeflow/state/tasks", taskId, "plan.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        taskId,
        steps: [
          {
            id: "1",
            title: "Do the work",
            status: "pending",
            commitSubject: "feat: do the work",
            verification: "`npm test` → pass",
            summary: "",
            note: "",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  assert.equal((await invoke(["approve", "plan", "--json"], dir)).code, 0);
  assert.equal((await invoke(["start", "--json"], dir)).code, 0);

  const taskFile = join(dir, ".codeflow/state/tasks", taskId, "task.json");
  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  return { taskId, task, taskFile, worktree: task.worktree };
}

async function verifyAndReview(dir) {
  const step = await invoke(
    [
      "plan",
      "step",
      "1",
      "--status",
      "done",
      "--summary",
      "Implemented and checked.",
      "--result",
      "`npm test` → pass",
      "--json",
    ],
    dir,
  );
  assert.equal(step.code, 0, step.err || step.out);
  const verified = await invoke(["verify", "--json"], dir);
  assert.equal(verified.code, 0, verified.err || verified.out);
  assert.equal((await invoke(["self-review", "--json"], dir)).code, 0);
  assert.equal((await invoke(["approve", "self-review", "--json"], dir)).code, 0);
}

async function deliver(dir, t, options) {
  const planned = await setupPlanned(dir, t);
  await verifyAndReview(dir);
  const env = fakeGhEnv(t, options);
  const pr = await invoke(["pr", "--json"], dir, env);
  assert.equal(pr.code, 0, pr.err || pr.out);
  return { ...planned, env, pr };
}

test("pr blocks with E_REBASE_CONFLICT when the base conflicts", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  writeFileSync(join(planned.worktree, "shared.txt"), "task\n");
  git(planned.worktree, ["add", "-A"]);
  git(planned.worktree, ["commit", "-m", "task change"]);
  await verifyAndReview(dir);

  writeFileSync(join(dir, "shared.txt"), "main\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base change"]);
  git(dir, ["push", "origin", "main"]);

  const pr = await invoke(["pr", "--json"], dir);
  assert.equal(pr.code, 4);
  assert.equal(pr.json.error.code, "E_REBASE_CONFLICT");
  assert.deepEqual(pr.json.error.details.conflicts, ["shared.txt"]);
  assert.equal(pr.json.error.details.taskStatus, "blocked");

  const task = JSON.parse(readFileSync(planned.taskFile, "utf8"));
  assert.equal(task.status, "blocked");
  assert.equal(task.blocked.code, "E_REBASE_CONFLICT");
  assert.equal(task.blocked.from, "verified");
  assert.equal(git(planned.worktree, ["status", "--porcelain"]), "");

  const resumed = await invoke(["resume", "--json"], dir);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.json.data.status, "verified");
});

test("pr rebases cleanly and refuses stale evidence until re-verified", async (t) => {
  const { dir, bare } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  writeFileSync(join(planned.worktree, "task.txt"), "task\n");
  git(planned.worktree, ["add", "-A"]);
  git(planned.worktree, ["commit", "-m", "task change"]);
  await verifyAndReview(dir);

  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base change"]);
  git(dir, ["push", "origin", "main"]);

  const first = await invoke(["pr", "--json"], dir);
  assert.equal(first.code, 3);
  assert.equal(first.json.error.code, "E_APPROVAL_STALE");
  assert.equal(first.json.error.details.rebased, true);
  assert.equal(readFileSync(join(planned.worktree, "base.txt"), "utf8"), "base\n");

  const taskAfter = JSON.parse(readFileSync(planned.taskFile, "utf8"));
  assert.equal(taskAfter.status, "verified");

  await verifyAndReview(dir);
  const env = fakeGhEnv(t, { checks: ["SUCCESS"] });
  const second = await invoke(["pr", "--json"], dir, env);
  assert.equal(second.code, 0, second.err || second.out);
  assert.equal(second.json.data.rebased, false);
  assert.equal(second.json.data.number, 7);

  const localHead = git(planned.worktree, ["rev-parse", "HEAD"]);
  const remoteHead = execFileSync(
    "git",
    ["--git-dir", bare, "rev-parse", planned.task.branch],
    { encoding: "utf8" },
  ).trim();
  assert.equal(remoteHead, localHead);
});

test("a failed push reports why it failed", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  writeFileSync(join(planned.worktree, "task.txt"), "task\n");
  git(planned.worktree, ["add", "-A"]);
  git(planned.worktree, ["commit", "-m", "task change"]);
  await verifyAndReview(dir);

  const hook = join(dir, ".git/hooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\necho 'pre-push refused the update' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  const env = fakeGhEnv(t, { checks: ["SUCCESS"] });
  const failed = await invoke(["pr", "--json"], dir, env);
  assert.equal(failed.code, 4, failed.err || failed.out);
  assert.equal(failed.json.error.code, "E_PUSH_FAILED");
  assert.equal(failed.json.error.details.timedOut, false);
  assert.match(failed.json.error.details.stderr, /pre-push refused the update/);

  const taskAfter = JSON.parse(readFileSync(planned.taskFile, "utf8"));
  assert.equal(taskAfter.status, "verified");
});

test("a rebase that cannot run is not reported as a conflict", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  writeFileSync(join(planned.worktree, "task.txt"), "task\n");
  git(planned.worktree, ["add", "-A"]);
  git(planned.worktree, ["commit", "-m", "task change"]);
  await verifyAndReview(dir);

  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base change"]);
  git(dir, ["push", "origin", "main"]);

  // A blocked pre-rebase hook fails the rebase without producing conflicts.
  const hook = join(dir, ".git/hooks/pre-rebase");
  writeFileSync(hook, "#!/bin/sh\necho 'hook blocked the rebase' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  const failed = await invoke(["pr", "--json"], dir);
  assert.equal(failed.code, 4, failed.err || failed.out);
  assert.equal(failed.json.error.code, "E_REBASE_FAILED");
  assert.equal(failed.json.error.details.reason, "failed");
  assert.match(failed.json.error.details.stderr, /hook blocked the rebase/);

  const taskAfter = JSON.parse(readFileSync(planned.taskFile, "utf8"));
  assert.equal(taskAfter.status, "verified");
  assert.equal(taskAfter.blocked, null);
  assert.equal(git(planned.worktree, ["status", "--porcelain"]), "");
});

test("finish trusts gh over --confirm and --force", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });

  const openEnv = fakeGhEnv(t, { prState: "OPEN", checks: ["SUCCESS"] });
  const forced = await invoke(["finish", "--force", "--json"], dir, openEnv);
  assert.equal(forced.code, 3);
  assert.equal(forced.json.error.code, "E_STATE_CONFLICT");
  assert.equal(forced.json.error.details.prState, "OPEN");
  assert.equal(existsSync(delivered.worktree), true);

  const confirmed = await invoke(
    ["finish", "--confirm", "--json"],
    dir,
    openEnv,
  );
  assert.equal(confirmed.code, 3);
  assert.equal(confirmed.json.error.code, "E_STATE_CONFLICT");

  const mergedEnv = fakeGhEnv(t, { prState: "MERGED", checks: ["SUCCESS"] });
  const finished = await invoke(["finish", "--json"], dir, mergedEnv);
  assert.equal(finished.code, 0, finished.err || finished.out);
  assert.equal(finished.json.data.mergeConfirmedBy, "gh");
  assert.equal(finished.json.data.activeCleared, true);
  assert.equal(existsSync(delivered.worktree), false);

  const activeFile = join(dir, ".codeflow/state/active.json");
  assert.equal(existsSync(activeFile), false);
  const status = await invoke(["status", "--json"], dir);
  assert.equal(status.code, 0, status.err || status.out);
  assert.equal(status.json.data.task, null);
  assert.deepEqual(status.json.data.next, ["new"]);
  const brief = await invoke(["status", "--brief"], dir);
  assert.equal(brief.out, "");
});

test("finish checks gh even when the task is marked merged", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });

  // Nothing writes "merged" yet; a future adoption path would. Prove the status
  // alone can never authorize deleting the worktree.
  const taskFile = join(
    dir,
    ".codeflow/state/tasks",
    delivered.taskId,
    "task.json",
  );
  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  task.status = "merged";
  writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`);

  const openEnv = fakeGhEnv(t, { prState: "OPEN", checks: ["SUCCESS"] });
  const refused = await invoke(["finish", "--json"], dir, openEnv);
  assert.equal(refused.code, 3);
  assert.equal(refused.json.error.code, "E_STATE_CONFLICT");
  assert.equal(refused.json.error.details.prState, "OPEN");
  assert.equal(existsSync(delivered.worktree), true);

  const mergedEnv = fakeGhEnv(t, { prState: "MERGED", checks: ["SUCCESS"] });
  const finished = await invoke(["finish", "--json"], dir, mergedEnv);
  assert.equal(finished.code, 0, finished.err || finished.out);
  assert.equal(finished.json.data.mergeConfirmedBy, "gh");
  assert.equal(existsSync(delivered.worktree), false);
});

test("finish keeps a pointer that already names another task", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });

  const otherId = "2026-11-02-a-newer-task";
  const activeFile = join(dir, ".codeflow/state/active.json");
  writeFileSync(
    activeFile,
    `${JSON.stringify({ schemaVersion: 1, taskId: otherId }, null, 2)}\n`,
  );

  const mergedEnv = fakeGhEnv(t, { prState: "MERGED", checks: ["SUCCESS"] });
  const finished = await invoke(
    ["finish", "--task", delivered.taskId, "--json"],
    dir,
    mergedEnv,
  );
  assert.equal(finished.code, 0, finished.err || finished.out);
  assert.equal(finished.json.data.activeCleared, false);

  const active = JSON.parse(readFileSync(activeFile, "utf8"));
  assert.equal(active.taskId, otherId);
});

test("abandon clears the active pointer", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);
  const activeFile = join(dir, ".codeflow/state/active.json");
  assert.equal(existsSync(activeFile), true);

  const abandoned = await invoke(
    ["abandon", "--confirm", "--force", "--json"],
    dir,
  );
  assert.equal(abandoned.code, 0, abandoned.err || abandoned.out);
  assert.equal(abandoned.json.data.activeCleared, true);
  assert.equal(existsSync(activeFile), false);

  const status = await invoke(["status", "--json"], dir);
  assert.equal(status.json.data.task, null);
  assert.deepEqual(status.json.data.next, ["new"]);
  // The archived task is still reachable by id.
  const archived = await invoke(
    ["status", "--task", planned.taskId, "--json"],
    dir,
  );
  assert.equal(archived.json.data.task.status, "abandoned");
});

test("finish keeps the PR state open when cleanup is refused", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });
  writeFileSync(join(delivered.worktree, "dirty.txt"), "dirty\n");

  const mergedEnv = fakeGhEnv(t, { prState: "MERGED", checks: ["SUCCESS"] });
  const refused = await invoke(["finish", "--json"], dir, mergedEnv);
  assert.equal(refused.code, 4);
  assert.equal(refused.json.error.code, "E_DIRTY_TREE");

  const prFile = join(
    dir,
    ".codeflow/state/tasks",
    delivered.taskId,
    "pr.json",
  );
  const pr = JSON.parse(readFileSync(prFile, "utf8"));
  assert.equal(pr.state, "open");
  assert.equal(existsSync(delivered.worktree), true);
});

test("the task workflow runs from the task worktree", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  const status = await invoke(["status", "--json"], planned.worktree);
  assert.equal(status.code, 0, status.err || status.out);
  assert.equal(status.json.data.task.id, planned.taskId);

  const verified = await invoke(["verify", "--json"], planned.worktree);
  assert.equal(verified.code, 0, verified.err || verified.out);
  assert.equal(verified.json.data.result, "pass");
});

test("a relative worktreeRoot resolves from the main repo, the worktree, and a subdirectory", async (t) => {
  const dir = tempRepo();
  t.after(() => cleanup(dir));
  const planned = await setupPlanned(dir, t, { worktreeRoot: ".worktrees" });
  assert.equal(isAbsolute(planned.worktree), false);

  const worktree = resolve(dir, planned.worktree);
  const nested = join(worktree, "nested", "src");
  mkdirSync(nested, { recursive: true });

  for (const cwd of [dir, worktree, nested]) {
    const verified = await invoke(["verify", "--json"], cwd);
    assert.equal(verified.code, 0, verified.err || verified.out);
    assert.equal(verified.json.data.result, "pass");
  }
});

test("verify refuses a missing task worktree", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);
  rmSync(planned.worktree, { recursive: true, force: true });

  const result = await invoke(["verify", "--json"], dir);
  assert.equal(result.code, 3);
  assert.equal(result.json.error.code, "E_WORKTREE_MISSING");
});

test("a task config change requires its own trust approval", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);

  const configFile = join(planned.worktree, ".codeflow/config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.gates[0].command = 'node -e "process.exit(1)"';
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  git(planned.worktree, ["add", ".codeflow/config.json"]);
  git(planned.worktree, ["commit", "-m", "test: change the gate command"]);

  const refused = await invoke(["verify", "--json"], dir);
  assert.equal(refused.code, 6);
  assert.equal(refused.json.error.code, "E_TRUST_STALE");

  const approved = await invoke(["trust", "--yes", "--json"], planned.worktree);
  assert.equal(approved.code, 0, approved.err || approved.out);

  const verified = await invoke(["verify", "--json"], dir);
  assert.equal(verified.code, 1);
  assert.equal(verified.json.data.result, "fail");
  assert.equal(verified.json.data.gates[0].exitCode, 1);
});

test("pr --no-push renders only and does not deliver", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);
  assert.equal((await invoke(["start", "--json"], dir)).code, 0);
  await verifyAndReview(dir);

  const rendered = await invoke(["pr", "--no-push", "--json"], dir);
  assert.equal(rendered.code, 0, rendered.err || rendered.out);
  assert.equal(rendered.json.data.rendered, true);
  assert.equal(rendered.json.data.pushed, false);
  assert.equal(
    existsSync(
      join(dir, ".codeflow/state/tasks", planned.taskId, "pr.json"),
    ),
    false,
  );

  const task = JSON.parse(readFileSync(planned.taskFile, "utf8"));
  assert.equal(task.status, "verified");
});

test("finish refuses when gh cannot read the PR state", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });
  const failing = fakeGhEnv(t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
    failPrView: true,
  });

  const refused = await invoke(["finish", "--confirm", "--json"], dir, failing);
  assert.equal(refused.code, 5);
  assert.equal(refused.json.error.code, "E_GH_AUTH");

  const task = JSON.parse(readFileSync(delivered.taskFile, "utf8"));
  assert.equal(task.status, "pr_open");
});

test("plan progress stays approved and pr requires every step done", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);
  const env = fakeGhEnv(t, { prState: "OPEN", checks: ["SUCCESS"] });

  assert.equal((await invoke(["verify", "--json"], dir)).code, 0);
  assert.equal((await invoke(["self-review", "--json"], dir)).code, 0);
  assert.equal(
    (await invoke(["approve", "self-review", "--json"], dir)).code,
    0,
  );

  const blocked = await invoke(["pr", "--json"], dir, env);
  assert.equal(blocked.code, 3);
  assert.equal(blocked.json.error.code, "E_STATE_CONFLICT");
  assert.equal(blocked.json.error.details.open[0].id, "1");

  const step = await invoke(
    [
      "plan",
      "step",
      "1",
      "--status",
      "done",
      "--summary",
      "Implemented and checked.",
      "--result",
      "`npm test` → pass",
      "--json",
    ],
    dir,
  );
  assert.equal(step.code, 0, step.err || step.out);
  assert.equal(step.json.data.step.status, "done");
  assert.equal(step.json.data.next[0], "self-review");

  const staleReview = await invoke(["pr", "--json"], dir, env);
  assert.equal(staleReview.code, 3);
  assert.equal(staleReview.json.error.code, "E_APPROVAL_STALE");

  assert.equal((await invoke(["self-review", "--json"], dir)).code, 0);
  assert.equal(
    (await invoke(["approve", "self-review", "--json"], dir)).code,
    0,
  );

  const status = await invoke(["status", "--json"], dir);
  assert.equal(status.json.data.task.status, "verified");
  assert.equal(status.json.data.approvals.plan.stale, false);
  assert.ok(status.json.data.approvals.selfReview);
  assert.equal(status.json.data.approvals.selfReview.stale, false);
  assert.deepEqual(status.json.data.next, ["pr"]);

  const delivered = await invoke(["pr", "--json"], dir, env);
  assert.equal(delivered.code, 0, delivered.err || delivered.out);
  assert.equal(delivered.json.data.number, 7);
  assert.ok(planned.taskFile);
});

test("a docs-only task verifies with no code gate", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t, { kind: "docs" });
  mkdirSync(join(planned.worktree, "docs"), { recursive: true });
  writeFileSync(join(planned.worktree, "docs/guide.md"), "# Guide\n");
  git(planned.worktree, ["add", "docs/guide.md"]);
  git(planned.worktree, ["commit", "-m", "docs: add a guide"]);

  const verified = await invoke(["verify", "--json"], dir);
  assert.equal(verified.code, 0, verified.err || verified.out);
  assert.equal(verified.json.data.result, "pass");
  assert.equal(verified.json.data.inferredKind, "docs");
  assert.equal(verified.json.data.effectiveKind, "docs");
  assert.equal(verified.json.data.gates.length, 0);
  assert.ok(
    verified.json.warnings.some((warning) => warning.code === "W_NO_GATES"),
  );
});

test("a mixed task runs the broader gate set", async (t) => {
  const { dir } = repoWithRemote(t);
  await setupPlanned(dir, t, { kind: "mixed" });

  const verified = await invoke(["verify", "--json"], dir);
  assert.equal(verified.code, 0, verified.err || verified.out);
  assert.equal(verified.json.data.result, "pass");
  assert.equal(verified.json.data.effectiveKind, "mixed");
  assert.equal(verified.json.data.gates.length, 1);
  assert.ok(
    verified.json.warnings.some(
      (warning) => warning.code === "W_KIND_INFERRED",
    ),
  );
});

test("pr requires a durable updates record", async (t) => {
  const { dir } = repoWithRemote(t);
  await setupPlanned(dir, t, { durable: false });
  await verifyAndReview(dir);

  const result = await invoke(
    ["pr", "--json"],
    dir,
    fakeGhEnv(t, { prState: "OPEN", checks: ["SUCCESS"] }),
  );
  assert.equal(result.code, 3);
  assert.equal(result.json.error.code, "E_STATE_CONFLICT");
  assert.match(result.json.error.message, /durable updates/i);
});

test("verify refuses while the task lock is held", async (t) => {
  const { dir } = repoWithRemote(t);
  const planned = await setupPlanned(dir, t);
  const config = JSON.parse(
    readFileSync(join(dir, ".codeflow/config.json"), "utf8"),
  );
  const paths = statePaths(dir, config);

  acquireLock(paths, planned.taskId, { command: "test" });
  const blocked = await invoke(["verify", "--json"], dir);
  assert.equal(blocked.code, 3);
  assert.equal(blocked.json.error.code, "E_LOCKED");

  releaseLock(paths, planned.taskId);
  const verified = await invoke(["verify", "--json"], dir);
  assert.equal(verified.code, 0, verified.err || verified.out);
});

test("comments reports resolved and open review threads", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
    threads: [
      {
        resolved: true,
        path: "src/a.ts",
        line: 1,
        comments: [{ author: "reviewer", body: "This is handled." }],
      },
      {
        resolved: false,
        path: "src/b.ts",
        line: 2,
        comments: [{ author: "reviewer", body: "Please change this." }],
      },
    ],
  });

  const result = await invoke(["comments", "--json"], dir, delivered.env);
  assert.equal(result.code, 0, result.err || result.out);
  assert.equal(result.json.data.resolutionAvailable, true);
  assert.equal(result.json.data.resolved, 1);
  assert.equal(result.json.data.unresolved, 1);

  const markdown = readFileSync(
    join(dir, ".codeflow/state/tasks", delivered.taskId, "COMMENTS.md"),
    "utf8",
  );
  assert.match(markdown, /\[resolved\]/);
  assert.match(markdown, /\[open\]/);
});

test("abandon refuses a task with an open PR", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });

  const result = await invoke(["abandon", "--confirm", "--json"], dir);
  assert.equal(result.code, 3);
  assert.equal(result.json.error.code, "E_STATE_CONFLICT");
  assert.equal(existsSync(delivered.worktree), true);

  const task = JSON.parse(readFileSync(delivered.taskFile, "utf8"));
  assert.equal(task.status, "pr_open");
});

test("watch --wait polls until checks settle", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["PENDING"],
  });

  const env = fakeGhEnv(t, {
    prState: "OPEN",
    checks: ["PENDING", "SUCCESS"],
  });
  const watch = await invoke(
    ["watch", "--wait", "--timeout", "2", "--interval", "10", "--json"],
    dir,
    env,
  );
  assert.equal(watch.code, 0, watch.err || watch.out);
  assert.equal(watch.json.data.state, "success");
  assert.equal(watch.json.data.timedOut, false);
  assert.equal(watch.json.data.waited, true);
  assert.ok(watch.json.data.polls >= 1);
  assert.equal(watch.json.data.mergeStateStatus, "BLOCKED");
  assert.equal(watch.json.data.reviewDecision, "");
  assert.ok(delivered.worktree);
});

test("watch records the observed pr state", async (t) => {
  const { dir } = repoWithRemote(t);
  const delivered = await deliver(dir, t, {
    prState: "OPEN",
    checks: ["SUCCESS"],
  });

  const env = fakeGhEnv(t, { prState: "MERGED", checks: ["SUCCESS"] });
  const watch = await invoke(["watch", "--json"], dir, env);
  assert.equal(watch.code, 0, watch.err || watch.out);

  const file = join(
    dir,
    ".codeflow/state/tasks",
    delivered.taskId,
    "pr.json",
  );
  const pr = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(pr.state, "merged");
  assert.equal(typeof pr.observedAt, "string");
  assert.ok(pr.observedAt.length > 0);
});

test("watch --wait reports a timeout without failing", async (t) => {
  const { dir } = repoWithRemote(t);
  await deliver(dir, t, { prState: "OPEN", checks: ["PENDING"] });

  const env = fakeGhEnv(t, { prState: "OPEN", checks: ["PENDING"] });
  const watch = await invoke(
    ["watch", "--wait", "--timeout", "0.1", "--interval", "20", "--json"],
    dir,
    env,
  );
  assert.equal(watch.code, 0, watch.err || watch.out);
  assert.equal(watch.json.data.state, "pending");
  assert.equal(watch.json.data.timedOut, true);
  assert.ok(
    watch.json.warnings.some((warning) => warning.code === "W_CHECKS_PENDING"),
  );
});
