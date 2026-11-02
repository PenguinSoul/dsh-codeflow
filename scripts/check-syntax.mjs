import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

function walk(dir) {
  const results = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") {
      continue;
    }
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      results.push(...walk(file));
    } else if (
      name.endsWith(".mjs") ||
      name.endsWith(".js") ||
      file === join(root, "bin", "codeflow")
    ) {
      results.push(file);
    }
  }
  return results;
}

const files = [
  join(root, "bin", "codeflow"),
  ...walk(join(root, "src")),
  ...walk(join(root, "dsh")),
  ...walk(join(root, "test")),
  ...walk(join(root, "hooks")),
  ...walk(join(root, "scripts")),
];

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`${relative(root, file)}\n${result.stderr}\n`);
  }
}

console.log(`checked ${files.length} files`);
process.exit(failed === 0 ? 0 : 1);
