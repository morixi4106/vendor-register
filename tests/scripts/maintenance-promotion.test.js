import assert from "node:assert/strict";
import test from "node:test";
import { promoteMaintenance } from "../../scripts/maintenance-promotion.mjs";

function fixture() {
  const base = "a".repeat(40),
    head = "b".repeat(40);
  const beforeManifest = {
    name: "test",
    version: "1.0.0",
    dependencies: { safe: "1.0.0" },
    devDependencies: { prettier: "3.8.0" },
  };
  const beforeLock = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: beforeManifest.dependencies,
        devDependencies: beforeManifest.devDependencies,
      },
      "node_modules/safe": { version: "1.0.0" },
      "node_modules/prettier": {
        version: "3.8.0",
        integrity: "sha512-YWJj",
        resolved: "https://registry.npmjs.org/prettier/-/prettier-3.8.0.tgz",
        dev: true,
      },
    },
  };
  const afterManifest = structuredClone(beforeManifest);
  afterManifest.devDependencies.prettier = "3.8.1";
  const afterLock = structuredClone(beforeLock);
  afterLock.packages[""].devDependencies = afterManifest.devDependencies;
  afterLock.packages["node_modules/prettier"].version = "3.8.1";
  const f = {
    env: {
      AUTO_MAINTENANCE_MERGE_ENABLED: "true",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "fake-token",
      LAUNCH_MONITOR_URL: "https://app.example.test",
      MAINTENANCE_GATE_TOKEN: "gate-".repeat(8),
      MAINTENANCE_SECONDARY_RECEIPT_ISSUE: "42",
    },
    event: {
      workflow_run: {
        id: 123,
        event: "pull_request",
        head_repository: { full_name: "owner/repo" },
        conclusion: "success",
        name: "Quality checks",
        pull_requests: [{ number: 7 }],
        head_sha: head,
      },
    },
    pr: {
      state: "open",
      draft: false,
      user: { login: "dependabot[bot]" },
      head: { sha: head, repo: { full_name: "owner/repo" } },
      base: { sha: base, ref: "main" },
      changed_files: 2,
    },
    files: [{ filename: "package.json" }, { filename: "package-lock.json" }],
    job: {
      name: "verify",
      conclusion: "success",
      steps: [
        "Test",
        "Enforce production audit coverage",
        "Test checkout validation function",
        "Verify isolated production runtime package",
        "Audit production dependencies",
      ].map((name) => ({ name, conclusion: "success" })),
    },
    gate: { schemaVersion: 1, ready: true, renderCommit: base },
    comments: [{ body: "/ack-maintenance", author_association: "OWNER" }],
    calls: [],
    beforeManifest,
    beforeLock,
    afterManifest,
    afterLock,
  };
  let prReads = 0;
  f.fetchImpl = async (input, options) => {
    const url = new URL(input);
    f.calls.push({ url, options });
    let data;
    if (url.pathname === "/internal/maintenance-readiness") data = f.gate;
    else if (url.pathname.endsWith("/pulls/7/merge")) data = { merged: true };
    else if (url.pathname.endsWith("/pulls/7")) {
      prReads++;
      data = structuredClone(f.pr);
      if (f.changeHead && prReads > 1) data.head.sha = "c".repeat(40);
    } else if (url.pathname.endsWith("/jobs")) data = { jobs: [f.job] };
    else if (url.pathname.endsWith("/files")) data = f.files;
    else if (url.pathname.includes("/contents/")) {
      const before = url.searchParams.get("ref") === base;
      const document = url.pathname.endsWith("/package.json")
        ? before
          ? f.beforeManifest
          : f.afterManifest
        : before
          ? f.beforeLock
          : f.afterLock;
      data = {
        type: "file",
        encoding: "base64",
        size: 1000,
        content: Buffer.from(JSON.stringify(document)).toString("base64"),
      };
    } else if (url.pathname.endsWith("/issues/42/comments")) data = f.comments;
    else if (url.pathname.endsWith("/issues/42"))
      data = { body: "<!-- maintenance-render-runner -->" };
    else if (url.pathname.includes("/compare/"))
      data = { status: "diverged", files: [] };
    else throw new Error("unexpected fixture request");
    return { ok: true, json: async () => data };
  };
  return f;
}

test("routine promotion preserves the sales release and freezes the exact head", async () => {
  const f = fixture();
  assert.equal((await promoteMaintenance(f)).promoted, true);
  const merge = f.calls.find((c) => c.url.pathname.endsWith("/merge"));
  assert.equal(merge.options.method, "PUT");
  const body = JSON.parse(merge.options.body);
  assert.equal(body.sha, f.pr.head.sha);
  assert.ok(body.commit_title.includes("[skip render]"));
});

test("disabled, forked, stale, unverified and protected changes never merge", async () => {
  for (const change of [
    (f) => (f.env.AUTO_MAINTENANCE_MERGE_ENABLED = "false"),
    (f) => (f.event.workflow_run.head_repository.full_name = "fork/repo"),
    (f) => (f.pr.user.login = "other-user"),
    (f) => (f.pr.head.sha = "c".repeat(40)),
    (f) => (f.job.steps[0].conclusion = "skipped"),
    (f) => f.files.push({ filename: "server.mjs" }),
    (f) => (f.gate.ready = false),
    (f) => delete f.env.MAINTENANCE_SECONDARY_RECEIPT_ISSUE,
    (f) => (f.comments[0].author_association = "NONE"),
    (f) => (f.gate.renderCommit = "c".repeat(40)),
    (f) => (f.changeHead = true),
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await promoteMaintenance(f)).promoted, false);
    assert.equal(
      f.calls.some((c) => c.url.pathname.endsWith("/merge")),
      false,
    );
  }
});
