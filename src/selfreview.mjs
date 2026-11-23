import { CodedError, ERROR_CODES } from "./contracts.mjs";
import { evidenceHash, readEvidence } from "./evidence.mjs";
import { git } from "./git.mjs";
import { planStateHash, readPlan } from "./plan.mjs";
import { assertSchema } from "./schema.mjs";
import { taskFile, writeTask } from "./state.mjs";
import { appendEvent } from "./task.mjs";
import {
  fileExists,
  nowIso,
  readJsonSafe,
  readText,
  sha256,
  stableStringify,
  writeJsonAtomic,
  writeTextAtomic,
} from "./util.mjs";

export function diffHash(cwd, base) {
  return sha256(git(["diff", "--binary", `${base}...HEAD`], { cwd }));
}

export function diffStat(cwd, base) {
  return git(["diff", "--stat", `${base}...HEAD`], { cwd });
}

export function readReview(paths, taskId) {
  const file = taskFile(paths, taskId, "review.json");
  const value = readJsonSafe(file);
  return value ? assertSchema(value, "review", file) : null;
}

function renderReview(review, context) {
  const { task, plan, evidence, diffStatText } = context;
  const lines = [
    `# Self-review — ${task.id}`,
    "",
    `Task: ${task.title}`,
    `Diff: ${review.diffHash}`,
    `Evidence: ${review.evidenceHash}`,
    "",
    "## Plan",
    ...(plan.steps ?? []).flatMap((step) => {
      const entries = [
        `- [${step.status === "done" ? "x" : " "}] ${step.id}. ${step.title}`,
      ];
      if (step.summary) {
        entries.push(`  - ${step.summary}`);
      }
      if (step.result) {
        entries.push(`  - Result: ${step.result}`);
      }
      return entries;
    }),
    "",
    "## Verification",
    "| Gate | Tier | Result | Duration |",
    "| --- | --- | --- | --- |",
    ...((evidence.gates ?? []).length === 0
      ? ["| _(none)_ | — | no gates ran | — |"]
      : []),
    ...(evidence.gates ?? []).map(
      (gate) =>
        `| ${gate.name} | ${gate.tier} | ${gate.exitCode}${gate.timedOut ? " (timeout)" : ""}${gate.flaky ? " (flaky)" : ""} | ${gate.durationMs}ms |`,
    ),
    "",
    "## Diff stat",
    "```text",
    diffStatText || "(empty)",
    "```",
    "",
    "## Attention",
    `- Test files: ${evidence.attention.testFiles.length}`,
    `- Skips: ${evidence.attention.skips.length}`,
    `- Suppressions: ${evidence.attention.suppressions.length}`,
    `- Config changes: ${evidence.attention.configChanges.length}`,
    `- Lockfile changes: ${evidence.attention.lockfileChanges.length}`,
    `- Large diff: ${evidence.attention.largeDiff.files} files / ${evidence.attention.largeDiff.lines} lines`,
    "",
    "## Scope drift",
    ...(review.scopeDrift.length > 0
      ? review.scopeDrift.map((item) => `- ${item}`)
      : ["- None recorded."]),
    "",
    "## Closest look",
    ...(review.closestLook.length > 0
      ? review.closestLook.map((item) => `- ${item}`)
      : ["- None recorded."]),
    "",
    "## Sign-off",
    review.reviewedBy
      ? `Reviewed by ${review.reviewedBy} at ${review.reviewedAt}.`
      : "Pending: run `codeflow approve self-review` after inspecting this packet.",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildReviewPacket(options) {
  const {
    paths,
    task,
    cwd,
    base,
    plan,
    evidence,
    notes = "",
    scopeDrift = [],
    closestLook = [],
  } = options;

  const review = {
    schemaVersion: 1,
    taskId: task.id,
    diffHash: diffHash(cwd, base),
    evidenceHash: evidenceHash(evidence),
    planHash: planStateHash(plan),
    reviewedBy: null,
    reviewedAt: null,
    notes,
    scopeDrift,
    closestLook,
    acknowledged: [],
  };

  writeJsonAtomic(taskFile(paths, task.id, "review.json"), review);
  writeTextAtomic(
    taskFile(paths, task.id, "REVIEW.md"),
    renderReview(review, {
      task,
      plan,
      evidence,
      diffStatText: diffStat(cwd, base),
    }),
  );
  return review;
}

export function reviewHash(review) {
  return sha256(stableStringify(review));
}

export function approveSelfReview(paths, task, options) {
  const {
    cwd,
    base,
    by,
    note = "",
  } = options;
  const review = readReview(paths, task.id);
  if (!review) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "review.json was not found",
      { taskId: task.id },
      "Run `codeflow self-review` first.",
    );
  }

  const evidence = readEvidence(paths, task.id);
  if (!evidence) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "evidence.json was not found",
      { taskId: task.id },
      "Run `codeflow verify` first.",
    );
  }

  const currentDiff = diffHash(cwd, base);
  const currentEvidence = evidenceHash(evidence);
  if (review.diffHash !== currentDiff) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the diff changed since the self-review packet was built",
      { expected: review.diffHash, actual: currentDiff },
      "Run `codeflow self-review` again.",
    );
  }
  if (review.evidenceHash !== currentEvidence) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the evidence changed since the self-review packet was built",
      { expected: review.evidenceHash, actual: currentEvidence },
      "Run `codeflow verify` and `codeflow self-review` again.",
    );
  }
  const plan = readPlan(paths, task.id);
  if (review.planHash !== planStateHash(plan)) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the plan changed since the self-review packet was built",
      { expected: review.planHash, actual: planStateHash(plan) },
      "Run `codeflow self-review` again.",
    );
  }

  review.reviewedBy = by;
  review.reviewedAt = nowIso();
  review.notes = note || review.notes;
  writeJsonAtomic(taskFile(paths, task.id, "review.json"), review);

  task.approvals.selfReview = {
    hash: reviewHash(review),
    approvedBy: by,
    approvedAt: review.reviewedAt,
    note: review.notes,
  };
  const event = appendEvent(paths, task.id, "review.approved", by, {
    hash: task.approvals.selfReview.hash,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);
  return { task, review };
}

export function selfReviewFresh(paths, task, options) {
  const review = readReview(paths, task.id);
  if (!review || !review.reviewedBy) {
    return { review, fresh: false, reason: "not approved" };
  }
  if (!task.approvals?.selfReview) {
    return { review, fresh: false, reason: "not approved" };
  }
  if (task.approvals.selfReview.hash !== reviewHash(review)) {
    return { review, fresh: false, reason: "review changed" };
  }
  const evidence = readEvidence(paths, task.id);
  if (!evidence) {
    return { review, fresh: false, reason: "no evidence" };
  }
  const diff = diffHash(options.cwd, options.base);
  if (review.diffHash !== diff) {
    return { review, fresh: false, reason: "diff changed" };
  }
  if (review.evidenceHash !== evidenceHash(evidence)) {
    return { review, fresh: false, reason: "evidence changed" };
  }
  let plan;
  try {
    plan = readPlan(paths, task.id);
  } catch {
    return { review, fresh: false, reason: "no plan" };
  }
  if (review.planHash !== planStateHash(plan)) {
    return { review, fresh: false, reason: "plan changed" };
  }
  return { review, fresh: true, reason: null };
}

export function reviewText(paths, taskId) {
  const file = taskFile(paths, taskId, "REVIEW.md");
  return fileExists(file) ? readText(file) : "";
}
