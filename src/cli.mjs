import path from "node:path";
import {
  CLI_VERSION,
  CodedError,
  ERROR_CODES,
  EXIT,
  exitFor,
  fail,
  failWithData,
  ok,
} from "./contracts.mjs";
import {
  configHash,
  configPath,
  detectConfig,
  loadConfig,
  writeConfig,
} from "./config.mjs";
import { runDoctor } from "./doctor.mjs";
import {
  addWorktree,
  assertWorktreeBranch,
  git,
  gitOrNull,
  gitResult,
  isClean,
  rebaseOntoBase,
  removeWorktree,
} from "./git.mjs";
import {
  changedFiles,
  failedAttention,
  inferKind,
  scanAttention,
} from "./attention.mjs";
import {
  buildEvidence,
  evidenceHash,
  gitTreeHash,
  isDirty,
  isFresh,
  readEvidence,
  writeEvidence,
} from "./evidence.mjs";
import {
  compareUrl,
  createOrUpdatePr,
  hasGh,
  prView,
  readComments,
} from "./github.mjs";
import { runGates, selectGates } from "./gates.mjs";
import {
  planApprovalHash,
  planPath,
  readPlan,
  updatePlanStep,
  validatePlan,
  writePlanMarkdown,
  writePlanTemplate,
} from "./plan.mjs";
import { renderPrBody, titleFor } from "./prbody.mjs";
import { render, renderBrief, renderError } from "./render.mjs";
import {
  assertStateNotTracked,
  ensureExcluded,
  findRepo,
  repoRelative,
} from "./repo.mjs";
import {
  approveSelfReview,
  buildReviewPacket,
  diffHash,
  diffStat,
  readReview,
  selfReviewFresh,
} from "./selfreview.mjs";
import {
  acquireLock,
  acquireProjectLock,
  clearActive,
  ensureState,
  readActive,
  readPr,
  readTask,
  releaseLock,
  releaseProjectLock,
  statePaths,
  taskDir,
  taskFile,
  writeTask,
} from "./state.mjs";
import {
  actor,
  appendEvent,
  approvalState,
  approveTask,
  createTask,
  durableUpdates,
  hashFile,
} from "./task.mjs";
import { assertTrusted, commandsFor, isTrusted, trustConfig } from "./trust.mjs";
import {
  fileExists,
  isContained,
  nowIso,
  readJsonSafe,
  readText,
  writeJsonAtomic,
  writeTextAtomic,
} from "./util.mjs";

const TASK_LOCK_COMMANDS = new Set([
  "plan",
  "approve",
  "verify",
  "self-review",
  "pr",
]);

const COMMANDS = new Set([
  "init",
  "new",
  "approve",
  "plan",
  "trust",
  "verify",
  "start",
  "resume",
  "finish",
  "abandon",
  "self-review",
  "pr",
  "watch",
  "comments",
  "status",
  "doctor",
]);

const HELP = `codeflow ${CLI_VERSION} — human-gated delivery workflow

Usage:
  codeflow <command> [options]

Commands:
  init       Detect the repository and write .codeflow/config.json
  new        Create a task and a task-spec
  approve    Approve the design or the plan by hash
  plan       Validate and render the task plan
  plan step  Record step progress
  trust      Review and approve the gate commands
  verify     Run the gates and record evidence
  start      Create the task branch and worktree
  resume     Clear a blocked state and continue
  finish     Remove the worktree after merge
  abandon    Discard a task that will not ship
  self-review Build the self-review packet
  pr         Render the PR body and create/update the PR
  watch      Read the PR checks (read-only)
  comments   Read the review comments (read-only)
  status     Show the active task and next step
  doctor     Check the environment and configuration

Options:
  --json       Print the versioned JSON envelope
  --task <id>  Select a task
  --kind <k>   Task kind: code, docs, infra, test, mixed
  --issue <n>  Link an issue (repeatable)
  --by <who>   Approver identity (default: git user)
  --note <s>   Approval note
  --yes        Confirm trust (trust only)
  --tier <t>   Gate tier: fast, full, live (verify only)
  --full       Run fast and full gates (verify only)
  --live       Run fast, full, and live gates (verify only)
  --allow-live Permit live gates (verify only)
  --retry      Retry a failing gate once (verify only)
  --init       Create a starter plan (plan only)
  --status <s> Step status: pending, in_progress, done, blocked (plan step)
  --summary <s> Step summary (plan step)
  --result <s> Step result, e.g. "npm test -> pass" (plan step)
  --confirm    Confirm a merge or abandon (finish/abandon)
  --delete-branch Delete the task branch (finish/abandon)
  --force-unlock Remove a stale task or project lock
  --no-push    Render the PR body only; do not push or create a PR (pr only)
  --scope-drift <s> Record scope drift (self-review, repeatable)
  --closest-look <s> Record a closest-look area (self-review, repeatable)
  --wait       Wait for checks (watch only)
  --timeout <s> Wait timeout in seconds (watch only)
  --interval <ms> Poll interval in milliseconds (watch only)
  --brief      One-line status (status only)
  --force      Overwrite config, force cleanup, or force unlock
  --dry-run    Print side effects without applying them
  --help       Show this help
  --version    Show the version
`;

function parseArgs(argv) {
  const flags = {
    json: false,
    help: false,
    version: false,
    brief: false,
    dryRun: false,
    force: false,
    init: false,
    yes: false,
    full: false,
    live: false,
    allowLive: false,
    retry: false,
    confirm: false,
    deleteBranch: false,
    forceUnlock: false,
    noPush: false,
    wait: false,
    timeout: null,
    interval: null,
    status: null,
    summary: null,
    result: null,
    scopeDrift: [],
    closestLook: [],
    tier: null,
    task: null,
    kind: null,
    issues: [],
    by: null,
    note: null,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--brief") {
      flags.brief = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--init") {
      flags.init = true;
    } else if (arg === "--status") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--status requires a value");
      }
      flags.status = value;
      index += 1;
    } else if (arg.startsWith("--status=")) {
      flags.status = arg.slice("--status=".length);
    } else if (arg === "--summary") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--summary requires a value");
      }
      flags.summary = value;
      index += 1;
    } else if (arg.startsWith("--summary=")) {
      flags.summary = arg.slice("--summary=".length);
    } else if (arg === "--result") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--result requires a value");
      }
      flags.result = value;
      index += 1;
    } else if (arg.startsWith("--result=")) {
      flags.result = arg.slice("--result=".length);
    } else if (arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--full") {
      flags.full = true;
    } else if (arg === "--live") {
      flags.live = true;
    } else if (arg === "--allow-live") {
      flags.allowLive = true;
    } else if (arg === "--retry") {
      flags.retry = true;
    } else if (arg === "--confirm") {
      flags.confirm = true;
    } else if (arg === "--delete-branch") {
      flags.deleteBranch = true;
    } else if (arg === "--force-unlock") {
      flags.forceUnlock = true;
    } else if (arg === "--no-push") {
      flags.noPush = true;
    } else if (arg === "--wait") {
      flags.wait = true;
    } else if (arg === "--timeout") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--timeout requires a value");
      }
      flags.timeout = value;
      index += 1;
    } else if (arg.startsWith("--timeout=")) {
      flags.timeout = arg.slice("--timeout=".length);
    } else if (arg === "--interval") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--interval requires a value");
      }
      flags.interval = value;
      index += 1;
    } else if (arg.startsWith("--interval=")) {
      flags.interval = arg.slice("--interval=".length);
    } else if (arg === "--scope-drift") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--scope-drift requires a value");
      }
      flags.scopeDrift.push(value);
      index += 1;
    } else if (arg.startsWith("--scope-drift=")) {
      flags.scopeDrift.push(arg.slice("--scope-drift=".length));
    } else if (arg === "--closest-look") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--closest-look requires a value");
      }
      flags.closestLook.push(value);
      index += 1;
    } else if (arg.startsWith("--closest-look=")) {
      flags.closestLook.push(arg.slice("--closest-look=".length));
    } else if (arg === "--tier") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--tier requires a value");
      }
      flags.tier = value;
      index += 1;
    } else if (arg.startsWith("--tier=")) {
      flags.tier = arg.slice("--tier=".length);
    } else if (arg === "--task") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--task requires a task id");
      }
      flags.task = value;
      index += 1;
    } else if (arg.startsWith("--task=")) {
      flags.task = arg.slice("--task=".length);
    } else if (arg === "--kind") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--kind requires a value");
      }
      flags.kind = value;
      index += 1;
    } else if (arg.startsWith("--kind=")) {
      flags.kind = arg.slice("--kind=".length);
    } else if (arg === "--issue") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--issue requires a value");
      }
      flags.issues.push(value);
      index += 1;
    } else if (arg.startsWith("--issue=")) {
      flags.issues.push(arg.slice("--issue=".length));
    } else if (arg === "--by") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--by requires a value");
      }
      flags.by = value;
      index += 1;
    } else if (arg.startsWith("--by=")) {
      flags.by = arg.slice("--by=".length);
    } else if (arg === "--note") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CodedError(ERROR_CODES.USAGE, "--note requires a value");
      }
      flags.note = value;
      index += 1;
    } else if (arg.startsWith("--note=")) {
      flags.note = arg.slice("--note=".length);
    } else if (arg.startsWith("-")) {
      throw new CodedError(ERROR_CODES.USAGE, `unknown flag "${arg}"`);
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

function emit(envelope, flags, out, err) {
  if (flags.json) {
    out.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (!envelope.ok) {
    err.write(`${renderError(envelope)}\n`);
    if (envelope.data === null) {
      return;
    }
  }
  if (flags.brief && envelope.command === "status") {
    const brief = renderBrief(envelope.data);
    if (brief) {
      out.write(`${brief}\n`);
    }
    return;
  }
  out.write(`${render(envelope)}\n`);
}

function initCommand(repo, flags) {
  const file = configPath(repo.mainRoot);
  if (fileExists(file) && !flags.force) {
    const config = loadConfig(repo.mainRoot);
    repo.projectConfig = config;
    const paths = statePaths(repo.mainRoot, config);
    ensureState(paths);
    ensureExcluded(repo);
    return {
      data: {
        repoRoot: repo.mainRoot,
        baseBranch: config.baseBranch,
        remote: config.remote,
        configPath: repoRelative(repo.mainRoot, file),
        excludePath: repoRelative(repo.mainRoot, repo.excludePath),
        detected: config.gates.map((gate) => ({
          name: gate.name,
          command: gate.command,
        })),
        trustRequired: true,
      },
      warnings: [
        {
          code: "W_CONFIG_EXISTS",
          message: "config already exists; left unchanged (use --force to rewrite)",
        },
      ],
    };
  }

  const config = detectConfig(repo);
  if (flags.dryRun) {
    return {
      data: {
        repoRoot: repo.mainRoot,
        baseBranch: config.baseBranch,
        remote: config.remote,
        configPath: repoRelative(repo.mainRoot, file),
        excludePath: repoRelative(repo.mainRoot, repo.excludePath),
        detected: config.gates.map((gate) => ({
          name: gate.name,
          command: gate.command,
        })),
        trustRequired: true,
        dryRun: true,
      },
      warnings: [],
    };
  }

  writeConfig(repo.mainRoot, config);
  repo.projectConfig = config;
  const paths = statePaths(repo.mainRoot, config);
  ensureState(paths);
  ensureExcluded(repo);

  const warnings = [];
  if (config.gates.length === 0) {
    warnings.push({
      code: "W_NO_GATES",
      message: "no gates detected; edit .codeflow/config.json before verify",
    });
  }
  if (
    !gitOrNull(["ls-files", "--", ".codeflow/config.json"], {
      cwd: repo.mainRoot,
    })
  ) {
    warnings.push({
      code: "W_CONFIG_UNCOMMITTED",
      message: "commit .codeflow/config.json before `codeflow start`",
    });
  }

  return {
    data: {
      repoRoot: repo.mainRoot,
      baseBranch: config.baseBranch,
      remote: config.remote,
      configPath: repoRelative(repo.mainRoot, file),
      excludePath: repoRelative(repo.mainRoot, repo.excludePath),
      detected: config.gates.map((gate) => ({
        name: gate.name,
        command: gate.command,
      })),
      trustRequired: true,
    },
    warnings,
  };
}

function newCommand(repo, config, flags, positional) {
  const title = positional.slice(1).join(" ").trim();
  if (!title) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      "new requires a task title",
      null,
      'Example: codeflow new "Fix the login redirect"',
    );
  }
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const task = createTask(paths, repo, config, {
    title,
    kind: flags.kind ?? "code",
    issues: flags.issues,
  });
  return {
    data: {
      taskId: task.id,
      taskPath: repoRelative(repo.mainRoot, taskDir(paths, task.id)),
      taskSpecPath: repoRelative(repo.mainRoot, taskFile(paths, task.id, "TASK.md")),
      kind: task.kind,
      next: ["edit TASK.md", "approve design"],
    },
    taskId: task.id,
  };
}

function approveCommand(repo, config, flags, positional) {
  const target = positional[1];
  if (!target) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      "approve requires a target",
      null,
      "Use `codeflow approve design` or `codeflow approve plan`.",
    );
  }
  if (target !== "design" && target !== "plan" && target !== "self-review") {
    throw new CodedError(
      ERROR_CODES.USAGE,
      `unknown approval target "${target}"`,
      null,
      "Use `design`, `plan`, or `self-review`.",
    );
  }

  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }

  const by = flags.by ?? actor(repo);
  if (target === "self-review") {
    const worktree = taskTree(repo, task);
    const { task: updated, review } = approveSelfReview(paths, task, {
      cwd: worktree,
      base: config.baseBranch,
      by,
      note: flags.note ?? "",
    });
    const approval = updated.approvals.selfReview;
    return {
      data: {
        target,
        hash: approval.hash,
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        notes: review.notes,
      },
      taskId,
    };
  }

  const updated = approveTask(paths, task, target, {
    by,
    note: flags.note ?? "",
  });
  const approval = updated.approvals[target];
  return {
    data: {
      target,
      hash: approval.hash,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    },
    taskId,
  };
}

function planStepCommand(repo, config, flags, positional) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "active" && task.status !== "verified") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; step progress requires an active or verified task`,
      { status: task.status },
      "Run `codeflow start` first.",
    );
  }

  const approval = task.approvals?.plan;
  if (!approval) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "the plan is not approved",
      { taskId },
      "Run `codeflow approve plan` first.",
    );
  }
  const plan = readPlan(paths, task.id);
  if (planApprovalHash(plan) !== approval.hash) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the plan changed since approval",
      { expected: approval.hash, actual: planApprovalHash(plan) },
      "Re-approve the plan before recording progress.",
    );
  }

  const stepId = positional[2];
  if (!stepId) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      "plan step requires a step id",
      null,
      "Example: codeflow plan step 1 --status done --result \"`npm test` → pass\"",
    );
  }
  const patch = {
    status: flags.status ?? undefined,
    summary: flags.summary ?? undefined,
    result: flags.result ?? undefined,
    note: flags.note ?? undefined,
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      "plan step needs at least one change",
      null,
      "Pass --status, --summary, --result, or --note.",
    );
  }

  const step = updatePlanStep(plan, stepId, patch);
  writeJsonAtomic(planPath(paths, task.id), plan);
  writePlanMarkdown(paths, task, plan);
  const event = appendEvent(paths, task.id, "plan.step", actor(repo), {
    stepId: step.id,
    status: step.status,
    result: step.result,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);

  return {
    data: {
      taskId,
      step: {
        id: step.id,
        title: step.title,
        status: step.status,
        result: step.result,
      },
      next: task.status === "verified" ? ["self-review", "pr"] : ["verify"],
    },
    taskId,
  };
}

function planCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }

  if (flags.init) {
    const created = writePlanTemplate(paths, task);
    const plan = created ?? readPlan(paths, task.id);
    writePlanMarkdown(paths, task, plan);
    return {
      data: {
        planPath: repoRelative(repo.mainRoot, planPath(paths, task.id)),
        steps: plan.steps.length,
        approved: Boolean(task.approvals.plan),
        next: ["edit plan.json", "approve plan"],
      },
      taskId,
      warnings: created
        ? []
        : [
            {
              code: "W_PLAN_EXISTS",
              message: "plan.json already exists; left unchanged",
            },
          ],
    };
  }

  const plan = readPlan(paths, task.id);
  const errors = validatePlan(plan, task);
  if (errors.length > 0) {
    throw new CodedError(
      ERROR_CODES.CONFIG,
      "plan is invalid",
      { errors },
      "Edit plan.json, then run `codeflow plan` again.",
    );
  }
  writePlanMarkdown(paths, task, plan);

  const approval = task.approvals.plan;
  const stale = Boolean(
    approval && planApprovalHash(plan) !== approval.hash,
  );
  return {
    data: {
      planPath: repoRelative(repo.mainRoot, planPath(paths, task.id)),
      steps: plan.steps.length,
      approved: Boolean(approval) && !stale,
      next: stale || !approval ? ["approve plan"] : ["start"],
    },
    taskId,
    warnings: stale
      ? [
          {
            code: "W_APPROVAL_STALE",
            message: "plan.json changed since plan approval; approve it again",
          },
        ]
      : [],
  };
}

function trustCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const commands = commandsFor(config);
  if (!flags.yes) {
    return {
      data: {
        configHash: configHash(config),
        commands,
        trusted: false,
        requiresConfirmation: true,
      },
      warnings: [
        {
          code: "W_TRUST_CONFIRM",
          message: "Review the commands, then run `codeflow trust --yes`.",
        },
      ],
    };
  }
  const trust = trustConfig(paths, config, flags.by ?? actor(repo));
  return {
    data: {
      configHash: trust.configHash,
      commands: trust.commands,
      approvedBy: trust.approvedBy,
      approvedAt: trust.approvedAt,
    },
    warnings:
      commands.length === 0
        ? [{ code: "W_NO_GATES", message: "the config has no gates" }]
        : [],
  };
}

function verifyCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "active" && task.status !== "verified") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; verify requires an active or verified task`,
      { status: task.status },
      "Run `codeflow start` first.",
    );
  }

  assertTrusted(paths, config);

  const tier = flags.live ? "live" : flags.full ? "full" : (flags.tier ?? "fast");
  if (!["fast", "full", "live"].includes(tier)) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      `unknown gate tier "${tier}"`,
      null,
      "Use fast, full, or live.",
    );
  }
  if (tier === "live" && !flags.allowLive) {
    throw new CodedError(
      ERROR_CODES.USAGE,
      "live gates are not allowed without --allow-live",
      { tier },
      "Re-run with --allow-live when you intend to spend real tokens.",
    );
  }

  const worktree = taskTree(repo, task);
  const inferredKind = inferKind(changedFiles(worktree, config.baseBranch));
  let effectiveKind = task.kind;
  const warnings = [];
  if (inferredKind !== task.kind) {
    effectiveKind = "mixed";
    warnings.push({
      code: "W_KIND_INFERRED",
      message: `inferred ${inferredKind} from the diff; using the broader gate set for the ${task.kind} task`,
    });
  }

  const gates = selectGates(config, effectiveKind, tier);
  if (gates.length === 0 && effectiveKind !== "docs") {
    throw new CodedError(
      ERROR_CODES.CONFIG,
      `no ${tier} gates apply to a ${effectiveKind} task`,
      { tier, kind: effectiveKind, inferredKind },
      "Edit .codeflow/config.json or choose a different tier.",
    );
  }
  if (gates.length === 0) {
    warnings.push({
      code: "W_NO_GATES",
      message: "no gates apply to a docs-only task",
    });
  }

  if (flags.dryRun) {
    return {
      data: {
        tier,
        dryRun: true,
        kind: task.kind,
        inferredKind,
        effectiveKind,
        gates: gates.map((gate) => ({
          name: gate.name,
          command: gate.command,
          tier: gate.tier,
          required: gate.required,
        })),
      },
      taskId,
      warnings,
    };
  }

  const startedAt = nowIso();
  const logDir = path.join(taskDir(paths, task.id), "logs");
  const run = runGates(gates, {
    cwd: worktree,
    logDir,
    retryFlaky: flags.retry || config.verify.retryFlaky,
    maxRetries: config.verify.maxRetries,
  });
  const attention = scanAttention(worktree, config.baseBranch, config);
  const failed = failedAttention(attention, config.attention.failOn);
  const result = run.result === "pass" && failed.length === 0 ? "pass" : "fail";

  const evidence = buildEvidence({
    root: repo.mainRoot,
    cwd: worktree,
    task,
    config,
    gates,
    gateResults: run.results,
    attention,
    startedAt,
    finishedAt: nowIso(),
    result,
    kind: task.kind,
    inferredKind,
    effectiveKind,
  });
  writeEvidence(paths, task, evidence);

  // Only changes that can weaken verification are worth a warning. Test-file
  // edits and diff size are normal work: they stay in data.attention, the
  // evidence, and the review packet, where a reviewer reads them anyway.
  const noted = failedAttention(attention, ["skip", "suppression"]);

  let next;
  if (result === "pass") {
    task.status = "verified";
    task.blocked = null;
    next = ["self-review", "pr"];
  } else if (failed.length > 0) {
    task.status = "blocked";
    task.blocked = {
      code: "E_GATE_FAILED",
      reason: `attention: ${failed.join(", ")}`,
      at: nowIso(),
      from: "active",
      hint: "Review the attention items, fix them, then run `codeflow resume`.",
    };
    next = ["resume"];
  } else {
    task.status = "active";
    next = ["fix the failure", "verify"];
  }

  const event = appendEvent(paths, task.id, "verify.finished", actor(repo), {
    result,
    failed,
    tier,
    kind: task.kind,
    inferredKind,
    effectiveKind,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);

  const resultWarnings = [...warnings];
  if (noted.length > 0) {
    resultWarnings.push({
      code: "W_ATTENTION",
      message: `attention items recorded: ${noted.join(", ")}`,
    });
  }

  const evidencePath = repoRelative(
    repo.mainRoot,
    taskFile(paths, task.id, "evidence.json"),
  );
  const failedGate = run.results.find(
    (gate) => gate.required && (gate.timedOut || gate.exitCode !== 0),
  );
  const failure =
    result === "pass"
      ? null
      : {
          code: failedGate?.timedOut
            ? ERROR_CODES.GATE_TIMEOUT
            : ERROR_CODES.GATE_FAILED,
          message:
            failed.length > 0
              ? `attention items failed the gate: ${failed.join(", ")}`
              : failedGate
                ? `gate "${failedGate.name}" ${failedGate.timedOut ? "timed out" : `exited ${failedGate.exitCode}`}`
                : "the gates did not pass",
          details: {
            result,
            evidencePath,
            gate: failedGate?.name ?? null,
            attention: failed,
            gates: run.results.map((gate) => ({
              name: gate.name,
              exitCode: gate.exitCode,
              timedOut: gate.timedOut,
              required: gate.required,
              logPath: gate.logPath
                ? repoRelative(repo.mainRoot, gate.logPath)
                : null,
            })),
          },
          hint:
            failed.length > 0
              ? "Review the attention items, fix them, then run `codeflow resume`."
              : "Fix the failing gate, then run `codeflow verify` again.",
        };

  return {
    data: {
      result,
      tier,
      kind: task.kind,
      inferredKind,
      effectiveKind,
      gates: run.results.map((gate) => ({
        name: gate.name,
        exitCode: gate.exitCode,
        durationMs: gate.durationMs,
        required: gate.required,
        timedOut: gate.timedOut,
        flaky: gate.flaky,
      })),
      attention,
      evidencePath,
      next,
    },
    taskId,
    warnings: resultWarnings,
    failure,
    exitCode: result === "pass" ? EXIT.OK : EXIT.GATE,
  };
}

function startCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "planned" && task.status !== "active") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; start requires a planned task`,
      { status: task.status },
    );
  }

  const approvals = approvalState(paths, task);
  if (!approvals.design || approvals.design.stale) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the design is not approved or has changed",
      { approval: approvals.design },
      "Run `codeflow approve design` first.",
    );
  }
  if (!approvals.plan || approvals.plan.stale) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the plan is not approved or has changed",
      { approval: approvals.plan },
      "Run `codeflow approve plan` first.",
    );
  }

  if (flags.dryRun) {
    return {
      data: {
        taskId,
        branch: task.branch,
        worktree: task.worktree,
        base: config.baseBranch,
        dryRun: true,
      },
      taskId,
    };
  }

  const wasActive = task.status === "active";
  const worktree = taskWorktreePath(repo, task);
  acquireLock(paths, task.id, {
    command: "start",
    force: flags.forceUnlock,
  });
  try {
    const result = addWorktree(repo.mainRoot, {
      worktree,
      branch: task.branch,
      base: config.baseBranch,
    });
    assertWorktreeBranch(worktree, task.branch);
    if (!fileExists(path.join(worktree, ".codeflow", "config.json"))) {
      throw new CodedError(
        ERROR_CODES.CONFIG,
        "the task worktree does not contain .codeflow/config.json",
        { worktree: task.worktree },
        "Commit .codeflow/config.json to the base branch before `codeflow start`.",
      );
    }
    task.status = "active";
    const event = appendEvent(paths, task.id, "task.started", actor(repo), {
      branch: task.branch,
      worktree: task.worktree,
      base: config.baseBranch,
    });
    task.lastEventHash = event.hash;
    writeTask(paths, task);

    const warnings = [];
    if (wasActive) {
      warnings.push({
        code: "W_ALREADY_ACTIVE",
        message: "the task was already active",
      });
    }
    if (!result.created) {
      warnings.push({
        code: "W_WORKTREE_EXISTS",
        message: "the worktree already exists; reused it",
      });
    }

    return {
      data: {
        taskId,
        branch: task.branch,
        worktree: task.worktree,
        baseCommit: gitOrNull(
          ["rev-parse", "--short", config.baseBranch],
          { cwd: repo.mainRoot },
        ),
        reused: !result.created,
        reusedBranch: result.reusedBranch,
      },
      taskId,
      warnings,
    };
  } finally {
    releaseLock(paths, task.id);
  }
}

function resumeCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "blocked") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; resume requires a blocked task`,
      { status: task.status },
    );
  }

  const previous = task.blocked?.from ?? "active";
  acquireLock(paths, task.id, {
    command: "resume",
    force: flags.forceUnlock,
  });
  try {
    task.status = previous;
    task.blocked = null;
    const event = appendEvent(paths, task.id, "task.resumed", actor(repo), {
      status: previous,
    });
    task.lastEventHash = event.hash;
    writeTask(paths, task);
    return {
      data: {
        taskId,
        previousStatus: "blocked",
        status: previous,
        next: nextFor(previous),
      },
      taskId,
    };
  } finally {
    releaseLock(paths, task.id);
  }
}

function mergeDetection(repo, task, paths, env) {
  const pr = readPr(paths, task.id);
  if (!pr || pr.mode !== "gh" || !pr.number) {
    return { available: false, merged: false, reason: "no GitHub PR" };
  }
  if (!hasGh(env)) {
    return { available: false, merged: false, reason: "gh is not installed" };
  }
  try {
    const view = prView(
      taskWorktree(repo, task, { required: false }),
      pr.number,
      env,
    );
    return {
      available: true,
      merged: String(view.state ?? "").toUpperCase() === "MERGED",
      state: view.state,
      pr,
      view,
    };
  } catch (error) {
    return {
      available: false,
      merged: false,
      error: true,
      code: error.code ?? ERROR_CODES.GH_AUTH,
      reason: error.message,
    };
  }
}

function abandonCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (["pr_open", "merged", "done"].includes(task.status)) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; abandon is only for tasks that will not ship`,
      { status: task.status },
      "Use `codeflow finish` for a task with a pull request.",
    );
  }

  if (flags.dryRun) {
    return {
      data: {
        taskId,
        worktree: task.worktree,
        wouldRemove: Boolean(existingTaskWorktree(repo, task)),
        dryRun: true,
      },
      taskId,
    };
  }
  if (!flags.confirm) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "abandon requires explicit confirmation",
      { status: task.status },
      "Re-run with `codeflow abandon --confirm`.",
    );
  }

  acquireLock(paths, task.id, {
    command: "abandon",
    force: flags.forceUnlock,
  });
  try {
    let removedWorktree = false;
    const worktree = existingTaskWorktree(repo, task);
    if (worktree) {
      if (!isClean(worktree) && !flags.force) {
        throw new CodedError(
          ERROR_CODES.DIRTY_TREE,
          "the worktree has uncommitted changes",
          { worktree },
          "Commit or discard them, or pass --force.",
        );
      }
      removeWorktree(repo.mainRoot, worktree, { force: flags.force });
      removedWorktree = true;
    }

    let deletedBranch = false;
    if (flags.deleteBranch && task.branch) {
      const result = git(["branch", "-D", task.branch], {
        cwd: repo.mainRoot,
        allowFail: true,
      });
      deletedBranch = result !== null;
    }

    task.status = "abandoned";
    task.blocked = null;
    const activeCleared = clearActive(paths, task.id);
    const event = appendEvent(paths, task.id, "task.abandoned", actor(repo), {
      removedWorktree,
      deletedBranch,
      activeCleared,
    });
    task.lastEventHash = event.hash;
    writeTask(paths, task);

    return {
      data: {
        taskId,
        removedWorktree,
        deletedBranch,
        activeCleared,
        status: "abandoned",
      },
      taskId,
    };
  } finally {
    releaseLock(paths, task.id);
  }
}

function finishCommand(repo, config, flags, env) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "pr_open" && task.status !== "merged") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; finish requires an open or merged pull request`,
      { status: task.status },
      "Use `codeflow abandon --confirm` to discard a task that will not ship.",
    );
  }

  // A recorded PR is always checked when gh can answer. The local status is a
  // hint about where the task stands, never proof that the work merged: a task
  // marked "merged" by some future path must not be able to authorize cleanup
  // on its own.
  const recordedPr = readPr(paths, task.id);
  const detection =
    task.status === "pr_open" || recordedPr
      ? mergeDetection(repo, task, paths, env)
      : {
          available: false,
          merged: false,
          reason: `no pull request is recorded for a ${task.status} task`,
        };
  if (detection.error) {
    throw new CodedError(
      ERROR_CODES.GH_AUTH,
      "could not read the pull request merge state",
      { reason: detection.reason, pr: detection.pr?.number ?? null },
      "Fix `gh auth status` or the network, then retry. Do not use --confirm to bypass a failed merge check.",
    );
  }
  const confirmedByStatus = task.status === "merged" && !detection.available;
  const confirmedByGh = detection.available && detection.merged;
  const confirmedByHuman = flags.confirm && !detection.available;
  const mergeConfirmed =
    confirmedByStatus || confirmedByGh || confirmedByHuman;
  const mergeConfirmedBy = confirmedByStatus
    ? "status"
    : confirmedByGh
      ? "gh"
      : confirmedByHuman
        ? "confirm"
        : null;

  if (!mergeConfirmed) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      detection.available
        ? `the GitHub PR is ${detection.state ?? "not merged"}; finish requires a merged PR`
        : `task is ${task.status}; finish requires a merged task or --confirm when merge detection is unavailable`,
      detection.available
        ? { status: task.status, prState: detection.state }
        : {
            status: task.status,
            mergeDetection: "unavailable",
            reason: detection.reason,
          },
      detection.available
        ? "Merge the PR first, then run `codeflow finish`."
        : "Merge the PR, then run `codeflow finish --confirm`.",
    );
  }

  if (flags.dryRun) {
    return {
      data: {
        taskId,
        worktree: task.worktree,
        wouldRemove: Boolean(existingTaskWorktree(repo, task)),
        mergeConfirmedBy,
        dryRun: true,
      },
      taskId,
    };
  }

  acquireLock(paths, task.id, {
    command: "finish",
    force: flags.forceUnlock,
  });
  try {
    let removedWorktree = false;
    const worktree = existingTaskWorktree(repo, task);
    if (worktree) {
      if (!isClean(worktree) && !flags.force) {
        throw new CodedError(
          ERROR_CODES.DIRTY_TREE,
          "the worktree has uncommitted changes",
          { worktree },
          "Commit or discard them, or pass --force.",
        );
      }
      removeWorktree(repo.mainRoot, worktree, { force: flags.force });
      removedWorktree = true;
    }

    let deletedBranch = false;
    if (flags.deleteBranch && task.branch) {
      const result = git(["branch", "-D", task.branch], {
        cwd: repo.mainRoot,
        allowFail: true,
      });
      deletedBranch = result !== null;
    }

    if (confirmedByGh && detection.pr) {
      writeJsonAtomic(taskFile(paths, task.id, "pr.json"), {
        ...detection.pr,
        state: "merged",
        lastReadAt: nowIso(),
      });
    }

    task.status = "done";
    task.blocked = null;
    const activeCleared = clearActive(paths, task.id);
    const event = appendEvent(paths, task.id, "task.finished", actor(repo), {
      removedWorktree,
      deletedBranch,
      mergeConfirmedBy,
      activeCleared,
    });
    task.lastEventHash = event.hash;
    writeTask(paths, task);

    return {
      data: {
        taskId,
        removedWorktree,
        deletedBranch,
        mergeConfirmedBy,
        activeCleared,
        status: "done",
      },
      taskId,
    };
  } finally {
    releaseLock(paths, task.id);
  }
}

const TASK_TREE_COMMANDS = new Set([
  "status",
  "verify",
  "self-review",
  "approve",
  "pr",
  "watch",
  "comments",
]);

function configForCommand(repo, command, task, projectConfig) {
  if (command === "trust") {
    const localConfig = path.join(repo.root, ".codeflow", "config.json");
    return repo.root !== repo.mainRoot && fileExists(localConfig)
      ? loadConfig(repo.root)
      : projectConfig;
  }
  if (TASK_TREE_COMMANDS.has(command)) {
    const worktree = existingTaskWorktree(repo, task);
    if (worktree) {
      return loadConfig(worktree);
    }
  }
  return projectConfig;
}

function taskWorktreePath(repo, task) {
  if (!task?.worktree) {
    return null;
  }
  return path.isAbsolute(task.worktree)
    ? task.worktree
    : path.resolve(repo.mainRoot, task.worktree);
}

function existingTaskWorktree(repo, task) {
  const worktree = taskWorktreePath(repo, task);
  return worktree && fileExists(worktree) ? worktree : null;
}

function taskWorktree(repo, task, options = {}) {
  const { required = true } = options;
  const worktree = existingTaskWorktree(repo, task);
  if (worktree) {
    return worktree;
  }
  if (!required) {
    return repo.mainRoot;
  }
  throw new CodedError(
    ERROR_CODES.WORKTREE_MISSING,
    "the task worktree is missing",
    { taskId: task.id, worktree: task.worktree },
    "Run `codeflow start` to recreate it, or `codeflow finish` if the task is complete.",
  );
}

function taskTree(repo, task) {
  const worktree = taskWorktree(repo, task);
  assertWorktreeBranch(worktree, task.branch);
  return worktree;
}

function selfReviewCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "verified") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; self-review requires a verified task`,
      { status: task.status },
      "Run `codeflow verify` first.",
    );
  }
  const evidence = readEvidence(paths, task.id);
  if (!evidence || evidence.result !== "pass") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "passing evidence was not found",
      { taskId },
      "Run `codeflow verify` first.",
    );
  }

  const worktree = taskTree(repo, task);
  const plan = readPlan(paths, task.id);
  const review = buildReviewPacket({
    paths,
    task,
    cwd: worktree,
    base: config.baseBranch,
    plan,
    evidence,
    notes: flags.note ?? "",
    scopeDrift: flags.scopeDrift,
    closestLook: flags.closestLook,
  });

  const counts = {
    testFiles: review ? evidence.attention.testFiles.length : 0,
    skips: evidence.attention.skips.length,
    suppressions: evidence.attention.suppressions.length,
    configChanges: evidence.attention.configChanges.length,
    lockfileChanges: evidence.attention.lockfileChanges.length,
  };
  return {
    data: {
      reviewPath: repoRelative(
        repo.mainRoot,
        taskFile(paths, task.id, "REVIEW.md"),
      ),
      diffHash: review.diffHash,
      evidenceHash: review.evidenceHash,
      attention: counts,
      signed: false,
      next: ["approve self-review"],
    },
    taskId,
    warnings:
      counts.skips + counts.suppressions > 0
        ? [
            {
              code: "W_ATTENTION",
              message: "attention items are present in the review packet",
            },
          ]
        : [],
  };
}

async function prCommand(repo, config, flags, env) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "no active task",
      null,
      "Run `codeflow new` or pass --task.",
    );
  }
  const task = readTask(paths, taskId);
  if (!task) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task "${taskId}" was not found`,
      { taskId },
    );
  }
  if (task.status !== "verified" && task.status !== "pr_open") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      `task is ${task.status}; pr requires a verified task`,
      { status: task.status },
      "Run `codeflow verify` and `codeflow approve self-review` first.",
    );
  }

  const approvals = approvalState(paths, task);
  if (!approvals.design || approvals.design.stale) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the design is not approved or has changed",
      { approval: approvals.design },
      "Re-approve the design.",
    );
  }
  if (!approvals.plan || approvals.plan.stale) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the plan is not approved or has changed",
      { approval: approvals.plan },
      "Re-approve the plan.",
    );
  }

  const worktree = taskTree(repo, task);
  if (isDirty(worktree)) {
    throw new CodedError(
      ERROR_CODES.DIRTY_TREE,
      "the worktree has uncommitted changes",
      { worktree },
      "Commit or discard the changes, then retry.",
    );
  }

  const remote = config.remote ?? "origin";
  let rebase = {
    attempted: false,
    rebased: false,
    source: null,
    baseCommit: null,
    conflicts: [],
  };
  if (!flags.noPush && !flags.dryRun) {
    const previousStatus = task.status;
    rebase = {
      attempted: true,
      ...rebaseOntoBase(worktree, remote, config.baseBranch),
    };
    if (!rebase.ok && rebase.reason === "conflict") {
      task.status = "blocked";
      task.blocked = {
        code: ERROR_CODES.REBASE_CONFLICT,
        reason: `rebasing onto ${remote}/${config.baseBranch} produced conflicts`,
        at: nowIso(),
        from: previousStatus,
        hint: "Resolve the conflict manually, then run `codeflow resume`.",
        conflicts: rebase.conflicts,
      };
      const event = appendEvent(paths, task.id, "pr.rebase_conflict", actor(repo), {
        base: `${remote}/${config.baseBranch}`,
        baseCommit: rebase.baseCommit,
        conflicts: rebase.conflicts,
      });
      task.lastEventHash = event.hash;
      writeTask(paths, task);
      throw new CodedError(
        ERROR_CODES.REBASE_CONFLICT,
        `rebase onto ${remote}/${config.baseBranch} produced conflicts`,
        {
          baseCommit: rebase.baseCommit,
          conflicts: rebase.conflicts,
          headBefore: rebase.headBefore,
          headAfter: rebase.headAfter,
          taskStatus: "blocked",
        },
        "Resolve the conflict manually, run `codeflow resume`, then verify again.",
      );
    }
    if (!rebase.ok) {
      throw new CodedError(
        ERROR_CODES.REBASE_FAILED,
        `the task branch could not be rebased onto ${remote}/${config.baseBranch}`,
        {
          reason: rebase.reason,
          stderr: rebase.stderr ?? null,
          headBefore: rebase.headBefore,
          headAfter: rebase.headAfter,
          taskStatus: task.status,
        },
        "Fix the local git state (a blocked hook, a dirty index, or a broken remote ref), then run `codeflow pr` again.",
      );
    }
  }

  const evidence = readEvidence(paths, task.id);
  if (!evidence) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "evidence.json was not found",
      { taskId },
      "Run `codeflow verify` first.",
    );
  }
  const tree = gitTreeHash(worktree);
  const hash = configHash(config);
  if (
    !isFresh(evidence, {
      treeHash: tree,
      configHash: hash,
      gateSetHash: evidence.gateSetHash,
      dirty: false,
      branch: task.branch,
    })
  ) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      rebase.rebased
        ? "the branch was rebased and the evidence no longer matches the tree"
        : "the evidence is missing, stale, or the worktree is dirty",
      {
        treeHash: tree,
        evidenceTree: evidence.treeHash,
        dirty: false,
        rebased: rebase.rebased,
        baseCommit: rebase.baseCommit,
      },
      rebase.rebased
        ? "Run `codeflow verify`, `codeflow self-review`, and `codeflow approve self-review`, then retry."
        : "Commit the work, run `codeflow verify`, then retry.",
    );
  }

  const self = selfReviewFresh(paths, task, {
    cwd: worktree,
    base: config.baseBranch,
  });
  if (!self.fresh) {
    throw new CodedError(
      ERROR_CODES.APPROVAL_STALE,
      "the self-review is missing, stale, or unapproved",
      { reason: self.reason },
      "Run `codeflow self-review` and `codeflow approve self-review`.",
    );
  }

  const plan = readPlan(paths, task.id);
  const openSteps = plan.steps.filter((step) => step.status !== "done");
  if (openSteps.length > 0) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "the plan still has open steps",
      {
        open: openSteps.map((step) => ({
          id: step.id,
          status: step.status,
          title: step.title,
        })),
      },
      "Record progress with `codeflow plan step <id> --status done --result \"...\"`.",
    );
  }
  const taskSpec = readText(taskFile(paths, task.id, "TASK.md"));
  if (!durableUpdates(taskSpec)) {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "TASK.md has no durable updates record",
      { taskId },
      "Add a `## Durable updates` section listing the specs, README sections, or ADRs you changed, or write `Not durable — <reason>`.",
    );
  }
  const templateFile = path.resolve(worktree, config.pr.template);
  if (!isContained(worktree, templateFile)) {
    throw new CodedError(
      ERROR_CODES.CONFIG,
      "pr.template escapes the task worktree",
      { template: config.pr.template },
      "Use a repository-relative template path.",
    );
  }
  const template = fileExists(templateFile) ? readText(templateFile) : "";
  const body = renderPrBody({
    template,
    task,
    taskSpec,
    plan,
    evidence,
    config,
    review: self.review,
    diffStatText: diffStat(worktree, config.baseBranch),
  });
  const bodyPath = taskFile(paths, task.id, "PR_BODY.md");
  writeTextAtomic(bodyPath, body);
  const title = titleFor(task, config);
  const mode = hasGh(env) ? "gh" : "compare";

  if (flags.dryRun) {
    return {
      data: {
        mode,
        title,
        bodyPath: repoRelative(repo.mainRoot, bodyPath),
        dryRun: true,
      },
      taskId,
    };
  }

  if (flags.noPush) {
    return {
      data: {
        mode,
        title,
        bodyPath: repoRelative(repo.mainRoot, bodyPath),
        rendered: true,
        pushed: false,
      },
      taskId,
      warnings: [
        {
          code: "W_RENDER_ONLY",
          message: "rendered the pull request body; nothing was pushed or created",
        },
      ],
    };
  }

  if (!flags.noPush) {
    const pushArgs = ["push", "-u"];
    if (rebase.rebased) {
      pushArgs.push("--force-with-lease");
    }
    pushArgs.push(remote, task.branch);
    // A push over a slow link can outlive the default 30s git timeout, and a
    // silent failure here is impossible to diagnose from the envelope. Keep the
    // stderr tail and say when the push timed out.
    const pushed = gitResult(pushArgs, { cwd: worktree, timeout: 120000 });
    if (!pushed.ok) {
      throw new CodedError(
        ERROR_CODES.PUSH_FAILED,
        pushed.timedOut
          ? `the push to ${remote} timed out`
          : "the task branch could not be pushed",
        {
          remote,
          branch: task.branch,
          rebased: rebase.rebased,
          timedOut: pushed.timedOut,
          stderr: pushed.stderr.trim().split(/\r?\n/).slice(-20).join("\n"),
        },
        pushed.timedOut
          ? "The remote did not answer in time. Check the network, then retry."
          : rebase.rebased
            ? "The rebase rewrote the branch and the lease failed. Fetch the remote, confirm nobody else updated the branch, then retry."
            : "Check the remote and your credentials, then retry.",
      );
    }
  }

  let pr;
  if (mode === "gh") {
    const created = createOrUpdatePr({
      cwd: worktree,
      base: config.baseBranch,
      branch: task.branch,
      title,
      bodyPath,
      env,
    });
    const localHead = git(["rev-parse", "HEAD"], { cwd: worktree });
    if (created.headSha && created.headSha !== localHead) {
      throw new CodedError(
        ERROR_CODES.PUSH_FAILED,
        "the pull request head does not match the verified commit",
        { localHead, prHead: created.headSha },
        "Push the task branch and retry; do not deliver an unverified head.",
      );
    }
    pr = {
      schemaVersion: 1,
      taskId: task.id,
      mode: "gh",
      number: created.number,
      url: created.url,
      state: String(created.state ?? "OPEN").toLowerCase(),
      title,
      bodyPath: repoRelative(repo.mainRoot, bodyPath),
      headSha: localHead,
      baseBranch: config.baseBranch,
      compareUrl: null,
      mergeStateStatus: created.mergeStateStatus ?? null,
      reviewDecision: created.reviewDecision ?? null,
      createdAt: nowIso(),
      lastReadAt: nowIso(),
      checks: created.checks,
    };
  } else {
    const remoteUrl = gitOrNull(["remote", "get-url", config.remote ?? "origin"], {
      cwd: repo.mainRoot,
    });
    pr = {
      schemaVersion: 1,
      taskId: task.id,
      mode: "compare",
      number: null,
      url: null,
      state: "open",
      title,
      bodyPath: repoRelative(repo.mainRoot, bodyPath),
      headSha: git(["rev-parse", "HEAD"], { cwd: worktree }),
      baseBranch: config.baseBranch,
      compareUrl: compareUrl(remoteUrl, config.baseBranch, task.branch),
      createdAt: nowIso(),
      lastReadAt: nowIso(),
      checks: null,
    };
  }

  writeJsonAtomic(taskFile(paths, task.id, "pr.json"), pr);
  task.status = "pr_open";
  task.blocked = null;
  const event = appendEvent(paths, task.id, "pr.created", actor(repo), {
    mode: pr.mode,
    number: pr.number,
    url: pr.url ?? pr.compareUrl,
    rebased: rebase.rebased,
    baseCommit: rebase.baseCommit,
  });
  task.lastEventHash = event.hash;
  writeTask(paths, task);

  const warnings = [];
  if (pr.mode === "compare") {
    warnings.push({
      code: "W_GH_MISSING",
      message: "gh is unavailable; pushed a compare URL instead of a PR",
    });
  }
  if (rebase.attempted && rebase.reason === "no-base") {
    warnings.push({
      code: "W_BASE_MISSING",
      message: `could not resolve ${remote}/${config.baseBranch}; skipped the pre-push rebase`,
    });
  } else if (rebase.attempted && rebase.source === "local") {
    warnings.push({
      code: "W_BASE_LOCAL",
      message: `could not fetch ${remote}/${config.baseBranch}; rebased onto the local ${config.baseBranch}`,
    });
  }
  if (rebase.rebased) {
    warnings.push({
      code: "W_REBASED",
      message: `rebased onto ${remote}/${config.baseBranch} and force-pushed with lease`,
    });
  }

  return {
    data: {
      mode: pr.mode,
      number: pr.number,
      url: pr.url,
      compareUrl: pr.compareUrl,
      bodyPath: pr.bodyPath,
      headSha: pr.headSha,
      checks: pr.checks,
      rebased: rebase.rebased,
      baseCommit: rebase.baseCommit,
    },
    taskId,
    warnings,
  };
}

async function watchCommand(repo, config, flags, env) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(ERROR_CODES.STATE_CONFLICT, "no active task");
  }
  const task = readTask(paths, taskId);
  if (!task || task.status !== "pr_open") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "watch requires an open PR",
      { status: task?.status ?? null },
    );
  }
  let pr = readPr(paths, task.id);
  if (!pr || pr.mode !== "gh" || !pr.number) {
    throw new CodedError(
      ERROR_CODES.GH_MISSING,
      "no GitHub PR is recorded for this task",
      { mode: pr?.mode ?? null },
      "Use the compare URL printed by `codeflow pr`.",
    );
  }  const worktree = taskTree(repo, task);
  let status = prView(worktree, pr.number, env);
  let checks = status.checks;
  let waited = false;
  let timedOut = false;
  let polls = 0;
  if (flags.wait) {
    const timeoutValue = Number(
      flags.timeout ?? process.env.CODEFLOW_WATCH_TIMEOUT_SEC ?? 300,
    );
    const intervalValue = Number(
      flags.interval ?? process.env.CODEFLOW_WATCH_INTERVAL_MS ?? 5000,
    );
    if (!Number.isFinite(timeoutValue) || timeoutValue < 0) {
      throw new CodedError(
        ERROR_CODES.USAGE,
        "--timeout must be a non-negative number of seconds",
      );
    }
    if (!Number.isFinite(intervalValue) || intervalValue < 1) {
      throw new CodedError(
        ERROR_CODES.USAGE,
        "--interval must be a positive number of milliseconds",
      );
    }
    const timeoutMs = timeoutValue * 1000;
    const interval = Math.round(intervalValue);
    const deadline = Date.now() + timeoutMs;
    const maxPolls = Number(
      process.env.CODEFLOW_WATCH_ATTEMPTS ?? Number.MAX_SAFE_INTEGER,
    );
    while (
      checks.state === "pending" &&
      Date.now() < deadline &&
      polls < maxPolls
    ) {
      const remaining = Math.max(0, deadline - Date.now());
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(interval, remaining)),
      );
      status = prView(worktree, pr.number, env);
      checks = status.checks;
      waited = true;
      polls += 1;
    }
    timedOut = checks.state === "pending" && Date.now() >= deadline;
  }
  acquireLock(paths, task.id, {
    command: "watch",
    force: flags.forceUnlock,
  });
  try {
    pr = readPr(paths, task.id) ?? pr;
    pr.checks = checks;
    pr.state = String(status.state ?? "").toLowerCase() || pr.state;
    pr.observedAt = nowIso();
    pr.mergeStateStatus = status.mergeStateStatus;
    pr.reviewDecision = status.reviewDecision;
    pr.headSha = status.headSha;
    pr.lastReadAt = pr.observedAt;
    writeJsonAtomic(taskFile(paths, task.id, "pr.json"), pr);
  } finally {
    releaseLock(paths, task.id);
  }
  return {
    data: {
      state: checks.state,
      checks,
      mergeStateStatus: status.mergeStateStatus,
      reviewDecision: status.reviewDecision,
      headSha: status.headSha,
      lastReadAt: pr.lastReadAt,
      waited,
      polls,
      timedOut,
    },
    taskId,
    warnings: timedOut
      ? [
          {
            code: "W_CHECKS_PENDING",
            message: "checks were still pending when the wait timeout expired",
          },
        ]
      : [],
  };
}

function commentsCommand(repo, config, flags, env) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId;
  if (!taskId) {
    throw new CodedError(ERROR_CODES.STATE_CONFLICT, "no active task");
  }
  const task = readTask(paths, taskId);
  if (!task || task.status !== "pr_open") {
    throw new CodedError(
      ERROR_CODES.STATE_CONFLICT,
      "comments requires an open PR",
      { status: task?.status ?? null },
    );
  }
  const pr = readPr(paths, task.id);
  if (!pr || pr.mode !== "gh" || !pr.number) {
    throw new CodedError(
      ERROR_CODES.GH_MISSING,
      "no GitHub PR is recorded for this task",
      { mode: pr?.mode ?? null },
    );
  }
  const worktree = taskTree(repo, task);
  const data = readComments(worktree, pr.number, env);
  const lines = [
    `# Review comments — ${task.id}`,
    "",
    `PR: #${pr.number}`,
    "",
    "## Review threads",
    ...(data.resolutionAvailable
      ? data.threads.length === 0
        ? ["- None."]
        : data.threads.map((thread) => {
            const first = thread.comments[0];
            return `- [${thread.isResolved ? "resolved" : "open"}] ${first?.author ?? "unknown"} at \`${thread.path ?? "?"}:${thread.line ?? "?"}\`: ${first?.body || "(no body)"}`;
          })
      : ["- Resolution state unavailable; showing inline comments only."]),
    "",
    "## Reviews",
    ...(data.reviews.length === 0
      ? ["- None."]
      : data.reviews.map(
          (review) =>
            `- ${review.author} (${review.state ?? "COMMENTED"}): ${review.body || "(no body)"}`,
        )),
    "",
    "## Inline comments",
    ...(data.comments.length === 0
      ? ["- None."]
      : data.comments.map(
          (comment) =>
            `- ${comment.author} at \`${comment.path ?? "?"}:${comment.line ?? "?"}\`: ${comment.body}`,
        )),
  ];
  acquireLock(paths, task.id, {
    command: "comments",
    force: flags.forceUnlock,
  });
  try {
    writeJsonAtomic(taskFile(paths, task.id, "comments.json"), data);
    writeTextAtomic(
      taskFile(paths, task.id, "COMMENTS.md"),
      `${lines.join("\n")}\n`,
    );
  } finally {
    releaseLock(paths, task.id);
  }
  return {
    data: {
      threads: data.resolutionAvailable
        ? data.threads.length
        : data.comments.length,
      reviews: data.reviews.length,
      path: repoRelative(repo.mainRoot, taskFile(paths, task.id, "COMMENTS.md")),
      resolutionAvailable: data.resolutionAvailable,
      resolved: data.resolved,
      unresolved: data.unresolved,
    },
    taskId,
  };
}

function nextFor(status) {
  const map = {
    created: ["edit TASK.md", "approve design"],
    designed: ["plan"],
    planned: ["start"],
    active: ["verify"],
    verified: ["self-review", "pr"],
    pr_open: ["watch", "comments"],
    merged: ["finish"],
    done: [],
    blocked: ["resume"],
    abandoned: [],
  };
  return map[status] ?? [];
}

function statusCommand(repo, config, flags) {
  const paths = statePaths(repo.mainRoot, repo.projectConfig);
  const active = readActive(paths);
  const taskId = flags.task ?? active?.taskId ?? null;

  let task = null;
  if (taskId) {
    task = readTask(paths, taskId);
    if (!task) {
      throw new CodedError(
        ERROR_CODES.STATE_CONFLICT,
        `task "${taskId}" was not found`,
        { taskId },
        "Run `codeflow status` without --task to see the active task.",
      );
    }
  }

  const hash = configHash(config);
  const trusted = isTrusted(paths, config);

  let evidence = null;
  if (task) {
    const value = readJsonSafe(taskFile(paths, task.id, "evidence.json"));
    if (value) {
      const evidenceCwd = existingTaskWorktree(repo, task);
      const tree = evidenceCwd
        ? gitOrNull(["rev-parse", "HEAD^{tree}"], { cwd: evidenceCwd })
        : null;
      evidence = {
        result: value.result,
        treeHash: value.treeHash,
        finishedAt: value.finishedAt,
        fresh: Boolean(
          value.result === "pass" &&
            value.dirty === false &&
            tree &&
            value.treeHash === `git:${tree}` &&
            value.configHash === hash &&
            value.branch === task.branch,
        ),
      };
    }
  }

  let pr = null;
  if (task) {
    const value = readPr(paths, task.id);
    if (value) {
      pr = {
        mode: value.mode,
        number: value.number ?? null,
        url: value.url ?? null,
        state: value.state ?? null,
        checks: value.checks ?? null,
      };
    }
  }

  const approvals = task ? approvalState(paths, task) : null;
  if (task && approvals?.selfReview) {
    const worktree = existingTaskWorktree(repo, task);
    let fresh = false;
    if (worktree) {
      try {
        fresh = selfReviewFresh(paths, task, {
          cwd: worktree,
          base: config.baseBranch,
        }).fresh;
      } catch {
        fresh = false;
      }
    }
    approvals.selfReview.stale = !fresh;
  }
  let next = task ? nextFor(task.status) : ["new"];
  const warnings = [];
  if (approvals?.design?.stale) {
    next = ["approve design"];
    warnings.push({
      code: "W_APPROVAL_STALE",
      message: "TASK.md changed since design approval",
    });
  } else if (approvals?.plan?.stale) {
    next = ["approve plan"];
    warnings.push({
      code: "W_APPROVAL_STALE",
      message: "plan.json changed since plan approval",
    });
  } else if (approvals?.selfReview && !approvals.selfReview.stale) {
    next = next.filter((step) => step !== "self-review");
  }

  return {
    data: {
      repo: {
        root: repo.mainRoot,
        baseBranch: repo.baseBranch,
        remote: repo.remote,
      },
      task: task
        ? {
            id: task.id,
            title: task.title,
            kind: task.kind,
            status: task.status,
            branch: task.branch,
            worktree: task.worktree,
          }
        : null,
      next,
      approvals,
      trust: { trusted, configHash: hash },
      evidence,
      pr,
      blocked: task?.blocked ?? null,
    },
    taskId,
    warnings,
  };
}

function doctorCommand(repo, config, configError, env) {
  return {
    data: runDoctor(repo, config, configError, env),
  };
}

export async function run(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const envelope = fail("codeflow", error, {});
    emit(envelope, { json: argv.includes("--json") }, out, err);
    return exitFor(error.code);
  }

  const { flags, positional } = parsed;
  if (flags.version) {
    out.write(`codeflow ${CLI_VERSION}\n`);
    return EXIT.OK;
  }
  if (flags.help || positional.length === 0) {
    out.write(HELP);
    return EXIT.OK;
  }

  const command = positional[0];
  const meta = { repoRoot: null, taskId: flags.task ?? null };
  let lockPaths = null;
  let heldTaskLock = null;
  let heldProjectLock = false;

  try {
    if (!COMMANDS.has(command)) {
      throw new CodedError(
        ERROR_CODES.USAGE,
        `unknown command "${command}"`,
        null,
        "Run `codeflow --help`.",
      );
    }
    const repo = findRepo(cwd);
    meta.repoRoot = repo.mainRoot;
    assertStateNotTracked(repo);

    let projectConfig = null;
    let configError = null;
    let task = null;
    let paths = null;
    if (command !== "init") {
      try {
        projectConfig = loadConfig(repo.mainRoot);
        repo.projectConfig = projectConfig;
      } catch (error) {
        configError = error;
      }
      if (projectConfig) {
        assertStateNotTracked(repo, projectConfig.stateDir);
      }
      if (!projectConfig && command !== "doctor") {
        throw configError;
      }
      if (projectConfig) {
        paths = statePaths(repo.mainRoot, projectConfig);
        const active = readActive(paths);
        const taskId = flags.task ?? active?.taskId ?? null;
        meta.taskId = taskId;
        if (taskId) {
          task = readTask(paths, taskId);
        }
      }
    }

    const config = projectConfig
      ? configForCommand(repo, command, task, projectConfig)
      : null;

    if (paths && task && TASK_LOCK_COMMANDS.has(command)) {
      acquireLock(paths, task.id, {
        command,
        force: flags.forceUnlock,
      });
      lockPaths = paths;
      heldTaskLock = task.id;
    }
    if (paths && (command === "new" || command === "trust")) {
      acquireProjectLock(paths, {
        command,
        force: flags.forceUnlock,
      });
      lockPaths = paths;
      heldProjectLock = true;
    }

    let result;
    switch (command) {
      case "init": {
        result = initCommand(repo, flags);
        break;
      }
      case "new": {
        result = newCommand(repo, config, flags, positional);
        break;
      }
      case "approve": {
        result = approveCommand(repo, config, flags, positional);
        break;
      }
      case "plan": {
        result =
          positional[1] === "step"
            ? planStepCommand(repo, config, flags, positional)
            : planCommand(repo, config, flags);
        break;
      }
      case "trust": {
        result = trustCommand(repo, config, flags);
        break;
      }
      case "verify": {
        result = verifyCommand(repo, config, flags);
        break;
      }
      case "start": {
        result = startCommand(repo, config, flags);
        break;
      }
      case "resume": {
        result = resumeCommand(repo, config, flags);
        break;
      }
      case "finish": {
        result = finishCommand(repo, config, flags, env);
        break;
      }
      case "abandon": {
        result = abandonCommand(repo, config, flags);
        break;
      }
      case "self-review": {
        result = selfReviewCommand(repo, config, flags);
        break;
      }
      case "pr": {
        result = await prCommand(repo, config, flags, env);
        break;
      }
      case "watch": {
        result = await watchCommand(repo, config, flags, env);
        break;
      }
      case "comments": {
        result = commentsCommand(repo, config, flags, env);
        break;
      }
      case "status": {
        result = statusCommand(repo, config, flags);
        break;
      }
      case "doctor": {
        result = doctorCommand(repo, projectConfig, configError, env);
        break;
      }
      default:
        throw new CodedError(
          ERROR_CODES.USAGE,
          `unknown command "${command}"`,
          null,
          "Run `codeflow --help`.",
        );
    }

    const resultMeta = {
      repoRoot: repo.mainRoot,
      taskId: result.taskId ?? flags.task ?? null,
    };
    const envelope = result.failure
      ? failWithData(
          command,
          result.failure,
          result.data ?? null,
          resultMeta,
          result.warnings ?? [],
        )
      : ok(command, result.data, resultMeta, result.warnings ?? []);
    emit(envelope, flags, out, err);
    return result.exitCode ?? EXIT.OK;
  } catch (error) {
    const coded =
      error instanceof CodedError
        ? error
        : new CodedError(ERROR_CODES.INTERNAL, error?.message ?? String(error));
    const envelope = fail(command, coded.toJSON(), meta);
    emit(envelope, flags, out, err);
    return exitFor(coded.code);
  } finally {
    if (heldTaskLock && lockPaths) {
      releaseLock(lockPaths, heldTaskLock);
    }
    if (heldProjectLock && lockPaths) {
      releaseProjectLock(lockPaths);
    }
  }
}
