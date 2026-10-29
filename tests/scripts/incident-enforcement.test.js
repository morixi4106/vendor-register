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
