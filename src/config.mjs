import path from "node:path";
import { CodedError, ERROR_CODES } from "./contracts.mjs";
import { assertSchema } from "./schema.mjs";
import {
  fileExists,
  isPlainObject,
  readText,
  sha256,
  stableStringify,
  writeJsonAtomic,
} from "./util.mjs";

export const CONFIG_SCHEMA_VERSION = 1;

const GATE_TIERS = new Set(["fast", "full", "live"]);
const KINDS = new Set(["code", "docs", "infra", "test", "mixed"]);

export function configPath(root) {
  return path.join(root, ".codeflow", "config.json");
}

export function detectPackageManager(root) {
  const markers = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, manager] of markers) {
    if (fileExists(path.join(root, file))) {
      return manager;
    }
  }
  return "npm";
}

function gate(overrides) {
  return {
    name: overrides.name,
    command: overrides.command,
    cwd: overrides.cwd ?? ".",
    tier: overrides.tier ?? "fast",
    kinds: overrides.kinds ?? ["code", "test", "infra"],
    required: overrides.required ?? true,
    timeoutSec: overrides.timeoutSec ?? 300,
  };
}

export function detectGates(root) {
  const gates = new Map();
  const add = (value) => {
    if (!gates.has(value.name)) {
      gates.set(value.name, value);
    }
  };

  const pkgFile = path.join(root, "package.json");
  if (fileExists(pkgFile)) {
    let pkg = null;
    try {
      pkg = JSON.parse(readText(pkgFile));
    } catch {
      pkg = null;
    }
    const scripts = isPlainObject(pkg?.scripts) ? pkg.scripts : {};
    const manager = detectPackageManager(root);
    const commandFor = (script) => `${manager} run ${script}`;
    const candidates = [
      ["lint", "lint", "fast", true, ["code", "test", "infra"], 300],
      ["typecheck", "typecheck", "fast", true, ["code", "test", "infra"], 300],
      ["test", "test", "fast", true, ["code", "test", "infra"], 600],
      ["e2e", "e2e", "full", false, ["code"], 900],
    ];
    for (const [name, script, tier, required, kinds, timeoutSec] of candidates) {
      if (typeof scripts[script] === "string" && scripts[script].trim()) {
        add(gate({ name, command: commandFor(script), tier, required, kinds, timeoutSec }));
      }
    }
  }

  const pyproject = path.join(root, "pyproject.toml");
  if (fileExists(pyproject)) {
    const text = readText(pyproject);
    if (/\[tool\.ruff|(^|\n)\s*ruff\s*[=<>]/m.test(text)) {
      add(gate({ name: "lint", command: "ruff check ." }));
    }
    if (/\[tool\.mypy|(^|\n)\s*mypy\s*[=<>]/m.test(text)) {
      add(gate({ name: "typecheck", command: "mypy ." }));
    }
    if (
      /\[tool\.pytest|(^|\n)\s*pytest\s*[=<>]/m.test(text) ||
      fileExists(path.join(root, "tests"))
    ) {
      add(gate({ name: "test", command: "pytest", timeoutSec: 600, kinds: ["code", "test"] }));
    }
  }

  if (fileExists(path.join(root, "go.mod"))) {
    add(gate({ name: "lint", command: "go vet ./..." }));
    add(gate({ name: "test", command: "go test ./...", timeoutSec: 600 }));
  }

  if (fileExists(path.join(root, "Cargo.toml"))) {
    add(gate({ name: "lint", command: "cargo clippy --all-targets -- -D warnings" }));
    add(gate({ name: "test", command: "cargo test", timeoutSec: 600 }));
  }

  return [...gates.values()];
}

export function defaultConfig(repo) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    baseBranch: repo.baseBranch || "main",
    remote: repo.remote ?? "origin",
    worktreeRoot: "~/.local/state/codeflow/worktrees",
    stateDir: ".codeflow/state",
    gates: [],
    verify: {
      retryFlaky: true,
      maxRetries: 1,
    },
    pr: {
      template: ".github/PULL_REQUEST_TEMPLATE.md",
      screenshots: "manual",
      titlePrefix: "",
      sections: {},
    },
    attention: {
      largeDiffFiles: 25,
      largeDiffLines: 1200,
      failOn: [],
    },
  };
}

export function detectConfig(repo) {
  const config = defaultConfig(repo);
  config.gates = detectGates(repo.root);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return ["config must be a JSON object"];
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    errors.push(`config schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (typeof config.baseBranch !== "string" || !config.baseBranch.trim()) {
    errors.push("baseBranch must be a non-empty string");
  }
  if (config.remote !== null && typeof config.remote !== "string") {
    errors.push("remote must be a string or null");
  }
  if (typeof config.worktreeRoot !== "string" || !config.worktreeRoot.trim()) {
    errors.push("worktreeRoot must be a non-empty string");
  }
  if (typeof config.stateDir !== "string" || !config.stateDir.trim()) {
    errors.push("stateDir must be a non-empty string");
  } else if (path.isAbsolute(config.stateDir) || config.stateDir.split("/").includes("..")) {
    errors.push("stateDir must be repository-relative and must not escape the repository");
  }

  if (!Array.isArray(config.gates)) {
    errors.push("gates must be an array");
  } else {
    const names = new Set();
    config.gates.forEach((entry, index) => {
      const at = `gates[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        errors.push(`${at}.name must be a non-empty string`);
      } else if (names.has(entry.name)) {
        errors.push(`${at}.name "${entry.name}" is duplicated`);
      } else {
        names.add(entry.name);
      }
      if (typeof entry.command !== "string" || !entry.command.trim()) {
        errors.push(`${at}.command must be a non-empty string`);
      }
      if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
        errors.push(`${at}.cwd must be a string`);
      }
      if (!GATE_TIERS.has(entry.tier)) {
        errors.push(`${at}.tier must be fast, full, or live`);
      }
      if (!Array.isArray(entry.kinds) || entry.kinds.some((kind) => !KINDS.has(kind))) {
        errors.push(`${at}.kinds must be an array of code, docs, infra, or test`);
      }
      if (typeof entry.required !== "boolean") {
        errors.push(`${at}.required must be a boolean`);
      }
      if (!Number.isFinite(entry.timeoutSec) || entry.timeoutSec <= 0) {
        errors.push(`${at}.timeoutSec must be a positive number`);
      }
    });
  }

  if (!isPlainObject(config.verify)) {
    errors.push("verify must be an object");
  } else {
    if (typeof config.verify.retryFlaky !== "boolean") {
      errors.push("verify.retryFlaky must be a boolean");
    }
    if (!Number.isInteger(config.verify.maxRetries) || config.verify.maxRetries < 0) {
      errors.push("verify.maxRetries must be a non-negative integer");
    }
  }

  if (!isPlainObject(config.pr)) {
    errors.push("pr must be an object");
  } else {
    if (typeof config.pr.template !== "string" || !config.pr.template.trim()) {
      errors.push("pr.template must be a non-empty string");
    } else if (
      path.isAbsolute(config.pr.template) ||
      /^[A-Za-z]:[\\/]/.test(config.pr.template) ||
      config.pr.template.startsWith("\\\\") ||
      config.pr.template.split(/[\\/]/).includes("..")
    ) {
      errors.push(
        "pr.template must be repository-relative and must not escape the repository",
      );
    }
    const screenshots = config.pr.screenshots;
    if (
      screenshots !== "manual" &&
      screenshots !== "none" &&
      !(isPlainObject(screenshots) && typeof screenshots.command === "string")
    ) {
      errors.push(
        'pr.screenshots must be "manual", "none", or { command: string }',
      );
    }
    if (typeof config.pr.titlePrefix !== "string") {
      errors.push("pr.titlePrefix must be a string");
    }
    if (!isPlainObject(config.pr.sections)) {
      errors.push("pr.sections must be an object");
    }
  }

  if (!isPlainObject(config.attention)) {
    errors.push("attention must be an object");
  } else {
    for (const key of ["largeDiffFiles", "largeDiffLines"]) {
      if (!Number.isFinite(config.attention[key]) || config.attention[key] < 0) {
        errors.push(`attention.${key} must be a non-negative number`);
      }
    }
    if (
      !Array.isArray(config.attention.failOn) ||
      config.attention.failOn.some((item) => typeof item !== "string")
    ) {
      errors.push("attention.failOn must be an array of strings");
    }
  }

  return errors;
}

export function loadConfig(root) {
  const file = configPath(root);
  if (!fileExists(file)) {
    throw new CodedError(
      ERROR_CODES.CONFIG,
      "codeflow config not found",
      { path: file },
      "Run `codeflow init` first.",
    );
  }
  let config;
  try {
    config = JSON.parse(readText(file));
  } catch (err) {
    throw new CodedError(ERROR_CODES.CONFIG, "codeflow config is not valid JSON", {
      path: file,
      error: err.message,
    });
  }
  assertSchema(config, "config", file);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new CodedError(ERROR_CODES.CONFIG, "codeflow config is invalid", {
      path: file,
      errors,
    });
  }
  return config;
}

export function writeConfig(root, config) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new CodedError(ERROR_CODES.CONFIG, "refusing to write an invalid config", {
      errors,
    });
  }
  writeJsonAtomic(configPath(root), config);
}

export function configHash(config) {
  return sha256(stableStringify(config));
}
