import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function routeAction(dependencies) {
  const source = ts.createSourceFile(
    "app.launch-monitor.jsx",
    fs.readFileSync(
      new URL("../../app/routes/app.launch-monitor.jsx", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const action = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "action",
  );
  assert.ok(action);
  const callable = ts.factory.updateFunctionDeclaration(
    action,
    action.modifiers.filter(
      (modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword,
    ),
    action.asteriskToken,
    action.name,
    action.typeParameters,
    action.parameters,
    action.type,
    action.body,
  );
  const code = ts
    .createPrinter()
    .printNode(ts.EmitHint.Unspecified, callable, source);
  return new Function(...Object.keys(dependencies), code + "; return action;")(
    ...Object.values(dependencies),
  );
}

function fixture(intent) {
  const calls = [];
  const form = new FormData();
  form.set("intent", intent);
  form.set("code", "123456");
  form.set("incidentKey", "a".repeat(24));
  const record = async (input) => {
    calls.push(input);
  };
  const dependencies = {
    requirePrivacyOperator: async () => ({
      operator: { actorKey: "shopify_user:unit-operator" },
    }),
    readBoundedFormData: async () => form,
    sendMonitorReceiptTest: record,
    confirmMonitorReceipt: record,
    refreshMonitorReceipt: record,
    acknowledgeMonitorIncident: record,
  };
  return { calls, dependencies };
}

test("receipt confirmation and incident acknowledgement use the authenticated operator identity", async () => {
  for (const intent of ["confirm-receipt", "ack-incident"]) {
    const f = fixture(intent);
    const response = await routeAction(f.dependencies)({
      request: new Request("https://example.test"),
    });
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].actor, "shopify_user:unit-operator");
  }
});

test("unauthorized operators cannot send, confirm, refresh or acknowledge", async () => {
  for (const intent of [
    "send-receipt-test",
    "confirm-receipt",
    "refresh-delivery",
    "ack-incident",
  ]) {
    const f = fixture(intent);
    f.dependencies.requirePrivacyOperator = async () => {
      throw new Response("Forbidden", { status: 403 });
    };
    await assert.rejects(
      routeAction(f.dependencies)({
        request: new Request("https://example.test"),
      }),
      (error) => error.status === 403,
    );
    assert.equal(f.calls.length, 0);
  }
});
