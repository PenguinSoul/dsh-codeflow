import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodedError, ERROR_CODES } from "./contracts.mjs";
import { gitOrNull } from "./git.mjs";
import { planApprovalHash, planPath, readPlan, validatePlan } from "./plan.mjs";
import {
  nextTaskId,
  readTask,
  taskDir,
  taskFile,
  writeActive,
  writeTask,
} from "./state.mjs";
import {
  ensureDir,
  expandHome,
  fileExists,
  nowIso,
  readText,
  sha256,
  slugify,
  stableStringify,
  writeTextAtomic,
} from "./util.mjs";

export const TASK_KINDS = ["code", "docs", "infra", "test", "mixed"];
const TASK_TEMPLATE = fileURLToPath(
  new URL("../templates/TASK.md", import.meta.url),
);

export function actor(repo) {
  const name = gitOrNull(["config", "user.name"], { cwd: repo.root }) ?? "unknown";
  const email = gitOrNull(["config", "user.email"], { cwd: repo.root }) ?? "unknown";
  return `${name} <${email}>`;
}

export function hashFile(file) {
  return sha256(readText(file).replace(/\r\n/g, "\n"));
}

export function taskTemplate(title) {
  return readText(TASK_TEMPLATE).replaceAll("{{title}}", title);
}

function strippedSections(markdown) {
  // Repeated headings append to the first section with that name. Resetting the
  // buffer on every heading let a second, empty `## Request` erase the first one
  // and made `approve design` claim TASK.md was still a template.
  const sections = {};
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1].toLowerCase();
      sections[current] = sections[current] ?? [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(
    Object.entries(sections).map(([name, lines]) => [
      name,
      lines
        .join("\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim(),
    ]),
  );
}

export function taskSections(markdown) {
  return strippedSections(markdown);
}

export function missingTaskSections(markdown) {
  const sections = strippedSections(markdown);
  return ["request", "product", "design"].filter(
    (name) => !sections[name],
  );
}

export function durableUpdates(markdown) {
  return strippedSections(markdown)["durable updates"] ?? "";
}

export function appendEvent(paths, taskId, type, eventActor, data = {}) {
  const file = taskFile(paths, taskId, "events.jsonl");
  ensureDir(path.dirname(file));
  let previous = null;
  if (fileExists(file)) {
    const lines = readText(file).trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      try {
        previous = JSON.parse(lines.at(-1)).hash ?? null;
      } catch {
        previous = null;
      }
    }
  }
  const base = {
    schemaVersion: 1,
    at: nowIso(),
    taskId,
    type,
    actor: eventActor,
    data,
    prevHash: previous,
  };
  const event = { ...base, hash: sha256(stableStringify(base)) };
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  return event;
}

export function createTask(paths, repo, config, options) {
  const {
    title,
    kind = "code",
    issues = [],
  } = options;
  if (!TASK_KINDS.includes(kind)) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      `unknown task kind "${kind}"`,
      { kinds: TASK_KINDS },
      "Use code, docs, infra, test, or mixed.",
    );
  }
  const id = nextTaskId(paths, title);
  const createdBy = actor(repo);
  const task = {
    schemaVersion: 1,
    id,
    title,
    kind,
    status: "created",
    branch: `codeflow/${id}`,
    worktree: path.join(
      expandHome(config.worktreeRoot),
      slugify(path.basename(repo.root)),
      id,
    ),
    baseBranch: config.baseBranch,
    remote: config.remote,
    createdAt: nowIso(),
    createdBy,
    issues: issues.map(String),
    approvals: {
      design: null,
      plan: null,
      selfReview: null,
    },
    blocked: null,
    lastEventHash: null,
  };

  ensureDir(taskDir(paths, id));
  writeTextAtomic(taskFile(paths, id, "TASK.md"), taskTemplate(title));
  const event = appendEvent(paths, id, "task.created", createdBy, {
    title,
    kind,
    issues: task.issues,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);
  writeActive(paths, id);
  return task;
}

export function approveTask(paths, task, target, options = {}) {
  const {
    by = "unknown <unknown>",
    note = "",
  } = options;

  if (target === "design") {
    const file = taskFile(paths, task.id, "TASK.md");
    if (!fileExists(file)) {
      throw new CodedError(
        ERROR_CODES.STATE_CONFLICT,
        "TASK.md was not found",
        { taskId: task.id },
      );
    }
    const markdown = readText(file);
    const missing = missingTaskSections(markdown);
    if (missing.length > 0) {
      throw new CodedError(
        ERROR_CODES.STATE_CONFLICT,
        "TASK.md is still a template",
        { missing },
        "Fill Request, Product, and Design, then approve again.",
      );
    }
    task.approvals.design = {
      hash: hashFile(file),
      approvedBy: by,
      approvedAt: nowIso(),
      note,
    };
    task.approvals.plan = null;
    task.status = "designed";
  } else if (target === "plan") {
    if (!task.approvals.design) {
      throw new CodedError(
        ERROR_CODES.STATE_CONFLICT,
        "design is not approved",
        { taskId: task.id },
        "Run `codeflow approve design` first.",
      );
    }
    const designHash = hashFile(taskFile(paths, task.id, "TASK.md"));
    if (designHash !== task.approvals.design.hash) {
      throw new CodedError(
        ERROR_CODES.APPROVAL_STALE,
        "TASK.md changed since design approval",
        { expected: task.approvals.design.hash, actual: designHash },
        "Re-approve the design before approving the plan.",
      );
    }
    const plan = readPlan(paths, task.id);
    const errors = validatePlan(plan, task);
    if (errors.length > 0) {
      throw new CodedError(
        ERROR_CODES.CONFIG,
        "plan is invalid",
        { errors },
        "Fix plan.json, then approve again.",
      );
    }
    task.approvals.plan = {
      hash: planApprovalHash(plan),
      approvedBy: by,
      approvedAt: nowIso(),
      note,
    };
    // Re-approving a revised plan must not undo progress: a task that already
    // started keeps its status, and the stale checks decide what to redo. Only
    // the pre-start states move to "planned".
    if (task.status === "created" || task.status === "designed") {
      task.status = "planned";
    }
  } else {
    throw new CodedError(
      ERROR_CODES.USAGE,
      `unknown approval target "${target}"`,
      null,
      "Use `design` or `plan`.",
    );
  }

  const event = appendEvent(paths, task.id, "task.approved", by, {
    target,
    hash: task.approvals[target].hash,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);
  return task;
}

function selfReviewState(paths, task) {
  const file = taskFile(paths, task.id, "review.json");
  let current = null;
  if (fileExists(file)) {
    try {
      current = sha256(stableStringify(JSON.parse(readText(file))));
    } catch {
      current = null;
    }
  }
  const approval = task.approvals?.selfReview;
  return approval
    ? {
        hash: approval.hash,
        stale: current !== approval.hash,
      }
    : null;
}

export function approvalState(paths, task) {
  const designFile = taskFile(paths, task.id, "TASK.md");
  const planFile = planPath(paths, task.id);
  const designCurrent = fileExists(designFile) ? hashFile(designFile) : null;
  let planCurrent = null;
  if (fileExists(planFile)) {
    try {
      planCurrent = planApprovalHash(readPlan(paths, task.id));
    } catch {
      planCurrent = null;
    }
  }

  return {
    design: task.approvals?.design
      ? {
          hash: task.approvals.design.hash,
          stale: designCurrent !== task.approvals.design.hash,
        }
      : null,
    plan: task.approvals?.plan
      ? {
          hash: task.approvals.plan.hash,
          stale: planCurrent !== task.approvals.plan.hash,
        }
      : null,
    selfReview: selfReviewState(paths, task),
  };
}

export function readActiveTask(paths, taskId) {
  if (!taskId) {
    return null;
  }
  return readTask(paths, taskId);
}
