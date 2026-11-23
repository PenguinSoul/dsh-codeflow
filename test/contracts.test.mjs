import test from "node:test";
import assert from "node:assert/strict";
import {
  CodedError,
  ERROR_CODES,
  EXIT,
  exitFor,
  fail,
  failWithData,
  ok,
} from "../src/contracts.mjs";

test("ok envelope has the contract shape", () => {
  const envelope = ok("status", { task: null });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "status");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, { task: null });
  assert.equal(envelope.error, null);
  assert.deepEqual(envelope.warnings, []);
  assert.equal(typeof envelope.meta.generatedAt, "string");
  assert.equal(envelope.meta.cliVersion, "0.1.0");
});

test("fail envelope carries a coded error", () => {
  const envelope = fail("init", {
    code: ERROR_CODES.NOT_REPO,
    message: "no git",
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.data, null);
  assert.equal(envelope.error.code, "E_NOT_REPO");
});

test("failWithData keeps the report on a failed command", () => {
  const envelope = failWithData(
    "verify",
    {
      code: ERROR_CODES.GATE_FAILED,
      message: 'gate "test" exited 1',
      details: { gate: "test", exitCode: 1 },
      hint: "Fix it.",
    },
    { result: "fail" },
    { repoRoot: "/repo", taskId: "2026-10-26-fix-login" },
    [{ code: "W_ATTENTION", message: "attention items recorded: skip" }],
  );

  assert.equal(envelope.ok, false);
  assert.equal(envelope.data.result, "fail");
  assert.equal(envelope.error.code, "E_GATE_FAILED");
  assert.equal(envelope.error.details.gate, "test");
  assert.equal(envelope.meta.taskId, "2026-10-26-fix-login");
  assert.equal(envelope.warnings.length, 1);
  assert.equal(exitFor(envelope.error.code), EXIT.GATE);
});

test("CodedError serializes and maps to an exit code", () => {
  const error = new CodedError(
    ERROR_CODES.TRUST_REQUIRED,
    "trust required",
    { gate: "lint" },
    "Run codeflow trust",
  );
  assert.deepEqual(error.toJSON(), {
    code: "E_TRUST_REQUIRED",
    message: "trust required",
    details: { gate: "lint" },
    hint: "Run codeflow trust",
  });
  assert.equal(exitFor(error.code), EXIT.TRUST);
  assert.equal(exitFor(ERROR_CODES.REBASE_FAILED), EXIT.GIT);
  assert.equal(exitFor("E_UNKNOWN"), EXIT.INTERNAL);
});
