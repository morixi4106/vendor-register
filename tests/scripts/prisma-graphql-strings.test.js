import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  validateGraphqlStringPolicy,
  verifyGraphqlStringOutput,
} from "../../scripts/security/prisma-graphql-strings.mjs";
import { prismaSourceInput } from "../../scripts/security/test-prisma-source.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "security/prisma-graphql-strings.json")),
);
function output(phase) {
  const text = prismaSourceInput(
    root,
    policy[phase === "baseline" ? "baseline" : "regressions"],
  ).toString();
  const names = [...text.matchAll(/#\[test\]\s+fn ([a-z_0-9]+)/g)].map(
    (m) => m[1],
  );
  return (
    names.map((n) => `test oja_string_review::${n} ... ok`).join("\n") +
    `\ntest result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n`
  );
}

test("string candidate binds fixed original source and all three byte-exact inputs, without native adoption", () => {
  assert.equal(validateGraphqlStringPolicy(policy), policy);
  for (const input of [policy.patch, policy.baseline, policy.regressions])
    assert.ok(prismaSourceInput(root, input).length > 100);
  const patch = prismaSourceInput(root, policy.patch).toString();
  assert.match(patch, /^@@ -149,38 \+149,21 @@$/m);
  assert.deepEqual(
    [...patch.matchAll(/^diff --git (.+)$/gm)].map((m) => m[1]),
    ["a/src/common.rs b/src/common.rs"],
  );
  assert.match(patch, /^-\s+let trimmed = line\.trim_start\(\)\.len\(\);/m);
  assert.match(patch, /^\+\s+let n = line\.bytes\(\)\.take_while/m);
  assert.equal(policy.productionPatchApplied, false);
});

test("string candidate rejects altered baselines, paths, quantities and every promotion flag", () => {
  const changes = [
    (p) => {
      p.schemaVersion = 2;
    },
    (p) => {
      p.basePolicySha256 = "0".repeat(64);
    },
    (p) => {
      p.commonBeforeSha256 = "0".repeat(64);
    },
    (p) => {
      p.commonAfterSha256 = p.commonBeforeSha256;
    },
    (p) => {
      p.baselineTests = 0;
    },
    (p) => {
      p.regressionTests = 1;
    },
    (p) => {
      p.productionPatchApplied = true;
    },
    (p) => {
      p.wholeEngineVerified = true;
    },
    (p) => {
      p.productionApproved = true;
    },
    (p) => {
      p.unknown = true;
    },
  ];
  for (const key of ["patch", "baseline", "regressions"]) {
    changes.push((p) => {
      p[key].path = "../unbound.rs";
    });
    changes.push((p) => {
      p[key].sha256 = "invalid";
    });
    changes.push((p) => {
      p[key].unknown = "ignored";
    });
  }
  for (const change of changes) {
    const p = structuredClone(policy);
    change(p);
    assert.throws(() => validateGraphqlStringPolicy(p));
  }
});

test("string replay requires every exact baseline and regression name, not an aggregate success", () => {
  for (const phase of ["baseline", "regressions"]) {
    const log = output(phase);
    assert.equal(
      verifyGraphqlStringOutput(log, phase).passed,
      phase === "baseline" ? 3 : 9,
    );
    for (const bad of [
      log.replace(/test oja_string_review::[^\n]+\n/, ""),
      log.replace("oja_string_review::", "unbound::"),
      log.replace(" ... ok", " ... FAILED"),
      log.replace("0 ignored", "1 ignored"),
      log.replace("0 failed", "1 failed"),
      log + "\ntest result: FAILED",
      log.replace("test result: ok", "test result: incomplete"),
      log + log,
    ])
      assert.throws(() => verifyGraphqlStringOutput(bad, phase));
  }
  assert.throws(() =>
    verifyGraphqlStringOutput(output("baseline"), "regressions"),
  );
  assert.throws(() => verifyGraphqlStringOutput("", "unknown"));
});

test("string candidate CI stays explicit and isolated, with both operating systems and no approval bypass", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(root, ".github/workflows/prisma-graphql-contracts.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.jobs["graphql-contracts"].strategy.matrix.os, [
    "ubuntu-latest",
    "windows-latest",
  ]);
  assert.ok(
    workflow.on.pull_request.paths.includes(
      "security/prisma-graphql-strings.json",
    ),
  );
  assert.ok(
    workflow.on.pull_request.paths.includes(
      "tests/fixtures/prisma/graphql-string-*.rs",
    ),
  );
  const steps = workflow.jobs["graphql-contracts"].steps;
  assert.ok(
    steps.some((s) =>
      s.run?.includes("tests/scripts/prisma-graphql-strings.test.js"),
    ),
  );
  assert.ok(steps.every((s) => !s["continue-on-error"]));
});
