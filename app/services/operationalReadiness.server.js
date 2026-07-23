import crypto from "node:crypto";

import prisma from "../db.server.js";

export const PLATFORM_OPERATIONAL_CONTROL_KEY = "GLOBAL";
export const OPERATIONAL_CONTROL_TYPE = Object.freeze({
  PURCHASE_STOP: "PURCHASE_STOP",
  EMAIL_AUTOMATION_STOP: "EMAIL_AUTOMATION_STOP",
  EMAIL_ORDER_STOP: "EMAIL_ORDER_STOP",
  EMAIL_LEGAL_STOP: "EMAIL_LEGAL_STOP",
  EMAIL_SECURITY_STOP: "EMAIL_SECURITY_STOP",
});
export const OPERATIONAL_CONTROL_STATE = Object.freeze({
  REQUESTED: "REQUESTED",
  ACTIVATING: "ACTIVATING",
  ACTIVE: "ACTIVE",
  PARTIAL_FAILURE: "PARTIAL_FAILURE",
  RECOVERY_REQUESTED: "RECOVERY_REQUESTED",
  RECOVERING: "RECOVERING",
  RECOVERED: "RECOVERED",
  RECOVERY_FAILED: "RECOVERY_FAILED",
});
export const EMAIL_MESSAGE_CLASS = Object.freeze({
  SECURITY: "SECURITY",
  LEGAL_TRANSACTIONAL: "LEGAL_TRANSACTIONAL",
  ORDER_TRANSACTIONAL: "ORDER_TRANSACTIONAL",
  SUPPORT: "SUPPORT",
  AUTOMATION: "AUTOMATION",
  MONITORING: "MONITORING",
});
export const OPERATIONAL_ATTESTATION_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  PENDING: "PENDING",
});
export const CHECKOUT_VALIDATION_LIVE_PROBE_KEY =
  "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED";

export const OPERATIONAL_READINESS_DEFINITIONS = Object.freeze([
  {
    key: "LEGAL_DISCLOSURES_REVIEWED",
    label: "法定表示・利用規約の実画面確認",
    validityDays: 90,
  },
  {
    key: "CHECKOUT_FINAL_SCREEN_REVIEWED",
    label: "購入直前画面の価格・送料・販売者表示確認",
    validityDays: 90,
  },
  {
    key: "CHECKOUT_VALIDATION_REPLAY_COMPLETED",
    label: "購入制御Functionの実ストア再生・遮断確認",
    validityDays: 30,
  },
  {
    key: CHECKOUT_VALIDATION_LIVE_PROBE_KEY,
    label: "本番Function・Release Manifestの4シナリオ実機確認",
    validityDays: 7,
  },
  {
    key: "UNSUPPORTED_SALES_SURFACES_DISABLED",
    label: "POS・管理画面注文・サブスク等の未対応販売経路の無効化確認",
    validityDays: 30,
  },
  {
    key: "EMERGENCY_STOP_DRILL_COMPLETED",
    label: "販売緊急停止の実地訓練",
    validityDays: 90,
  },
  {
    key: "INDEPENDENT_SALES_STOP_DRILL_COMPLETED",
    label: "Render・DB停止時の独立販売停止訓練",
    validityDays: 90,
  },
  {
    key: "REFUND_LIQUIDITY_CONFIRMED",
    label: "返金原資と支払可能額の確認",
    validityDays: 1,
  },
  {
    key: "SHOPIFY_PAYMENTS_LIVE_CONFIRMED",
    label: "Shopify Payments本番モード確認",
    validityDays: 30,
  },
  {
    key: "ADMIN_MFA_ACCESS_REVIEWED",
    label: "管理者権限・MFAの棚卸し",
    validityDays: 90,
  },
  {
    key: "PRIVACY_INCIDENT_RUNBOOK_CONFIRMED",
    label: "個人情報事故対応手順の確認",
    validityDays: 90,
  },
  {
    key: "EMAIL_DELIVERY_CONFIRMED",
    label: "購入者・管理者メールの実受信確認",
    validityDays: 7,
  },
  {
    key: "LIVE_ORDER_REFUND_E2E_COMPLETED",
    label: "本番注文・返金・台帳のE2E確認",
    validityDays: 90,
  },
]);

const ATTESTATION_DEFINITIONS = new Map(
  OPERATIONAL_READINESS_DEFINITIONS.map((definition) => [
    definition.key,
    definition,
  ]),
);

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeSha256(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function getPlatformOperationalControl({
  prismaClient = prisma,
} = {}) {
  if (!prismaClient?.platformOperationalControl?.findUnique) {
    return {
      key: PLATFORM_OPERATIONAL_CONTROL_KEY,
      checkoutHold: false,
      automatedEmailHold: false,
      orderEmailHold: false,
      legalEmailHold: false,
      securityEmailHold: false,
      internationalShippingHold: false,
      checkoutControlState: "IDLE",
      available: false,
    };
  }

  const control = await prismaClient.platformOperationalControl.findUnique({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
  });

  return {
    key: PLATFORM_OPERATIONAL_CONTROL_KEY,
    checkoutHold: false,
    automatedEmailHold: false,
    orderEmailHold: false,
    legalEmailHold: false,
    securityEmailHold: false,
    internationalShippingHold: false,
    checkoutControlState: "IDLE",
    available: true,
    ...control,
  };
}

export async function isPlatformCheckoutHoldActive(options = {}) {
  const control = await getPlatformOperationalControl(options);
  return control.checkoutHold === true;
}

export async function isAutomatedEmailHoldActive(options = {}) {
  const control = await getPlatformOperationalControl(options);
  return control.automatedEmailHold === true;
}

const EMAIL_CLASS_CONTROL = Object.freeze({
  [EMAIL_MESSAGE_CLASS.AUTOMATION]: {
    field: "automatedEmailHold",
    metadataKey: "emailAutomation",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_AUTOMATION_STOP,
  },
  [EMAIL_MESSAGE_CLASS.SUPPORT]: {
    field: "automatedEmailHold",
    metadataKey: "emailAutomation",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_AUTOMATION_STOP,
  },
  [EMAIL_MESSAGE_CLASS.ORDER_TRANSACTIONAL]: {
    field: "orderEmailHold",
    metadataKey: "emailOrder",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_ORDER_STOP,
  },
  [EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL]: {
    field: "legalEmailHold",
    metadataKey: "emailLegal",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_LEGAL_STOP,
  },
  [EMAIL_MESSAGE_CLASS.SECURITY]: {
    field: "securityEmailHold",
    metadataKey: "emailSecurity",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_SECURITY_STOP,
  },
});

export function getEmailClassControl(messageClass) {
  return EMAIL_CLASS_CONTROL[normalizeUpper(messageClass)] || null;
}

export async function isEmailClassHoldActive(messageClass, options = {}) {
  const status = await getEmailClassHoldStatus(messageClass, options);
  return status.active;
}

export async function getEmailClassHoldStatus(
  messageClass,
  { prismaClient = prisma } = {},
) {
  const normalizedClass = normalizeUpper(messageClass);
  if (normalizedClass === EMAIL_MESSAGE_CLASS.MONITORING) {
    return {
      active: false,
      messageClass: normalizedClass,
      control: null,
      platformControl: null,
    };
  }
  const mapping = getEmailClassControl(normalizedClass);
  if (!mapping) {
    return {
      active: false,
      messageClass: normalizedClass,
      control: null,
      platformControl: null,
    };
  }
  const platformControl = await getPlatformOperationalControl({
    prismaClient,
  });
  const active = platformControl[mapping.field] === true;
  const control =
    active && prismaClient?.operationalControl?.findFirst
      ? await prismaClient.operationalControl.findFirst({
          where: {
            controlType: mapping.controlType,
            activeKey: { not: null },
            state: {
              in: [
                OPERATIONAL_CONTROL_STATE.ACTIVE,
                OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE,
                OPERATIONAL_CONTROL_STATE.RECOVERY_REQUESTED,
                OPERATIONAL_CONTROL_STATE.RECOVERING,
                OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
              ],
            },
          },
          orderBy: { requestedAt: "desc" },
        })
      : null;

  return {
    active,
    messageClass: normalizedClass,
    control,
    platformControl,
    reason:
      normalizeText(control?.reasonText) ||
      normalizeText(platformControl?.holdReason),
  };
}

function asMetadataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

async function setPlatformOperationalHold(
  {
    field,
    metadataKey,
    hold,
    reason,
    changedBy,
    releaseEvidenceReference = null,
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedReason = normalizeText(reason);
  const normalizedActor = normalizeText(changedBy);
  const normalizedEvidence = normalizeText(releaseEvidenceReference);

  if (!normalizedReason || !normalizedActor) {
    return { ok: false, reason: "reason_and_actor_required" };
  }
  if (hold !== true && !normalizedEvidence) {
    return { ok: false, reason: "release_evidence_required" };
  }

  const current = prismaClient.platformOperationalControl.findUnique
    ? await prismaClient.platformOperationalControl.findUnique({
        where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
      })
    : null;
  const currentMetadata = asMetadataObject(current?.metadataJson);
  const currentHoldMetadata = asMetadataObject(
    asMetadataObject(currentMetadata.holds)[metadataKey],
  );
  const activatingActor =
    normalizeText(currentHoldMetadata.activatedBy) ||
    (current?.[field] === true ? normalizeText(current.changedBy) : null);

  if (
    hold !== true &&
    current?.[field] === true &&
    activatingActor === normalizedActor
  ) {
    return {
      ok: false,
      reason: "independent_release_approval_required",
      activatingActor,
    };
  }

  const nextHoldMetadata =
    hold === true
      ? {
          active: true,
          activatedBy: normalizedActor,
          activatedAt: now.toISOString(),
          reason: normalizedReason,
          context: asMetadataObject(metadataJson),
        }
      : {
          ...currentHoldMetadata,
          active: false,
          releasedBy: normalizedActor,
          releasedAt: now.toISOString(),
          releaseReason: normalizedReason,
          releaseEvidenceReference: normalizedEvidence,
          releaseContext: asMetadataObject(metadataJson),
        };
  const nextMetadata = {
    ...currentMetadata,
    holds: {
      ...asMetadataObject(currentMetadata.holds),
      [metadataKey]: nextHoldMetadata,
    },
  };
  const values = {
    [field]: hold === true,
    holdReason: normalizedReason,
    changedBy: normalizedActor,
    changedAt: now,
    releaseEvidenceReference: hold === true ? null : normalizedEvidence,
    metadataJson: nextMetadata,
  };

  const control = await prismaClient.platformOperationalControl.upsert({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
    create: {
      key: PLATFORM_OPERATIONAL_CONTROL_KEY,
      ...values,
    },
    update: values,
  });

  return { ok: true, control };
}

function buildOperationalControlActiveKey({
  shopDomain,
  controlType,
  scopeType = "PLATFORM",
  scopeId = "GLOBAL",
}) {
  return [
    normalizeText(shopDomain) || "GLOBAL",
    normalizeUpper(controlType),
    normalizeUpper(scopeType),
    normalizeText(scopeId) || "GLOBAL",
  ].join(":");
}

async function recordSimpleOperationalControl(
  {
    controlType,
    hold,
    reason,
    changedBy,
    shopDomain = "GLOBAL",
    releaseEvidenceReference = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!prismaClient?.operationalControl?.findFirst) return null;
  const activeKey = buildOperationalControlActiveKey({
    shopDomain,
    controlType,
  });
  const current = await prismaClient.operationalControl.findFirst({
    where: { activeKey },
    orderBy: { requestedAt: "desc" },
  });

  if (hold === true) {
    if (current) return current;
    try {
      return await prismaClient.operationalControl.create({
        data: {
          activeKey,
          shopDomain: normalizeText(shopDomain) || "GLOBAL",
          controlType,
          state: OPERATIONAL_CONTROL_STATE.ACTIVE,
          reasonCode: "MANUAL_EMERGENCY_HOLD",
          reasonText: normalizeText(reason),
          requestedByUserId: normalizeText(changedBy),
          activatedByUserId: normalizeText(changedBy),
          activatedAt: now,
          lastVerifiedAt: now,
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      return prismaClient.operationalControl.findFirst({
        where: { activeKey },
        orderBy: { requestedAt: "desc" },
      });
    }
  }

  if (!current) return null;
  return prismaClient.operationalControl.update({
    where: { id: current.id },
    data: {
      activeKey: null,
      state: OPERATIONAL_CONTROL_STATE.RECOVERED,
      recoveryRequestedByUserId: normalizeText(changedBy),
      recoveryRequestedAt: now,
      recoveredByUserId: normalizeText(changedBy),
      recoveredAt: now,
      lastVerifiedAt: now,
      recoveryEvidenceJson: {
        reference: normalizeText(releaseEvidenceReference),
        reason: normalizeText(reason),
      },
    },
  });
}

export async function setPlatformCheckoutHold(
  {
    hold,
    reason,
    changedBy,
    releaseEvidenceReference = null,
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  return setPlatformOperationalHold(
    {
      field: "checkoutHold",
      metadataKey: "checkout",
      hold,
      reason,
      changedBy,
      releaseEvidenceReference,
      metadataJson,
    },
    { prismaClient, now },
  );
}

export async function setAutomatedEmailHold(
  {
    hold,
    reason,
    changedBy,
    releaseEvidenceReference = null,
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  return setEmailClassHold(
    EMAIL_MESSAGE_CLASS.AUTOMATION,
    {
      hold,
      reason,
      changedBy,
      releaseEvidenceReference,
      metadataJson,
    },
    { prismaClient, now },
  );
}

export async function setEmailClassHold(
  messageClass,
  {
    hold,
    reason,
    changedBy,
    releaseEvidenceReference = null,
    metadataJson = null,
    allowSecurityHold = false,
    shopDomain = "GLOBAL",
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedClass = normalizeUpper(messageClass);
  const mapping = getEmailClassControl(normalizedClass);
  if (!mapping || normalizedClass === EMAIL_MESSAGE_CLASS.MONITORING) {
    return { ok: false, reason: "unsupported_email_message_class" };
  }
  if (
    normalizedClass === EMAIL_MESSAGE_CLASS.SECURITY &&
    allowSecurityHold !== true
  ) {
    return { ok: false, reason: "security_hold_requires_incident_channel" };
  }

  const result = await setPlatformOperationalHold(
    {
      field: mapping.field,
      metadataKey: mapping.metadataKey,
      hold,
      reason,
      changedBy,
      releaseEvidenceReference,
      metadataJson: {
        ...asMetadataObject(metadataJson),
        messageClass: normalizedClass,
      },
    },
    { prismaClient, now },
  );
  if (!result.ok) return result;

  const operationalControl = await recordSimpleOperationalControl(
    {
      controlType: mapping.controlType,
      hold,
      reason,
      changedBy,
      shopDomain,
      releaseEvidenceReference,
    },
    { prismaClient, now },
  );

  if (hold !== true) {
    const { releaseHeldWithdrawalEmails } =
      await import("./withdrawalEmailOutbox.server.js");
    await releaseHeldWithdrawalEmails({
      prismaClient,
      messageClasses: [normalizedClass],
      approvedBy: normalizeText(changedBy),
      controlId: operationalControl?.id || null,
      limit: 100,
      now,
    });
  }

  return { ...result, operationalControl, messageClass: normalizedClass };
}

export async function applyPlatformCheckoutEmergencyHold(
  { reason, changedBy, shopDomain = null },
  {
    prismaClient = prisma,
    enforceResourceBoundary = null,
    syncCheckoutPolicy = null,
    syncShopControl = null,
    ensureCheckoutValidation = null,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const normalizedReason = normalizeText(reason);
  const normalizedActor = normalizeText(changedBy);
  if (!normalizedReason || !normalizedActor) {
    return { ok: false, reason: "reason_and_actor_required" };
  }

  const products = await prismaClient.product.findMany({
    where: {
      shopifyProductId: { not: null },
      vendorStore: {
        is: { isTestStore: false },
      },
    },
    select: {
      id: true,
      shopDomain: true,
      shopifyProductId: true,
    },
  });
  const shopDomains = Array.from(
    new Set(
      [
        normalizeText(shopDomain),
        ...products.map((product) => normalizeText(product.shopDomain)),
      ].filter(Boolean),
    ),
  );
  const primaryShopDomain =
    shopDomains[0] ||
    normalizeText(env.SHOPIFY_PRIMARY_SHOP_DOMAIN) ||
    "GLOBAL";
  if (
    primaryShopDomain !== "GLOBAL" &&
    !shopDomains.includes(primaryShopDomain)
  ) {
    shopDomains.push(primaryShopDomain);
  }
  let operationalControl = null;

  if (prismaClient?.operationalControl?.create) {
    const activeKey = buildOperationalControlActiveKey({
      shopDomain: primaryShopDomain,
      controlType: OPERATIONAL_CONTROL_TYPE.PURCHASE_STOP,
    });
    try {
      operationalControl = await prismaClient.operationalControl.create({
        data: {
          activeKey,
          shopDomain: primaryShopDomain,
          controlType: OPERATIONAL_CONTROL_TYPE.PURCHASE_STOP,
          state: OPERATIONAL_CONTROL_STATE.ACTIVATING,
          reasonCode: "EMERGENCY_PURCHASE_STOP",
          reasonText: normalizedReason,
          requestedByUserId: normalizedActor,
          activatedByUserId: normalizedActor,
          preControlSnapshotJson: {
            productIds: products.map((product) => product.id),
            shopDomains,
            capturedAt: now.toISOString(),
          },
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      operationalControl = await prismaClient.operationalControl.findFirst({
        where: { activeKey },
      });
      return {
        ok: false,
        reason: "purchase_stop_already_active",
        operationalControl,
      };
    }
  }

  const holdResult = await setPlatformCheckoutHold(
    {
      hold: true,
      reason: normalizedReason,
      changedBy: normalizedActor,
      metadataJson: {
        phase: "unpublishing",
        startedAt: now.toISOString(),
        operationalControlId: operationalControl?.id || null,
      },
    },
    { prismaClient, now },
  );
  if (!holdResult.ok) {
    if (operationalControl) {
      await prismaClient.operationalControl.update({
        where: { id: operationalControl.id },
        data: {
          state: OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE,
          lastVerifiedAt: now,
          metadataJson: {
            failureStage: "persist_platform_checkout_hold",
            failureReason: holdResult.reason,
          },
        },
      });
    }
    return { ...holdResult, operationalControl };
  }

  if (operationalControl) {
    await prismaClient.platformOperationalControl.update({
      where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
      data: {
        checkoutControlState: OPERATIONAL_CONTROL_STATE.ACTIVATING,
        activeCheckoutControlId: operationalControl.id,
      },
    });
  }

  let enforce = enforceResourceBoundary;
  let syncPolicy = syncCheckoutPolicy;
  let syncShop = syncShopControl;
  let ensureValidation = ensureCheckoutValidation;
  if ((!enforce && !syncPolicy) || (!syncShop && operationalControl)) {
    const checkoutGate = await import("./marketplaceCheckoutGate.server.js");
    enforce ||= checkoutGate.enforceShopifyResourcePublicationBoundary;
    syncPolicy ||= checkoutGate.syncMarketplaceCheckoutPolicyForProduct;
    syncShop ||= checkoutGate.syncShopOperationalPurchaseControl;
  }
  if (operationalControl && !ensureValidation) {
    const checkoutValidation =
      await import("./shopifyCheckoutValidation.server.js");
    ensureValidation = checkoutValidation.ensureMarketplaceCheckoutValidation;
  }
  const results = [];

  if (operationalControl) {
    if (shopDomains.length === 0) {
      results.push({
        targetType: "SHOP",
        targetId: "UNKNOWN",
        operation: "BLOCK_CHECKOUT",
        ok: false,
        error: "shop_domain_missing_for_emergency_stop",
      });
    }
    for (const targetShopDomain of shopDomains) {
      const startedAt = new Date();
      try {
        const result = await syncShop({
          shopDomain: targetShopDomain,
          state: "BLOCKED",
        });
        const ok = result?.ok !== false;
        results.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          ok,
          result,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "BLOCK_CHECKOUT",
          status: ok ? "SUCCEEDED" : "FAILED",
          startedAt,
          completedAt: new Date(),
          beforeStateJson: { state: result?.beforeState || null },
          afterStateJson: { state: result?.state || null },
          errorCode: ok ? null : result?.reason || "shop_block_failed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          ok: false,
          error: message,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "BLOCK_CHECKOUT",
          status: "FAILED",
          startedAt,
          completedAt: new Date(),
          errorCode: error?.reason || "shop_block_failed",
          errorMessage: message,
        });
      }

      const validationStartedAt = new Date();
      try {
        const validation = await ensureValidation(targetShopDomain);
        const ok = validation?.ok === true && validation?.active === true;
        results.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ENSURE_CHECKOUT_VALIDATION",
          ok,
          result: validation,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ENSURE_CHECKOUT_VALIDATION",
          status: ok ? "SUCCEEDED" : "FAILED",
          startedAt: validationStartedAt,
          completedAt: new Date(),
          afterStateJson: {
            validationId: validation?.validation?.id || null,
            enabled: validation?.validation?.enabled ?? null,
            blockOnFailure: validation?.validation?.blockOnFailure ?? null,
          },
          errorCode: ok
            ? null
            : validation?.reason || "checkout_validation_inactive",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ENSURE_CHECKOUT_VALIDATION",
          ok: false,
          error: message,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ENSURE_CHECKOUT_VALIDATION",
          status: "FAILED",
          startedAt: validationStartedAt,
          completedAt: new Date(),
          errorCode: error?.reason || "checkout_validation_inactive",
          errorMessage: message,
        });
      }
    }
  }

  for (const product of products) {
    const startedAt = new Date();
    try {
      const result = syncPolicy
        ? await syncPolicy(
            {
              localProductId: product.id,
              shopDomain: product.shopDomain,
            },
            { prismaClient },
          )
        : await enforce({
            shopDomain: product.shopDomain,
            resourceId: product.shopifyProductId,
          });
      const ok = result?.ok !== false;
      results.push({
        targetType: "PRODUCT",
        targetId: product.id,
        productId: product.id,
        ok,
        result,
      });
      if (operationalControl) {
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "PRODUCT",
          targetId: product.id,
          operation: "BLOCK_PURCHASE_AND_UNPUBLISH",
          status: ok ? "SUCCEEDED" : "FAILED",
          startedAt,
          completedAt: new Date(),
          beforeStateJson: {
            shopifyProductId: product.shopifyProductId,
            shopDomain: product.shopDomain,
            publicationIds:
              result?.boundary?.publicationIds || result?.publicationIds || [],
          },
          afterStateJson: {
            policy: result?.policy || "MARKETPLACE_GOVERNED",
            remainingPublicationIds:
              result?.boundary?.remainingPublicationIds ||
              result?.remainingPublicationIds ||
              [],
          },
          errorCode: ok ? null : result?.reason || "product_block_failed",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        targetType: "PRODUCT",
        targetId: product.id,
        productId: product.id,
        ok: false,
        error: message,
      });
      if (operationalControl) {
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "PRODUCT",
          targetId: product.id,
          operation: "BLOCK_PURCHASE_AND_UNPUBLISH",
          status: "FAILED",
          startedAt,
          completedAt: new Date(),
          beforeStateJson: {
            shopifyProductId: product.shopifyProductId,
            shopDomain: product.shopDomain,
          },
          errorCode: error?.reason || "product_block_failed",
          errorMessage: message,
        });
      }
    }
  }

  const failures = results.filter((result) => !result.ok);
  const finalState =
    failures.length === 0
      ? OPERATIONAL_CONTROL_STATE.ACTIVE
      : OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE;
  const existingMetadata = asMetadataObject(holdResult.control?.metadataJson);
  const control = await prismaClient.platformOperationalControl.update({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
    data: {
      checkoutControlState: finalState,
      activeCheckoutControlId: operationalControl?.id || null,
      metadataJson: {
        ...existingMetadata,
        checkoutEnforcement: {
          phase: failures.length === 0 ? "secured" : "partial_failure",
          completedAt: new Date().toISOString(),
          productCount: results.length,
          failureCount: failures.length,
          failures: failures.slice(0, 20),
        },
      },
    },
  });

  if (operationalControl) {
    operationalControl = await prismaClient.operationalControl.update({
      where: { id: operationalControl.id },
      data: {
        state: finalState,
        activatedAt: failures.length === 0 ? new Date() : null,
        lastVerifiedAt: new Date(),
        metadataJson: {
          productCount: products.length,
          shopCount: shopDomains.length,
          failureCount: failures.length,
          failures: failures.slice(0, 20),
        },
      },
    });
  }

  return {
    ok: failures.length === 0,
    reason:
      failures.length === 0 ? null : "publication_boundary_partial_failure",
    control,
    operationalControl,
    productCount: results.length,
    failureCount: failures.length,
    results,
  };
}

async function upsertOperationalExecution(prismaClient, values) {
  if (!prismaClient?.operationalControlExecution?.upsert) return null;
  const unique = {
    controlId_targetSystem_targetType_targetId_operation: {
      controlId: values.controlId,
      targetSystem: values.targetSystem,
      targetType: values.targetType,
      targetId: values.targetId,
      operation: values.operation,
    },
  };
  const data = {
    status: values.status,
    attemptCount: { increment: 1 },
    errorCode: values.errorCode || null,
    errorMessage: normalizeText(values.errorMessage)?.slice(0, 1000) || null,
    startedAt: values.startedAt || null,
    completedAt: values.completedAt || null,
    beforeStateJson: values.beforeStateJson || undefined,
    afterStateJson: values.afterStateJson || undefined,
  };
  return prismaClient.operationalControlExecution.upsert({
    where: unique,
    create: {
      controlId: values.controlId,
      targetSystem: values.targetSystem,
      targetType: values.targetType,
      targetId: values.targetId,
      operation: values.operation,
      status: values.status,
      attemptCount: 1,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      beforeStateJson: values.beforeStateJson || undefined,
      afterStateJson: values.afterStateJson || undefined,
    },
    update: data,
  });
}

export async function recoverPlatformCheckoutEmergencyHold(
  { reason, changedBy, releaseEvidenceReference },
  {
    prismaClient = prisma,
    syncShopControl = null,
    clearSharedWatchdogVeto = null,
    syncCheckoutPolicy = null,
    restorePublications = null,
    inspectCheckoutValidation = null,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const normalizedActor = normalizeText(changedBy);
  const normalizedReason = normalizeText(reason);
  const normalizedEvidence = normalizeText(releaseEvidenceReference);
  if (!normalizedActor || !normalizedReason || !normalizedEvidence) {
    return { ok: false, reason: "recovery_evidence_and_actor_required" };
  }
  if (!prismaClient?.operationalControl?.findFirst) {
    return setPlatformCheckoutHold(
      {
        hold: false,
        reason,
        changedBy,
        releaseEvidenceReference,
      },
      { prismaClient, now },
    );
  }

  let operationalControl = await prismaClient.operationalControl.findFirst({
    where: {
      controlType: OPERATIONAL_CONTROL_TYPE.PURCHASE_STOP,
      activeKey: { not: null },
      state: {
        in: [
          OPERATIONAL_CONTROL_STATE.ACTIVE,
          OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE,
          OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
        ],
      },
    },
    orderBy: { requestedAt: "desc" },
  });
  if (!operationalControl) {
    return { ok: false, reason: "active_purchase_stop_not_found" };
  }
  if (
    operationalControl.requestedByUserId === normalizedActor ||
    operationalControl.activatedByUserId === normalizedActor
  ) {
    return {
      ok: false,
      reason: "independent_release_approval_required",
      activatingActor:
        operationalControl.activatedByUserId ||
        operationalControl.requestedByUserId,
    };
  }

  const recoveryRequested = await prismaClient.operationalControl.updateMany({
    where: {
      id: operationalControl.id,
      revision: operationalControl.revision,
      state: operationalControl.state,
    },
    data: {
      state: OPERATIONAL_CONTROL_STATE.RECOVERY_REQUESTED,
      recoveryRequestedByUserId: normalizedActor,
      recoveryRequestedAt: now,
      revision: { increment: 1 },
      recoveryEvidenceJson: {
        reference: normalizedEvidence,
        reason: normalizedReason,
      },
    },
  });
  if (recoveryRequested.count !== 1) {
    return { ok: false, reason: "purchase_stop_recovery_conflict" };
  }
  operationalControl = await prismaClient.operationalControl.findUnique({
    where: { id: operationalControl.id },
  });
  const recovering = await prismaClient.operationalControl.updateMany({
    where: {
      id: operationalControl.id,
      revision: operationalControl.revision,
      state: OPERATIONAL_CONTROL_STATE.RECOVERY_REQUESTED,
      recoveryRequestedByUserId: normalizedActor,
    },
    data: {
      state: OPERATIONAL_CONTROL_STATE.RECOVERING,
      revision: { increment: 1 },
    },
  });
  if (recovering.count !== 1) {
    return { ok: false, reason: "purchase_stop_recovery_conflict" };
  }
  operationalControl = await prismaClient.operationalControl.findUnique({
    where: { id: operationalControl.id },
  });
  await prismaClient.platformOperationalControl.update({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
    data: {
      checkoutControlState: OPERATIONAL_CONTROL_STATE.RECOVERING,
    },
  });

  const checkoutGate = await import("./marketplaceCheckoutGate.server.js");
  const saleEligibility = await import("./saleEligibility.server.js");
  const checkoutValidation =
    await import("./shopifyCheckoutValidation.server.js");
  const syncShop =
    syncShopControl || checkoutGate.syncShopOperationalPurchaseControl;
  const clearWatchdogVeto =
    clearSharedWatchdogVeto ||
    checkoutGate.clearSharedWatchdogPurchaseVeto;
  const syncPolicy =
    syncCheckoutPolicy || checkoutGate.syncMarketplaceCheckoutPolicyForProduct;
  const restore =
    restorePublications || checkoutGate.restoreShopifyResourcePublications;
  const inspectValidation =
    inspectCheckoutValidation ||
    checkoutValidation.inspectMarketplaceCheckoutValidation;
  const products = await prismaClient.product.findMany({
    where: {
      shopifyProductId: { not: null },
      vendorStore: {
        is: { isTestStore: false },
      },
    },
    include: saleEligibility.SALE_ELIGIBILITY_PRODUCT_INCLUDE,
  });
  const previousSnapshot = asMetadataObject(
    operationalControl.preControlSnapshotJson,
  );
  const shopDomains = Array.from(
    new Set(
      [
        normalizeText(operationalControl.shopDomain),
        ...(Array.isArray(previousSnapshot.shopDomains)
          ? previousSnapshot.shopDomains
          : []
        ).map(normalizeText),
        ...products.map((product) => normalizeText(product.shopDomain)),
      ].filter((value) => value && value !== "GLOBAL"),
    ),
  );
  const results = [];
  const failures = [];
  if (shopDomains.length === 0) {
    failures.push({
      targetType: "SHOP",
      targetId: "UNKNOWN",
      ok: false,
      error: "shop_domain_missing_for_recovery",
    });
  }
  for (const targetShopDomain of shopDomains) {
    const startedAt = new Date();
    try {
      const status = await inspectValidation(targetShopDomain);
      const ok = status?.ok === true && status?.active === true;
      if (!ok) {
        failures.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          ok: false,
          error: status?.reason || "checkout_validation_inactive",
        });
      }
      await upsertOperationalExecution(prismaClient, {
        controlId: operationalControl.id,
        targetSystem: "SHOPIFY",
        targetType: "SHOP",
        targetId: targetShopDomain,
        operation: "VERIFY_CHECKOUT_VALIDATION_FOR_RECOVERY",
        status: ok ? "SUCCEEDED" : "FAILED",
        startedAt,
        completedAt: new Date(),
        afterStateJson: {
          validationId: status?.validation?.id || null,
          active: status?.active === true,
        },
        errorCode: ok ? null : status?.reason || "checkout_validation_inactive",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        targetType: "SHOP",
        targetId: targetShopDomain,
        ok: false,
        error: message,
      });
      await upsertOperationalExecution(prismaClient, {
        controlId: operationalControl.id,
        targetSystem: "SHOPIFY",
        targetType: "SHOP",
        targetId: targetShopDomain,
        operation: "VERIFY_CHECKOUT_VALIDATION_FOR_RECOVERY",
        status: "FAILED",
        startedAt,
        completedAt: new Date(),
        errorCode: error?.reason || "checkout_validation_inactive",
        errorMessage: message,
      });
    }
  }
  const previousExecutions =
    await prismaClient.operationalControlExecution.findMany({
      where: {
        controlId: operationalControl.id,
        targetType: "PRODUCT",
        operation: "BLOCK_PURCHASE_AND_UNPUBLISH",
      },
    });
  const previousByProduct = new Map(
    previousExecutions.map((entry) => [entry.targetId, entry]),
  );
  const evaluations = await saleEligibility.evaluateProductsForRecovery(
    products,
    {
      prismaClient,
      env,
      operationalControl: {
        checkoutHold: false,
        checkoutControlState: "RECOVERING",
      },
      evaluatedAt: now,
    },
  );
  if (failures.length === 0) {
    for (const { product, result: evaluation } of evaluations) {
      const previous = previousByProduct.get(product.id);
      const publicationIds = Array.isArray(
        previous?.beforeStateJson?.publicationIds,
      )
        ? previous.beforeStateJson.publicationIds
        : [];
      const startedAt = new Date();
      if (!evaluation.allowed) {
        results.push({
          productId: product.id,
          ok: true,
          restored: false,
          skipped: true,
          reasonCodes: evaluation.reasonCodes,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "PRODUCT",
          targetId: product.id,
          operation: "RESTORE_AFTER_REEVALUATION",
          status: "SKIPPED",
          startedAt,
          completedAt: new Date(),
          afterStateJson: {
            eligibility: evaluation,
            publicationIds: [],
          },
        });
        continue;
      }

      try {
        const policy = checkoutGate.resolveMarketplaceCheckoutPolicy(product);
        const policyResult = await syncPolicy(
          { product, shopDomain: product.shopDomain },
          {
            prismaClient,
            policyOverride: policy,
            isPlatformCheckoutHoldActiveImpl: async () => false,
          },
        );
        const publicationResult = await restore({
          shopDomain: product.shopDomain,
          resourceId: product.shopifyProductId,
          publicationIds,
        });
        const ok =
          policyResult?.ok !== false && publicationResult?.ok !== false;
        results.push({
          productId: product.id,
          ok,
          restored: publicationIds.length > 0,
          evaluation,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "PRODUCT",
          targetId: product.id,
          operation: "RESTORE_AFTER_REEVALUATION",
          status: ok ? "SUCCEEDED" : "FAILED",
          startedAt,
          completedAt: new Date(),
          afterStateJson: {
            eligibility: evaluation,
            policy: policyResult?.policy || policy,
            publicationIds:
              publicationResult?.remainingPublicationIds || publicationIds,
          },
          errorCode: ok
            ? null
            : policyResult?.reason ||
              publicationResult?.reason ||
              "product_recovery_failed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          productId: product.id,
          ok: false,
          restored: false,
          error: message,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "PRODUCT",
          targetId: product.id,
          operation: "RESTORE_AFTER_REEVALUATION",
          status: "FAILED",
          startedAt,
          completedAt: new Date(),
          errorCode: error?.reason || "product_recovery_failed",
          errorMessage: message,
        });
      }
    }
  }
  failures.push(...results.filter((result) => !result.ok));
  if (failures.length === 0) {
    for (const targetShopDomain of shopDomains) {
      const startedAt = new Date();
      try {
        const shopResult = await syncShop({
          shopDomain: targetShopDomain,
          state: "ALLOWED",
        });
        const ok = shopResult?.ok !== false;
        if (!ok) {
          failures.push({
            targetType: "SHOP",
            targetId: targetShopDomain,
            ok: false,
            error: shopResult.reason || "shop_recovery_failed",
          });
        }
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ALLOW_CHECKOUT_AFTER_RECOVERY",
          status: ok ? "SUCCEEDED" : "FAILED",
          startedAt,
          completedAt: new Date(),
          afterStateJson: { state: shopResult?.state || null },
          errorCode: ok ? null : shopResult?.reason || "shop_recovery_failed",
        });
        if (!ok) continue;

        const vetoStartedAt = new Date();
        try {
          const vetoResult = await clearWatchdogVeto({
            shopDomain: targetShopDomain,
          });
          const vetoCleared = vetoResult?.ok !== false;
          if (!vetoCleared) {
            failures.push({
              targetType: "SHOP",
              targetId: targetShopDomain,
              ok: false,
              error:
                vetoResult.reason ||
                "watchdog_purchase_veto_recovery_failed",
            });
          }
          await upsertOperationalExecution(prismaClient, {
            controlId: operationalControl.id,
            targetSystem: "SHOPIFY",
            targetType: "SHOP",
            targetId: targetShopDomain,
            operation: "CLEAR_SHARED_WATCHDOG_VETO_AFTER_RECOVERY",
            status: vetoCleared ? "SUCCEEDED" : "FAILED",
            startedAt: vetoStartedAt,
            completedAt: new Date(),
            afterStateJson: {
              state: vetoResult?.state || null,
            },
            errorCode: vetoCleared
              ? null
              : vetoResult?.reason ||
                "watchdog_purchase_veto_recovery_failed",
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push({
            targetType: "SHOP",
            targetId: targetShopDomain,
            ok: false,
            error: message,
          });
          await upsertOperationalExecution(prismaClient, {
            controlId: operationalControl.id,
            targetSystem: "SHOPIFY",
            targetType: "SHOP",
            targetId: targetShopDomain,
            operation: "CLEAR_SHARED_WATCHDOG_VETO_AFTER_RECOVERY",
            status: "FAILED",
            startedAt: vetoStartedAt,
            completedAt: new Date(),
            errorCode:
              error?.reason ||
              "watchdog_purchase_veto_recovery_failed",
            errorMessage: message,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({
          targetType: "SHOP",
          targetId: targetShopDomain,
          ok: false,
          error: message,
        });
        await upsertOperationalExecution(prismaClient, {
          controlId: operationalControl.id,
          targetSystem: "SHOPIFY",
          targetType: "SHOP",
          targetId: targetShopDomain,
          operation: "ALLOW_CHECKOUT_AFTER_RECOVERY",
          status: "FAILED",
          startedAt,
          completedAt: new Date(),
          errorCode: error?.reason || "shop_recovery_failed",
          errorMessage: message,
        });
      }
    }
  }

  if (failures.length > 0) {
    operationalControl = await prismaClient.operationalControl.update({
      where: { id: operationalControl.id },
      data: {
        state: OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
        lastVerifiedAt: new Date(),
        metadataJson: {
          recoveryFailureCount: failures.length,
          recoveryFailures: failures.slice(0, 20),
        },
      },
    });
    await prismaClient.platformOperationalControl.update({
      where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
      data: {
        checkoutControlState: OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
      },
    });
    return {
      ok: false,
      reason: "purchase_stop_recovery_failed",
      operationalControl,
      results,
      failures,
    };
  }

  const release = await setPlatformCheckoutHold(
    {
      hold: false,
      reason: normalizedReason,
      changedBy: normalizedActor,
      releaseEvidenceReference: normalizedEvidence,
      metadataJson: {
        operationalControlId: operationalControl.id,
        recoveredProductCount: results.filter((result) => result.restored)
          .length,
        skippedProductCount: results.filter((result) => result.skipped).length,
      },
    },
    { prismaClient, now },
  );
  if (!release.ok) return release;

  operationalControl = await prismaClient.operationalControl.update({
    where: { id: operationalControl.id },
    data: {
      activeKey: null,
      state: OPERATIONAL_CONTROL_STATE.RECOVERED,
      recoveredByUserId: normalizedActor,
      recoveredAt: now,
      lastVerifiedAt: now,
      recoveryPlanJson: {
        restoredProductIds: results
          .filter((result) => result.restored)
          .map((result) => result.productId),
        skippedProducts: results
          .filter((result) => result.skipped)
          .map((result) => ({
            productId: result.productId,
            reasonCodes: result.reasonCodes,
          })),
      },
    },
  });
  await prismaClient.platformOperationalControl.update({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
    data: {
      checkoutControlState: "IDLE",
      activeCheckoutControlId: null,
    },
  });

  return {
    ok: true,
    control: release.control,
    operationalControl,
    results,
  };
}

export async function recordOperationalReadinessAttestation(
  {
    checkKey,
    status = OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
    evidenceReference,
    evidenceHash = null,
    notes = null,
    confirmedBy,
    scopeType = "PLATFORM",
    scopeId = "GLOBAL",
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedKey = normalizeUpper(checkKey);
  const definition = ATTESTATION_DEFINITIONS.get(normalizedKey);
  const normalizedStatus = normalizeUpper(status);
  const normalizedReference = normalizeText(evidenceReference);
  const normalizedActor = normalizeText(confirmedBy);
  const normalizedHash = normalizeSha256(evidenceHash);

  if (!definition) return { ok: false, reason: "unknown_check_key" };
  if (
    !Object.values(OPERATIONAL_ATTESTATION_STATUS).includes(normalizedStatus)
  ) {
    return { ok: false, reason: "invalid_status" };
  }
  if (!normalizedActor || !normalizedReference) {
    return { ok: false, reason: "evidence_and_actor_required" };
  }
  if (evidenceHash && !normalizedHash) {
    return { ok: false, reason: "invalid_evidence_hash" };
  }
  const normalizedMetadata = asMetadataObject(metadataJson);
  if (
    normalizedKey === CHECKOUT_VALIDATION_LIVE_PROBE_KEY &&
    !isCompleteCheckoutValidationLiveProbe(normalizedMetadata)
  ) {
    return { ok: false, reason: "checkout_live_probe_manifest_incomplete" };
  }

  const confirmed =
    normalizedStatus === OPERATIONAL_ATTESTATION_STATUS.CONFIRMED;
  const attestation = await prismaClient.operationalReadinessAttestation.upsert(
    {
      where: {
        checkKey_scopeType_scopeId: {
          checkKey: normalizedKey,
          scopeType: normalizeUpper(scopeType) || "PLATFORM",
          scopeId: normalizeText(scopeId) || "GLOBAL",
        },
      },
      create: {
        checkKey: normalizedKey,
        scopeType: normalizeUpper(scopeType) || "PLATFORM",
        scopeId: normalizeText(scopeId) || "GLOBAL",
        status: normalizedStatus,
        evidenceReference: normalizedReference,
        evidenceHash: normalizedHash,
        confirmedBy: normalizedActor,
        confirmedAt: now,
        expiresAt: confirmed ? addDays(now, definition.validityDays) : null,
        notes: normalizeText(notes),
        metadataJson: normalizedMetadata,
      },
      update: {
        status: normalizedStatus,
        evidenceReference: normalizedReference,
        evidenceHash: normalizedHash,
        confirmedBy: normalizedActor,
        confirmedAt: now,
        expiresAt: confirmed ? addDays(now, definition.validityDays) : null,
        notes: normalizeText(notes),
        metadataJson: normalizedMetadata,
      },
    },
  );

  return { ok: true, attestation, definition };
}

export function isCompleteCheckoutValidationLiveProbe(metadataJson) {
  const metadata = asMetadataObject(metadataJson);
  const manifest = asMetadataObject(metadata.releaseManifest);
  const probes = asMetadataObject(metadata.probes);
  const requiredManifestStrings = [
    "releaseId",
    "renderCommit",
    "migrationVersion",
    "shopifyAppVersion",
    "functionHandle",
    "functionUid",
    "functionId",
    "functionApiVersion",
    "validationId",
    "policyVersion",
    "shopDomain",
  ];
  const requiredProbeIds = [
    "directProductAllowed",
    "blockedProductRejected",
    "globalStopRejected",
    "shopPayObserved",
  ];
  return Boolean(
    Number(manifest.projectionSchemaVersion) >= 1 &&
    requiredManifestStrings.every(
      (key) => String(manifest[key] || "").trim().length > 0,
    ) &&
    String(metadata.challengeNonce || "").trim().length >= 16 &&
    String(metadata.executedBy || "").trim().length > 0 &&
    requiredProbeIds.every((probeId) =>
      isCompleteLiveProbeScenario(probes[probeId], probeId),
    ),
  );
}

function isCompleteLiveProbeScenario(value, scenarioId) {
  const probe = asMetadataObject(value);
  const observedAt = new Date(probe.observedAt);
  return Boolean(
    probe.scenarioId === scenarioId &&
    probe.passed === true &&
    String(probe.expectedResult || "").trim() &&
    String(probe.actualResult || "").trim() &&
    String(probe.evidenceReference || "").trim() &&
    String(probe.projectionRevision || "").trim() &&
    Number.isFinite(observedAt.getTime()),
  );
}

export async function inspectOperationalReadiness({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  if (!prismaClient?.operationalReadinessAttestation?.findMany) {
    return {
      available: false,
      definitions: OPERATIONAL_READINESS_DEFINITIONS,
      attestations: [],
      rows: OPERATIONAL_READINESS_DEFINITIONS.map((definition) => ({
        definition,
        attestation: null,
        ready: false,
        reason: "model_unavailable",
      })),
    };
  }

  const attestations =
    await prismaClient.operationalReadinessAttestation.findMany({
      where: {
        scopeType: "PLATFORM",
        scopeId: "GLOBAL",
        checkKey: {
          in: OPERATIONAL_READINESS_DEFINITIONS.map(
            (definition) => definition.key,
          ),
        },
      },
    });
  const byKey = new Map(
    attestations.map((attestation) => [attestation.checkKey, attestation]),
  );
  const rows = OPERATIONAL_READINESS_DEFINITIONS.map((definition) => {
    const attestation = byKey.get(definition.key) || null;
    const expired = Boolean(
      attestation?.expiresAt &&
      attestation.expiresAt.getTime() <= now.getTime(),
    );
    const ready = Boolean(
      attestation?.status === OPERATIONAL_ATTESTATION_STATUS.CONFIRMED &&
      attestation?.evidenceReference &&
      attestation?.confirmedBy &&
      attestation?.confirmedAt &&
      !expired,
    );
    return {
      definition,
      attestation,
      ready,
      reason: !attestation
        ? "missing"
        : expired
          ? "expired"
          : ready
            ? null
            : "not_confirmed",
    };
  });

  return {
    available: true,
    definitions: OPERATIONAL_READINESS_DEFINITIONS,
    attestations,
    rows,
    ready: rows.every((row) => row.ready),
  };
}

export function buildOperationalReadinessChecks({ inspection, control } = {}) {
  const checks = (inspection?.rows || []).map((row) => ({
    id: `operational_attestation_${row.definition.key.toLowerCase()}`,
    category: "operations",
    status: row.ready ? "pass" : "fail",
    title: row.definition.label,
    detail: row.ready
      ? `証跡 ${row.attestation.evidenceReference} / 有効期限 ${row.attestation.expiresAt.toISOString()}`
      : row.reason === "expired"
        ? "確認証跡の有効期限が切れています。"
        : "有効な確認証跡が登録されていません。",
    action: row.ready
      ? ""
      : "本番確認画面で実際の確認を行い、証跡参照と確認者を記録してください。",
  }));

  const checkoutControlState = normalizeUpper(
    control?.checkoutControlState || "IDLE",
  );
  const checkoutControlActive =
    control?.checkoutHold === true || checkoutControlState !== "IDLE";
  checks.push({
    id: "platform_checkout_emergency_hold",
    category: "operations",
    status: checkoutControlActive ? "fail" : "pass",
    title: "販売緊急停止",
    detail: checkoutControlActive
      ? `販売統制 ${checkoutControlState} / ${
          control?.holdReason || "理由未記録"
        }`
      : "販売緊急停止は解除されています。",
    action: checkoutControlActive
      ? "原因を解消し、停止者とは別の管理者が証拠を確認して復旧してください。PARTIAL_FAILUREやRECOVERY_FAILEDでは購入拒否を維持します。"
      : "",
  });

  checks.push({
    id: "platform_automated_email_hold",
    category: "operations",
    status: control?.automatedEmailHold ? "fail" : "pass",
    title: "自動メール緊急停止",
    detail: control?.automatedEmailHold
      ? `自動メール停止中です: ${control.holdReason || "理由未記録"}`
      : "自動メール緊急停止は解除されています。",
    action: control?.automatedEmailHold
      ? "原因を解消し、停止者とは別の管理者が復旧証拠を確認して解除してください。"
      : "",
  });

  const classHoldChecks = [
    {
      id: "platform_order_email_hold",
      field: "orderEmailHold",
      title: "注文メール緊急停止",
    },
    {
      id: "platform_legal_email_hold",
      field: "legalEmailHold",
      title: "法務メール緊急保留",
    },
    {
      id: "platform_security_email_hold",
      field: "securityEmailHold",
      title: "セキュリティメール緊急停止",
    },
  ];
  for (const item of classHoldChecks) {
    const active = control?.[item.field] === true;
    checks.push({
      id: item.id,
      category: "operations",
      status: active ? "fail" : "pass",
      title: item.title,
      detail: active
        ? `${item.title}中です: ${control?.holdReason || "理由未記録"}`
        : `${item.title}は解除されています。`,
      action: active
        ? "原因を解消し、停止者とは別の管理者が復旧証拠を確認して解除してください。"
        : "",
    });
  }

  return checks;
}

export function createEvidenceKey(prefix, values) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex");
  return `${prefix}:${digest}`;
}
