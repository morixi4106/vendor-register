import fs from "node:fs/promises";
import path from "node:path";

const ROOTS = ["app", "docs", "prisma", "scripts", "tests"];
const EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".prisma",
  ".sql",
  ".ts",
  ".tsx",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];

async function scan(target) {
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await scan(fullPath);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const bytes = await fs.readFile(fullPath);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      failures.push(`${fullPath}: invalid UTF-8`);
      continue;
    }
    if (text.includes("\uFFFD")) {
      failures.push(`${fullPath}: contains Unicode replacement character`);
    }
    if (/(?:縺|繧|譁|陦|蜿|莉|荳|謖|螟|逕|髯|鬆){3,}/u.test(text)) {
      failures.push(`${fullPath}: contains a likely mojibake sequence`);
    }
  }
}

for (const root of ROOTS) {
  await scan(path.resolve(root));
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Text encoding check passed.\n");
}
