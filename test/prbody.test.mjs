import test from "node:test";
import assert from "node:assert/strict";
import { parseTemplate, renderPrBody, titleFor } from "../src/prbody.mjs";

const task = {
  id: "2026-10-26-fix-login",
  title: "Fix login",
  issues: ["#123"],
};

const taskSpec = [
  "# Fix login",
  "",
  "## Request",
  "Stop the redirect loop.",
  "",
  "## Product",
  "A user lands on the dashboard.",
  "",
  "## Design",
  "Guard the redirect when the token is present.",
  "",
  "## Durable updates",
  "Updated docs/architecture.md with the redirect guard decision.",
].join("\n");

const plan = {
  steps: [
    {
      id: "1",
      title: "Add the guard",
      status: "done",
      commitSubject: "fix(auth): add the guard",
      verification: "`npm test` → pass",
    },
  ],
};

const evidence = {
  gates: [
    {
      name: "test",
      tier: "fast",
      required: true,
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      flaky: false,
    },
  ],
  attention: {
    testFiles: [],
    skips: [],
    suppressions: [],
    configChanges: [],
    lockfileChanges: [],
    largeDiff: {
      files: 1,
      lines: 10,
      thresholdFiles: 25,
      thresholdLines: 1200,
    },
  },
};

const review = {
  scopeDrift: ["also renamed a helper"],
  closestLook: ["the redirect guard"],
};

const template = [
  "## Problem",
  "",
  "old",
  "",
  "## Approach",
  "",
  "old",
  "",
  "## Changes",
  "",
  "old",
  "",
  "## Screenshots",
  "",
  "old",
  "",
  "## Related issues",
  "",
  "old",
  "",
  "## Checklist",
  "",
  "- [ ] test",
  "- [ ] lint",
  "- [ ] screenshots",
].join("\n");

test("parseTemplate preserves headings and bodies", () => {
  const sections = parseTemplate(template);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["Problem", "Approach", "Changes", "Screenshots", "Related issues", "Checklist"],
  );
  assert.equal(sections[0].lines.join("\n").trim(), "old");
});

test("renderPrBody fills sections from artifacts and only ticks evidence-backed gates", () => {
  const body = renderPrBody({
    template,
    task,
    taskSpec,
    plan,
    evidence,
    config: { pr: { screenshots: "manual", titlePrefix: "" } },
    review,
    diffStatText: "1 file changed",
  });

  assert.match(body, /Stop the redirect loop\./);
  assert.match(body, /Guard the redirect when the token is present\./);
  assert.match(body, /- \[x\] 1\. Add the guard/);
  assert.match(body, /- \[x\] test/);
  assert.match(body, /- \[ \] lint/);
  assert.match(body, /- \[ \] screenshots/);
  assert.match(body, /## Verification/);
  assert.match(body, /## Review attention/);
  assert.match(body, /## Durable updates/);
  assert.match(body, /Updated docs\/architecture\.md/);
  assert.match(body, /also renamed a helper/);
  assert.match(body, /the redirect guard/);
  assert.doesNotMatch(body, /^old$/m);
});

test("screenshots: none renders the no-frontend sentence, not a TODO", () => {
  const body = renderPrBody({
    template,
    task,
    taskSpec,
    plan,
    evidence,
    config: { pr: { screenshots: "none", titlePrefix: "" } },
    review,
    diffStatText: "",
  });

  assert.match(body, /Not applicable — no frontend changes\./);
  assert.doesNotMatch(body, /TODO: add before\/after screenshots/);
});

test("screenshots: a command names the capture step", () => {
  const body = renderPrBody({
    template,
    task,
    taskSpec,
    plan,
    evidence,
    config: {
      pr: { screenshots: { command: "npm run shots" }, titlePrefix: "" },
    },
    review,
    diffStatText: "",
  });

  assert.match(body, /Capture with `npm run shots`/);
});

test("a missing template falls back to the default shape", () => {
  const body = renderPrBody({
    template: "",
    task,
    taskSpec,
    plan,
    evidence,
    config: { pr: { screenshots: "manual", titlePrefix: "" } },
    review,
    diffStatText: "",
  });

  assert.match(body, /## Problem/);
  assert.match(body, /## Approach/);
  assert.match(body, /## Changes/);
  assert.match(body, /## Verification/);
});

test("titleFor applies the configured prefix", () => {
  assert.equal(
    titleFor(task, { pr: { titlePrefix: "[auth] " } }),
    "[auth] Fix login",
  );
});
