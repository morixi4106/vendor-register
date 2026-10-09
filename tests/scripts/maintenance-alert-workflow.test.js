import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(
  fs.readFileSync(
    new URL("../../.github/workflows/maintenance-alerts.yml", import.meta.url),
    "utf8",
  ),
);
const script = workflow.jobs.notify.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fixture({
  ref = "refs/heads/main",
  confirmation = "TEST_NOTIFICATION",
  existing = null,
} = {}) {
  const writes = [];
  const context = {
    eventName: "workflow_dispatch",
    ref,
    repo: { owner: "operator", repo: "example" },
    payload: { inputs: { confirmation } },
  };
  const github = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: existing ? [existing] : [] }),
        create: async (input) => {
          writes.push(input);
        },
        createComment: async (input) => {
          writes.push(input);
        },
      },
    },
  };
  return { context, github, writes };
}

test("manual bot notification is explicitly confirmed, main-only and writes no human acknowledgement", async () => {
  const f = fixture();
  await new AsyncFunction("github", "context", script)(f.github, f.context);
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].body.includes("@operator"));
  assert.ok(f.writes[0].body.includes("After actually receiving"));
  assert.notEqual(f.writes[0].body.trim(), "/ack-maintenance");
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    actions: "read",
    issues: "write",
  });
  assert.ok(
    workflow.jobs.notify.if.includes(
      "inputs.confirmation == 'TEST_NOTIFICATION'",
    ),
  );
  assert.ok(
    workflow.jobs.notify.if.includes(
      "head_repository.full_name == github.repository",
    ),
  );
});

test("wrong confirmations and other branches do not write notifications", async () => {
  for (const args of [
    { confirmation: "not-approved" },
    { ref: "refs/heads/untrusted" },
  ]) {
    const f = fixture(args);
    await assert.rejects(
      new AsyncFunction("github", "context", script)(f.github, f.context),
      /not authorized/,
    );
    assert.equal(f.writes.length, 0);
  }
});

test("manual notification tests do not flood an existing recent test Issue", async () => {
  const f = fixture({
    existing: {
      number: 5,
      updated_at: new Date().toISOString(),
      body: "<!-- maintenance-github-receipt-test -->",
    },
  });
  await new AsyncFunction("github", "context", script)(f.github, f.context);
  assert.equal(f.writes.length, 0);
});
