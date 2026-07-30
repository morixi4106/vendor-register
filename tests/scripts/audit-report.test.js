import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLeafAdvisories,
  extractAdvisoryId,
  splitAuditVulnerabilitiesByReachability,
  vulnerabilityNodeLocations,
} from "../../scripts/security/audit-report.mjs";

test("extracts normalized GHSA identifiers", () => {
  assert.equal(
    extractAdvisoryId("https://github.com/advisories/GHSA-abcd-1234-efgh"),
    "GHSA-ABCD-1234-EFGH",
  );
  assert.equal(extractAdvisoryId("https://example.test/no-advisory"), null);
});

test("collects, deduplicates, and sorts transitive leaf advisories", () => {
  const report = {
    vulnerabilities: {
      parent: {
        via: ["child", "child"],
      },
      child: {
        severity: "high",
        via: [
          {
            name: "leaf",
            severity: "high",
            url: "https://github.com/advisories/GHSA-2222-3333-4444",
          },
          {
            name: "another",
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-1111-2222-3333",
          },
        ],
      },
    },
  };
  const result = collectLeafAdvisories(report, "parent");
  assert.deepEqual(
    result.advisories.map((item) => item.advisoryId),
    ["GHSA-1111-2222-3333", "GHSA-2222-3333-4444"],
  );
  assert.deepEqual(result.errors, []);
});

test("fails closed for cycles, missing links, and malformed via entries", () => {
  const cycle = collectLeafAdvisories(
    {
      vulnerabilities: {
        a: { via: ["b"] },
        b: { via: ["a"] },
      },
    },
    "a",
  );
  assert.ok(cycle.errors.some((error) => error.includes("Circular")));

  const missing = collectLeafAdvisories(
    {
      vulnerabilities: {
        a: { via: ["missing"] },
      },
    },
    "a",
  );
  assert.ok(missing.errors.some((error) => error.includes("missing")));

  const malformed = collectLeafAdvisories(
    {
      vulnerabilities: {
        a: { via: [null, { name: "leaf", url: "invalid" }] },
      },
    },
    "a",
  );
  assert.equal(malformed.errors.length, 2);
});

test("enforces audit report depth, advisory, and vulnerability limits", () => {
  const report = {
    vulnerabilities: {
      a: { via: ["b"] },
      b: {
        via: [
          {
            name: "one",
            url: "https://github.com/advisories/GHSA-1111-2222-3333",
          },
          {
            name: "two",
            url: "https://github.com/advisories/GHSA-2222-3333-4444",
          },
        ],
      },
    },
  };
  assert.ok(
    collectLeafAdvisories(report, "a", {
      limits: { maxDepth: 1 },
    }).errors.some((error) => error.includes("depth")),
  );
  assert.ok(
    collectLeafAdvisories(report, "a", {
      limits: { maxAdvisories: 1 },
    }).errors.some((error) => error.includes("advisory count")),
  );
  assert.ok(
    collectLeafAdvisories(report, "a", {
      limits: { maxVulnerabilities: 1 },
    }).errors.some((error) => error.includes("vulnerability count")),
  );
});

test("splits runtime and toolchain nodes and reports unresolved packages", () => {
  const result = splitAuditVulnerabilitiesByReachability(
    {
      vulnerabilities: {
        missing: { nodes: [] },
        runtime: { nodes: ["node_modules/runtime"] },
        tool: { nodes: ["node_modules/tool"] },
      },
    },
    new Set(["node_modules/runtime"]),
  );
  assert.deepEqual(Object.keys(result.runtime), ["runtime"]);
  assert.deepEqual(Object.keys(result.nonRuntime), ["tool"]);
  assert.deepEqual(result.unresolved, ["missing"]);
  assert.deepEqual(
    vulnerabilityNodeLocations({
      nodes: ["b", "a", "a"],
    }),
    ["a", "b"],
  );
});

test("enforces node reference and vulnerability limits while splitting", () => {
  const report = {
    vulnerabilities: {
      a: { nodes: ["one", "two"] },
      b: { nodes: ["three"] },
    },
  };
  const nodes = splitAuditVulnerabilitiesByReachability(report, new Set(), {
    limits: {
      maxNodeReferences: 2,
    },
  });
  assert.ok(
    nodes.unresolved.includes("__audit_node_reference_limit_exceeded__"),
  );

  const vulnerabilities = splitAuditVulnerabilitiesByReachability(
    report,
    new Set(),
    {
      limits: {
        maxVulnerabilities: 1,
      },
    },
  );
  assert.deepEqual(vulnerabilities.unresolved, [
    "__audit_report_limit_exceeded__",
  ]);
});

test("rejects invalid limit overrides", () => {
  assert.throws(
    () =>
      collectLeafAdvisories({ vulnerabilities: {} }, "a", {
        limits: {
          maxDepth: 0,
        },
      }),
    /invalid/,
  );
});

test("handles absent report structures and node arrays safely", () => {
  const leaf = collectLeafAdvisories(null, "missing");
  assert.deepEqual(leaf.advisories, []);
  assert.ok(leaf.errors.some((error) => error.includes("missing")));

  const split = splitAuditVulnerabilitiesByReachability(null, new Set());
  assert.deepEqual(split, {
    nonRuntime: {},
    runtime: {},
    unresolved: [],
  });
  assert.deepEqual(vulnerabilityNodeLocations({ nodes: null }), []);
});

test("inherits vulnerability severity when a leaf omits it", () => {
  const result = collectLeafAdvisories(
    {
      vulnerabilities: {
        parent: {
          severity: "critical",
          via: [
            {
              dependency: "leaf",
              url: "https://github.com/advisories/GHSA-1111-2222-3333",
            },
          ],
        },
      },
    },
    "parent",
  );
  assert.equal(result.advisories[0].name, "parent");
  assert.equal(result.advisories[0].severity, "critical");
});
