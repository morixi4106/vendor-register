import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as polaris from "@shopify/polaris";
import * as icons from "@shopify/polaris-icons";
import { internationalRunnerPageFixture } from "../fixtures/internationalRunnerPage.js";

function render(role, phase) {
  const text = fs.readFileSync(
    new URL(
      "../../app/components/international/InternationalRunnerPanel.jsx",
      import.meta.url,
    ),
    "utf8",
  );
  const source = ts.createSourceFile(
    "panel.jsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const file = ts.factory.updateSourceFile(
    source,
    source.statements.filter((node) => !ts.isImportDeclaration(node)),
  );
  const code = ts.transpileModule(ts.createPrinter().printFile(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const deps = {
    ...polaris,
    ...icons,
    useState: React.useState,
    Form: ({ children }) =>
      React.createElement("form", { method: "post" }, children),
    useInternationalActionResult: () => null,
  };
  delete deps.default;
  for (const key of Object.keys(deps))
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) delete deps[key];
  const exported = {};
  new Function("exports", "React", ...Object.keys(deps), code)(
    exported,
    React,
    ...Object.values(deps),
  );
  return renderToStaticMarkup(
    React.createElement(
      polaris.AppProvider,
      { i18n: {} },
      React.createElement(exported.default, {
        data: internationalRunnerPageFixture(role, phase).runner,
      }),
    ),
  );
}
test("actual panel keeps deployment success distinct from sale and locks unsupported approval", () => {
  const html = render("admin", "PASSED");
  assert.ok(html.includes("一般販売未承認"));
  assert.ok(html.includes("購入・決済の検証機能は未完成"));
  const approvalButton = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    .find((button) => button.includes("承認内容を確認"));
  assert.match(approvalButton, /(?:disabled=""|aria-disabled="true")/);
  assert.ok(html.includes("観測を更新"));
  assert.ok(!html.includes('name="nonce"'));
});
test("role-specific actual controls do not expose another role's mutation", () => {
  assert.ok(!render("release", "PASSED").includes("配備記録を取消"));
  assert.ok(!render("review", "PASSED").includes("閉鎖検査を開始"));
  assert.ok(!render("incident", "PASSED").includes("証拠を取消"));
  assert.ok(render("incident", "PASSED").includes("海外販売ゲートを停止"));
});
test("empty, revoked and pending states remain explicit and do not expose raw proof inputs", () => {
  assert.ok(render("admin", "EMPTY").includes("配備記録は未受信です。"));
  assert.ok(render("admin", "RUNNING").includes("観測待ち"));
  const html = render("admin", "REVOKED");
  assert.ok(html.includes("取消済み"));
  for (const text of [
    "閉鎖検査を開始",
    "観測を更新",
    "receiptJson",
    "leaseToken",
    "signature",
  ])
    assert.ok(!html.includes(text));
});
