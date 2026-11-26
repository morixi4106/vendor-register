const DEFINITIONS = [
  ["LEGAL_DISCLOSURES_REVIEWED", "法定表示・利用規約の実画面確認"],
  [
    "CHECKOUT_FINAL_SCREEN_REVIEWED",
    "購入直前画面の価格・送料・販売者表示確認",
  ],
  ["UNSUPPORTED_SALES_SURFACES_DISABLED", "未対応販売経路の無効化確認"],
  ["EMERGENCY_STOP_DRILL_COMPLETED", "販売緊急停止の実地訓練"],
  ["REFUND_LIQUIDITY_CONFIRMED", "返金原資と支払可能額の確認"],
  ["ADMIN_MFA_ACCESS_REVIEWED", "管理者権限・MFAの棚卸し"],
  ["PRIVACY_INCIDENT_RUNBOOK_CONFIRMED", "個人情報事故対応手順の確認"],
  ["EMAIL_DELIVERY_CONFIRMED", "購入者・管理者メールの実受信確認"],
  [
    "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED",
    "KOMOJU本番決済・注文・台帳の直販確認",
  ],
];

export function productionReadinessFixture(state = "pending") {
  const confirmed = state === "confirmed";
  const available = state !== "unavailable";
  const rows = DEFINITIONS.map(([key, label]) => ({
    definition: {
      key,
      label,
      validityDays: key === "REFUND_LIQUIDITY_CONFIRMED" ? 1 : 90,
      automated: key === "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED",
    },
    ready: confirmed,
    reason: confirmed ? null : state === "expired" ? "expired" : "missing",
    attestation:
      confirmed || state === "expired"
        ? { status: "CONFIRMED", expiresAt: "2026-10-16T02:35:00.000Z" }
        : null,
  }));
  return {
    generatedAt: "2026-10-15T02:35:00.000Z",
    canGoLive: state !== "unavailable",
    checks: [
      {
        id: "marketplace_checkout_server_validation",
        title: "Shopify標準チェックアウト",
        category: "shopify",
        status: "pass",
        releaseBlocking: false,
      },
      ...rows.map((row) => ({
        id: `operational_attestation_${row.definition.key.toLowerCase()}`,
        title: row.definition.label,
        category: "operations",
        status: confirmed ? "pass" : "warning",
        releaseDisposition: confirmed ? "satisfied" : "owner_risk_accepted",
        releaseBlocking: false,
      })),
    ],
    checkoutMode: { standardDirectReady: true },
    checkoutValidation: {
      ok: true,
      exists: true,
      prepared: true,
      active: false,
    },
    checkoutGate: { available: true, active: true },
    productionRelease: {
      expected: { releaseId: "3c3c527cea2e:limited-launch-v2-3470d47" },
    },
    operationalReadiness: { available, rows },
    monitorNotificationMode: "prelaunch",
    shopify: {
      productShipping: {
        available,
        internationalProductCount: 0,
        requiredCountryCount: 0,
      },
    },
    operation: {
      paymentProviders: ["komoju"],
      sellerPayoutProvider: "manual",
      stripeConnectProductionEnabled: false,
    },
    sellers: { activeCount: 0, totalCount: 0 },
    summary: { releaseBlockingCount: 0, decisionRequiredCount: 0 },
    platformOperationalControl: {},
  };
}
