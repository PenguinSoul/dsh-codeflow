export const SCHEMA_VERSION = 1;
export const CLI_VERSION = "0.1.0";

export const EXIT = Object.freeze({
  OK: 0,
  GATE: 1,
  USAGE: 2,
  STATE: 3,
  GIT: 4,
  GITHUB: 5,
  TRUST: 6,
  BLOCKED: 7,
  INTERNAL: 8,
});

export const ERROR_CODES = Object.freeze({
  USAGE: "E_USAGE",
  NOT_REPO: "E_NOT_REPO",
  CONFIG: "E_CONFIG",
  SCHEMA_UNSUPPORTED: "E_SCHEMA_UNSUPPORTED",
  STATE_TRACKED: "E_STATE_TRACKED",
  WORKTREE_MISSING: "E_WORKTREE_MISSING",
  WORKTREE_MISMATCH: "E_WORKTREE_MISMATCH",
  TRUST_REQUIRED: "E_TRUST_REQUIRED",
  TRUST_STALE: "E_TRUST_STALE",
  STATE_CONFLICT: "E_STATE_CONFLICT",
  APPROVAL_STALE: "E_APPROVAL_STALE",
  LOCKED: "E_LOCKED",
  GATE_FAILED: "E_GATE_FAILED",
  GATE_TIMEOUT: "E_GATE_TIMEOUT",
  DIRTY_TREE: "E_DIRTY_TREE",
  REBASE_CONFLICT: "E_REBASE_CONFLICT",
  REBASE_FAILED: "E_REBASE_FAILED",
  PUSH_FAILED: "E_PUSH_FAILED",
  GH_MISSING: "E_GH_MISSING",
  GH_AUTH: "E_GH_AUTH",
  PR_EXISTS: "E_PR_EXISTS",
  BLOCKED: "E_BLOCKED",
  INTERNAL: "E_INTERNAL",
});

const EXIT_BY_CODE = Object.freeze({
  [ERROR_CODES.USAGE]: EXIT.USAGE,
  [ERROR_CODES.NOT_REPO]: EXIT.USAGE,
  [ERROR_CODES.CONFIG]: EXIT.USAGE,
  [ERROR_CODES.SCHEMA_UNSUPPORTED]: EXIT.USAGE,
  [ERROR_CODES.STATE_TRACKED]: EXIT.TRUST,
  [ERROR_CODES.WORKTREE_MISSING]: EXIT.STATE,
  [ERROR_CODES.WORKTREE_MISMATCH]: EXIT.STATE,
  [ERROR_CODES.TRUST_REQUIRED]: EXIT.TRUST,
  [ERROR_CODES.TRUST_STALE]: EXIT.TRUST,
  [ERROR_CODES.STATE_CONFLICT]: EXIT.STATE,
  [ERROR_CODES.APPROVAL_STALE]: EXIT.STATE,
  [ERROR_CODES.LOCKED]: EXIT.STATE,
  [ERROR_CODES.GATE_FAILED]: EXIT.GATE,
  [ERROR_CODES.GATE_TIMEOUT]: EXIT.GATE,
  [ERROR_CODES.DIRTY_TREE]: EXIT.GIT,
  [ERROR_CODES.REBASE_CONFLICT]: EXIT.GIT,
  [ERROR_CODES.REBASE_FAILED]: EXIT.GIT,
  [ERROR_CODES.PUSH_FAILED]: EXIT.GIT,
  [ERROR_CODES.GH_MISSING]: EXIT.GITHUB,
  [ERROR_CODES.GH_AUTH]: EXIT.GITHUB,
  [ERROR_CODES.PR_EXISTS]: EXIT.GITHUB,
  [ERROR_CODES.BLOCKED]: EXIT.BLOCKED,
  [ERROR_CODES.INTERNAL]: EXIT.INTERNAL,
});

export class CodedError extends Error {
  constructor(code, message, details = null, hint = null) {
    super(message);
    this.name = "CodedError";
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

export function error(code, message, details = null, hint = null) {
  return { code, message, details, hint };
}

export function exitFor(code) {
  return EXIT_BY_CODE[code] ?? EXIT.INTERNAL;
}

function metaWith({ repoRoot = null, taskId = null } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    taskId,
    cliVersion: CLI_VERSION,
  };
}

export function ok(command, data, meta = {}, warnings = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: true,
    data,
    error: null,
    warnings,
    meta: metaWith(meta),
  };
}

function errorValue(err) {
  return err instanceof CodedError
    ? err.toJSON()
    : err && typeof err === "object" && typeof err.code === "string"
      ? {
          code: err.code,
          message: err.message ?? "",
          details: err.details ?? null,
          hint: err.hint ?? null,
        }
      : error(ERROR_CODES.INTERNAL, err?.message ?? String(err));
}

// Commands that fail but still produce a report (currently only `verify`) keep
// their `data` so the caller can render the gate table. Every other failure
// drops it; see "Envelope" in docs/contracts.md.
export function failWithData(command, err, data, meta = {}, warnings = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    data,
    error: errorValue(err),
    warnings,
    meta: metaWith(meta),
  };
}

export function fail(command, err, meta = {}) {
  const value = errorValue(err);
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    data: null,
    error: value,
    warnings: [],
    meta: metaWith(meta),
  };
}
