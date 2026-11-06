import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as polaris from "@shopify/polaris";
import * as icons from "@shopify/polaris-icons";
import {
  internationalRunnerPageFixture,
  internationalCompatibilityPageFixture,
} from "../fixtures/internationalRunnerPage.js";

function component(name, deps) {
  const text = fs.readFileSync(
    new URL(`../../app/components/international/${name}.jsx`, import.meta.url),
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
  const exported = {};
  new Function("exports", "React", ...Object.keys(deps), code)(
    exported,
    React,
    ...Object.values(deps),
  );
  return exported.default;
}

function render(role, phase, compatibility = null) {
  const deps = {
    ...polaris,
    ...icons,
    useState: React.useState,
    useEffect: React.useEffect,
    Form: ({ children }) =>
      React.createElement("form", { method: "post" }, children),
    useInternationalActionResult: () =>
      compatibility ? { compatibility } : null,
  };
  delete deps.default;
  for (const key of Object.keys(deps))
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) delete deps[key];
  deps.InternationalCheckoutCompatibilityPanel = component(
    "InternationalCheckoutCompatibilityPanel",
    deps,
  );
  const Panel = component("InternationalRunnerPanel", deps);
  return renderToStaticMarkup(
    React.createElement(
      polaris.AppProvider,
      { i18n: {} },
      React.createElement(Panel, {
        data: internationalRunnerPageFixture(role, phase).runner,
      }),
    ),
  );
}
test("actual panel keeps deployment success distinct from sale and locks unsupported approval", () => {
  const html = render("admin", "PASSED");
  assert.ok(html.includes("一般販売未承認"));
  assert.ok(html.includes(" JST"));
  assert.ok(html.includes("購入・決済の検証機能は未完成"));
  const approvalButton = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    .find((button) => button.includes("承認内容を確認"));
  assert.match(approvalButton, /(?:disabled=""|aria-disabled="true")/);
  assert.ok(html.includes("観測を更新"));
  assert.ok(!html.includes('name="nonce"'));
});

test("actual compatibility panel is release-only and never presents Plus as verification success", () => {
  for (const role of ["review", "incident"])
    assert.ok(!render(role, "EMPTY").includes("対応状況を取得"));
  for (const mode of ["PLUS", "NON_PLUS", "UNAVAILABLE"]) {
    const html = render(
      "release",
      "EMPTY",
      internationalCompatibilityPageFixture(mode),
    );
    assert.ok(html.includes("購入検証は未確認"));
    assert.ok(html.includes("対応状況を取得"));
    assert.ok(!html.includes("検証合格"));
    if (mode === "PLUS")
      assert.ok(html.includes("プラン条件のみ確認、購入検証は未確認"));
    if (mode === "NON_PLUS") assert.ok(html.includes("Shopify Plusが必要"));
    if (mode === "UNAVAILABLE") assert.ok(html.includes("店舗プラン: 未確認"));
  }
});

test("expired or unknown diagnostic version cannot display current plan evidence", () => {
  for (const mode of ["EXPIRED", "BAD_VERSION"]) {
    const report = internationalCompatibilityPageFixture(mode);
    if (mode === "BAD_VERSION") report.version = "unknown";
    const html = render("release", "EMPTY", report);
    assert.ok(html.includes("診断結果は期限切れ、または未確認です。"));
    assert.ok(!html.includes("店舗プラン:"));
  }
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
