import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const guardPath = fileURLToPath(new URL("./braces-guard.cjs", import.meta.url));
const verified = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:")) return loaded;
    const filename = fileURLToPath(url).replaceAll("\\", "/");
    const match = filename.match(
      /^(.*\/node_modules\/braces)\/(index|lib\/(parse|compile|expand|stringify))\.js$/,
    );
    if (!match) return loaded;
    const directory = match[1];
    if (!verified.has(directory)) {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      if (metadata.name !== "braces" || metadata.version !== "3.0.3")
        throw new Error("unreviewed_build_dependency");
      verified.add(directory);
    }
    const source = loaded.source ?? fs.readFileSync(fileURLToPath(url), "utf8");
    const kind = match[3] || "index";
    return {
      ...loaded,
      format: "commonjs",
      source: `${source}\nmodule.exports = require(${JSON.stringify(guardPath)}).wrap(module.exports, ${JSON.stringify(kind)});\n`,
    };
  },
});
