import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const lockfile = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);

test("every GraphQL Tools utility installation is pinned to the official patched version", () => {
  assert.equal(manifest.overrides["@graphql-tools/utils"], "12.0.3");
  assert.equal(manifest.resolutions["@graphql-tools/utils"], "12.0.3");
  const installations = Object.entries(lockfile.packages).filter(([location]) =>
    location.endsWith("node_modules/@graphql-tools/utils"),
  );
  assert.ok(installations.length > 0);
  for (const [location, metadata] of installations) {
    assert.equal(metadata.version, "12.0.3", location);
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, location, "package.json"), "utf8"),
    );
    assert.equal(installed.version, metadata.version, location);
  }
});

test("Shopify Function compiler tools stay development-only and resolve patched utilities", () => {
  assert.equal(manifest.devDependencies["@shopify/shopify_function"], "2.0.1");
  const workspace = JSON.parse(
    fs.readFileSync(
      path.join(root, "extensions/marketplace-purchase-control/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    workspace.dependencies?.["@shopify/shopify_function"],
    undefined,
  );
  assert.equal(
    lockfile.packages["node_modules/@shopify/shopify_function"].dev,
    true,
  );
  const fromFunction = createRequire(
    require.resolve("@shopify/shopify_function/package.json"),
  );
  for (const name of ["@graphql-codegen/cli", "graphql-config"]) {
    const fromCompiler = createRequire(
      fromFunction.resolve(`${name}/package.json`),
    );
    assert.equal(
      fromCompiler.resolve("@graphql-tools/utils"),
      require.resolve("@graphql-tools/utils"),
    );
  }
});

test("patched GraphQL result merging preserves aliases without polluting prototypes", () => {
  const { mergeDeep } = require("@graphql-tools/utils");
  const marker = "__graphqlToolchainSecurityTest";
  const dangerous = JSON.parse(
    `{"constructor":{"__proto__":{"${marker}":true}},"__proto__":{"${marker}":true}}`,
  );
  try {
    const result = mergeDeep([
      { result: { amount: 65 } },
      dangerous,
      { result: { currency: "JPY" } },
    ]);
    assert.equal(Object.prototype[marker], undefined);
    assert.equal(Function.prototype[marker], undefined);
    assert.deepEqual(result.result, { amount: 65, currency: "JPY" });
  } finally {
    delete Object.prototype[marker];
    delete Function.prototype[marker];
  }
});
