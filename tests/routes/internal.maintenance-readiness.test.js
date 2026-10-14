import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  requireBearerToken,
  requirePostRequest,
} from "../../app/utils/internalRouteSecurity.server.js";

function route(dependencies) {
  const source = fs.readFileSync(
    new URL(
      "../../app/routes/internal.maintenance-readiness.jsx",
      import.meta.url,
    ),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "route.jsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const file = ts.factory.updateSourceFile(
    parsed,
    parsed.statements.filter((node) => !ts.isImportDeclaration(node)),
  );
  const compiled = ts.transpileModule(ts.createPrinter().printFile(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("exports", ...Object.keys(dependencies), compiled)(
    exports,
    ...Object.values(dependencies),
  );
  return exports;
}

function fixture(token = "test-token-".repeat(4)) {
  const reads = [];
  const readiness = {
    schemaVersion: 1,
    ready: false,
    reasons: ["maintenance_not_authorized"],
  };
  const diagnostics = { schemaVersion: 1, notification: { ready: false } };
  const handlers = route({
    requireBearerToken,
    requirePostRequest,
    process: { env: { MAINTENANCE_GATE_TOKEN: token } },
    inspectMaintenanceReadiness: async () => {
      reads.push("readiness");
      return readiness;
    },
    inspectLaunchMonitorStatus: async () => {
      reads.push("diagnostics");
      return diagnostics;
    },
  });
  return { handlers, reads, token, readiness, diagnostics };
}

test("diagnostics retain the existing gate result and remain authenticated and non-cacheable", async () => {
  const f = fixture();
  const response = await f.handlers.action({
    request: new Request(
      "https://example.test/internal/maintenance-readiness",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}` },
      },
    ),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.deepEqual(await response.json(), {
    ...f.readiness,
    diagnostics: f.diagnostics,
  });
  assert.deepEqual(f.reads, ["readiness", "diagnostics"]);
});

test("missing, invalid and unconfigured credentials and GET requests cannot read diagnostics", async () => {
  for (const [method, header, token, expected] of [
    ["GET", "", undefined, 405],
    ["POST", "", undefined, 401],
    ["POST", "Bearer wrong-token", undefined, 401],
    ["POST", "", "", 503],
  ]) {
    const f = fixture(token);
    await assert.rejects(
      f.handlers.action({
        request: new Request(
          "https://example.test/internal/maintenance-readiness",
          {
            method,
            headers: { Authorization: header },
          },
        ),
      }),
      (error) =>
        error.status === expected &&
        error.headers.get("Cache-Control") === "no-store",
    );
    assert.equal(f.reads.length, 0);
  }
  const response = fixture().handlers.loader();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
