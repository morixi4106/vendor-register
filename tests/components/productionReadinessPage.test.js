import assert from "node:assert/strict";
import test from "node:test";

import { productionReadinessFixture } from "../fixtures/productionReadinessPage.js";
import { renderProductionReadinessPage } from "../helpers/renderProductionReadinessPage.js";

test("the actual page separates the configured route, unverified evidence, and overseas preparation", () => {
  const html = renderProductionReadinessPage(productionReadinessFixture());
  assert.ok(html.includes("経路設定確認済み"));
  assert.ok(html.includes("現設定の判定：条件付き"));
  assert.ok(html.includes("確認済み 0 / 対象 9件"));
  assert.ok(html.includes("未確認・国内限定例外"));
  assert.ok(html.includes("対象未設定"));
  assert.ok(!html.includes("標準チェックアウトの準備ができています"));
  assert.ok(
    !html.includes("16シナリオと着金・返金は公開前の必須条件ではありません"),
  );
  const next = html
    .split('id="readiness-next-step-title"')[1]
    .split("</section>")[0];
  assert.equal((next.match(/<li>/g) || []).length, 3);
  assert.ok(!next.includes("<form"));
  assert.ok(!next.includes("<button"));
  for (const href of next.matchAll(/href="(#[^"]+)"/g)) {
    assert.ok(html.includes(`id="${href[1].slice(1)}"`));
  }
});

test("monitor notifications are visibly prelaunch-suppressed, independently of mail-class holds", () => {
  const html = renderProductionReadinessPage(productionReadinessFixture());
  assert.ok(html.includes("自動監視通知"));
  assert.ok(html.includes("公開前停止"));
  assert.ok(!html.includes("監視通知は継続します"));
  assert.ok(
    html.includes('value="hold_legal_email"') ||
      html.includes('value="activate_legal_email_hold"'),
  );
  assert.ok(html.includes('value="activate_automated_email_hold"'));
});

test("unavailable and expired evidence still server-render without silently clearing failures", () => {
  const unavailable = renderProductionReadinessPage(
    productionReadinessFixture("unavailable"),
  );
  assert.ok(unavailable.includes("取得未確認"));
  assert.ok(!unavailable.includes("確認済み 9"));
  const expired = renderProductionReadinessPage(
    productionReadinessFixture("expired"),
  );
  assert.ok(expired.includes("有効期限切れ"));
  assert.ok(expired.includes("未確認・国内限定例外"));
});
