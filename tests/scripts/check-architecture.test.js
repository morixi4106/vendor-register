import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findImportCycles,
  inspectArchitecture,
  parseStaticImportSpecifiers,
} from "../../scripts/check-architecture.mjs";

test("parseStaticImportSpecifiers reads multiline imports and re-exports", () => {
  assert.deepEqual(
    parseStaticImportSpecifiers(`
      import { one, two } from "./one.js";
      export { three } from './two.js';
      import "./side-effect.js";
      const lazy = import("./dynamic.js");
    `),
    ["./one.js", "./two.js", "./side-effect.js"],
  );
});

test("findImportCycles reports strongly connected service modules", () => {
  const graph = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a"]],
    ["d", []],
  ]);

  assert.deepEqual(findImportCycles(graph), [["c", "b", "a"]]);
});

test("inspectArchitecture rejects forbidden imports and line growth", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-check-"));
  const servicesDir = path.join(rootDir, "app", "services");
  fs.mkdirSync(servicesDir, { recursive: true });
  fs.writeFileSync(
    path.join(servicesDir, "orchestrator.js"),
    'import "./reader.js";\nexport const value = true;\n',
  );
  fs.writeFileSync(
    path.join(servicesDir, "reader.js"),
    'import "./orchestrator.js";\nexport const value = true;\n',
  );

  const result = inspectArchitecture({
    rootDir,
    lineBudgets: { "app/services/reader.js": 1 },
    forbiddenImports: [
      {
        importer: "app/services/reader.js",
        imported: "app/services/orchestrator.js",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    new Set(result.errors.map((error) => error.code)),
    new Set([
      "service_import_cycle",
      "architecture_line_budget_exceeded",
      "forbidden_architecture_import",
    ]),
  );
});

test("inspectArchitecture rejects a domain module importing its facade", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "facade-check-"));
  const servicesDir = path.join(rootDir, "app", "services");
  const domainDir = path.join(servicesDir, "example");
  fs.mkdirSync(domainDir, { recursive: true });
  fs.writeFileSync(
    path.join(servicesDir, "example.server.js"),
    'export { value } from "./example/value.js";\n',
  );
  fs.writeFileSync(
    path.join(domainDir, "value.js"),
    'import "../example.server.js";\nexport const value = true;\n',
  );

  const result = inspectArchitecture({
    rootDir,
    lineBudgets: {},
    forbiddenImports: [],
    compatibilityFacades: [
      {
        directory: "app/services/example/",
        facade: "app/services/example.server.js",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some(
      (error) => error.code === "compatibility_facade_reverse_dependency",
    ),
    true,
  );
});

test("the repository satisfies its architecture boundaries", () => {
  const result = inspectArchitecture({
    rootDir: path.resolve(import.meta.dirname, "..", ".."),
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
