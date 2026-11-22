import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  adapt,
  apply,
  buildMessage,
  packageRoot,
  readCommands,
  readSkill,
  splitFrontmatter,
} from "../dsh/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const installed = packageRoot.replace(/[\\/]+$/u, "");

function fakeContext() {
  const skills = [];
  const commands = [];
  return {
    skills: { register: (skill) => skills.push(skill) },
    commands: { register: (command) => commands.push(command) },
    registered: { skills, commands },
  };
}

function capture(command, rawInput) {
  const messages = [];
  const result = command.handler({
    agent: { followup: (message) => messages.push(message) },
    rawInput,
  });
  return { messages, result };
}

test("the DSH bundle manifest wires the adapter and the patch row", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.main, "./dsh/index.js");
  assert.equal(pkg.dsh.bundle.patch, "./dsh/cordis.patch.yml");

  const patch = readFileSync(join(root, pkg.dsh.bundle.patch), "utf8");
  assert.match(patch, /^-\s+insert:/mu);
  assert.match(patch, /- id:\s*codeflow/u);
  assert.match(patch, /name:\s*codeflow/u);
});

test("adapt rewrites the two spellings", () => {
  const text = "run ${CODEFLOW_ROOT}/bin/codeflow; next /codeflow:approve plan";
  assert.equal(
    adapt(text, "/opt/plugin/"),
    "run /opt/plugin/bin/codeflow; next /codeflow-approve plan",
  );
  assert.equal(adapt("codeflow/<id> branch", "/opt/plugin"), "codeflow/<id> branch");
});

test("splitFrontmatter separates the flat metadata from the body", () => {
  const { meta, body } = splitFrontmatter('---\ndescription: "hello: world"\n---\nbody\n');
  assert.equal(meta.description, "hello: world");
  assert.equal(body, "body\n");
  assert.deepEqual(splitFrontmatter("plain"), { meta: {}, body: "plain" });
});

test("readSkill registers the packaged skill with DSH-resolved paths", () => {
  const skill = readSkill();
  assert.equal(skill.name, "codeflow");
  assert.ok(skill.description.length > 0);
  assert.ok(skill.content.startsWith("# Codeflow"));
  assert.equal(skill.content.includes("${CODEFLOW_ROOT}"), false);
  assert.equal(skill.content.includes("/codeflow:"), false);
  assert.ok(skill.content.includes(`${installed}/bin/codeflow`));
});

test("the skill payload satisfies every field DSH validateDefinition requires", () => {
  // Mirrors @deepseek-ai/dsh-skill's validateDefinition: registration accepts
  // a partial payload, but skills.get() rejects anything missing a string
  // source, provider, or content.
  const skill = readSkill();
  assert.equal(typeof skill.source, "string");
  assert.ok(skill.source.length > 0);
  assert.ok(skill.provider === undefined || typeof skill.provider === "string");
  assert.equal(typeof skill.content, "string");
});

test("readCommands maps every command markdown to a valid DSH command", () => {
  const commands = readCommands();
  assert.equal(commands.length, 16);
  const names = commands.map((command) => command.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(new Set(names).size, commands.length);
  for (const command of commands) {
    assert.match(command.name, /^codeflow-[a-z0-9-]+$/u);
    assert.ok(command.description.length > 0);
    assert.equal(command.body.includes("${CODEFLOW_ROOT}"), false);
    assert.equal(command.body.includes("/codeflow:"), false);
  }
  assert.ok(commands.some((command) => command.hint !== undefined));
});

test("every command grants and calls the CLI by its resolved root path", () => {
  const files = readdirSync(join(root, "commands")).filter((name) =>
    name.endsWith(".md"),
  );
  assert.ok(files.length >= 15);
  for (const name of files) {
    const text = readFileSync(join(root, "commands", name), "utf8");
    assert.match(
      text,
      /"\$\{CODEFLOW_ROOT\}\/bin\/codeflow" /,
      `${name} never calls the CLI by its resolved root path`,
    );
    assert.doesNotMatch(
      text,
      /`codeflow\s/,
      `${name} still invokes a bare codeflow`,
    );
    assert.doesNotMatch(
      text,
      /gh pr merge/,
      `${name} must not instruct a merge`,
    );
  }
});

test("the skill carries the human boundary and red lines", () => {
  const skill = readSkill();
  assert.match(skill.content, /Hydrate then act/);
  assert.match(skill.content, /Never merge/);
  assert.match(skill.content, /Never approve on your own/);
  assert.match(skill.content, /Never fabricate evidence/);
  assert.match(skill.content, /Never weaken a gate/);
  assert.match(skill.content, /Never touch the base branch/);
});

test("apply registers one skill and every command", () => {
  const ctx = fakeContext();
  apply(ctx);
  assert.equal(ctx.registered.skills.length, 1);
  assert.equal(ctx.registered.skills[0].name, "codeflow");
  assert.equal(ctx.registered.commands.length, 16);
  const names = new Set(ctx.registered.commands.map((command) => command.name));
  assert.ok(names.has("codeflow-plan"));
  assert.ok(names.has("codeflow-self-review"));
});

test("a command handler queues the adapted body as a user message", () => {
  const ctx = fakeContext();
  apply(ctx);
  const plan = ctx.registered.commands.find((command) => command.name === "codeflow-plan");
  const { messages, result } = capture(plan, "");
  assert.equal(result.kind, "success");
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "user");
  assert.match(message.id, /^[0-9a-f-]{36}$/u);
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, "text");
  assert.ok(message.content[0].text.includes(`${installed}/bin/codeflow`));
});

test("$ARGUMENTS carries the human input into the queued instructions", () => {
  const ctx = fakeContext();
  apply(ctx);
  const created = ctx.registered.commands.find(
    (command) => command.name === "codeflow-new",
  );
  const { messages } = capture(created, "  fix the build ");
  assert.ok(messages[0].content[0].text.includes('new "fix the build"'));
  assert.equal(messages[0].content[0].text.includes("$ARGUMENTS"), false);
});

test("free-form input is appended when the body has no argument slot", () => {
  const ctx = fakeContext();
  apply(ctx);
  const status = ctx.registered.commands.find(
    (command) => command.name === "codeflow-status",
  );
  const { messages } = capture(status, "now");
  assert.ok(messages[0].content[0].text.endsWith("User input: now"));
});

test("buildMessage produces the identity and source the inbox expects", () => {
  const message = buildMessage("hello");
  assert.match(message.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(message.source, { kind: "user" });
});
