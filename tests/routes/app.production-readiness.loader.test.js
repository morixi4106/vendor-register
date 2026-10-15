import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

import { resolveMonitorNotificationMode } from "../../app/services/monitorNotificationPolicy.js";
import { MARKETPLACE_OPERATOR_ROLES } from "../../app/utils/marketplaceOperatorRoles.js";

function loader(dependencies) {
  const source = ts.createSourceFile(
    "app.production-readiness.jsx",
    fs.readFileSync(
      new URL("../../app/routes/app.production-readiness.jsx", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const declaration = source.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (entry) => entry.name.getText(source) === "loader",
      ),
  );
  assert.ok(declaration);
  const file = ts.factory.updateSourceFile(source, [declaration]);
  const transformed = ts.transform(file, [
    (context) => (root) => {
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          return ts.factory.updateCallExpression(
            node,
            ts.factory.createIdentifier("loadModule"),
            node.typeArguments,
            node.arguments,
          );
        }
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit);
    },
  ]);
  const printed = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  const code = ts.transpileModule(printed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(dependencies), code)(
    exported,
    ...Object.values(dependencies),
  );
  return exported.loader;
}

function fixture(env = {}) {
  const calls = [];
  const source = Object.freeze({
    canGoLive: false,
    checks: [],
    marker: "unchanged",
  });
  const modules = {
    "../services/productionReadiness.server.js": {
      getProductionReadiness: async (options) => {
        calls.push(["readiness", options]);
        return source;
      },
      includeCheckoutGateInProductionReadiness: (data, gate) => ({
        ...data,
        checkoutGate: gate,
      }),
      includeCheckoutValidationInProductionReadiness: (data, validation) => ({
        ...data,
        checkoutValidation: validation,
      }),
    },
    "../services/marketplaceCheckoutGate.server.js": {
      getMarketplaceCheckoutGateStatus: async () => ({
        exists: true,
        active: true,
      }),
    },
    "../services/shopifyCheckoutValidation.server.js": {
      inspectMarketplaceCheckoutValidation: async () => ({
        ok: true,
        active: false,
      }),
    },
    "../services/productionRelease.server.js": {
      createProductionProbeChallenge: () => null,
    },
  };
  const dependencies = {
    requireMarketplaceOperator: async (_request, options) => {
      calls.push(["authorize", options]);
      return {
        session: { shop: "example.myshopify.com" },
        operator: { actorKey: "shopify_user:test" },
      };
    },
    MARKETPLACE_OPERATOR_ROLES,
    resolveMonitorNotificationMode,
    process: { env },
    console: { error: () => {} },
    loadModule: async (name) => {
      calls.push(["import", name]);
      assert.ok(
        Object.hasOwn(modules, name),
        `Unexpected module or mutation path: ${name}`,
      );
      return modules[name];
    },
  };
  return { calls, modules, dependencies, source };
}

test("the real loader returns only a safe notification enum and retains authenticated no-store access", async () => {
  for (const [mode, expected] of [
    [undefined, "prelaunch"],
    ["prelaunch", "prelaunch"],
    ["live", "live"],
    ["unexpected", "paused"],
  ]) {
    const f = fixture({
      LAUNCH_MONITOR_NOTIFICATION_MODE: mode,
      RESEND_API_KEY: "private-key-not-returned",
    });
    const response = await loader(f.dependencies)({
      request: new Request("https://example.test/app/production-readiness"),
    });
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    const data = await response.json();
    assert.equal(data.monitorNotificationMode, expected);
    assert.equal(data.canGoLive, false);
    assert.equal(data.marker, "unchanged");
    assert.ok(!JSON.stringify(data).includes("private-key-not-returned"));
    assert.equal(f.calls[0][0], "authorize");
    assert.equal(
      f.calls.find(([name]) => name === "readiness")[1].shopDomain,
      "example.myshopify.com",
    );
    assert.equal(f.calls.filter(([name]) => name === "import").length, 4);
  }
});

test("an unauthorized request cannot inspect readiness, send mail, or record evidence", async () => {
  const f = fixture();
  f.dependencies.requireMarketplaceOperator = async () => {
    throw new Response("Forbidden", { status: 403 });
  };
  await assert.rejects(
    loader(f.dependencies)({ request: new Request("https://example.test") }),
    (error) => error.status === 403,
  );
  assert.deepEqual(f.calls, []);
});

test("failed Shopify inspection remains unavailable and cannot be turned into proof by loading the page", async () => {
  const f = fixture();
  f.modules[
    "../services/marketplaceCheckoutGate.server.js"
  ].getMarketplaceCheckoutGateStatus = async () => {
    throw new Error("unavailable");
  };
  f.modules[
    "../services/shopifyCheckoutValidation.server.js"
  ].inspectMarketplaceCheckoutValidation = async () => {
    throw new Error("unavailable");
  };
  const response = await loader(f.dependencies)({
    request: new Request("https://example.test"),
  });
  const data = await response.json();
  assert.equal(data.checkoutGate.available, false);
  assert.equal(data.checkoutValidation.ok, false);
  assert.equal(data.canGoLive, false);
  assert.deepEqual(f.source, {
    canGoLive: false,
    checks: [],
    marker: "unchanged",
  });
});
