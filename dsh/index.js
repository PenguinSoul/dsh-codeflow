/**
 * DeepSeek Harness adapter for codeflow.
 *
 * DSH bundle plugins are declared through `package.json`'s `dsh.bundle.patch`
 * field; the patch mounts this module as one cordis plugin. The adapter does
 * not re-implement the workflow. It reads the artifacts Claude Code already
 * loads — `skills/codeflow/SKILL.md` and `commands/*.md` — and registers them
 * with the two DSH seams that own embedded contribution:
 *
 *  - `ctx.skills.register()` publishes the skill from memory, which is the
 *    documented channel for a skill that ships inside a plugin package;
 *  - `ctx.commands.register()` publishes one `/codeflow-<verb>` command per
 *    markdown file. The handler hands the adapted body to `agent.followup()`,
 *    the same mechanism `/goal` uses, so the model receives exactly the
 *    instructions Claude Code would have received.
 *
 * Two Claude-only spellings are rewritten at load time instead of forking the
 * prose: `${CLAUDE_PLUGIN_ROOT}` becomes the installed package root, and the
 * `/codeflow:` command prefix becomes `/codeflow-` (DSH command names allow
 * only `[a-z0-9_-]`). Core state, gates, and evidence are untouched.
 *
 * The module imports Node built-ins only, so the package stays dependency-free
 * and every helper below is testable without a DSH installation.
 *
 * @module dsh/index.js
 */

import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Installed package root; what `${CLAUDE_PLUGIN_ROOT}` means at runtime. */
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const ARGUMENT_PLACEHOLDER = "$ARGUMENTS";

/**
 * Split YAML frontmatter from a markdown body.
 * @param {string} markdown - raw artifact text.
 * @returns {{meta: Record<string, string>, body: string}}
 */
export function splitFrontmatter(markdown) {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) {
    return { meta: {}, body: markdown };
  }
  return { meta: parseMeta(match[1]), body: markdown.slice(match[0].length) };
}

/** Parse the flat `key: value` frontmatter both harnesses use. */
function parseMeta(block) {
  const meta = {};
  for (const line of block.split(/\r?\n/u)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/u.exec(line);
    if (match !== null) {
      meta[match[1]] = unquote(match[2]);
    }
  }
  return meta;
}

/** Strip one matching pair of surrounding quotes. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Rewrite the two Claude-only spellings for DSH.
 * @param {string} text - skill or command markdown.
 * @param {string} [root] - package root substituted for `${CLAUDE_PLUGIN_ROOT}`.
 * @returns {string}
 */
export function adapt(text, root = packageRoot) {
  const installed = root.replace(/[\\/]+$/u, "");
  return text
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", installed)
    .replaceAll("/codeflow:", "/codeflow-");
}

/**
 * Read the skill as a runtime registration payload.
 * @param {string} [root] - package root.
 */
export function readSkill(root = packageRoot) {
  const { meta, body } = splitFrontmatter(
    readFileSync(join(root, "skills/codeflow/SKILL.md"), "utf8"),
  );
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new Error("codeflow skill is missing its name");
  }
  if (typeof meta.description !== "string" || meta.description.length === 0) {
    throw new Error("codeflow skill is missing its description");
  }
  return {
    name: meta.name,
    description: meta.description,
    ...(typeof meta.whenToUse === "string" ? { whenToUse: meta.whenToUse } : {}),
    content: adapt(body.trimStart(), root),
  };
}

/**
 * Read every command markdown as one DSH command descriptor.
 * @param {string} [root] - package root.
 */
export function readCommands(root = packageRoot) {
  const dir = join(root, "commands");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const verb = file.slice(0, -".md".length);
      if (!COMMAND_NAME.test(verb)) {
        throw new Error(`codeflow command "${file}" is not a valid DSH command name`);
      }
      const { meta, body } = splitFrontmatter(readFileSync(join(dir, file), "utf8"));
      const hint = meta["argument-hint"];
      return {
        name: `codeflow-${verb}`,
        verb,
        description:
          typeof meta.description === "string" && meta.description.length > 0
            ? meta.description
            : `Run /codeflow:${verb}`,
        ...(typeof hint === "string" && hint.length > 0 ? { hint } : {}),
        body: adapt(body.trimStart(), root),
      };
    });
}

/**
 * Build the user message the command handler queues.
 * @param {string} text - adapted command body.
 */
export function buildMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/** Apply `$ARGUMENTS`, or append free-form input when the body has no slot. */
function dispatchBody(body, rawInput) {
  const input = rawInput.trim();
  if (body.includes(ARGUMENT_PLACEHOLDER)) {
    return body.replaceAll(ARGUMENT_PLACEHOLDER, input);
  }
  if (input.length === 0) {
    return body;
  }
  return `${body}\n\nUser input: ${input}`;
}

export const name = "codeflow";
export const inject = ["skills", "commands"];

/**
 * Mount the adapter.
 * @param {object} ctx - cordis context with `skills` and `commands`.
 * @param {{root?: string}} [config] - test override for the package root.
 */
export function apply(ctx, config = {}) {
  const root = config.root ?? packageRoot;
  ctx.skills.register(readSkill(root));
  for (const command of readCommands(root)) {
    ctx.commands.register({
      name: command.name,
      description: command.description,
      ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
      handler: (invocation) => {
        const rawInput = typeof invocation.rawInput === "string" ? invocation.rawInput : "";
        invocation.agent.followup(buildMessage(dispatchBody(command.body, rawInput)));
        return { kind: "success", text: `${command.name}: instructions queued` };
      },
    });
  }
}
