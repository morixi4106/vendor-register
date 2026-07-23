import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
  resolveProductionReadinessOperatorRole,
} from "../utils/marketplaceOperator.server.js";

export const loader = async ({ request }) => {
  const { session, operator } = await requireMarketplaceOperator(request, {
    roles: [
      MARKETPLACE_OPERATOR_ROLES.ADMIN,
      MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
      MARKETPLACE_OPERATOR_ROLES.INCIDENT_COMMANDER,
      MARKETPLACE_OPERATOR_ROLES.RECOVERY_APPROVER,
      MARKETPLACE_OPERATOR_ROLES.COMPLIANCE_REVIEWER,
    ],
  });
  const {
    getProductionReadiness,
    includeCheckoutGateInProductionReadiness,
    includeCheckoutValidationInProductionReadiness,
  } =
    await import("../services/productionReadiness.server.js");
  const { getMarketplaceCheckoutGateStatus } =
    await import("../services/marketplaceCheckoutGate.server.js");

  const readiness = await getProductionReadiness();
  let checkoutGate;

  try {
    checkoutGate = {
      available: true,
      ...(await getMarketplaceCheckoutGateStatus(session.shop)),
    };
  } catch (error) {
    console.error("Marketplace checkout gate status failed:", error);
    checkoutGate = {
      available: false,
      exists: false,
      active: false,
      message:
        "Online Storeの公開権限と商品同期状態を確認してください。",
    };
  }

  let checkoutValidation;
  try {
    const { inspectMarketplaceCheckoutValidation } =
      await import("../services/shopifyCheckoutValidation.server.js");
    checkoutValidation = await inspectMarketplaceCheckoutValidation(
      session.shop,
    );
  } catch (error) {
    console.error("Marketplace checkout validation status failed:", error);
    checkoutValidation = {
      ok: false,
      active: false,
      reason: "validation_status_unavailable",
    };
  }

  const result = includeCheckoutValidationInProductionReadiness(
    includeCheckoutGateInProductionReadiness(readiness, checkoutGate),
    checkoutValidation,
  );
  const { createProductionProbeChallenge } =
    await import("../services/productionRelease.server.js");
  const liveProbeChallenge = createProductionProbeChallenge({
    expected: result.productionRelease?.expected,
    shopDomain: session.shop,
    actorKey: operator.actorKey,
  });

  return json({ ...result, liveProbeChallenge });
};

export const action = async ({ request }) => {
  const formData = await request.clone().formData();
  const intent = String(formData.get("intent") || "register_carrier");
  const { session, operator } = await requireMarketplaceOperator(request, {
    role: resolveProductionReadinessOperatorRole(intent),
  });

  if (intent === "record_operational_attestation") {
    const {
      CHECKOUT_VALIDATION_LIVE_PROBE_KEY,
      recordOperationalReadinessAttestation,
    } =
      await import("../services/operationalReadiness.server.js");
    const checkKey = String(formData.get("checkKey") || "");
    let metadataJson = null;
    if (checkKey === CHECKOUT_VALIDATION_LIVE_PROBE_KEY) {
      const {
        buildProductionReleaseExpectation,
        verifyProductionProbeChallenge,
      } = await import("../services/productionRelease.server.js");
      const { inspectMarketplaceCheckoutValidation } =
        await import("../services/shopifyCheckoutValidation.server.js");
      const checkoutValidation =
        await inspectMarketplaceCheckoutValidation(session.shop);
      const expectedRelease = buildProductionReleaseExpectation({
        checkoutValidation,
      });
      const challenge = verifyProductionProbeChallenge(
        formData.get("liveProbeChallenge"),
        {
          expected: expectedRelease,
          shopDomain: session.shop,
          actorKey: operator.actorKey,
        },
      );
      if (!challenge.ok) {
        return json(
          {
            operationalAttestation: {
              ok: false,
              reason: challenge.reason,
            },
          },
          { status: 400 },
        );
      }
      metadataJson = {
        releaseManifest: {
          releaseId: formData.get("releaseId"),
          renderCommit: formData.get("renderCommit"),
          migrationVersion: formData.get("migrationVersion"),
          shopifyAppVersion: formData.get("shopifyAppVersion"),
          shopDomain: formData.get("shopDomain"),
          functionHandle: formData.get("functionHandle"),
          functionUid: formData.get("functionUid"),
          functionId: formData.get("functionId"),
          functionApiVersion: formData.get("functionApiVersion"),
          validationId: formData.get("validationId"),
          policyVersion: formData.get("policyVersion"),
          projectionSchemaVersion: Number(
            formData.get("projectionSchemaVersion"),
          ),
        },
        challengeNonce: challenge.payload.nonce,
        challengeIssuedAt: challenge.payload.issuedAt,
        executedBy: operator.actorKey,
        probes: buildLiveProbeScenarios(formData),
      };
    }
    const result = await recordOperationalReadinessAttestation({
      checkKey,
      status: formData.get("status"),
      evidenceReference: formData.get("evidenceReference"),
      evidenceHash: formData.get("evidenceHash"),
      notes: formData.get("notes"),
      confirmedBy: operator.actorKey,
      metadataJson,
    });
    return json(
      { operationalAttestation: result },
      { status: result.ok ? 200 : 400 },
    );
  }

  if (intent === "activate_emergency_checkout_hold") {
    const { applyPlatformCheckoutEmergencyHold } =
      await import("../services/operationalReadiness.server.js");
    const result = await applyPlatformCheckoutEmergencyHold({
      reason: formData.get("reason"),
      changedBy: operator.actorKey,
    });
    return json(
      { operationalControl: result },
      { status: result.ok ? 200 : 500 },
    );
  }

  if (intent === "release_emergency_checkout_hold") {
    const { recoverPlatformCheckoutEmergencyHold } =
      await import("../services/operationalReadiness.server.js");
    const result = await recoverPlatformCheckoutEmergencyHold({
      reason: formData.get("reason"),
      changedBy: operator.actorKey,
      releaseEvidenceReference: formData.get("releaseEvidenceReference"),
    });
    return json(
      { operationalControl: result },
      { status: result.ok ? 200 : 400 },
    );
  }

  if (
    intent === "activate_automated_email_hold" ||
    intent === "release_automated_email_hold"
  ) {
    const { setAutomatedEmailHold } =
      await import("../services/operationalReadiness.server.js");
    const activating = intent === "activate_automated_email_hold";
    const result = await setAutomatedEmailHold({
      hold: activating,
      reason: formData.get("reason"),
      changedBy: operator.actorKey,
      releaseEvidenceReference: formData.get("releaseEvidenceReference"),
    });
    return json(
      { automatedEmailControl: result },
      { status: result.ok ? 200 : 400 },
    );
  }

  if (
    intent === "activate_legal_email_hold" ||
    intent === "release_legal_email_hold"
  ) {
    const { EMAIL_MESSAGE_CLASS, setEmailClassHold } =
      await import("../services/operationalReadiness.server.js");
    const activating = intent === "activate_legal_email_hold";
    const result = await setEmailClassHold(
      EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL,
      {
        hold: activating,
        reason: formData.get("reason"),
        changedBy: operator.actorKey,
        releaseEvidenceReference: formData.get(
          "releaseEvidenceReference",
        ),
        shopDomain: session.shop,
      },
    );
    return json(
      { legalEmailControl: result },
      { status: result.ok ? 200 : 400 },
    );
  }

  if (intent === "activate_checkout_gate") {
    try {
      const { reconcileShopifyProductCatalog } =
        await import("../services/shopifyProductSync.server.js");
      const { activateMarketplaceCheckoutGate } =
        await import("../services/marketplaceCheckoutGate.server.js");

      const catalog = await reconcileShopifyProductCatalog(session.shop, {
        limit: 1000,
      });
      const result = await activateMarketplaceCheckoutGate(session.shop);

      return json({
        checkoutGate: {
          ok: true,
          catalog,
          result,
        },
      });
    } catch (error) {
      console.error("Marketplace checkout gate activation failed:", error);
      return json(
        {
          checkoutGate: {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "チェックアウトゲートの有効化に失敗しました。",
          },
        },
        { status: 400 },
      );
    }
  }

  if (
    intent === "stage_checkout_validation" ||
    intent === "activate_checkout_validation"
  ) {
    try {
      const {
        ensureMarketplaceCheckoutValidation,
        inspectMarketplaceCheckoutValidation,
        stageMarketplaceCheckoutValidation,
      } =
        await import("../services/shopifyCheckoutValidation.server.js");
      const {
        backfillMarketplaceCheckoutPolicies,
        syncShopOperationalPurchaseControl,
      } = await import("../services/marketplaceCheckoutGate.server.js");
      const { getPlatformOperationalControl } =
        await import("../services/operationalReadiness.server.js");
      const activating = intent === "activate_checkout_validation";

      const inspection =
        await inspectMarketplaceCheckoutValidation(session.shop);
      if (!inspection.ok) {
        return json(
          { checkoutValidation: inspection },
          { status: 400 },
        );
      }
      if (!inspection.exists) {
        const staged = await stageMarketplaceCheckoutValidation(session.shop);
        if (!staged.ok || staged.validation?.enabled !== false) {
          return json(
            { checkoutValidation: staged },
            { status: 400 },
          );
        }
      }

      const backfill = await backfillMarketplaceCheckoutPolicies(session.shop);
      if (!backfill.ok) {
        return json(
          {
            checkoutValidation: {
              ok: false,
              active: false,
              reason: "sale_eligibility_projection_backfill_failed",
              backfill,
            },
          },
          { status: 400 },
        );
      }
      const operationalControl = await getPlatformOperationalControl();
      const shopControl = await syncShopOperationalPurchaseControl({
        shopDomain: session.shop,
        state:
          operationalControl.checkoutHold === true ||
          operationalControl.checkoutControlState !== "IDLE"
            ? "BLOCKED"
            : "ALLOWED",
      });
      if (!shopControl.ok) {
        return json(
          {
            checkoutValidation: {
              ok: false,
              active: false,
              reason:
                shopControl.reason ||
                "shop_operational_control_sync_failed",
            },
          },
          { status: 400 },
        );
      }
      if (!activating) {
        const stagedInspection =
          await inspectMarketplaceCheckoutValidation(session.shop);
        return json(
          {
            checkoutValidation: {
              ...stagedInspection,
              ok: stagedInspection.ok === true,
              active: false,
              staged: stagedInspection.exists === true,
              backfill,
              shopControl,
            },
          },
          {
            status:
              stagedInspection.ok && stagedInspection.exists ? 200 : 400,
          },
        );
      }

      const { inspectOperationalReadiness } =
        await import("../services/operationalReadiness.server.js");
      const { CHECKOUT_VALIDATION_LIVE_PROBE_KEY } =
        await import("../services/operationalReadiness.server.js");
      const {
        buildProductionReleaseExpectation,
        inspectProductionReleaseEvidence,
      } = await import("../services/productionRelease.server.js");
      const operationalReadiness = await inspectOperationalReadiness();
      const replayEvidence = operationalReadiness.rows?.find(
        (row) =>
          row.definition?.key ===
          "CHECKOUT_VALIDATION_REPLAY_COMPLETED",
      );
      if (!replayEvidence?.ready) {
        return json(
          {
            checkoutValidation: {
              ok: false,
              active: false,
              staged: true,
              reason: "checkout_validation_live_test_evidence_required",
              backfill,
              shopControl,
            },
          },
          { status: 400 },
        );
      }
      const liveProbeEvidence = operationalReadiness.rows?.find(
        (row) =>
          row.definition?.key === CHECKOUT_VALIDATION_LIVE_PROBE_KEY,
      );
      const expectedRelease = buildProductionReleaseExpectation({
        checkoutValidation: inspection,
      });
      const liveProbeMatchesCurrentRelease =
        liveProbeEvidence?.ready === true &&
        inspectProductionReleaseEvidence({
          operationalReadiness,
          expected: expectedRelease,
        }).ready;
      if (!liveProbeMatchesCurrentRelease) {
        return json(
          {
            checkoutValidation: {
              ok: false,
              active: false,
              staged: true,
              reason: "checkout_validation_release_manifest_mismatch",
              backfill,
              shopControl,
            },
          },
          { status: 400 },
        );
      }
      const result = await ensureMarketplaceCheckoutValidation(session.shop);
      return json(
        {
          checkoutValidation: {
            ...result,
            backfill,
            shopControl,
          },
        },
        { status: result.ok && result.active ? 200 : 400 },
      );
    } catch (error) {
      console.error("Marketplace checkout validation activation failed:", error);
      return json(
        {
          checkoutValidation: {
            ok: false,
            active: false,
            reason:
              error instanceof Error
                ? error.message
                : "validation_activation_failed",
          },
        },
        { status: 400 },
      );
    }
  }

  const { getCarrierCallbackUrl, upsertShippingV2CarrierService } =
    await import("../services/carrierShippingRates.server.js");
  const appUrl = process.env.APP_URL;

  if (!appUrl) {
    return json(
      {
        carrierService: {
          ok: false,
          message: "APP_URL is not configured.",
        },
      },
      { status: 400 },
    );
  }

  const result = await upsertShippingV2CarrierService({
    shopDomain: session.shop,
    appUrl,
  });

  return json({
    carrierService: {
      ok: true,
      shopDomain: session.shop,
      callbackUrl: getCarrierCallbackUrl(appUrl),
      result,
    },
  });
};

function buildLiveProbeScenarios(formData) {
  const definitions = [
    {
      id: "directProductAllowed",
      expectedResult: "checkout_allowed",
    },
    {
      id: "blockedProductRejected",
      expectedResult: "checkout_rejected",
    },
    {
      id: "globalStopRejected",
      expectedResult: "checkout_rejected",
    },
    {
      id: "shopPayObserved",
      expectedResult: "checkout_allowed",
    },
  ];
  return Object.fromEntries(
    definitions.map(({ id, expectedResult }) => [
      id,
      {
        scenarioId: id,
        passed: formData.get(`${id}Passed`) === "on",
        expectedResult,
        actualResult: formData.get(`${id}ActualResult`),
        observedAt: formData.get(`${id}ObservedAt`),
        evidenceReference: formData.get(`${id}EvidenceReference`),
        evidenceHash: formData.get(`${id}EvidenceHash`),
        projectionRevision: formData.get(`${id}ProjectionRevision`),
      },
    ]),
  );
}

export default function ProductionReadinessPage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submittingIntent = navigation.formData?.get("intent");
  const isCarrierSubmitting =
    navigation.state === "submitting" && submittingIntent === "register_carrier";
  const isCheckoutGateSubmitting =
    navigation.state === "submitting" &&
    submittingIntent === "activate_checkout_gate";
  const isCheckoutValidationSubmitting =
    navigation.state === "submitting" &&
    ["stage_checkout_validation", "activate_checkout_validation"].includes(
      submittingIntent,
    );
  const displayChecks = data.checks.map((check) =>
    decorateCheckForDisplay(check, data),
  );
  const blockingChecks = displayChecks.filter(
    (check) => check.displayStatus === "fail",
  );
  const nonBlockingChecks = displayChecks.filter(
    (check) => check.displayStatus !== "fail",
  );
  const displaySummary = {
    blockingCount: blockingChecks.length,
    warningCount: displayChecks.filter(
      (check) => check.displayStatus === "warning",
    ).length,
    manualCount: displayChecks.filter(
      (check) => check.displayStatus === "manual",
    ).length,
    optionalCount: displayChecks.filter(
      (check) => check.displayStatus === "optional",
    ).length,
  };
  const orderedChecks = [...blockingChecks, ...nonBlockingChecks].sort(
    (a, b) =>
      statusSortOrder(a.displayStatus) - statusSortOrder(b.displayStatus),
  );

  return (
    <div className="readiness-page">
      <style>{`
        .readiness-page{
          display:grid;
          gap:24px;
          padding:24px;
          background:#f3f4f6;
          min-height:100%;
          color:#111827;
        }
        .readiness-card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:22px;
        }
        .readiness-header{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:flex-start;
          flex-wrap:wrap;
        }
        .readiness-title{
          margin:0 0 8px;
          font-size:28px;
          line-height:1.25;
        }
        .readiness-subtitle{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-badge{
          display:inline-flex;
          align-items:center;
          min-height:36px;
          padding:0 14px;
          border-radius:999px;
          font-weight:800;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-badge--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-badge--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
          gap:14px;
        }
        .readiness-metric{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:16px;
          display:grid;
          gap:6px;
          min-width:0;
        }
        .readiness-metric__label{
          margin:0;
          color:#6b7280;
          font-size:13px;
          font-weight:700;
        }
        .readiness-metric__value{
          margin:0;
          font-size:22px;
          line-height:1.2;
          font-weight:900;
          overflow-wrap:anywhere;
        }
        .readiness-metric__value--compact{
          font-size:20px;
        }
        .readiness-section-title{
          margin:0 0 14px;
          font-size:20px;
        }
        .readiness-table{
          width:100%;
          border-collapse:collapse;
        }
        .readiness-table th,
        .readiness-table td{
          padding:14px 12px;
          border-bottom:1px solid #eef2f7;
          text-align:left;
          vertical-align:top;
        }
        .readiness-table th{
          color:#6b7280;
          font-size:13px;
          white-space:nowrap;
        }
        .readiness-status{
          display:inline-flex;
          align-items:center;
          min-height:28px;
          padding:0 10px;
          border-radius:999px;
          font-weight:800;
          font-size:12px;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-status--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-status--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-status--warning{
          color:#92400e;
          background:#fffbeb;
          border-color:#fde68a;
        }
        .readiness-status--manual{
          color:#374151;
          background:#f9fafb;
          border-color:#d1d5db;
        }
        .readiness-status--optional{
          color:#1f2937;
          background:#f3f4f6;
          border-color:#d1d5db;
        }
        .readiness-actions{
          margin:0;
          padding-left:18px;
          color:#374151;
          line-height:1.7;
        }
        .readiness-action-stack{
          display:grid;
          gap:8px;
          align-items:start;
        }
        .readiness-action-link{
          display:inline-flex;
          width:max-content;
          min-height:32px;
          align-items:center;
          border:1px solid #d1d5db;
          border-radius:999px;
          padding:0 12px;
          color:#111827;
          background:#fff;
          font-weight:900;
          text-decoration:none;
        }
        .readiness-link{
          color:#111827;
          font-weight:800;
        }
        .readiness-tool{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:center;
          flex-wrap:wrap;
        }
        .readiness-tool__body{
          display:grid;
          gap:6px;
          min-width:260px;
        }
        .readiness-tool__title{
          margin:0;
          font-size:18px;
          font-weight:900;
        }
        .readiness-tool__text{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-button{
          border:0;
          border-radius:999px;
          min-height:44px;
          padding:0 18px;
          background:#111827;
          color:#fff;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        }
        .readiness-button:disabled{
          cursor:wait;
          opacity:.65;
        }
        .readiness-button--danger{
          background:#b91c1c;
        }
        .readiness-inline-form{
          display:flex;
          gap:8px;
          align-items:center;
          flex-wrap:wrap;
        }
        .readiness-inline-form input{
          min-height:42px;
          min-width:180px;
          border:1px solid #cbd5e1;
          border-radius:8px;
          padding:8px 10px;
          font:inherit;
        }
        .readiness-release-manifest{
          flex:1 0 100%;
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
          gap:10px;
          border:1px solid #cbd5e1;
          border-radius:8px;
          padding:12px;
        }
        .readiness-release-manifest legend{
          padding:0 6px;
          font-weight:800;
        }
        .readiness-release-manifest label{
          display:flex;
          gap:8px;
          align-items:center;
        }
        .readiness-release-manifest label:has(input:not([type="checkbox"])){
          align-items:stretch;
          flex-direction:column;
        }
        .readiness-release-manifest input{
          width:100%;
          min-width:0;
        }
        .readiness-release-manifest input[type="checkbox"]{
          width:18px;
          min-width:18px;
          min-height:18px;
        }
        .readiness-result{
          margin:14px 0 0;
          border:1px solid #d1fae5;
          background:#ecfdf5;
          color:#065f46;
          border-radius:12px;
          padding:12px 14px;
          line-height:1.7;
        }
        .readiness-result--error{
          border-color:#fecaca;
          background:#fef2f2;
          color:#991b1b;
        }
        @media (max-width: 720px){
          .readiness-page{
            padding:16px;
          }
          .readiness-table{
            min-width:760px;
          }
          .readiness-table-wrap{
            overflow-x:auto;
          }
        }
      `}</style>

      <section className="readiness-card">
        <div className="readiness-header">
          <div>
            <h1 className="readiness-title">本番前チェック</h1>
            <p className="readiness-subtitle">
              決済、精算、Shopify権限、出店者まわりの切り替え漏れを確認します。
              秘密鍵の値は表示しません。
            </p>
          </div>
          <span
            className={`readiness-badge ${
              data.canGoLive ? "readiness-badge--pass" : "readiness-badge--fail"
            }`}
          >
            {data.canGoLive ? "コード上のブロッカーなし" : "要対応あり"}
          </span>
        </div>
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">法務メール緊急保留</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.legalEmailHold
                ? "保留中"
                : "送信可能"}
            </p>
            <p className="readiness-tool__text">
              撤回受付・返送案内・返金などの法務メールだけをHELDへ移します。ログインコードと監視通知は継続します。
            </p>
          </div>
          {data.platformOperationalControl?.legalEmailHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_legal_email_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="文面確認・復旧の証跡"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                法務メールを段階再開
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_legal_email_hold"
              />
              <input name="reason" placeholder="保留理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                法務メールを保留
              </button>
            </Form>
          )}
        </div>
        {actionData?.legalEmailControl ? (
          <div
            className={`readiness-result ${
              actionData.legalEmailControl.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.legalEmailControl.ok
              ? "法務メール統制を更新しました。"
              : `処理を完了できませんでした: ${
                  actionData.legalEmailControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">自動メール緊急停止</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.automatedEmailHold
                ? "停止中"
                : "送信可能"}
            </p>
            <p className="readiness-tool__text">
              販促・AI・補助的な自動通知だけを停止します。ログインコード、法務通知、注文通知、監視通知は別の制御で継続します。
            </p>
          </div>
          {data.platformOperationalControl?.automatedEmailHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_automated_email_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="復旧確認の証拠"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                自動メールを再開
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_automated_email_hold"
              />
              <input name="reason" placeholder="停止理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                自動メールを停止
              </button>
            </Form>
          )}
        </div>
        {actionData?.automatedEmailControl ? (
          <div
            className={`readiness-result ${
              actionData.automatedEmailControl.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.automatedEmailControl.ok
              ? "自動メール統制を更新しました。"
              : `処理を完了できませんでした: ${
                  actionData.automatedEmailControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <h2 className="readiness-section-title">実地確認の証跡</h2>
        <p className="readiness-subtitle">
          設定値では確認できない項目を、確認者・証跡・有効期限つきで管理します。期限切れは自動的に本番ブロッカーへ戻ります。
        </p>
        <div className="readiness-table-wrap">
          <table className="readiness-table">
            <thead>
              <tr>
                <th>確認項目</th>
                <th>現在</th>
                <th>証跡を更新</th>
              </tr>
            </thead>
            <tbody>
              {(data.operationalReadiness?.rows || []).map((row) => (
                <tr key={row.definition.key}>
                  <td>
                    <strong>{row.definition.label}</strong>
                    <div>有効期間 {row.definition.validityDays}日</div>
                  </td>
                  <td>
                    {row.ready ? "確認済み" : "要確認"}
                    {row.attestation?.expiresAt
                      ? ` / ${new Date(
                          row.attestation.expiresAt,
                        ).toLocaleDateString("ja-JP")}まで`
                      : ""}
                  </td>
                  <td>
                    <Form method="post" className="readiness-inline-form">
                      <input
                        type="hidden"
                        name="intent"
                        value="record_operational_attestation"
                      />
                      <input
                        type="hidden"
                        name="checkKey"
                        value={row.definition.key}
                      />
                      <input type="hidden" name="status" value="CONFIRMED" />
                      <input
                        aria-label={`${row.definition.label}の証跡参照`}
                        name="evidenceReference"
                        placeholder="チケット番号、保存先URL、確認記録"
                        required
                      />
                      <input
                        aria-label={`${row.definition.label}のSHA-256`}
                        name="evidenceHash"
                        placeholder="SHA-256（任意）"
                      />
                      <input
                        aria-label={`${row.definition.label}のメモ`}
                        name="notes"
                        placeholder="確認内容"
                      />
                      {row.definition.key ===
                      "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED" ? (
                        <fieldset className="readiness-release-manifest">
                          <legend>現在のリリースと実チェックアウト結果</legend>
                          {[
                            ["releaseId", "Release ID"],
                            ["renderCommit", "Render commit"],
                            ["migrationVersion", "Migration"],
                            ["shopifyAppVersion", "Shopify app version"],
                            ["shopDomain", "Shop domain"],
                            ["functionHandle", "Function handle"],
                            ["functionUid", "Function UID"],
                            ["functionId", "Shopify Function ID"],
                            ["functionApiVersion", "Function API version"],
                            ["validationId", "Validation ID"],
                            ["policyVersion", "Policy version"],
                            [
                              "projectionSchemaVersion",
                              "Projection schema version",
                            ],
                          ].map(([name, label]) => (
                            <label key={name}>
                              <span>{label}</span>
                              <input
                                name={name}
                                defaultValue={
                                  data.productionRelease?.expected?.[name] ||
                                  ""
                                }
                                required
                              />
                            </label>
                          ))}
                          <input
                            type="hidden"
                            name="liveProbeChallenge"
                            value={data.liveProbeChallenge?.token || ""}
                            required
                          />
                          {[
                            [
                              "directProductAllowed",
                              "直販商品が購入できた",
                            ],
                            [
                              "blockedProductRejected",
                              "BLOCKED商品が拒否された",
                            ],
                            [
                              "globalStopRejected",
                              "全体停止中に購入が拒否された",
                            ],
                            [
                              "shopPayObserved",
                              "Shop Payでも期待どおりになった",
                            ],
                          ].map(([name, label]) => (
                            <div key={name} className="readiness-probe-row">
                              <label>
                                <input
                                  name={`${name}Passed`}
                                  type="checkbox"
                                  required
                                />
                                <span>{label}</span>
                              </label>
                              <input
                                name={`${name}ObservedAt`}
                                type="datetime-local"
                                aria-label={`${label}の実行日時`}
                                required
                              />
                              <input
                                name={`${name}ProjectionRevision`}
                                placeholder="対象商品のProjection revision"
                                aria-label={`${label}のProjection revision`}
                                required
                              />
                              <input
                                name={`${name}ActualResult`}
                                placeholder="実際の結果"
                                aria-label={`${label}の実際の結果`}
                                required
                              />
                              <input
                                name={`${name}EvidenceReference`}
                                placeholder="このシナリオの証跡URL・実行ID"
                                aria-label={`${label}の証跡参照`}
                                required
                              />
                              <input
                                name={`${name}EvidenceHash`}
                                placeholder="証跡SHA-256（任意）"
                                aria-label={`${label}の証跡SHA-256`}
                              />
                            </div>
                          ))}
                        </fieldset>
                      ) : null}
                      <button
                        className="readiness-button"
                        disabled={navigation.state !== "idle"}
                        type="submit"
                      >
                        確認を記録
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {actionData?.operationalAttestation ? (
          <div
            className={`readiness-result ${
              actionData.operationalAttestation.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.operationalAttestation.ok
              ? "実地確認の証跡を更新しました。"
              : `保存できませんでした: ${
                  actionData.operationalAttestation.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">販売緊急停止</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.checkoutHold
                ? "停止中"
                : "販売可能"}
            </p>
            <p className="readiness-tool__text">
              Shopify側の購入拒否を先に有効化し、運営直販商品を全販売チャネルから外します。復旧時は現在の適格性を再審査し、停止前に公開されていた適格商品のみ戻します。
            </p>
          </div>
          {data.platformOperationalControl?.checkoutHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_emergency_checkout_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="復旧確認の証跡"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                停止を解除
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_emergency_checkout_hold"
              />
              <input name="reason" placeholder="停止理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                全商品の販売を停止
              </button>
            </Form>
          )}
        </div>
        {actionData?.operationalControl ? (
          <div
            className={`readiness-result ${
              actionData.operationalControl.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.operationalControl.ok
              ? "販売統制を更新しました。"
              : `処理を完了できませんでした。停止状態は維持されます: ${
                  actionData.operationalControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">
              Shopifyサーバー側の購入制御
            </h2>
            <p className="readiness-tool__text">
              状態: {data.checkoutValidation?.active ? "有効" : "無効"}
            </p>
            <p className="readiness-tool__text">
              Shopify標準チェックアウト、Shop Payなどを含む購入処理をShopify Functionsで検証します。制御関数の実行失敗時も購入を拒否します。
            </p>
          </div>
          <div className="readiness-inline-form">
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="stage_checkout_validation"
              />
              <button
                className="readiness-button"
                type="submit"
                disabled={isCheckoutValidationSubmitting}
              >
                無効状態で準備
              </button>
            </Form>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="activate_checkout_validation"
              />
              <button
                className="readiness-button"
                type="submit"
                disabled={isCheckoutValidationSubmitting}
              >
                {isCheckoutValidationSubmitting
                  ? "購入制御を確認中"
                  : "証跡確認後に有効化"}
              </button>
            </Form>
          </div>
        </div>
        {actionData?.checkoutValidation ? (
          <div
            className={`readiness-result ${
              actionData.checkoutValidation.ok &&
              actionData.checkoutValidation.active
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.checkoutValidation.ok &&
            actionData.checkoutValidation.active
              ? "Shopifyサーバー側の購入制御を有効化しました。"
              : actionData.checkoutValidation.ok &&
                  actionData.checkoutValidation.staged
                ? "購入制御を無効状態で準備しました。実ストアのFunction再生と正常・遮断確認を記録してから有効化してください。"
              : `購入制御を有効化できませんでした: ${
                  actionData.checkoutValidation.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">
              第三者商品の公開境界
            </h2>
            <p className="readiness-tool__text">
              運営直販商品だけをOnline Storeへ公開し、店舗別精算が必要な商品はApp ProxyとDraft Orderの購入導線に限定します。
            </p>
            <p className="readiness-tool__text">
              状態: {data.checkoutGate?.active ? "有効" : "無効"}
              {!data.checkoutGate?.available && data.checkoutGate?.message
                ? ` / ${data.checkoutGate.message}`
                : ""}
            </p>
          </div>
          <Form method="post">
            <input
              type="hidden"
              name="intent"
              value="activate_checkout_gate"
            />
            <button
              className="readiness-button"
              type="submit"
              disabled={isCheckoutGateSubmitting}
            >
              {isCheckoutGateSubmitting
                ? "商品同期・公開境界を確認中"
                : "商品同期と公開境界を適用"}
            </button>
          </Form>
        </div>
        {actionData?.checkoutGate ? (
          <div
            className={`readiness-result ${
              actionData.checkoutGate.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.checkoutGate.ok
              ? `公開境界を適用しました。更新: ${
                  actionData.checkoutGate.result?.backfill?.changedCount ?? 0
                }件`
              : actionData.checkoutGate.message ||
                "公開境界の適用に失敗しました。"}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">配送サービス再登録</h2>
            <p className="readiness-tool__text">
              アプリを再インストールした後は、Shopify側の配送サービス登録が外れることがあります。
              配送方法にShipping V2が出ない場合はここから再登録します。
            </p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="register_carrier" />
            <button
              className="readiness-button"
              type="submit"
              disabled={isCarrierSubmitting}
            >
              {isCarrierSubmitting ? "再登録中" : "Shipping V2を再登録"}
            </button>
          </Form>
        </div>
        {actionData?.carrierService ? (
          <div
            className={`readiness-result ${
              actionData.carrierService.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.carrierService.ok
              ? `登録しました。Callback: ${actionData.carrierService.callbackUrl}`
              : actionData.carrierService.message || "再登録に失敗しました。"}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-grid">
          <Metric
            label="決済"
            value={paymentFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="出店者精算"
            value={sellerPayoutFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="Stripe Connect"
            value={
              data.operation?.stripeConnectProductionEnabled
                ? "使用中"
                : "使わない"
            }
            compact
          />
          <Metric label="要対応" value={displaySummary.blockingCount} />
          <Metric label="注意" value={displaySummary.warningCount} />
          <Metric label="外部確認" value={displaySummary.manualCount} />
          <Metric label="任意" value={displaySummary.optionalCount} />
          <Metric
            label="出店者"
            value={`${data.sellers.activeCount}/${data.sellers.totalCount}`}
          />
          <Metric label="撤回申請" value={data.withdrawals?.openCount ?? 0} />
          <Metric
            label="撤回期限"
            value={`${data.withdrawals?.deadlineExpiredCount ?? 0}/${data.withdrawals?.deadlineSoonCount ?? 0}`}
            compact
          />
          <Metric
            label="撤回メール失敗"
            value={data.withdrawals?.emailFailedCount ?? 0}
          />
          <Metric
            label="撤回要確認"
            value={data.withdrawals?.processingIssueCount ?? 0}
          />
          <Metric
            label="定期メール"
            value={heartbeatStatusLabel(data.integrity?.heartbeat)}
            compact
          />
          <Metric
            label="注文差分"
            value={data.integrity?.sellerOrderShadow?.unresolvedCount ?? 0}
          />
          <Metric
            label="台帳補正待ち"
            value={`${data.integrity?.ledgerRepairs?.productionCount ?? 0}/${data.integrity?.ledgerRepairs?.testCount ?? 0}`}
            compact
          />
          <Metric
            label="テスト出金予定"
            value={data.integrity?.testStores?.pendingPayoutRunCount ?? 0}
          />
        </div>
      </section>

      {blockingChecks.length > 0 ? (
        <section className="readiness-card">
          <h2 className="readiness-section-title">先に直すこと</h2>
          <ul className="readiness-actions">
            {blockingChecks.map((check) => (
              <li key={check.id}>
                <strong>{check.displayTitle}</strong>:{" "}
                {check.displayAction || check.displayDetail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="readiness-card">
        <h2 className="readiness-section-title">チェック結果</h2>
        <div className="readiness-table-wrap">
          <table className="readiness-table">
            <thead>
              <tr>
                <th>状態</th>
                <th>区分</th>
                <th>項目</th>
                <th>現在</th>
                <th>対応</th>
              </tr>
            </thead>
            <tbody>
              {orderedChecks.map((check) => (
                <tr key={check.id}>
                  <td>
                    <Status status={check.displayStatus} />
                  </td>
                  <td>{categoryLabel(check.category)}</td>
                  <td>{check.displayTitle}</td>
                  <td>{check.displayDetail || "-"}</td>
                  <td>
                    <div className="readiness-action-stack">
                      <span>{check.displayAction || "-"}</span>
                      {check.actionLink ? (
                        <Link
                          className="readiness-action-link"
                          to={check.actionLink.to}
                        >
                          {check.actionLink.label}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="readiness-card">
        <h2 className="readiness-section-title">補足</h2>
        <p className="readiness-subtitle">
          Shopify
          Payments、KOMOJU、Wise、銀行口座などの外部側ステータスは、アプリから完全には確認できません。
          Shopify管理画面と各決済サービス側で有効状態を確認し、少額注文、返金、キャンセル、精算記録まで通してください。
          出金管理は{" "}
          <Link className="readiness-link" to="/app/payout-runs">
            出金管理
          </Link>{" "}
          から確認できます。
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value, compact = false }) {
  return (
    <div className="readiness-metric">
      <p className="readiness-metric__label">{label}</p>
      <p
        className={`readiness-metric__value ${
          compact ? "readiness-metric__value--compact" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Status({ status }) {
  return (
    <span className={`readiness-status readiness-status--${status}`}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status) {
  switch (status) {
    case "pass":
      return "OK";
    case "fail":
      return "要対応";
    case "warning":
      return "注意";
    case "manual":
      return "外部確認";
    case "optional":
      return "任意";
    default:
      return status;
  }
}

function categoryLabel(category) {
  switch (category) {
    case "stripe":
      return "Stripe";
    case "shopify":
      return "Shopify";
    case "seller":
      return "出店者";
    case "payout":
      return "出金";
    case "app":
      return "アプリ";
    default:
      return category;
  }
}

function statusSortOrder(status) {
  switch (status) {
    case "fail":
      return 0;
    case "warning":
      return 1;
    case "manual":
      return 2;
    case "optional":
      return 3;
    case "pass":
      return 4;
    default:
      return 5;
  }
}

function paymentFlowLabel(operation) {
  if (operation?.stripeConnectProductionEnabled) {
    return "Stripe Connect";
  }

  return "Shopify Checkout";
}

function sellerPayoutFlowLabel(operation) {
  if (operation?.sellerPayoutProvider === "wise") {
    return "Wise API精算";
  }

  if (operation?.sellerPayoutProvider === "manual") {
    return "月次手動精算";
  }

  return operation?.sellerPayoutProviderLabel || "未設定";
}

function heartbeatStatusLabel(heartbeat) {
  if (!heartbeat?.available) return "未確認";
  if (heartbeat.failureUnresolved || heartbeat.stale) return "要確認";
  if (!heartbeat.row?.lastSucceededAt) return "未実行";
  return "稼働中";
}

const CHECK_TITLE_LABELS = {
  payment_provider: "決済方式",
  seller_payout_provider: "出店者精算方式",
  production_payment_flow: "本番フロー",
  stripe_secret_key_live: "Stripe secret key",
  stripe_publishable_key_live: "Stripe publishable key",
  stripe_key_modes_match: "Stripeキー整合",
  stripe_platform_webhook_secret: "Stripe webhook",
  stripe_connect_webhook_secret: "Stripe Connect webhook",
  stripe_platform_fee_bps: "Stripe手数料設定",
  production_runtime: "実行環境",
  shopify_configured_scopes: "Shopify設定権限",
  shopify_granted_scopes: "Shopify承認済み権限",
  shopify_product_store_mapping: "Shopify商品と店舗の紐付け",
  shopify_payments_bank_account: "決済入金口座",
  active_sellers_have_stripe_accounts: "出店者の受取先",
  connected_accounts_match_current_stripe_key: "Stripe接続アカウント確認",
  connected_accounts_ready: "Stripe接続アカウント状態",
  seller_payout_transfer_mode: "精算実行方法",
  wise_api_environment: "Wise API設定",
  wise_webhook_secret: "Wise webhook",
  wise_execution_safety: "Wise実行安全性",
  wise_api_connection: "Wise API接続",
};

function decorateCheckForDisplay(check, data) {
  const stripeConnectEnabled = Boolean(
    data.operation?.stripeConnectProductionEnabled,
  );
  const isOptionalStripe =
    check.category === "stripe" &&
    !stripeConnectEnabled &&
    check.status === "warning";
  const displayStatus = isOptionalStripe ? "optional" : check.status;

  return {
    ...check,
    displayStatus,
    displayTitle: CHECK_TITLE_LABELS[check.id] || check.title,
    displayDetail: checkDetailForDisplay(check, data, { isOptionalStripe }),
    displayAction: checkActionForDisplay(check, data, { isOptionalStripe }),
    actionLink: checkActionLinkForDisplay(check),
  };
}

function checkDetailForDisplay(check, data, { isOptionalStripe }) {
  if (isOptionalStripe) {
    return "現在の本番導線では使いません。Stripe Connectを再開する場合だけ確認します。";
  }

  switch (check.id) {
    case "payment_provider":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connect が決済方式として有効です。"
        : "購入者の決済は Shopify Checkout で処理します。";
    case "seller_payout_provider":
      return `出店者への支払いは ${sellerPayoutFlowLabel(
        data.operation,
      )} として扱います。`;
    case "production_payment_flow":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connect の本番確認が有効です。"
        : `決済は ${paymentFlowLabel(data.operation)}、精算は ${sellerPayoutFlowLabel(
            data.operation,
          )} です。`;
    case "shopify_configured_scopes":
      return formatMissingScopeDetail(
        check.detail,
        "本番設定のSCOPESに不足があります",
      );
    case "shopify_granted_scopes":
      return formatMissingScopeDetail(
        check.detail,
        "インストール済みアプリに未承認の権限があります",
      );
    case "shopify_payments_bank_account":
      return "入金口座や決済サービス側の有効状態は、アプリから完全には確認できません。";
    case "active_sellers_have_stripe_accounts":
      if (data.operation?.sellerPayoutProvider === "wise") {
        return (
          check.detail || "Wise精算では、出店者ごとの受取先登録が必要です。"
        );
      }
      return "月次手動精算では、出店者のStripe登録は不要です。";
    case "connected_accounts_match_current_stripe_key":
    case "connected_accounts_ready":
      return data.operation?.stripeConnectProductionEnabled
        ? check.detail
        : "Stripe Connect未使用のため対象外です。";
    case "seller_payout_transfer_mode":
      return data.operation?.sellerPayoutProvider === "wise"
        ? "承認済みの精算予定からWise送金を実行します。"
        : "実送金後に外部送金IDを記録する運用です。";
    case "wise_api_connection":
      return data.operation?.sellerPayoutProvider === "wise"
        ? check.detail
        : "現在は手動精算のため、Wise API接続は任意です。";
    default:
      return check.detail;
  }
}

function checkActionForDisplay(check, data, { isOptionalStripe }) {
  if (isOptionalStripe) {
    return "今は対応不要です。Stripe Connectを使う方針に戻す時だけ設定します。";
  }

  switch (check.id) {
    case "payment_provider":
      return check.status === "pass"
        ? ""
        : "Renderの環境変数で PAYMENT_PROVIDER=shopify_payments を明示します。";
    case "seller_payout_provider":
      return check.status === "pass"
        ? ""
        : "Renderの環境変数で SELLER_PAYOUT_PROVIDER=manual または wise を明示します。";
    case "production_payment_flow":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connectを使う場合だけ、live key、webhook、接続アカウントを確認します。"
        : "Stripe Connect direct charge と Connect payout は無効のままにします。";
    case "shopify_configured_scopes":
      return check.status === "pass"
        ? ""
        : "Shopify設定とRenderのSCOPESを更新し、再デプロイ後に再認可します。";
    case "shopify_granted_scopes":
      return check.status === "pass"
        ? ""
        : "Shopify管理画面でアプリを開き、追加権限を承認してください。出ない場合は再インストールで再認可します。";
    case "shopify_payments_bank_account":
      return "Shopify管理画面とKOMOJU側で、決済受付と入金口座の状態を確認します。";
    case "active_sellers_have_stripe_accounts":
      return check.status === "pass"
        ? ""
        : "受取先未登録の出店者は精算対象外にするか、受取先確認を完了します。";
    case "connected_accounts_match_current_stripe_key":
    case "connected_accounts_ready":
      return data.operation?.stripeConnectProductionEnabled
        ? check.action
        : "今は対応不要です。";
    case "seller_payout_transfer_mode":
      return data.operation?.sellerPayoutProvider === "wise"
        ? "承認、残高再計算、冪等性キーを通してから送金します。"
        : "銀行/Wiseなどで送金後、出金管理に外部送金IDを記録します。";
    case "wise_api_connection":
      return data.operation?.sellerPayoutProvider === "wise"
        ? check.action
        : "Wise API精算に切り替える時だけ設定します。";
    default:
      return check.action;
  }
}

function formatMissingScopeDetail(detail, prefix) {
  const missingScopes = String(detail || "").match(/:\s*(.+)$/)?.[1];

  if (missingScopes) {
    return `${prefix}: ${missingScopes}`;
  }

  return detail;
}

function checkActionLinkForDisplay(check) {
  switch (check.id) {
    case "shopify_product_store_mapping":
      return {
        label: "商品同期を開く",
        to: "/app/shopify-product-sync",
      };
    case "product_shipping_profiles_available":
    case "approved_product_shipping_weight":
    case "air_packet_product_profiles":
    case "air_packet_single_variant_products":
    case "air_packet_weight_sync":
    case "eu_product_international_shipping_profiles":
      return {
        label: "商品配送設定を開く",
        to: "/app/product-shipping",
      };
    case "air_packet_country_availability":
      return {
        label: "国際配送状況を開く",
        to: "/app/international-shipping",
      };
    case "withdrawal_open_requests":
      return {
        label: "未完了を見る",
        to: "/app/withdrawals?queue=open",
      };
    case "withdrawal_deadlines":
      return {
        label: "期限超過を見る",
        to: "/app/withdrawals?queue=deadline_expired",
      };
    case "withdrawal_email_failures":
      return {
        label: "メール失敗を見る",
        to: "/app/withdrawals?queue=email_failed",
      };
    case "withdrawal_processing_integrity":
      return {
        label: "処理不整合を見る",
        to: "/app/withdrawals?queue=processing_issue",
      };
    case "withdrawal_email_worker_heartbeat":
      return {
        label: "送信キューを見る",
        to: "/app/withdrawals?queue=email_failed",
      };
    case "seller_order_unresolved_shadow_checks":
      return {
        label: "注文差分を見る",
        to: "/app/seller-order-shadow",
      };
    case "seller_ledger_repair_candidates":
    case "test_store_pending_payout_runs":
      return {
        label: "出金管理を見る",
        to: "/app/payout-runs",
      };
    default:
      return null;
  }
}
