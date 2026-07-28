import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyBuildArtifacts } from "../../scripts/security/artifact-reachability.mjs";

function wasmImportFixture(moduleName = "minimatch", importName = "f") {
  const moduleBytes = Buffer.from(moduleName, "utf8");
  const importBytes = Buffer.from(importName, "utf8");
  const typeSection = Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]);
  const importPayload = Buffer.concat([
    Buffer.from([0x01, moduleBytes.length]),
    moduleBytes,
    Buffer.from([importBytes.length]),
    importBytes,
    Buffer.from([0x00, 0x00]),
  ]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    typeSection,
    Buffer.from([0x02, importPayload.length]),
    importPayload,
  ]);
}

function createFixture() {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "vendor-register-artifacts-"),
  );
  const requiredArtifacts = [
    "extensions/test-function/dist/function.js",
    "extensions/test-function/dist/function.wasm",
    "extensions/test-ui/dist/extension.js",
    "extensions/test-ui/dist/extension.js.map",
    "extensions/test-ui/dist/extension.metafile.json",
  ];
  const files = {
    "build/server/index.js": "export const loader = () => 'ok';\n",
    "build/server/assets/chunk.js": "export const chunk = true;\n",
    "build/client/assets/entry.client-fixture.js":
      "console.log('client entry');\n",
    "build/client/assets/manifest-fixture.js":
      "export default { version: 'fixture' };\n",
    "build/client/assets/route-fixture.js": "console.log('route');\n",
    "build/client/assets/styles-fixture.css": "body { color: black; }\n",
    "extensions/test-function/dist/function.js":
      "export function run() { return 1; }\n",
    "extensions/test-function/dist/function.wasm": Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]),
    "extensions/test-ui/dist/extension.js":
      "export const extension = 'account';\n",
    "extensions/test-ui/dist/extension.js.map":
      '{"version":3,"sources":["src/index.tsx"],"mappings":""}\n',
    "extensions/test-ui/dist/extension.metafile.json":
      '{"inputs":{"src/index.tsx":{"bytes":20,"imports":[]}}}\n',
    ".shopify/deploy-bundle/function/dist/index.wasm": Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]),
    ".shopify/deploy-bundle/entry/dist/account-home-entry.js":
      "export const entry = true;\n",
    ".shopify/deploy-bundle/page/dist/account-home-page.js":
      "export const page = true;\n",
  };
  files[".shopify/deploy-bundle/manifest.json"] = JSON.stringify({
    modules: [
      {
        assets: "entry",
        config: {
          extension_points: [
            {
              build_manifest: {
                assets: {
                  main: {
                    filepath: "dist/account-home-entry.js",
                  },
                },
              },
            },
          ],
        },
        handle: "account-home-entry",
        type: "ui_extension",
      },
      {
        assets: "page",
        config: {
          extension_points: [
            {
              build_manifest: {
                assets: {
                  main: {
                    filepath: "dist/account-home-page.js",
                  },
                },
              },
            },
          ],
        },
        handle: "account-home-page",
        type: "ui_extension",
      },
      {
        assets: "function",
        config: {},
        handle: "marketplace-purchase-control",
        type: "function",
      },
    ],
  });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDirectory, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }

  return {
    packageFiles: [],
    requiredArtifacts,
    rootDirectory,
  };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.rootDirectory, { force: true, recursive: true });
}

test("accepts complete artifacts without toolchain package references", () => {
  const fixture = createFixture();
  try {
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, true);
    assert.deepEqual(result.invalidArtifacts, []);
    assert.deepEqual(result.missingArtifacts, []);
    assert.deepEqual(result.targetMatches, []);
    assert.equal(result.artifacts.length, 15);
    assert.match(result.artifactSetSha256, /^[A-F0-9]{64}$/);
    assert.ok(
      result.artifacts.every((artifact) =>
        /^[A-F0-9]{64}$/.test(artifact.sha256),
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when a required artifact is missing", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-function/dist/function.wasm",
      ),
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingArtifacts, [
      "extensions/test-function/dist/function.wasm",
    ]);
  } finally {
    removeFixture(fixture);
  }
});

test("detects a target package imported by the server bundle", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.rootDirectory, "build/server/index.js"),
      "import minimatch from 'minimatch';\nexport default minimatch;\n",
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.artifact === "build/server/index.js" &&
          match.target === "minimatch",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("detects a direct toolchain import in application source", () => {
  const fixture = createFixture();
  try {
    const sourcePath = path.join(fixture.rootDirectory, "app", "direct.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      "const braceExpansion = require('brace-expansion');\nexport default braceExpansion;\n",
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.artifact === "app/direct.js" &&
          match.target === "brace-expansion" &&
          match.evidence === "source-import:brace-expansion",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("detects a target package in an extension metafile", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-ui/dist/extension.metafile.json",
      ),
      JSON.stringify({
        inputs: {
          "node_modules/brace-expansion/index.js": {
            bytes: 42,
            imports: [],
          },
        },
      }),
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.target === "brace-expansion" &&
          match.evidence.startsWith("metafile-input:"),
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for an invalid extension metafile", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-ui/dist/extension.metafile.json",
      ),
      "{",
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalidArtifacts, [
      "extensions/test-ui/dist/extension.metafile.json:invalid_json",
    ]);
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when the Shopify deploy manifest omits a module", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(
      fixture.rootDirectory,
      ".shopify/deploy-bundle/manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.modules = manifest.modules.filter(
      (module) => module.handle !== "account-home-page",
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        ".shopify/deploy-bundle/manifest.json:missing_module:account-home-page",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("rejects path traversal in the Shopify deploy manifest", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(
      fixture.rootDirectory,
      ".shopify/deploy-bundle/manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.modules[0].assets = "../../outside";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        ".shopify/deploy-bundle/manifest.json:missing_assets:account-home-entry",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("detects import variants, createRequire, and static string concatenation", () => {
  const variants = [
    "import 'minimatch';",
    "import { minimatch } from 'minimatch';",
    "const value = require('minimatch');",
    "const value = createRequire(import.meta.url).require('minimatch');",
    "const value = import('minimatch');",
    "const value = require('mini' + 'match');",
  ];

  for (const [index, source] of variants.entries()) {
    const fixture = createFixture();
    try {
      const sourcePath = path.join(
        fixture.rootDirectory,
        "app",
        `variant-${index}.js`,
      );
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, source);
      const result = verifyBuildArtifacts(fixture);
      assert.equal(result.ok, false, source);
      assert.ok(
        result.targetMatches.some(
          (match) =>
            match.artifact === `app/variant-${index}.js` &&
            match.target === "minimatch",
        ),
        source,
      );
    } finally {
      removeFixture(fixture);
    }
  }
});

test("ignores target strings that only occur in JavaScript comments", () => {
  const fixture = createFixture();
  try {
    const sourcePath = path.join(fixture.rootDirectory, "app", "comment.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      "// require('minimatch')\n/* import 'brace-expansion' */\nexport const safe = true;\n",
    );
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, true);
  } finally {
    removeFixture(fixture);
  }
});

test("detects a target package name stored before an indirect require", () => {
  const fixture = createFixture();
  try {
    const sourcePath = path.join(fixture.rootDirectory, "app", "indirect.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      "const packageName = 'minimatch';\nconst value = require(packageName);\nexport default value;\n",
    );
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.artifact === "app/indirect.js" &&
          match.target === "minimatch" &&
          match.evidence === "source-target-string",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("detects direct and aliased package.json dependencies", () => {
  const fixture = createFixture();
  try {
    const packagePath = path.join(fixture.rootDirectory, "package.json");
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        dependencies: {
          direct: "npm:minimatch@9.0.9",
          minimatch: "9.0.9",
        },
      }),
    );
    const result = verifyBuildArtifacts({
      ...fixture,
      packageFiles: ["package.json"],
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.artifact === "package.json" && match.target === "minimatch",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for empty files and invalid Wasm", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.rootDirectory, "build/server/index.js"),
      "",
    );
    fs.writeFileSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-function/dist/function.wasm",
      ),
      "not-wasm",
    );
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes("build/server/index.js:empty_file"),
    );
    assert.ok(
      result.invalidArtifacts.includes(
        "extensions/test-function/dist/function.wasm:invalid_wasm",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("detects target imports in a structurally valid Wasm module", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-function/dist/function.wasm",
      ),
      wasmImportFixture(),
    );
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.targetMatches.some(
        (match) =>
          match.artifact === "extensions/test-function/dist/function.wasm" &&
          match.target === "minimatch" &&
          match.evidence === "wasm-import:minimatch:f",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for per-file, total-byte, file-count, and depth limits", () => {
  const fixture = createFixture();
  try {
    const fileResult = verifyBuildArtifacts({
      ...fixture,
      limits: {
        maxFileBytes: 8,
      },
    });
    assert.equal(fileResult.ok, false);
    assert.ok(
      fileResult.invalidArtifacts.some((item) =>
        item.endsWith(":file_size_limit_exceeded"),
      ),
    );

    assert.throws(
      () =>
        verifyBuildArtifacts({
          ...fixture,
          limits: {
            maxTotalBytes: 16,
          },
        }),
      (error) => error.code === "ARTIFACT_TOTAL_SIZE_LIMIT_EXCEEDED",
    );

    const countResult = verifyBuildArtifacts({
      ...fixture,
      limits: {
        maxFiles: 1,
      },
    });
    assert.equal(countResult.ok, false);
    assert.ok(
      countResult.invalidArtifacts.some((item) =>
        item.endsWith(":ARTIFACT_FILE_LIMIT_EXCEEDED"),
      ),
    );

    const nestedPath = path.join(
      fixture.rootDirectory,
      "app",
      "one",
      "two",
      "three.js",
    );
    fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
    fs.writeFileSync(nestedPath, "export const deep = true;\n");
    const depthResult = verifyBuildArtifacts({
      ...fixture,
      limits: {
        maxDepth: 1,
      },
    });
    assert.equal(depthResult.ok, false);
    assert.ok(
      depthResult.invalidArtifacts.some((item) =>
        item.endsWith(":ARTIFACT_DEPTH_LIMIT_EXCEEDED"),
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("rejects invalid artifact limit definitions", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        verifyBuildArtifacts({
          ...fixture,
          limits: {
            maxFiles: 0,
          },
        }),
      (error) => error.code === "INVALID_ARTIFACT_LIMIT",
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for missing build trees and unsafe package files", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(path.join(fixture.rootDirectory, "build"), {
      force: true,
      recursive: true,
    });
    const missingPackage = verifyBuildArtifacts({
      ...fixture,
      packageFiles: ["missing-package.json"],
    });
    assert.equal(missingPackage.ok, false);
    assert.ok(missingPackage.missingArtifacts.includes("build/server/**/*.js"));
    assert.ok(
      missingPackage.missingArtifacts.includes("build/client/**/*.{css,js}"),
    );
    assert.ok(missingPackage.missingArtifacts.includes("missing-package.json"));

    const packagePath = path.join(fixture.rootDirectory, "package.json");
    fs.writeFileSync(packagePath, "{");
    const invalidPackage = verifyBuildArtifacts({
      ...fixture,
      packageFiles: ["package.json"],
    });
    assert.equal(invalidPackage.ok, false);
    assert.ok(
      invalidPackage.invalidArtifacts.includes("package.json:invalid_json"),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when a required artifact is a directory", () => {
  const fixture = createFixture();
  try {
    const target = path.join(
      fixture.rootDirectory,
      "extensions/test-function/dist/function.js",
    );
    fs.rmSync(target);
    fs.mkdirSync(target);
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        "extensions/test-function/dist/function.js:not_a_file",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("enforces the stricter source file size limit", () => {
  const fixture = createFixture();
  try {
    const sourcePath = path.join(fixture.rootDirectory, "app", "large.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export const source = 'larger';\n");
    const result = verifyBuildArtifacts({
      ...fixture,
      limits: {
        maxSourceFileBytes: 8,
      },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes("app/large.js:file_size_limit_exceeded"),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("rejects archives instead of scanning only their outer bytes", () => {
  const fixture = createFixture();
  try {
    const archivePath = path.join(
      fixture.rootDirectory,
      ".shopify",
      "deploy-bundle",
      "payload.zip",
    );
    fs.writeFileSync(archivePath, "PK fixture archive");
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        ".shopify/deploy-bundle/payload.zip:archive_not_supported",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for missing and malformed deploy manifests", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(
      fixture.rootDirectory,
      ".shopify/deploy-bundle/manifest.json",
    );
    fs.rmSync(manifestPath);
    const missing = verifyBuildArtifacts({
      ...fixture,
      requireShopifyDeployBundle: true,
    });
    assert.equal(missing.ok, false);
    assert.ok(
      missing.missingArtifacts.includes(".shopify/deploy-bundle/manifest.json"),
    );

    fs.writeFileSync(manifestPath, "{");
    const invalid = verifyBuildArtifacts(fixture);
    assert.equal(invalid.ok, false);
    assert.ok(
      invalid.invalidArtifacts.includes(
        ".shopify/deploy-bundle/manifest.json:invalid_json",
      ),
    );

    fs.writeFileSync(manifestPath, JSON.stringify({ modules: null }));
    const missingModules = verifyBuildArtifacts(fixture);
    assert.equal(missingModules.ok, false);
    assert.ok(
      missingModules.invalidArtifacts.includes(
        ".shopify/deploy-bundle/manifest.json:missing_modules",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("treats a deploy bundle as optional for a build-only audit", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(path.join(fixture.rootDirectory, ".shopify", "deploy-bundle"), {
      force: true,
      recursive: true,
    });
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, true);
    assert.equal(
      result.artifactClasses.find(
        (artifactClass) => artifactClass.id === "shopify-deploy-bundle",
      )?.expectedMinimumCount,
      0,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed for missing module assets and referenced files", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(
      fixture.rootDirectory,
      ".shopify/deploy-bundle/manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    manifest.modules[0].config.extension_points = [];
    const functionArtifact = path.join(
      fixture.rootDirectory,
      ".shopify/deploy-bundle/function/dist/index.wasm",
    );
    fs.rmSync(functionArtifact);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        ".shopify/deploy-bundle/manifest.json:missing_main_asset:account-home-entry",
      ),
    );
    assert.ok(
      result.missingArtifacts.includes(
        ".shopify/deploy-bundle/function/dist/index.wasm",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when a metafile has no inputs map", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(
        fixture.rootDirectory,
        "extensions/test-ui/dist/extension.metafile.json",
      ),
      JSON.stringify({ inputs: null }),
    );
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        "extensions/test-ui/dist/extension.metafile.json:missing_inputs",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test(
  "rejects symlinks in audited trees",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture();
    try {
      const outside = path.join(fixture.rootDirectory, "outside.js");
      fs.writeFileSync(outside, "export const outside = true;\n");
      fs.symlinkSync(
        outside,
        path.join(fixture.rootDirectory, "build/server/assets/link.js"),
      );
      const result = verifyBuildArtifacts(fixture);
      assert.equal(result.ok, false);
      assert.ok(
        result.invalidArtifacts.includes(
          "build/server:ARTIFACT_SYMLINK_REJECTED",
        ),
      );
    } finally {
      removeFixture(fixture);
    }
  },
);

test("reports artifact classes with required minima", () => {
  const fixture = createFixture();
  try {
    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, true);
    assert.ok(result.artifactClasses.length >= 12);
    assert.ok(
      result.artifactClasses.every(
        (artifactClass) =>
          artifactClass.actualCount >= artifactClass.expectedMinimumCount,
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when the Remix client entry bundle is missing", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(
      path.join(
        fixture.rootDirectory,
        "build/client/assets/entry.client-fixture.js",
      ),
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        "artifact_class_missing:remix-client-entry:build/client/assets/entry.client-*.js",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when the Remix client runtime manifest is missing", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(
      path.join(
        fixture.rootDirectory,
        "build/client/assets/manifest-fixture.js",
      ),
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        "artifact_class_missing:remix-client-runtime-manifest:build/client/assets/manifest-*.js",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails closed when the Remix client stylesheet is missing", () => {
  const fixture = createFixture();
  try {
    fs.rmSync(
      path.join(
        fixture.rootDirectory,
        "build/client/assets/styles-fixture.css",
      ),
    );

    const result = verifyBuildArtifacts(fixture);
    assert.equal(result.ok, false);
    assert.ok(
      result.invalidArtifacts.includes(
        "artifact_class_missing:remix-client-styles:build/client/assets/*.css",
      ),
    );
  } finally {
    removeFixture(fixture);
  }
});
