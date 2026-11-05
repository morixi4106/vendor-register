import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import toml from "toml";
import yaml from "js-yaml";
import {
  prismaGitIdentities,
  assessPrismaGitIdentities,
} from "../../scripts/security/prisma-git-assessment.mjs";

const root = new URL("../../", import.meta.url);
const policy = JSON.parse(
  fs.readFileSync(new URL("security/prisma-source-contracts.json", root)),
);
const lock = fs.readFileSync(new URL(policy.lockfile.path, root));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
function fixture() {
  const packages = toml
    .parse(lock.toString("utf8"))
    .package.filter(
      (p) =>
        p.source?.startsWith("git+") ||
        [
          "graphql-parser",
          "mysql_async",
          "cuid",
          "cuid-util",
          "cuid1",
          "cuid2",
          "postgres-protocol",
          "postgres-types",
          "postgres-native-tls",
          "tokio-postgres",
        ].includes(p.name),
    )
    .map((p) => ({ ...p, id: p.name }));
  packages.push(
    ...["query-engine-node-api", "schema-engine-cli"].map((name) => ({
      id: name,
      name,
      version: "0.1.0",
    })),
  );
  const nodes = packages.map((p) => ({ id: p.id, deps: [], features: [] }));
  nodes.find((n) => n.id === "query-engine-node-api").deps = packages
    .slice(0, 13)
    .map((p) => ({
      name: p.name,
      pkg: p.id,
      dep_kinds: [{ kind: p.name === "barrel" ? "dev" : null, target: null }],
    }));
  return { packages, resolve: { nodes } };
}
const advisory = () => ({
  id: "RUSTSEC-2026-0178",
  modified: "2026-08-25T02:45:03.437011884Z",
  affected: [{ package: { ecosystem: "crates.io", name: "tokio-postgres" } }],
  details: "Fixture only. Not a source review.",
  references: [
    {
      type: "ADVISORY",
      url: "https://rustsec.org/advisories/RUSTSEC-2026-0178.html",
    },
  ],
});
const response = (v) => new Response(JSON.stringify(v));

test("all original Git identities survive path patching and keep declared upstream versions", () => {
  const entries = prismaGitIdentities(policy, lock, fixture());
  assert.equal(entries.length, 13);
  assert.equal(entries.filter((p) => p.source).length, 3);
  assert.equal(new Set(entries.map((p) => p.commit)).size, 6);
  assert.equal(
    entries.find((p) => p.name === "mysql_async").upstreamVersion,
    "0.31.3",
  );
  assert.equal(entries.find((p) => p.name === "cuid").upstreamVersion, "1.3.3");
  assert.ok(entries.every((p) => p.reviewStatus === "UNREVIEWED"));
  assert.ok(
    entries
      .filter((p) => !p.source)
      .every((p) => p.archiveSha256 && p.patchSha256),
  );
});

test("graph paths exclude dev-only edges, include build edges, and handle cycles", () => {
  const m = fixture();
  const node = m.resolve.nodes.find((n) => n.id === "tiberius");
  node.deps.push({ pkg: "tiberius-macros", dep_kinds: [{ kind: "build" }] });
  m.resolve.nodes
    .find((n) => n.id === "tiberius-macros")
    .deps.push({ pkg: "tiberius", dep_kinds: [{ kind: null }] });
  m.resolve.nodes.find((n) => n.id === "query-engine-node-api").deps =
    m.resolve.nodes
      .find((n) => n.id === "query-engine-node-api")
      .deps.filter((d) => d.pkg !== "tiberius-macros");
  const entries = prismaGitIdentities(policy, lock, m);
  assert.equal(
    entries.find((p) => p.name === "barrel").pathsFromReleaseRoots[
      "query-engine-node-api"
    ],
    null,
  );
  assert.deepEqual(
    entries.find((p) => p.name === "tiberius-macros").pathsFromReleaseRoots[
      "query-engine-node-api"
    ],
    ["query-engine-node-api", "tiberius", "tiberius-macros"],
  );
});

test("changed Git commit, missing inventory, changed lock and substituted metadata are rejected", () => {
  assert.throws(
    () =>
      prismaGitIdentities(
        policy,
        Buffer.concat([lock, Buffer.from("\n")]),
        fixture(),
      ),
    /lock_unbound/,
  );
  const changed = Buffer.from(
    lock
      .toString()
      .replace("35605c90adb38cc107d35c3432fd2643d9d6e1e6", "0".repeat(40)),
  );
  assert.throws(
    () =>
      prismaGitIdentities(
        { ...policy, lockfile: { sha256: sha(changed) } },
        changed,
        fixture(),
      ),
    /inventory_changed/,
  );
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "cuid").version = "9.9.9";
    },
    (m) => {
      m.packages.find((p) => p.name === "cuid").source = "registry+hidden";
    },
    (m) => {
      m.packages.push({ ...m.packages[0], id: "duplicate" });
    },
    (m) => {
      m.packages = m.packages.filter((p) => p.name !== "tiberius");
    },
    (m) => {
      m.resolve.nodes[0].deps = [
        { pkg: "missing", dep_kinds: [{ kind: null }] },
      ];
    },
    (m) => {
      m.resolve.nodes[0].deps = [{ pkg: "cuid", dep_kinds: [] }];
    },
    (m) => {
      m.resolve.nodes[0].deps = [
        { pkg: "cuid", dep_kinds: [{ kind: "unexpected" }] },
      ];
    },
    (m) => {
      m.packages = m.packages.filter((p) => p.name !== "schema-engine-cli");
    },
  ]) {
    const m = fixture();
    change(m);
    assert.throws(
      () => prismaGitIdentities(policy, lock, m),
      /prisma_git_metadata/,
    );
  }
});

test("13 registry identities and six exact commits are queried; no empty result grants approval", async () => {
  const report = await assessPrismaGitIdentities(policy, lock, fixture(), {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.osv.dev/v1/querybatch");
      assert.equal(options.redirect, "error");
      const queries = JSON.parse(options.body).queries;
      assert.equal(queries.length, 19);
      assert.equal(
        queries.find((q) => q.package?.name === "cuid").version,
        "1.3.3",
      );
      assert.ok(
        queries.slice(13).every((q) => /^[a-f0-9]{40}$/.test(q.commit)),
      );
      return response({ results: queries.map(() => ({})) });
    },
  });
  assert.equal(report.lookups.length, 19);
  assert.equal(report.packagesWithVersionMatches, 0);
  assert.equal(report.commitsWithMatches, 0);
  for (const name of [
    "sourceReviewed",
    "sourceAuditOk",
    "wholeEngineVerified",
    "productionApproved",
  ])
    assert.equal(report[name], false);
  assert.equal(report.artifactStatus, "NOT_VERIFIED");
  assert.equal(report.lockfileSha256, policy.lockfile.sha256);
  assert.match(report.scope, /not fork equivalence/);
});

test("full advisory payload and digest are retained once for shared version and commit matches", async () => {
  let calls = 0;
  const payload = advisory();
  const report = await assessPrismaGitIdentities(policy, lock, fixture(), {
    fetchImpl: async (url) => {
      calls++;
      if (url.endsWith("querybatch")) {
        const results = Array.from({ length: 19 }, () => ({}));
        for (const i of [12, 18])
          results[i] = {
            vulns: [
              { id: payload.id, modified: "2026-08-25T02:45:03.437011Z" },
            ],
          };
        return response({ results });
      }
      assert.ok(url.endsWith(payload.id));
      return response(payload);
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.packagesWithVersionMatches, 1);
  assert.equal(report.commitsWithMatches, 1);
  assert.deepEqual(report.advisories[0].payload, payload);
  assert.match(report.advisories[0].sha256, /^[a-f0-9]{64}$/);
});

test("advisory binding ignores object key order but retains body, references and affected ranges", async () => {
  async function digest(payload) {
    const report = await assessPrismaGitIdentities(policy, lock, fixture(), {
      fetchImpl: async (url) =>
        response(
          url.endsWith("querybatch")
            ? {
                results: [
                  { vulns: [advisory()] },
                  ...Array.from({ length: 18 }, () => ({})),
                ],
              }
            : payload,
        ),
    });
    return report.advisories[0].sha256;
  }
  const initial = advisory();
  const expected = await digest(initial);
  function reorder(value) {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, v]) => [key, reorder(v)]),
      );
    return value;
  }
  assert.equal(await digest(reorder(initial)), expected);
  for (const change of [
    (p) => {
      p.details += " Changed.";
    },
    (p) => {
      p.affected[0].ranges = [
        { type: "SEMVER", events: [{ introduced: "0" }] },
      ];
    },
    (p) => {
      p.references[0].url += "?changed=true";
    },
  ]) {
    const payload = advisory();
    change(payload);
    assert.notEqual(await digest(payload), expected);
  }
});

test("unavailable, malformed, paginated, duplicated and oversized responses fail closed", async () => {
  const good = Array.from({ length: 19 }, () => ({}));
  for (const body of [
    {},
    { results: [] },
    { results: good, unexpected: true },
    ...[
      null,
      [],
      { next_page_token: "more" },
      { vulns: {} },
      { unknown: true },
      { vulns: [{ id: "bad", modified: "bad" }] },
      { vulns: [advisory(), advisory()] },
    ].map((entry) => ({ results: [entry, ...good.slice(1)] })),
  ])
    await assert.rejects(
      assessPrismaGitIdentities(policy, lock, fixture(), {
        fetchImpl: async () => response(body),
      }),
    );
  await assert.rejects(
    assessPrismaGitIdentities(policy, lock, fixture(), {
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    /unavailable/,
  );
  await assert.rejects(
    assessPrismaGitIdentities(policy, lock, fixture(), {
      fetchImpl: async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
    }),
    /limit/,
  );
});

test("missing, changed, or partial advisory payloads cannot complete assessment", async () => {
  for (const change of [
    (p) => {
      p.id = "RUSTSEC-2026-0179";
    },
    (p) => {
      p.modified = "2026-11-05T00:00:00Z";
    },
    (p) => {
      p.affected = [];
    },
    (p) => {
      p.references = [];
    },
    (p) => {
      delete p.details;
    },
  ])
    await assert.rejects(
      assessPrismaGitIdentities(policy, lock, fixture(), {
        fetchImpl: async (url) => {
          if (url.endsWith("querybatch"))
            return response({
              results: [
                { vulns: [advisory()] },
                ...Array.from({ length: 18 }, () => ({})),
              ],
            });
          const payload = advisory();
          change(payload);
          return response(payload);
        },
      }),
      /payload_invalid/,
    );
});

test("both source and native workflows run rejection cases and preserve read-only permissions", () => {
  for (const name of ["prisma-source-contracts", "prisma-native-probe"]) {
    const workflow = yaml.load(
      fs.readFileSync(new URL(`.github/workflows/${name}.yml`, root), "utf8"),
    );
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.equal(workflow.on.schedule, undefined);
    assert.ok(
      workflow.on.pull_request.paths.includes(
        "tests/scripts/prisma-git-assessment.test.js",
      ),
    );
    for (const job of Object.values(workflow.jobs))
      assert.ok(
        job.steps.some((s) => s.run?.includes("prisma-git-assessment.test.js")),
      );
  }
  const runner = fs.readFileSync(
    new URL("scripts/security/test-prisma-source.mjs", root),
    "utf8",
  );
  assert.ok(
    runner.includes(
      'json("git-original-identity-assessment.json", gitAssessment)',
    ),
  );
  assert.ok(
    runner.includes(
      "gitIdentityAssessmentSha256: digest(JSON.stringify(gitAssessment))",
    ),
  );
});
