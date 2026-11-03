import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  configHash,
  defaultConfig,
  detectConfig,
  loadConfig,
  validateConfig,
  writeConfig,
} from "../src/config.mjs";
import { findRepo } from "../src/repo.mjs";
import { cleanup, tempRepo } from "./helpers.mjs";

test("detectConfig proposes Node gates from package.json scripts", (t) => {
  const dir = tempRepo({
    packageJson: {
      scripts: {
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "node --test",
      },
    },
    lockfile: "package-lock.json",
  });
  t.after(() => cleanup(dir));

  const config = detectConfig(findRepo(dir));
  assert.deepEqual(
    config.gates.map((gate) => gate.name).sort(),
    ["lint", "test", "typecheck"],
  );
  assert.equal(
    config.gates.find((gate) => gate.name === "lint").command,
    "npm run lint",
  );
  assert.deepEqual(validateConfig(config), []);
});

test("detectConfig proposes Python gates from pyproject.toml", (t) => {
  const dir = tempRepo({
    pyproject: [
      "[tool.ruff]",
      "line-length = 100",
      "[tool.pytest.ini_options]",
      "testpaths = [\"tests\"]",
    ].join("\n"),
  });
  t.after(() => cleanup(dir));

  const config = detectConfig(findRepo(dir));
  assert.deepEqual(
    config.gates.map((gate) => gate.name).sort(),
    ["lint", "test"],
  );
  assert.equal(
    config.gates.find((gate) => gate.name === "test").command,
    "pytest",
  );
});

test("detectConfig returns no gates when nothing matches", (t) => {
  const dir = tempRepo();
  t.after(() => cleanup(dir));

  const config = detectConfig(findRepo(dir));
  assert.deepEqual(config.gates, []);
});

test("writeConfig and loadConfig round-trip and hash stably", (t) => {
  const dir = tempRepo();
  t.after(() => cleanup(dir));
  const repo = findRepo(dir);
  const config = defaultConfig(repo);

  writeConfig(dir, config);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded, config);
  assert.equal(configHash(loaded), configHash(config));
  assert.ok(JSON.parse(readFileSync(`${dir}/.codeflow/config.json`, "utf8")));
});

test("validateConfig rejects duplicate names and bad gate fields", () => {
  const config = defaultConfig({ baseBranch: "main", remote: "origin" });
  config.gates = [
    {
      name: "lint",
      command: "lint",
      tier: "fast",
      kinds: ["code"],
      required: true,
      timeoutSec: 300,
    },
    {
      name: "lint",
      command: "",
      tier: "slow",
      kinds: ["nope"],
      required: "yes",
      timeoutSec: -1,
    },
  ];

  const errors = validateConfig(config);
  assert.ok(errors.some((error) => error.includes("duplicated")));
  assert.ok(errors.some((error) => error.includes("command")));
  assert.ok(errors.some((error) => error.includes("tier")));
  assert.ok(errors.some((error) => error.includes("kinds")));
  assert.ok(errors.some((error) => error.includes("required")));
  assert.ok(errors.some((error) => error.includes("timeoutSec")));
});

test("validateConfig rejects a stateDir that escapes the repository", () => {
  const config = defaultConfig({ baseBranch: "main", remote: "origin" });
  config.stateDir = "../escape";
  assert.ok(
    validateConfig(config).some((error) => error.includes("stateDir")),
  );
});

test("validateConfig rejects a PR template outside the repository", () => {
  const config = defaultConfig({ baseBranch: "main", remote: "origin" });
  config.pr.template = "../secret.md";
  assert.ok(
    validateConfig(config).some((error) => error.includes("pr.template")),
  );
  config.pr.template = "C:\\secrets\\template.md";
  assert.ok(
    validateConfig(config).some((error) => error.includes("pr.template")),
  );
});

test("validateConfig accepts the three screenshot forms and rejects others", () => {
  const config = defaultConfig({ baseBranch: "main", remote: "origin" });
  for (const value of ["manual", "none", { command: "npm run shots" }]) {
    config.pr.screenshots = value;
    assert.deepEqual(validateConfig(config), []);
  }
  config.pr.screenshots = "auto";
  assert.ok(
    validateConfig(config).some((error) => error.includes("pr.screenshots")),
  );
});

test("validateConfig accepts a mixed gate", () => {
  const config = defaultConfig({ baseBranch: "main", remote: "origin" });
  config.gates = [
    {
      name: "mixed",
      command: "node -e \"process.exit(0)\"",
      cwd: ".",
      tier: "fast",
      kinds: ["mixed"],
      required: true,
      timeoutSec: 30,
    },
  ];
  assert.deepEqual(validateConfig(config), []);
});
