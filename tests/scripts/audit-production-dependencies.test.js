import assert from "node:assert/strict";
import test from "node:test";

import { evaluateProductionAuditReport } from "../../scripts/audit-production-dependencies.mjs";

function knownReport() {
  return {
    vulnerabilities: {
      "@remix-run/react": {
        severity: "moderate",
        via: ["react-router", "react-router-dom"],
      },
      "react-router": {
        severity: "moderate",
        via: [
          {
            url: "https://github.com/advisories/GHSA-wrjc-x8rr-h8h6",
          },
          {
            url: "https://github.com/advisories/GHSA-337j-9hxr-rhxg",
          },
        ],
      },
      "react-router-dom": {
        severity: "moderate",
        via: [
          {
            url: "https://github.com/advisories/GHSA-jjmj-jmhj-qwj2",
          },
          "react-router",
        ],
      },
    },
  };
}

test("allows only the documented React Router advisories before expiry", () => {
  const result = evaluateProductionAuditReport(knownReport(), {
    now: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.allowed.length, 3);
  assert.deepEqual(result.blocking, []);
});

test("blocks an unknown moderate advisory", () => {
  const report = knownReport();
  report.vulnerabilities["react-router"].via.push({
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  });

  const result = evaluateProductionAuditReport(report, {
    now: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].packageName, "react-router");
});

test("never allows a high severity advisory", () => {
  const report = knownReport();
  report.vulnerabilities["react-router"].severity = "high";

  const result = evaluateProductionAuditReport(report, {
    now: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].severity, "high");
});

test("blocks the temporary exception after its expiry date", () => {
  const result = evaluateProductionAuditReport(knownReport(), {
    now: new Date("2026-10-01T00:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.ok(result.blocking.length >= 1);
});
