import { taskSections } from "./task.mjs";

const DEFAULT_TEMPLATE = `## Problem

## Approach

## Changes

## Screenshots

## Related issues

## Checklist
`;

export function parseTemplate(text) {
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current.heading) {
        sections.push(current);
      }
      current = { heading: heading[1], lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading) {
    sections.push(current);
  } else if (current.lines.join("").trim()) {
    sections.push({ heading: "Summary", lines: current.lines });
  }
  return sections;
}

function verificationTable(evidence) {
  const lines = [
    "| Gate | Tier | Required | Result | Duration |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const gate of evidence.gates ?? []) {
    const result = gate.timedOut
      ? "timeout"
      : gate.exitCode === 0
        ? "pass"
        : `fail (${gate.exitCode})`;
    lines.push(
      `| ${gate.name} | ${gate.tier} | ${gate.required ? "yes" : "no"} | ${result}${gate.flaky ? " (flaky)" : ""} | ${gate.durationMs}ms |`,
    );
  }
  return lines.join("\n");
}

function attentionBody(attention, review) {
  const lines = [
    `- Test files changed: ${attention.testFiles.length}`,
    `- Skips: ${attention.skips.length}`,
    `- Suppressions: ${attention.suppressions.length}`,
    `- Config changes: ${attention.configChanges.length}`,
    `- Lockfile changes: ${attention.lockfileChanges.length}`,
    `- Large diff: ${attention.largeDiff.files} files / ${attention.largeDiff.lines} lines`,
  ];
  if (attention.testFiles.length > 0) {
    lines.push("", "Test files:");
    lines.push(...attention.testFiles.map((entry) => `- \`${entry.path}\` (${entry.change})`));
  }
  if (attention.skips.length > 0) {
    lines.push("", "Skips:");
    lines.push(
      ...attention.skips.map(
        (entry) => `- \`${entry.path}:${entry.line}\` — ${entry.pattern}`,
      ),
    );
  }
  if (attention.suppressions.length > 0) {
    lines.push("", "Suppressions:");
    lines.push(
      ...attention.suppressions.map(
        (entry) => `- \`${entry.path}:${entry.line}\` — ${entry.pattern}`,
      ),
    );
  }
  lines.push("", "Scope drift:");
  lines.push(
    ...(review.scopeDrift.length > 0
      ? review.scopeDrift.map((item) => `- ${item}`)
      : ["- None recorded."]),
  );
  lines.push("", "Closest look:");
  lines.push(
    ...(review.closestLook.length > 0
      ? review.closestLook.map((item) => `- ${item}`)
      : ["- None recorded."]),
  );
  return lines.join("\n");
}

function checklistBody(body, evidence) {
  const gates = new Map((evidence.gates ?? []).map((gate) => [gate.name.toLowerCase(), gate]));
  return body
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*)- \[( |x)\] (.+)$/);
      if (!match) {
        return line;
      }
      const item = match[3].toLowerCase();
      const gate = [...gates.entries()].find(([name]) => item.includes(name));
      if (gate && gate[1].exitCode === 0) {
        return `${match[1]}- [x] ${match[3]}`;
      }
      return line;
    })
    .join("\n")
    .trim();
}

function screenshotsBody(config, task) {
  if (config.pr.screenshots === "none") {
    return "Not applicable — no frontend changes.";
  }
  if (config.pr.screenshots !== "manual" && config.pr.screenshots?.command) {
    return `Capture with \`${config.pr.screenshots.command}\`, then attach before/after images for \`${task.id}\`.`;
  }
  return "TODO: add before/after screenshots for UI changes, or write `Not applicable — no frontend changes.`";
}

function bodyFor(heading, context) {
  const name = heading.toLowerCase();
  const {
    spec,
    task,
    plan,
    evidence,
    config,
    changes,
    verification,
    attention,
    review,
  } = context;

  if (name.includes("problem") || name.includes("summary")) {
    return spec.request || spec.problem || "TODO: describe the problem.";
  }
  if (name.includes("approach")) {
    return spec.design || "TODO: describe the approach.";
  }
  if (name.includes("changes")) {
    return changes;
  }
  if (name.includes("screenshot")) {
    return screenshotsBody(config, task);
  }
  if (name.includes("related issue")) {
    return task.issues.length > 0 ? task.issues.join(", ") : "None.";
  }
  if (name.includes("durable")) {
    return spec["durable updates"] || "Not recorded.";
  }
  if (name.includes("checklist")) {
    return checklistBody(context.originalBody, evidence);
  }
  if (name.includes("testing") || name.includes("verification")) {
    return verification;
  }
  if (name.includes("attention")) {
    return attention;
  }
  return context.originalBody.trim() || "TODO";
}

export function renderPrBody(options) {
  const {
    template,
    task,
    taskSpec,
    plan,
    evidence,
    config,
    review,
    diffStatText,
  } = options;

  const text = String(template ?? "").trim() ? template : DEFAULT_TEMPLATE;
  const sections = parseTemplate(text);
  const spec = taskSections(taskSpec);
  const changes = [
    ...(plan.steps ?? []).flatMap((step) => {
      const lines = [
        `- [${step.status === "done" ? "x" : " "}] ${step.id}. ${step.title}`,
      ];
      if (step.summary) {
        lines.push(`  - ${step.summary}`);
      }
      if (step.result) {
        lines.push(`  - Result: ${step.result}`);
      }
      return lines;
    }),
    "",
    "Diff stat:",
    "```text",
    diffStatText || "(empty)",
    "```",
  ].join("\n");
  const verification = verificationTable(evidence);
  const attention = attentionBody(evidence.attention, review);

  const rendered = sections.map((section) => {
    const originalBody = section.lines.join("\n");
    const body = bodyFor(section.heading, {
      spec,
      task,
      plan,
      evidence,
      config,
      changes,
      verification,
      attention,
      review,
      originalBody,
    });
    return `## ${section.heading}\n\n${body}`;
  });

  const hasAttention = sections.some((section) =>
    section.heading.toLowerCase().includes("attention"),
  );
  const hasVerification = sections.some((section) => {
    const name = section.heading.toLowerCase();
    return name.includes("testing") || name.includes("verification");
  });
  const hasDurable = sections.some((section) =>
    section.heading.toLowerCase().includes("durable"),
  );

  if (!hasVerification) {
    rendered.push(`## Verification\n\n${verification}`);
  }
  if (!hasDurable) {
    rendered.push(
      `## Durable updates\n\n${spec["durable updates"] || "Not recorded."}`,
    );
  }
  if (!hasAttention) {
    rendered.push(`## Review attention\n\n${attention}`);
  }

  return `${rendered.join("\n\n").trim()}\n`;
}

export function titleFor(task, config) {
  return `${config.pr.titlePrefix ?? ""}${task.title}`.trim();
}
