import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("production builds and CI cannot skip the incident audit", () => {
  const quality = yaml.load(read(".github/workflows/quality.yml"));
  const steps = quality.jobs.verify.steps;
  const gateIndex = steps.findIndex(
    (step) => step.run === "npm run audit:incident",
  );
  const nativeBuildIndex = steps.findIndex((step) =>
    step.run?.includes("npm run test:checkout-function"),
  );
  assert.ok(gateIndex > 0 && gateIndex < nativeBuildIndex);
  assert.equal(steps[gateIndex]["continue-on-error"], undefined);
  assert.equal(steps[gateIndex].if, undefined);
  const minimatchStep = steps.find(
    (step) => step.run === "node scripts/security/minimatch-backport.mjs",
  );
  assert.ok(minimatchStep);
  assert.equal(minimatchStep.if, undefined);
  assert.equal(minimatchStep["continue-on-error"], undefined);
  const incident = read("scripts/security/incident-audit.mjs");
  assert.ok(incident.includes('"scripts/security/minimatch-backport.mjs"'));
  assert.ok(
    incident.indexOf('"scripts/security/minimatch-backport.mjs"') <
      incident.indexOf("collectNativeInventory(root)"),
  );
  assert.ok(
    quality.jobs["runtime-integrity"].steps.some((step) =>
      step.run?.includes("tests/scripts/native-inventory.test.js"),
    ),
  );
  const build = read("scripts/security/production-build.mjs");
  assert.ok(
    build.indexOf("const incident = auditIncident(ROOT)") <
      build.indexOf("assertProductionBuildAdmission();"),
  );
  assert.match(
    build,
    /if \(!incident\.ok\) throw new Error\("production_build_incident_unresolved"\)/,
  );
  const migration = yaml.load(
    read(".github/workflows/production-migration.yml"),
  );
  const migrationSteps = migration.jobs.migrate.steps;
  assert.ok(
    migrationSteps.findIndex((step) => step.run === "npm run audit:incident") <
      migrationSteps.findIndex(
        (step) => step.run === "npx prisma migrate deploy",
      ),
  );
});

test("runtime integrity checks fail independently on both Windows and Linux", () => {
  const quality = yaml.load(read(".github/workflows/quality.yml"));
  const job = quality.jobs["runtime-integrity"];
  assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
  const commands = [
    "npm run runtime:version",
    "node --test tests/scripts/node-runtime.test.js tests/scripts/deepmerge-security-backport.test.js tests/scripts/vendor-patches.test.js tests/scripts/native-inventory.test.js tests/scripts/incident-enforcement.test.js tests/scripts/runtime-package.test.js tests/scripts/safe-build.test.js tests/scripts/rebuild-esbuild.test.js",
    "node --test tests/scripts/minimatch-backport.test.js tests/scripts/npm-tree-verification.test.js",
    "node scripts/security/minimatch-backport.mjs",
    "npm run audit:npm-tree",
    "npm audit --audit-level=low",
    "npm run build:function:types",
    "git diff --exit-code",
  ];
  let previous = -1;
  for (const command of commands) {
    const index = job.steps.findIndex(
      (step, index) => index > previous && step.run === command,
    );
    assert.ok(index > previous, command);
    const step = job.steps[index];
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.shell, undefined);
    assert.equal(step.run.includes("\n"), false);
    previous = index;
  }
});

test("all Node setup workflows use the exact version policy and no floating action tags", () => {
  for (const name of fs.readdirSync(path.join(ROOT, ".github/workflows"))) {
    const workflow = yaml.load(read(`.github/workflows/${name}`));
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps || []) {
        if (step.uses?.startsWith("actions/"))
          assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("actions/setup-node@")) {
          assert.equal(step.with["node-version-file"], ".node-version");
          assert.equal(step.with["node-version"], undefined);
        }
      }
    }
  }
  assert.equal(
    read(".node-version").trim(),
    JSON.parse(read("security/node-runtime.json")).version,
  );
  assert.match(
    read("Dockerfile"),
    /^FROM node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64}/,
  );
  assert.match(read("Dockerfile"), /npm run build:production/);
  assert.match(
    read(".gitattributes"),
    /vendor\/deepmerge\/\*\.cjs text eol=lf/,
  );
  assert.match(read(".gitattributes"), /vendor\/deepmerge\/\*\.tgz binary/);
});

test("manual backport verification retains both platforms and unconditional checks", () => {
  const workflow = yaml.load(read(".github/workflows/minimatch-backport.yml"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  const job = workflow.jobs.backport;
  assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
  for (const command of [
    "node --test tests/scripts/minimatch-backport.test.js tests/scripts/npm-tree-verification.test.js",
    "node scripts/security/minimatch-backport.mjs",
    "npm run audit:npm-tree",
    "npm audit --audit-level=low",
    "npm run build:function:types",
    "git diff --exit-code",
  ]) {
    const step = job.steps.find((item) => item.run === command);
    assert.ok(step, command);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  assert.equal(job.steps[0].with["persist-credentials"], false);
  assert.match(job.steps[3].run, /npm ci --ignore-scripts/);
  const manifest = JSON.parse(read("package.json"));
  assert.equal(
    manifest.scripts["audit:npm-tree"],
    "node scripts/security/verify-npm-tree.mjs",
  );
  const entrypoint = read("scripts/security/verify-npm-tree.mjs");
  assert.ok(entrypoint.includes("!process.env.npm_execpath"));
  assert.ok(entrypoint.includes("collectNpmTreeEvidence"));
  assert.ok(!entrypoint.includes("npm exec"));
});
