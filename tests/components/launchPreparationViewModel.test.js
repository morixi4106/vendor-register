import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchPreparation,
  formatReadinessTime,
  operationalEvidenceAnchor,
} from "../../app/components/readiness/launchPreparationViewModel.js";
import { buildProductionReadinessPageState } from "../../app/components/readiness/productionReadinessPageState.js";

function fixture() {
  const definitions = [
    {
      key: "LEGAL_DISCLOSURES_REVIEWED",
      label: "法定表示・利用規約の実画面確認",
    },
    { key: "CHECKOUT_FINAL_SCREEN_REVIEWED", label: "購入直前画面" },
    {
      key: "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED",
      label: "本番決済",
      automated: true,
    },
    { key: "EMAIL_DELIVERY_CONFIRMED", label: "業務メール" },
  ];
  return {
    generatedAt: "2026-10-15T02:35:00.000Z",
    canGoLive: true,
    checkoutMode: { standardDirectReady: true },
    checkoutValidation: { ok: true, active: false },
    productionRelease: {
      expected: { releaseId: "test-release:shopify-version" },
    },
    monitorNotificationMode: "prelaunch",
    shopify: {
      productShipping: {
        available: true,
        internationalProductCount: 0,
        requiredCountryCount: 0,
      },
    },
    operationalReadiness: {
      available: true,
      rows: definitions.map((definition) => ({
        definition,
        ready: false,
        reason: "missing",
        attestation: null,
      })),
    },
    checks: [
      {
        id: "marketplace_checkout_server_validation",
        title: "購入経路",
        status: "pass",
        releaseBlocking: false,
      },
      ...definitions.map((definition) => ({
        id: `operational_attestation_${definition.key.toLowerCase()}`,
        title: definition.label,
        status: "warning",
        releaseBlocking: false,
        releaseDisposition: "owner_risk_accepted",
      })),
    ],
  };
}

function view(data) {
  return buildProductionReadinessPageState(data, { state: "idle" })
    .launchPreparation;
}

test("domestic risk acceptance is not confirmed evidence or international readiness", () => {
  const data = fixture();
  const before = structuredClone(data);
  const result = view(data);
  assert.deepEqual(result.evidence, {
    available: true,
    requiredCount: 4,
    confirmedCount: 0,
    pendingCount: 4,
    acceptedCount: 4,
  });
  assert.equal(result.verdict.status, "warning");
  assert.equal(result.checkout.status, "pass");
  assert.equal(result.international.label, "対象未設定");
  assert.notEqual(result.international.status, "pass");
  assert.equal(result.notificationLabel, "公開前停止");
  assert.equal(result.nextActions.length, 3);
  assert.equal(
    result.evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.label,
    "未確認・国内限定例外",
  );
  assert.deepEqual(data, before);
  assert.equal(data.canGoLive, true);
});

test("actual evidence clears its pending row without altering the release verdict", () => {
  const data = fixture();
  for (const row of data.operationalReadiness.rows) {
    row.ready = true;
    row.reason = null;
    row.attestation = {
      status: "CONFIRMED",
      expiresAt: "2026-10-16T02:35:00.000Z",
    };
  }
  const result = view(data);
  assert.equal(result.evidence.confirmedCount, 4);
  assert.equal(result.evidence.acceptedCount, 0);
  assert.equal(result.verdict.status, "pass");
  assert.equal(result.international.label, "対象未設定");
  assert.equal(result.nextActions[0].id, "international_review");
  assert.match(
    result.evidenceByKey.EMAIL_DELIVERY_CONFIRMED.expiresAt,
    /11:35/,
  );
});

test("failed release checks stay ahead of risk-accepted evidence, with no new action intents", () => {
  const data = fixture();
  data.canGoLive = false;
  data.checks.unshift({
    id: "seller_order_unresolved_shadow_checks",
    title: "注文差分",
    status: "fail",
    releaseBlocking: true,
  });
  const result = view(data);
  assert.equal(result.verdict.status, "fail");
  assert.equal(
    result.nextActions[0].id,
    "seller_order_unresolved_shadow_checks",
  );
  assert.equal(result.nextActions[0].to, "/app/seller-order-shadow");
  assert.equal(result.nextActions.length, 3);
  assert.ok(result.nextActions.every((item) => !Object.hasOwn(item, "intent")));
});

test("scope exclusions and unused Stripe warnings are not presented as mandatory work", () => {
  const data = fixture();
  data.checks[1].releaseDisposition = "scope_excluded";
  data.checks[1].releaseDispositionReason = "現在の公開範囲外";
  data.checks.push({
    id: "stripe_secret_key_live",
    title: "Stripe",
    category: "stripe",
    status: "warning",
  });
  data.operationalReadiness.rows.push({
    definition: {
      key: "CHECKOUT_VALIDATION_REPLAY_COMPLETED",
      supplemental: true,
    },
    ready: false,
  });
  const result = view(data);
  assert.equal(result.evidence.requiredCount, 3);
  assert.equal(result.evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.label, "対象外");
  assert.equal(
    result.evidenceByKey.CHECKOUT_VALIDATION_REPLAY_COMPLETED,
    undefined,
  );
  assert.ok(
    result.nextActions.every(
      (item) =>
        item.id !== "stripe_secret_key_live" &&
        item.id !== "evidence_LEGAL_DISCLOSURES_REVIEWED",
    ),
  );
});

test("specific evidence failure reasons survive presentation", () => {
  for (const [reason, label] of [
    ["expired", "有効期限切れ"],
    ["release_mismatch", "現在のリリースと不一致"],
    ["release_unconfigured", "現在のリリースを特定できません"],
    ["payout_evidence_invalid", "入金証拠の照合が未完了"],
  ]) {
    const data = fixture();
    data.operationalReadiness.rows[0].reason = reason;
    assert.equal(
      view(data).evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.reason,
      label,
    );
  }
  const data = fixture();
  data.checks[1].releaseDisposition = "decision_required";
  data.operationalReadiness.rows[0].attestation = { status: "FAILED" };
  assert.equal(
    view(data).evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.label,
    "確認失敗",
  );
});

test("unavailable evidence cannot be counted as confirmed even when stale rows say ready", () => {
  const data = fixture();
  data.operationalReadiness.available = false;
  data.operationalReadiness.rows[0].ready = true;
  const result = view(data);
  assert.equal(result.evidence.confirmedCount, 0);
  assert.equal(
    result.evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.reason,
    "証跡を取得できません",
  );
  assert.equal(result.nextActions[0].id, "evidence_unavailable");
});

test("missing, empty or malformed source data remains unknown rather than complete", () => {
  for (const rows of [undefined, null, [], {}]) {
    const result = view({ operationalReadiness: { available: true, rows } });
    assert.equal(result.evidence.available, false);
    assert.equal(result.verdict.status, "manual");
    assert.equal(result.international.label, "未確認");
    assert.equal(result.notificationLabel, "未取得");
  }
});

test("international evidence inspection never claims live checkout or transaction proof", () => {
  const data = fixture();
  data.shopify.productShipping = {
    available: true,
    internationalProductCount: 2,
    requiredCountryCount: 1,
  };
  assert.equal(view(data).international.label, "未確認");
  data.checks.push({
    id: "international_market_country_evidence",
    status: "fail",
    title: "国別証拠",
  });
  assert.equal(view(data).international.label, "要対応");
  data.checks.at(-1).status = "pass";
  assert.equal(view(data).international.label, "実機確認待ち");
  assert.notEqual(view(data).international.status, "pass");
  data.shopify.productShipping.requiredCountryCount = 0;
  assert.equal(view(data).international.label, "販売国未確認");
  data.shopify.productShipping.available = false;
  assert.equal(view(data).international.label, "未確認");
});

test("notification labels reflect only the safe mode enum and do not affect readiness", () => {
  for (const [mode, label] of [
    ["prelaunch", "公開前停止"],
    ["live", "本番通知有効"],
    ["paused", "停止"],
    ["invalid", "未取得"],
  ]) {
    const data = fixture();
    data.monitorNotificationMode = mode;
    assert.equal(view(data).notificationLabel, label);
    assert.equal(data.canGoLive, true);
  }
});

test("evidence actions use stable anchors or the existing transaction screen", () => {
  const result = buildLaunchPreparation(fixture());
  assert.equal(
    result.evidenceByKey.PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED.to,
    "/app/production-transaction-probe",
  );
  assert.equal(
    result.evidenceByKey.LEGAL_DISCLOSURES_REVIEWED.to,
    "#operational-evidence-legal_disclosures_reviewed",
  );
  assert.equal(
    operationalEvidenceAnchor("CHECKOUT_VALIDATION_REPLAY_COMPLETED"),
    "checkout-validation-replay-evidence",
  );
  assert.equal(formatReadinessTime(null), "未取得");
  assert.equal(formatReadinessTime("invalid"), "未取得");
});

test("presentation does not expose extra private fields from input data", () => {
  const data = fixture();
  data.privateField = "private-value-do-not-render";
  data.operationalReadiness.rows[0].attestation = {
    metadataJson: { token: data.privateField },
  };
  assert.ok(!JSON.stringify(view(data)).includes(data.privateField));
});
