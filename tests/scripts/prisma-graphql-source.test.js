import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  validatePrismaGraphqlSource,
  checkPrismaGraphqlWiring,
  checkPrismaGraphqlMetadata,
  prismaGraphqlArguments,
} from "../../scripts/security/prisma-graphql-source.mjs";
import { prismaSourceInput } from "../../scripts/security/test-prisma-source.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "security/prisma-source-contracts.json")),
);
const entry = policy.graphqlSource;

test("GraphQL recipe binds the original fork, upstream reference, limits and test-only contracts without approval", () => {
  assert.equal(validatePrismaGraphqlSource(entry), entry);
  for (const change of [
    (p) => {
      p.maximumNesting = 5000;
    },
    (p) => {
      p.commit = "0".repeat(40);
    },
    (p) => {
      p.sha256 = "0".repeat(64);
    },
    (p) => {
      p.reviewStatus = "REVIEWED";
    },
    (p) => {
      p.sourceFiles.pop();
    },
    (p) => {
      p.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.patch.path = "../graphql.patch";
    },
    (p) => {
      p.productionApproved = true;
    },
    (p) => {
      p.referenceCommit = "0".repeat(40);
    },
  ]) {
    const p = structuredClone(entry);
    change(p);
    assert.throws(() => validatePrismaGraphqlSource(p), /policy_invalid/);
  }
  const patch = prismaSourceInput(root, entry.patch).toString("utf8");
  assert.match(patch, /tokens\.uncons\(\)/);
  assert.match(patch, /token\.kind != Kind::Punctuator/);
  assert.equal(
    [...patch.matchAll(/^\+ {4}TokenStream::check_recursion_limit\(s\)\?;/gm)]
      .length,
    2,
  );
  assert.equal([...patch.matchAll(/^\+#\[test\]/gm)].length, 18);
  assert.ok(patch.includes("#[cfg(test)]"));
  assert.deepEqual(prismaGraphqlArguments(), [
    "test",
    "--locked",
    "--package",
    "graphql-parser",
    "--lib",
    "oja_security_contracts",
  ]);
});

function fixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-source-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "vendor/graphql/src"), { recursive: true });
  const workspace =
    '[workspace]\nexclude=["vendor/graphql"]\n[workspace.dependencies]\ngraphql-parser={path="vendor/graphql",version="=0.3.0+oja.1"}\n';
  fs.writeFileSync(path.join(source, "Cargo.toml"), workspace);
  fs.writeFileSync(
    path.join(source, "vendor/graphql/Cargo.toml"),
    '[package]\nname="graphql-parser"\nversion="0.3.0+oja.1"\n[dependencies]\ncombine="3.2.0"\nindexmap="1.5"\nthiserror="1.0.11"\n',
  );
  fs.writeFileSync(
    path.join(source, "vendor/graphql/src/lib.rs"),
    "#[cfg(test)]\nmod oja_security_contracts;\n",
  );
  const pkg = {
    id: "graphql",
    name: "graphql-parser",
    version: entry.version,
    manifest_path: path.join(source, "vendor/graphql/Cargo.toml"),
  };
  const packages = [
    pkg,
    ...["query-engine", "request-handlers"].map((name) => ({ id: name, name })),
  ];
  const metadata = {
    packages,
    resolve: {
      nodes: packages.map((p) => ({
        id: p.id,
        features: p.name === "request-handlers" ? ["graphql-protocol"] : [],
        deps: p === pkg ? [] : [{ name: "graphql_parser", pkg: pkg.id }],
      })),
    },
  };
  return { source, metadata };
}

test("GraphQL source wiring requires the actual path dependency and all bound source hashes", (t) => {
  const { source } = fixture(t),
    calls = [];
  checkPrismaGraphqlWiring(source, entry, (base, f) =>
    calls.push({ base, ...f }),
  );
  assert.equal(calls.length, 8);
  assert.ok(calls.every((f) => f.base === path.join(source, "vendor/graphql")));
  assert.deepEqual(
    calls.map((f) => f.sha256),
    entry.sourceFiles.map((f) => f.sha256),
  );
  assert.throws(
    () =>
      checkPrismaGraphqlWiring(source, entry, () => {
        throw Error("changed_hash");
      }),
    /changed_hash/,
  );
  fs.writeFileSync(
    path.join(source, "Cargo.toml"),
    '[workspace]\n[workspace.dependencies]\ngraphql-parser={git="https://github.com/unbound/parser"}',
  );
  assert.throws(
    () => checkPrismaGraphqlWiring(source, entry, () => {}),
    /wiring_invalid/,
  );
});

test("GraphQL metadata rejects detached code, version changes, dropped consumers or features", (t) => {
  const { source, metadata } = fixture(t);
  assert.equal(checkPrismaGraphqlMetadata(metadata, source, entry), true);
  for (const change of [
    (m) => {
      m.packages[0].source = "registry+unreviewed";
    },
    (m) => {
      m.packages[0].version = "0.3.0";
    },
    (m) => {
      m.packages[0].manifest_path = path.join(source, "Cargo.toml");
    },
    (m) => {
      m.resolve.nodes[1].deps = [];
    },
    (m) => {
      m.resolve.nodes[2].features = [];
    },
    (m) => {
      m.resolve.nodes[0].features = ["unreviewed"];
    },
  ]) {
    const m = structuredClone(metadata);
    change(m);
    assert.throws(
      () => checkPrismaGraphqlMetadata(m, source, entry),
      /prisma_graphql_/,
    );
  }
});

test("dedicated parser regression CI remains read-only, unscheduled and non-promoting", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(root, ".github/workflows/prisma-graphql-contracts.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.on.schedule, undefined);
  const steps = workflow.jobs["graphql-contracts"].steps;
  assert.ok(
    steps.some(
      (s) =>
        s.run === "node scripts/security/test-prisma-source.mjs --graphql-only",
    ),
  );
  assert.ok(steps.every((s) => !s["continue-on-error"]));
});
