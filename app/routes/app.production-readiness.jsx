import { json } from "@remix-run/node";
import ProductionReadinessPage from "../components/readiness/ProductionReadinessPage.jsx";
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
  } = await import("../services/productionReadiness.server.js");
  const { getMarketplaceCheckoutGateStatus } =
    await import("../services/marketplaceCheckoutGate.server.js");

  const readiness = await getProductionReadiness({
    shopDomain: session.shop,
  });
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
      message: "Online Storeの公開権限と商品同期状態を確認してください。",
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
    } = await import("../services/operationalReadiness.server.js");
    const checkKey = String(formData.get("checkKey") || "");
    let metadataJson = null;
    if (checkKey === CHECKOUT_VALIDATION_LIVE_PROBE_KEY) {
      const {
        buildProductionReleaseExpectation,
        verifyProductionProbeChallenge,
      } = await import("../services/productionRelease.server.js");
      const { inspectMarketplaceCheckoutValidation } =
        await import("../services/shopifyCheckoutValidation.server.js");
      const checkoutValidation = await inspectMarketplaceCheckoutValidation(
        session.shop,
      );
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
        releaseEvidenceReference: formData.get("releaseEvidenceReference"),
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
      } = await import("../services/shopifyCheckoutValidation.server.js");
      const {
        backfillMarketplaceCheckoutPolicies,
        syncShopOperationalPurchaseControl,
      } = await import("../services/marketplaceCheckoutGate.server.js");
      const { getPlatformOperationalControl } =
        await import("../services/operationalReadiness.server.js");
      const activating = intent === "activate_checkout_validation";

      const inspection = await inspectMarketplaceCheckoutValidation(
        session.shop,
      );
      if (!inspection.ok) {
        return json({ checkoutValidation: inspection }, { status: 400 });
      }
      if (!inspection.exists) {
        const staged = await stageMarketplaceCheckoutValidation(session.shop);
        if (!staged.ok || staged.validation?.enabled !== false) {
          return json({ checkoutValidation: staged }, { status: 400 });
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
                shopControl.reason || "shop_operational_control_sync_failed",
            },
          },
          { status: 400 },
        );
      }
      if (!activating) {
        const stagedInspection = await inspectMarketplaceCheckoutValidation(
          session.shop,
        );
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
            status: stagedInspection.ok && stagedInspection.exists ? 200 : 400,
          },
        );
      }

      const {
        inspectCheckoutValidationActivationEvidence,
        inspectOperationalReadiness,
      } = await import("../services/operationalReadiness.server.js");
      const operationalReadiness = await inspectOperationalReadiness();
      const activationEvidence =
        inspectCheckoutValidationActivationEvidence(operationalReadiness);
      if (!activationEvidence.ok) {
        return json(
          {
            checkoutValidation: {
              ok: false,
              active: false,
              staged: true,
              reason: activationEvidence.reason,
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
      console.error(
        "Marketplace checkout validation activation failed:",
        error,
      );
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

export default ProductionReadinessPage;
