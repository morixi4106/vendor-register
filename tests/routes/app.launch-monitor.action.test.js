import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "@shopify/polaris";
import { CheckIcon, EmailIcon, RefreshIcon } from "@shopify/polaris-icons";
import { buildLaunchMonitorGuide } from "../../app/services/launchMonitorGuide.js";
import {
  getMonitorAcknowledgement,
  getMonitorReceiptStatus,
} from "../../app/services/monitorNotification.server.js";

function routeSource() {
  return ts.createSourceFile(
    "app.launch-monitor.jsx",
    fs.readFileSync(
      new URL("../../app/routes/app.launch-monitor.jsx", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
}

function routeAction(dependencies, name = "action") {
  const source = routeSource();
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      [name, "isEnabled"].includes(node.name?.text),
  );
  assert.ok(functions.some((node) => node.name.text === name));
  const code = functions
    .map((node) => {
      const callable = ts.factory.updateFunctionDeclaration(
        node,
        node.modifiers?.filter(
          (modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword,
        ),
        node.asteriskToken,
        node.name,
        node.typeParameters,
        node.parameters,
        node.type,
        node.body,
      );
      return ts
        .createPrinter()
        .printNode(ts.EmitHint.Unspecified, callable, source);
    })
    .join("\n");
  return new Function(...Object.keys(dependencies), code + `; return ${name};`)(
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

async function firstVisit() {
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async () => null,
      upsert: () => assert.fail("Opening the page cannot create receipt proof"),
      updateMany: () => assert.fail("Opening the page cannot verify receipt"),
    },
  };
  const options = {
    prismaClient,
    env: {
      PRIVACY_HASH_SECRET: "receipt-test-".repeat(4),
      RESEND_API_KEY: "test-key",
      MAIL_FROM: "sender@example.test",
      ADMIN_EMAIL: "recipient@example.test",
    },
  };
  const loader = routeAction(
    {
      prisma: prismaClient,
      requirePrivacyOperator: async () => ({
        operator: { actorKey: "operator" },
      }),
      LAUNCH_MONITOR_HEARTBEAT_KEY: "production_integrity_monitor",
      buildLaunchMonitorGuide,
      getMonitorReceiptStatus: () => getMonitorReceiptStatus(options),
      getMonitorAcknowledgement: (input) =>
        getMonitorAcknowledgement({ ...options, ...input }),
      process: { env: { LAUNCH_MONITOR_ENABLED: "true" } },
    },
    "loader",
  );
  const response = await loader({
    request: new Request("https://example.test/app/launch-monitor"),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return response.json();
}

test("the real loader with no monitor or receipt history returns unverified data, not an error", async () => {
  const data = await firstVisit();
  assert.equal(data.heartbeat, null);
  assert.equal(data.notification.ready, false);
  assert.equal(data.notification.providerEvent, "unchecked");
  assert.equal(data.acknowledgement.acknowledged, false);
});

test("the initial monitor page actually server-renders its receipt controls", async () => {
  const data = await firstVisit();
  const source = routeSource();
  const file = ts.factory.updateSourceFile(
    source,
    source.statements.filter((node) => !ts.isImportDeclaration(node)),
  );
  const printed = ts.createPrinter().printFile(file);
  const compiled = ts.transpileModule(printed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    fileName: "app.launch-monitor.jsx",
  }).outputText;
  const dependencies = {
    React,
    Icon,
    CheckIcon,
    EmailIcon,
    RefreshIcon,
    Form: ({ children, method }) =>
      React.createElement("form", { method }, children),
    Link: ({ children, to }) =>
      React.createElement("a", { href: to }, children),
    useLoaderData: () => data,
    useActionData: () => null,
    useNavigation: () => ({ state: "idle" }),
  };
  const exported = {};
  new Function("exports", ...Object.keys(dependencies), compiled)(
    exported,
    ...Object.values(dependencies),
  );
  const html = renderToStaticMarkup(React.createElement(exported.default));
  assert.ok(html.includes('value="send-receipt-test"'));
  assert.ok(html.includes('value="confirm-receipt"'));
  assert.ok(html.includes('name="code"'));
  assert.ok(html.includes("<svg"));
});
