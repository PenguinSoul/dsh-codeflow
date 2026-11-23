import { spawnSync } from "node:child_process";
import path from "node:path";
import { CodedError, ERROR_CODES } from "./contracts.mjs";
import { ensureDir } from "./util.mjs";

export function git(args, options = {}) {
  const {
    cwd,
    allowFail = false,
    timeout = 30000,
    env = process.env,
  } = options;
  const result = spawnSync("git", args, {
    cwd,
    timeout,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFail) {
      return null;
    }
    throw new CodedError(
      ERROR_CODES.INTERNAL,
      `git ${args.join(" ")} could not run: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    if (allowFail) {
      return null;
    }
    throw new CodedError(
      ERROR_CODES.NOT_REPO,
      `git ${args.join(" ")} failed`,
      { status: result.status, stderr: result.stderr.trim() },
    );
  }
  return result.stdout.trim();
}

export function gitOrNull(args, options = {}) {
  return git(args, { ...options, allowFail: true });
}

// Like git(), but keeps stdout/stderr even when the command fails, so callers
// can report why a command could not run.
export function gitResult(args, options = {}) {
  const {
    cwd,
    timeout = 30000,
    env = process.env,
  } = options;
  const result = spawnSync("git", args, {
    cwd,
    timeout,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? -1,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

export function isGitRepo(cwd) {
  return gitOrNull(["rev-parse", "--is-inside-work-tree"], { cwd }) === "true";
}

export function gitVersion() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function worktreeList(cwd) {
  const entries = [];
  let current = null;
  for (const line of git(["worktree", "list", "--porcelain"], { cwd }).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { worktree: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export function branchExists(cwd, branch) {
  return Boolean(
    gitOrNull(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd }),
  );
}

export function addWorktree(cwd, options) {
  const { worktree, branch, base } = options;
  ensureDir(path.dirname(worktree));
  const existing = worktreeList(cwd).find((entry) => entry.worktree === worktree);
  if (existing) {
    return { created: false, reusedBranch: Boolean(existing.branch) };
  }
  if (branchExists(cwd, branch)) {
    git(["worktree", "add", worktree, branch], { cwd });
    return { created: true, reusedBranch: true };
  }
  git(["worktree", "add", "-b", branch, worktree, base], { cwd });
  return { created: true, reusedBranch: false };
}

export function removeWorktree(cwd, worktree, options = {}) {
  const args = ["worktree", "remove"];
  if (options.force) {
    args.push("--force");
  }
  args.push(worktree);
  git(args, { cwd });
}

export function isClean(cwd) {
  return git(["status", "--porcelain"], { cwd }).length === 0;
}

export function assertWorktreeBranch(cwd, branch) {
  const current = git(["branch", "--show-current"], { cwd });
  if (current !== branch) {
    throw new CodedError(
      ERROR_CODES.WORKTREE_MISMATCH,
      "the task worktree is not on the task branch",
      { expected: branch, actual: current || "(detached)" },
      "Check out the task branch in the worktree, or run `codeflow start` again.",
    );
  }
  return current;
}

function resolveBaseRef(cwd, remote, base) {
  if (remote) {
    const fetched = gitOrNull(["fetch", "--quiet", remote, base], { cwd });
    if (fetched !== null) {
      const fetchedCommit = gitOrNull(["rev-parse", "--verify", "FETCH_HEAD"], {
        cwd,
      });
      if (fetchedCommit) {
        return { ref: "FETCH_HEAD", source: "fetch", fetched: true };
      }
    }
    const remoteRef = `refs/remotes/${remote}/${base}`;
    if (gitOrNull(["rev-parse", "--verify", remoteRef], { cwd })) {
      return { ref: remoteRef, source: "remote", fetched: false };
    }
  }
  if (gitOrNull(["rev-parse", "--verify", `refs/heads/${base}`], { cwd })) {
    return { ref: `refs/heads/${base}`, source: "local", fetched: false };
  }
  return { ref: null, source: null, fetched: false };
}

export function rebaseOntoBase(cwd, remote, base) {
  const headBefore = git(["rev-parse", "HEAD"], { cwd });
  const resolved = resolveBaseRef(cwd, remote, base);
  if (!resolved.ref) {
    return {
      ok: true,
      rebased: false,
      reason: "no-base",
      source: null,
      fetched: resolved.fetched,
      baseCommit: null,
      headBefore,
      headAfter: headBefore,
      conflicts: [],
    };
  }

  const baseCommit = git(["rev-parse", resolved.ref], { cwd });
  const upToDate =
    gitOrNull(["merge-base", "--is-ancestor", baseCommit, "HEAD"], { cwd }) !==
    null;
  if (upToDate) {
    return {
      ok: true,
      rebased: false,
      reason: "up-to-date",
      source: resolved.source,
      fetched: resolved.fetched,
      baseCommit,
      headBefore,
      headAfter: headBefore,
      conflicts: [],
    };
  }

  const rebased = gitResult(["rebase", resolved.ref], { cwd });
  if (!rebased.ok) {
    const conflicts = (gitOrNull(
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd },
    ) ?? "")
      .split(/\r?\n/)
      .filter(Boolean);
    gitOrNull(["rebase", "--abort"], { cwd });
    // A non-zero rebase with no unmerged paths is not a conflict: a blocked
    // pre-rebase hook, a dirty index, or a spawn failure all land here.
    const reason = conflicts.length > 0 ? "conflict" : "failed";
    return {
      ok: false,
      rebased: false,
      reason,
      source: resolved.source,
      fetched: resolved.fetched,
      baseCommit,
      headBefore,
      headAfter: gitOrNull(["rev-parse", "HEAD"], { cwd }) ?? headBefore,
      conflicts,
      stderr: rebased.stderr.trim().split(/\r?\n/).slice(-20).join("\n"),
    };
  }

  return {
    ok: true,
    rebased: true,
    reason: "rebased",
    source: resolved.source,
    fetched: resolved.fetched,
    baseCommit,
    headBefore,
    headAfter: git(["rev-parse", "HEAD"], { cwd }),
    conflicts: [],
  };
}

