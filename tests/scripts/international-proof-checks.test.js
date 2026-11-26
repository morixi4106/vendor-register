import assert from "node:assert/strict";
import test from "node:test";
import { collectInternationalProofChecks } from "../../scripts/international-proof-artifact.mjs";
const headSha = "a".repeat(40);
function fixture(production = false) {
  const rows = [
    "quality.yml",
    "database-compatibility.yml",
    "international-checkout-browser.yml",
  ].map((name, index) => ({
    id: index + 10,
    path: `.github/workflows/${name}`,
    head_sha: headSha,
    run_attempt: 1,
    event: production ? "workflow_dispatch" : "pull_request",
    head_branch: production ? "main" : "agent/test",
    status: "completed",
    conclusion: "success",
  }));
  const api = {
    json: async (path) => ({
      workflow_runs: [
        rows.find((row) =>
          path.startsWith(`/actions/workflows/${row.path.split("/").at(-1)}/`),
        ),
      ].filter(Boolean),
    }),
  };
  return { rows, options: { api, production, headSha, ownRunId: 100 } };
}
test("proof exporter requires independent Quality and reviewed isolated database workflows, including candidate artifacts", async () => {
  for (const production of [false, true]) {
    const f = fixture(production);
    assert.deepEqual(await collectInternationalProofChecks(f.options), {
      quality: { runId: 10, runAttempt: 1 },
      postgres: { runId: 11, runAttempt: 1 },
      checkoutBrowser: { runId: 12, runAttempt: 1 },
    });
  }
});
test("exporter cannot substitute itself, old standalone DB workflow, stale source, pending or superseded failure", async () => {
  for (const mutate of [
    (f) => {
      f.rows[0].id = 100;
    },
    (f) => {
      f.rows[0].conclusion = "failure";
    },
    (f) => {
      f.rows[1].status = "in_progress";
    },
    (f) => {
      f.rows[1].head_sha = "b".repeat(40);
    },
    (f) => {
      f.rows[1].path =
        ".github/workflows/international-authorization-postgres.yml";
    },
    (f) => {
      f.rows[1].event = "push";
    },
    (f) => {
      f.rows[1].run_attempt = 0;
    },
    (f) => {
      f.rows[2].conclusion = "failure";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      collectInternationalProofChecks(f.options),
      /proof_required_ci_incomplete/,
    );
  }
  const f = fixture(true);
  f.rows[1].head_branch = "agent/test";
  await assert.rejects(
    collectInternationalProofChecks(f.options),
    /proof_required_ci_incomplete/,
  );
  const newer = fixture();
  const original = newer.options.api.json;
  newer.options.api.json = async (path) => {
    const value = await original(path);
    return {
      workflow_runs: [
        ...value.workflow_runs,
        { ...value.workflow_runs[0], id: 99, conclusion: "failure" },
      ],
    };
  };
  await assert.rejects(
    collectInternationalProofChecks(newer.options),
    /proof_required_ci_incomplete/,
  );
});
