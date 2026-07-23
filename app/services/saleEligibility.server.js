import crypto from "node:crypto";

import prisma from "../db.server.js";
import { evaluateProductDeliveryEligibility } from "../utils/deliveryEligibility.js";
import {
  evaluateProductGovernanceReadiness,
  evaluateSellerGovernanceReadiness,
  getMarketplaceGovernanceConfiguration,
  getSellerAgreementReadinessOptions,
  getShopifyMarketplacePaymentsApproval,
  isMarketplaceGovernanceGateEnabled,
} from "./marketplaceGovernance.server.js";
import { getPlatformOperationalControl } from "./operationalReadiness.server.js";
import { OPERATIONAL_TIMING_DEFAULTS } from "./operationalTimingPolicy.js";

export const SALE_ELIGIBILITY_POLICY_VERSION = "sale-eligibility-2026-07-v1";
export const SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION = 2;
export const SALE_ELIGIBILITY_PROJECTION_TTL_HOURS =
  OPERATIONAL_TIMING_DEFAULTS.projectionTtlMinutes / 60;
const SALE_ELIGIBILITY_PROJECTION_REFRESH_LEAD_MS =
  OPERATIONAL_TIMING_DEFAULTS.catalogSyncCriticalMinutes * 60 * 1000;
const SALE_ELIGIBILITY_PROJECTION_TRANSACTION_ATTEMPTS = 3;

export const SALE_ELIGIBILITY_STATUS = Object.freeze({
  LEGACY_REVIEW_REQUIRED: "LEGACY_REVIEW_REQUIRED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  ELIGIBLE: "ELIGIBLE",
  BLOCKED: "BLOCKED",
  RECALLED: "RECALLED",
  ARCHIVED: "ARCHIVED",
});

export const POST_ORDER_ELIGIBILITY_POLICY = Object.freeze({
  RETROACTIVE_HOLD: "RETROACTIVE_HOLD",
  PROSPECTIVE_ONLY: "PROSPECTIVE_ONLY",
  CHECKOUT_INTEGRITY_ONLY: "CHECKOUT_INTEGRITY_ONLY",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

export const POST_ORDER_ELIGIBILITY_TRIGGER = Object.freeze({
  ORDERS_PAID: "ORDERS_PAID",
  ORDERS_EDITED: "ORDERS_EDITED",
  ORDERS_UPDATED: "ORDERS_UPDATED",
  PERIODIC_RECONCILIATION: "PERIODIC_RECONCILIATION",
});

export const SALE_ELIGIBILITY_CHANNEL = Object.freeze({
  SHOPIFY_STANDARD_CHECKOUT: "SHOPIFY_STANDARD_CHECKOUT",
  DRAFT_ORDER: "DRAFT_ORDER",
  APP_PROXY: "APP_PROXY",
  PUBLIC_API: "PUBLIC_API",
  CARRIER_SERVICE: "CARRIER_SERVICE",
  PUBLICATION_SYNC: "PUBLICATION_SYNC",
  MONITORING: "MONITORING",
});

export const SALE_ELIGIBILITY_PRODUCT_INCLUDE = Object.freeze({
  vendorStore: {
    include: {
      seller: true,
      vendorAuth: { include: { seller: true } },
    },
  },
  countryPolicy: true,
  complianceProfile: true,
  complianceEvidence: {
    include: { requirement: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  },
  complianceDecisions: {
    include: { requirement: true },
    orderBy: { decidedAt: "desc" },
    take: 100,
  },
});

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildProjectionExpiry(evaluatedAt) {
  return new Date(
    evaluatedAt.getTime() +
      OPERATIONAL_TIMING_DEFAULTS.projectionTtlMinutes * 60 * 1000,
  );
}

function projectionArraysEqual(left, right) {
  return JSON.stringify(asArray(left)) === JSON.stringify(asArray(right));
}

function canReuseSaleEligibilityProjection(
  current,
  result,
  evaluatedAt,
  { forceRefresh = false } = {},
) {
  if (!current || forceRefresh) return false;
  const currentExpiresAt = toValidDate(current.expiresAt);
  if (
    !currentExpiresAt ||
    currentExpiresAt.getTime() <=
      evaluatedAt.getTime() + SALE_ELIGIBILITY_PROJECTION_REFRESH_LEAD_MS
  ) {
    return false;
  }

  return (
    String(current.vendorStoreId || "") ===
      String(result.vendorStoreId || "") &&
    String(current.status || "") === String(result.status || "") &&
    String(current.policyVersion || "") ===
      String(result.policyVersion || "") &&
    String(current.inputHash || "") === String(result.inputHash || "") &&
    projectionArraysEqual(current.reasonCodes, result.reasonCodes) &&
    projectionArraysEqual(
      current.requirementVersions,
      result.requirementVersions,
    ) &&
    projectionArraysEqual(current.decisionIds, result.decisionIds)
  );
}

async function runProjectionTransaction(prismaClient, callback) {
  for (
    let attempt = 1;
    attempt <= SALE_ELIGIBILITY_PROJECTION_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await prismaClient.$transaction(callback, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        error?.code !== "P2034" ||
        attempt === SALE_ELIGIBILITY_PROJECTION_TRANSACTION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }

  throw new Error("Sale eligibility projection transaction retry exhausted.");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasRecallBlock(product) {
  return (
    normalizeUpper(product?.complianceProfile?.approvalStatus) === "RECALLED" ||
    asArray(product?.complianceDecisions).some(
      (decision) =>
        normalizeUpper(decision?.decision) === "BLOCKED" &&
        normalizeUpper(decision?.reasonCode).startsWith("RECALL"),
    )
  );
}

function buildInputHash({
  product,
  destinationCountry,
  salesChannel,
  control,
  governanceGateEnabled,
}) {
  const store = product?.vendorStore || null;
  const seller =
    store?.seller || store?.vendorAuth?.seller || product?.seller || null;
  const profile = product?.complianceProfile || null;
  const countryPolicy = product?.countryPolicy || null;

  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        productId: product?.id || null,
        approvalStatus: product?.approvalStatus || null,
        shopifyProductId: product?.shopifyProductId || null,
        productEuStatus: product?.productEuStatus || null,
        store: store
          ? {
              id: store.id,
              isPlatformStore: store.isPlatformStore === true,
              isTestStore: store.isTestStore === true,
            }
          : null,
        seller: seller
          ? {
              id: seller.id,
              status: seller.status,
              euSellerStatus: seller.euSellerStatus,
              updatedAt: seller.updatedAt,
            }
          : null,
        countryPolicy: countryPolicy
          ? {
              allowedCountries: countryPolicy.allowedCountries,
              blockedCountries: countryPolicy.blockedCountries,
              requiresWarningCountries:
                countryPolicy.requiresWarningCountries,
              euSaleStatus: countryPolicy.euSaleStatus,
              warningVersion: countryPolicy.warningVersion,
            }
          : null,
        destinationCountry: normalizeUpper(destinationCountry),
        salesChannel: normalizeUpper(salesChannel),
        checkoutHold: control?.checkoutHold === true,
        checkoutControlState: control?.checkoutControlState || null,
        governanceGateEnabled,
        complianceProfile: profile
          ? {
              legalSellerType: profile.legalSellerType,
              conditionStatus: profile.conditionStatus,
              countryOfOriginCode: profile.countryOfOriginCode,
              customsDescriptionEn: profile.customsDescriptionEn,
              applicabilityStatus: profile.applicabilityStatus,
              verificationLevel: profile.verificationLevel,
              applicabilityReasonCode: profile.applicabilityReasonCode,
              applicabilityReasonText: profile.applicabilityReasonText,
              applicabilitySourceUrl: profile.applicabilitySourceUrl,
              applicabilityDecidedAt: profile.applicabilityDecidedAt,
              applicabilityDecidedBy: profile.applicabilityDecidedBy,
              nextReviewAt: profile.nextReviewAt,
              authenticityConfirmedAt: profile.authenticityConfirmedAt,
              ipRightsConfirmedAt: profile.ipRightsConfirmedAt,
              approvalStatus: profile.approvalStatus,
              updatedAt: profile.updatedAt,
            }
          : null,
        evidence: asArray(product?.complianceEvidence).map((entry) => [
          entry.id,
          entry.status,
          entry.verificationLevel,
          entry.expiresAt,
          entry.reviewDueAt,
          entry.revokedAt,
          entry.requirement?.code,
          entry.requirement?.version,
        ]),
        decisions: asArray(product?.complianceDecisions).map((entry) => [
          entry.id,
          entry.decision,
          entry.reasonCode,
          entry.decidedAt,
          entry.reviewDueAt,
          entry.requirement?.code,
          entry.requirement?.version,
        ]),
      }),
    )
    .digest("hex");
}

export function evaluateSaleEligibilitySnapshot({
  product,
  shopDomain = null,
  vendorStoreId = null,
  destinationCountry = null,
  salesChannel = SALE_ELIGIBILITY_CHANNEL.MONITORING,
  operationalControl = null,
  env = process.env,
  evaluatedAt = new Date(),
} = {}) {
  const reasons = [];
  const governanceGateEnabled = isMarketplaceGovernanceGateEnabled(env);
  const store = product?.vendorStore || null;
  const normalizedChannel =
    normalizeUpper(salesChannel) || SALE_ELIGIBILITY_CHANNEL.MONITORING;
  const normalizedCountry = normalizeUpper(destinationCountry) || "";
  const productGovernance = evaluateProductGovernanceReadiness(product);
  const isThirdPartyProduct = Boolean(
    store &&
    store.isPlatformStore !== true &&
    normalizeUpper(product?.complianceProfile?.legalSellerType || "VENDOR") !==
      "PLATFORM",
  );
  const seller =
    store?.seller || store?.vendorAuth?.seller || product?.seller || null;
  const sellerGovernance = isThirdPartyProduct
    ? evaluateSellerGovernanceReadiness(
        seller ? { ...seller, vendorStore: store } : null,
        getSellerAgreementReadinessOptions(env),
      )
    : { ready: true, reasons: [] };
  const governanceConfiguration = isThirdPartyProduct
    ? getMarketplaceGovernanceConfiguration(env)
    : { ready: true, reasons: [] };
  const shopifyPaymentsApproval = isThirdPartyProduct
    ? getShopifyMarketplacePaymentsApproval(env)
    : { ready: true, reasons: [] };
  const governance = {
    ready:
      productGovernance.ready &&
      sellerGovernance.ready &&
      governanceConfiguration.ready &&
      shopifyPaymentsApproval.ready,
    reasons: unique([
      ...productGovernance.reasons,
      ...sellerGovernance.reasons,
      ...governanceConfiguration.reasons,
      ...shopifyPaymentsApproval.reasons,
    ]),
  };
  const delivery = normalizedCountry
    ? evaluateProductDeliveryEligibility({
        product,
        seller:
          store?.seller || store?.vendorAuth?.seller || product?.seller || null,
        deliveryCountry: normalizedCountry,
      })
    : null;

  if (!product?.id) reasons.push("PRODUCT_NOT_FOUND");
  if (operationalControl?.checkoutHold === true) {
    reasons.push("GLOBAL_PURCHASE_STOP_ACTIVE");
  }
  if (
    [
      "REQUESTED",
      "ACTIVATING",
      "PARTIAL_FAILURE",
      "ACTIVE",
      "RECOVERY_REQUESTED",
      "RECOVERY_FAILED",
    ].includes(normalizeUpper(operationalControl?.checkoutControlState))
  ) {
    reasons.push("PURCHASE_CONTROL_NOT_RECOVERED");
  }
  if (store?.isTestStore === true) reasons.push("TEST_STORE");
  if (product?.approvalStatus !== "approved") {
    reasons.push("PRODUCT_NOT_APPROVED");
  }
  if (!normalizeText(product?.shopifyProductId)) {
    reasons.push("SHOPIFY_PRODUCT_NOT_LINKED");
  }
  if (
    normalizedChannel !== SALE_ELIGIBILITY_CHANNEL.MONITORING &&
    store &&
    store.isPlatformStore !== true &&
    String(env.PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED || "").toLowerCase() !==
      "true"
  ) {
    reasons.push("THIRD_PARTY_CHECKOUT_DISABLED");
  }
  if (hasRecallBlock(product)) reasons.push("PRODUCT_RECALLED");
  if (
    normalizeUpper(product?.complianceProfile?.approvalStatus) === "HOLD" ||
    governance.reasons.includes("product_compliance_blocked")
  ) {
    reasons.push("COMPLIANCE_BLOCK_ACTIVE");
  }
  if (delivery && !delivery.isAvailable) {
    reasons.push(
      `DELIVERY_${normalizeUpper(delivery.reason || delivery.status)}`,
    );
  }

  const hardReasons = unique(reasons);
  let status;
  let allowed;

  if (hardReasons.includes("PRODUCT_RECALLED")) {
    status = SALE_ELIGIBILITY_STATUS.RECALLED;
    allowed = false;
  } else if (hardReasons.length > 0) {
    status = SALE_ELIGIBILITY_STATUS.BLOCKED;
    allowed = false;
  } else if (!governance.ready && governanceGateEnabled) {
    status = SALE_ELIGIBILITY_STATUS.REVIEW_REQUIRED;
    allowed = false;
    hardReasons.push(
      ...governance.reasons.map((reason) => normalizeUpper(reason)),
    );
  } else if (!governance.ready) {
    status = SALE_ELIGIBILITY_STATUS.LEGACY_REVIEW_REQUIRED;
    allowed = store?.isPlatformStore === true;
    hardReasons.push(
      ...governance.reasons.map((reason) => normalizeUpper(reason)),
    );
  } else {
    status = SALE_ELIGIBILITY_STATUS.ELIGIBLE;
    allowed = true;
  }

  const currentDecisions = asArray(product?.complianceDecisions).filter(
    (decision) =>
      !decision.reviewDueAt ||
      new Date(decision.reviewDueAt).getTime() > evaluatedAt.getTime(),
  );
  const requirementVersions = unique([
    ...asArray(product?.complianceEvidence).map((entry) =>
      entry.requirement
        ? `${entry.requirement.code}:${entry.requirement.version || "v1"}`
        : null,
    ),
    ...currentDecisions.map((entry) =>
      entry.requirement
        ? `${entry.requirement.code}:${entry.requirement.version || "v1"}`
        : null,
    ),
  ]);
  const result = {
    allowed,
    status,
    reasonCodes: unique(hardReasons),
    requirementVersions,
    decisionIds: currentDecisions.map((entry) => entry.id).filter(Boolean),
    policyVersion: SALE_ELIGIBILITY_POLICY_VERSION,
    evaluatedAt: evaluatedAt.toISOString(),
    expiresAt: buildProjectionExpiry(evaluatedAt).toISOString(),
    projectionRevision: null,
    shopDomain: normalizeText(shopDomain || product?.shopDomain),
    productId: product?.id || null,
    vendorStoreId: vendorStoreId || store?.id || product?.vendorStoreId || null,
    destinationCountry: normalizedCountry,
    salesChannel: normalizedChannel,
    governanceGateEnabled,
  };

  return {
    ...result,
    inputHash: buildInputHash({
      product,
      destinationCountry: normalizedCountry,
      salesChannel: normalizedChannel,
      control: operationalControl,
      governanceGateEnabled,
    }),
  };
}

export async function persistSaleEligibilityProjection(
  result,
  {
    prismaClient = prisma,
    evaluatedAt = new Date(result?.evaluatedAt || Date.now()),
    forceRefresh = false,
  } = {},
) {
  if (
    !result?.productId ||
    !result?.shopDomain ||
    !prismaClient?.saleEligibilityProjection?.upsert
  ) {
    return null;
  }

  const expiresAt = new Date(
    result.expiresAt || buildProjectionExpiry(evaluatedAt),
  );
  const persist = async (tx) => {
    const uniqueWhere = {
      shopDomain_productId_destinationCountry_salesChannel: {
        shopDomain: result.shopDomain,
        productId: result.productId,
        destinationCountry: result.destinationCountry || "",
        salesChannel: result.salesChannel,
      },
    };
    const current = tx.saleEligibilityProjection.findUnique
      ? await tx.saleEligibilityProjection.findUnique({
          where: uniqueWhere,
          select: {
            id: true,
            shopDomain: true,
            productId: true,
            vendorStoreId: true,
            destinationCountry: true,
            salesChannel: true,
            status: true,
            reasonCodes: true,
            requirementVersions: true,
            decisionIds: true,
            policyVersion: true,
            inputHash: true,
            projectionRevision: true,
            evaluatedAt: true,
            expiresAt: true,
          },
        })
      : null;
    if (
      canReuseSaleEligibilityProjection(current, result, evaluatedAt, {
        forceRefresh,
      })
    ) {
      return { projection: current, reused: true };
    }

    const projection = await tx.saleEligibilityProjection.upsert({
      where: uniqueWhere,
      create: {
        shopDomain: result.shopDomain,
        productId: result.productId,
        vendorStoreId: result.vendorStoreId,
        destinationCountry: result.destinationCountry || "",
        salesChannel: result.salesChannel,
        status: result.status,
        reasonCodes: result.reasonCodes,
        requirementVersions: result.requirementVersions,
        decisionIds: result.decisionIds,
        policyVersion: result.policyVersion,
        inputHash: result.inputHash,
        projectionRevision: 1,
        evaluatedAt,
        expiresAt,
      },
      update: {
        vendorStoreId: result.vendorStoreId,
        status: result.status,
        reasonCodes: result.reasonCodes,
        requirementVersions: result.requirementVersions,
        decisionIds: result.decisionIds,
        policyVersion: result.policyVersion,
        inputHash: result.inputHash,
        projectionRevision: { increment: 1 },
        evaluatedAt,
        expiresAt,
      },
    });

    if (tx.saleEligibilityProjectionRevision?.create) {
      await tx.saleEligibilityProjectionRevision.create({
        data: {
          shopDomain: projection.shopDomain,
          productId: projection.productId,
          vendorStoreId: projection.vendorStoreId,
          destinationCountry: projection.destinationCountry,
          salesChannel: projection.salesChannel,
          status: projection.status,
          reasonCodes: projection.reasonCodes,
          requirementVersions: projection.requirementVersions,
          decisionIds: projection.decisionIds,
          policyVersion: projection.policyVersion,
          inputHash: projection.inputHash,
          projectionRevision: projection.projectionRevision,
          evaluatedAt: projection.evaluatedAt,
          expiresAt: projection.expiresAt,
        },
      });
    }
    return { projection, reused: false };
  };
  const outcome =
    prismaClient.saleEligibilityProjectionRevision?.create &&
    prismaClient.$transaction
      ? await runProjectionTransaction(prismaClient, persist)
      : await persist(prismaClient);
  const projection = outcome.projection;
  const persistedEvaluatedAt =
    toValidDate(projection.evaluatedAt) || evaluatedAt;
  const persistedExpiresAt = toValidDate(projection.expiresAt) || expiresAt;

  return {
    ...result,
    projectionRevision: projection.projectionRevision,
    evaluatedAt: persistedEvaluatedAt.toISOString(),
    expiresAt: persistedExpiresAt.toISOString(),
    projectionReused: outcome.reused,
  };
}

export async function evaluateSaleEligibility(
  {
    shopDomain = null,
    productId,
    vendorStoreId = null,
    destinationCountry = null,
    salesChannel = SALE_ELIGIBILITY_CHANNEL.MONITORING,
    evaluatedAt = new Date(),
    persist = true,
  },
  { prismaClient = prisma, env = process.env, operationalControl = null } = {},
) {
  const [product, control] = await Promise.all([
    prismaClient.product.findUnique({
      where: { id: productId },
      include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
    }),
    operationalControl
      ? Promise.resolve(operationalControl)
      : getPlatformOperationalControl({ prismaClient }),
  ]);
  const result = evaluateSaleEligibilitySnapshot({
    product,
    shopDomain,
    vendorStoreId,
    destinationCountry,
    salesChannel,
    operationalControl: control,
    env,
    evaluatedAt,
  });

  if (
    persist &&
    product?.id &&
    result.shopDomain &&
    prismaClient.saleEligibilityProjection?.upsert
  ) {
    const projection = await persistSaleEligibilityProjection(result, {
      prismaClient,
      evaluatedAt,
    });
    if (projection) return projection;
  }

  return result;
}

const PAID_ORDER_ALLOWED_STATUSES = new Set([
  SALE_ELIGIBILITY_STATUS.ELIGIBLE,
  SALE_ELIGIBILITY_STATUS.LEGACY_REVIEW_REQUIRED,
]);

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildPaidOrderEvidenceFailure(productId, code, details = {}) {
  return {
    productId: productId || null,
    code,
    ...details,
  };
}

const RETROACTIVE_REASON_PATTERNS = [
  "RECALL",
  "COUNTERFEIT",
  "SERIOUS_SAFETY",
  "SAFETY_RISK",
  "PROHIBITED",
  "BANNED",
  "SALE_PROHIBITION",
  "LEGAL_ORDER",
];

const PROSPECTIVE_REASON_CODES = new Set([
  "GLOBAL_PURCHASE_STOP_ACTIVE",
  "PURCHASE_CONTROL_NOT_RECOVERED",
  "THIRD_PARTY_CHECKOUT_DISABLED",
  "TEST_STORE",
  "SHOPIFY_PRODUCT_NOT_LINKED",
]);

const CHECKOUT_INTEGRITY_REASON_CODES = new Set([
  "PRODUCT_NOT_FOUND",
  "PRODUCT_NOT_APPROVED",
]);

function getProductDecisionReasonCodes(product, now = new Date()) {
  const nowTime = toValidDate(now)?.getTime() ?? Date.now();
  return unique(
    asArray(product?.complianceDecisions)
      .filter(
        (decision) =>
          normalizeUpper(decision?.decision) === "BLOCKED" &&
          (!decision?.reviewDueAt ||
            new Date(decision.reviewDueAt).getTime() > nowTime),
      )
      .map((decision) => normalizeUpper(decision?.reasonCode)),
  );
}

function hasRetroactiveReason(reasonCodes) {
  return reasonCodes.some((reasonCode) =>
    RETROACTIVE_REASON_PATTERNS.some((pattern) =>
      normalizeUpper(reasonCode).includes(pattern),
    ),
  );
}

export function classifyPostOrderEligibilityPolicy({
  reasonCodes = [],
  decisionReasonCodes = [],
  triggerType = POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_PAID,
} = {}) {
  const normalizedReasons = unique([
    ...reasonCodes.map(normalizeUpper),
    ...decisionReasonCodes.map(normalizeUpper),
  ]);

  if (hasRetroactiveReason(normalizedReasons)) {
    return POST_ORDER_ELIGIBILITY_POLICY.RETROACTIVE_HOLD;
  }

  const normalizedTrigger = normalizeUpper(triggerType);
  if (normalizedTrigger === POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_EDITED) {
    return normalizedReasons.length > 0
      ? POST_ORDER_ELIGIBILITY_POLICY.CHECKOUT_INTEGRITY_ONLY
      : POST_ORDER_ELIGIBILITY_POLICY.MANUAL_REVIEW;
  }

  if (normalizedTrigger === POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_UPDATED) {
    const onlyInfrastructureReasons = normalizedReasons.every((reasonCode) =>
      PROSPECTIVE_REASON_CODES.has(reasonCode),
    );
    if (!onlyInfrastructureReasons) {
      return POST_ORDER_ELIGIBILITY_POLICY.CHECKOUT_INTEGRITY_ONLY;
    }
  }

  if (
    normalizedReasons.length > 0 &&
    normalizedReasons.every((reasonCode) =>
      PROSPECTIVE_REASON_CODES.has(reasonCode),
    )
  ) {
    return POST_ORDER_ELIGIBILITY_POLICY.PROSPECTIVE_ONLY;
  }

  if (
    normalizedReasons.length > 0 &&
    normalizedReasons.every((reasonCode) =>
      CHECKOUT_INTEGRITY_REASON_CODES.has(reasonCode),
    )
  ) {
    return POST_ORDER_ELIGIBILITY_POLICY.CHECKOUT_INTEGRITY_ONLY;
  }

  return POST_ORDER_ELIGIBILITY_POLICY.MANUAL_REVIEW;
}

function getEligibilityBlockEffectiveAt({
  product,
  operationalControl,
  reasonCodes,
  now,
}) {
  const normalizedReasons = reasonCodes.map(normalizeUpper);
  const candidates = [];

  if (
    normalizedReasons.some(
      (reasonCode) =>
        reasonCode === "GLOBAL_PURCHASE_STOP_ACTIVE" ||
        reasonCode === "PURCHASE_CONTROL_NOT_RECOVERED",
    )
  ) {
    candidates.push(operationalControl?.updatedAt);
  }

  candidates.push(
    product?.complianceProfile?.updatedAt,
    ...asArray(product?.complianceDecisions).map(
      (decision) => decision?.decidedAt || decision?.createdAt,
    ),
    product?.updatedAt,
  );

  return (
    candidates
      .map(toValidDate)
      .filter(Boolean)
      .sort((left, right) => right.getTime() - left.getTime())[0] ||
    toValidDate(now)
  );
}

export async function inspectPaidOrderSaleEligibility(
  {
    shopDomain,
    matchedLines = [],
    orderOccurredAt,
    destinationCountry = "",
    triggerType = POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_PAID,
    verifyOrderTimeProjection = true,
  },
  {
    prismaClient = prisma,
    env = process.env,
    operationalControl = null,
    now = new Date(),
  } = {},
) {
  const sourceProductsById = new Map(
    matchedLines
      .map((entry) => entry?.product)
      .filter((product) => product?.id)
      .map((product) => [product.id, product]),
  );
  const productIds = [...sourceProductsById.keys()];
  const normalizedShopDomain = normalizeText(shopDomain);
  const occurredAt = toValidDate(orderOccurredAt);

  if (!normalizedShopDomain || !occurredAt || productIds.length === 0) {
    return {
      ok: false,
      reason: "paid_order_eligibility_input_invalid",
      failures: [
        buildPaidOrderEvidenceFailure(
          productIds[0] || null,
          "PAID_ORDER_ELIGIBILITY_INPUT_INVALID",
        ),
      ],
      evidence: [],
    };
  }

  if (!prismaClient?.saleEligibilityProjection?.findMany) {
    return {
      ok: false,
      reason: "sale_eligibility_projection_unavailable",
      failures: productIds.map((productId) =>
        buildPaidOrderEvidenceFailure(
          productId,
          "SALE_ELIGIBILITY_PROJECTION_UNAVAILABLE",
        ),
      ),
      evidence: [],
    };
  }

  const revisionHistoryAvailable = Boolean(
    prismaClient?.saleEligibilityProjectionRevision?.findMany,
  );
  const [control, projections, eligibilityProducts] = await Promise.all([
    operationalControl
      ? Promise.resolve(operationalControl)
      : getPlatformOperationalControl({ prismaClient }),
    revisionHistoryAvailable
      ? prismaClient.saleEligibilityProjectionRevision.findMany({
          where: {
            shopDomain: normalizedShopDomain,
            productId: { in: productIds },
            destinationCountry: "",
            salesChannel:
              SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
            evaluatedAt: { lte: occurredAt },
            expiresAt: { gt: occurredAt },
          },
          select: {
            id: true,
            productId: true,
            status: true,
            policyVersion: true,
            inputHash: true,
            projectionRevision: true,
            evaluatedAt: true,
            expiresAt: true,
          },
          orderBy: [
            { evaluatedAt: "desc" },
            { projectionRevision: "desc" },
          ],
        })
      : prismaClient.saleEligibilityProjection.findMany({
          where: {
            shopDomain: normalizedShopDomain,
            productId: { in: productIds },
            destinationCountry: "",
            salesChannel:
              SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
          },
          select: {
            id: true,
            productId: true,
            status: true,
            policyVersion: true,
            inputHash: true,
            projectionRevision: true,
            evaluatedAt: true,
            expiresAt: true,
          },
        }),
    prismaClient?.product?.findMany
      ? prismaClient.product.findMany({
          where: { id: { in: productIds } },
          include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
        })
      : Promise.resolve([...sourceProductsById.values()]),
  ]);
  const productsById = new Map(
    eligibilityProducts.map((product) => [product.id, product]),
  );
  const projectionByProductId = new Map();
  for (const projection of projections) {
    if (!projectionByProductId.has(projection.productId)) {
      projectionByProductId.set(projection.productId, projection);
    }
  }
  const failures = [];
  const evidence = [];

  for (const productId of productIds) {
    const product = productsById.get(productId);
    const projection = projectionByProductId.get(productId) || null;
    const current = evaluateSaleEligibilitySnapshot({
      product,
      shopDomain: normalizedShopDomain,
      vendorStoreId: product?.vendorStoreId,
      destinationCountry,
      salesChannel: SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
      operationalControl: control,
      env,
      evaluatedAt: now,
    });

    if (!product) {
      failures.push(
        buildPaidOrderEvidenceFailure(
          productId,
          "CURRENT_PRODUCT_MAPPING_MISSING",
        ),
      );
      continue;
    }

    if (verifyOrderTimeProjection && !projection) {
      failures.push(
        buildPaidOrderEvidenceFailure(
          productId,
          "ORDER_TIME_PROJECTION_MISSING",
        ),
      );
    }

    const projectionEvaluatedAt = toValidDate(projection?.evaluatedAt);
    const projectionExpiresAt = toValidDate(projection?.expiresAt);
    const projectionStatus = normalizeUpper(projection?.status);
    const projectionValidAtOrderTime = Boolean(
      projectionEvaluatedAt &&
      projectionExpiresAt &&
      projectionEvaluatedAt.getTime() <= occurredAt.getTime() &&
      projectionExpiresAt.getTime() > occurredAt.getTime(),
    );
    const projectionShapeValid = Boolean(
      PAID_ORDER_ALLOWED_STATUSES.has(projectionStatus) &&
      projection?.policyVersion === SALE_ELIGIBILITY_POLICY_VERSION &&
      /^[a-f0-9]{64}$/.test(String(projection?.inputHash || "")) &&
      Number.isInteger(projection?.projectionRevision) &&
      projection.projectionRevision > 0,
    );
    const decisionReasonCodes = getProductDecisionReasonCodes(product, now);
    const postOrderPolicy = classifyPostOrderEligibilityPolicy({
      reasonCodes: current.reasonCodes,
      decisionReasonCodes,
      triggerType,
    });
    const blockEffectiveAt = getEligibilityBlockEffectiveAt({
      product,
      operationalControl: control,
      reasonCodes: current.reasonCodes,
      now,
    });
    const blockWasEffectiveAtOrder = Boolean(
      blockEffectiveAt && blockEffectiveAt.getTime() <= occurredAt.getTime(),
    );

    evidence.push({
      productId,
      projectionRecordId: projection?.id || null,
      projectionSource: revisionHistoryAvailable ? "revision" : "legacy_current",
      status: projectionStatus,
      policyVersion: projection?.policyVersion || null,
      inputHash: projection?.inputHash || null,
      projectionRevision: projection?.projectionRevision || null,
      evaluatedAt: projectionEvaluatedAt?.toISOString() || null,
      expiresAt: projectionExpiresAt?.toISOString() || null,
      currentStatus: current.status,
      currentAllowed: current.allowed === true,
      currentReasonCodes: current.reasonCodes,
      decisionReasonCodes,
      postOrderPolicy,
      blockEffectiveAt: blockEffectiveAt?.toISOString() || null,
      blockWasEffectiveAtOrder,
      triggerType: normalizeUpper(triggerType),
    });

    if (verifyOrderTimeProjection && !projectionShapeValid) {
      failures.push(
        buildPaidOrderEvidenceFailure(
          productId,
          "ORDER_TIME_PROJECTION_INVALID",
          { projectionStatus },
        ),
      );
    } else if (verifyOrderTimeProjection && !projectionValidAtOrderTime) {
      failures.push(
        buildPaidOrderEvidenceFailure(
          productId,
          "ORDER_TIME_PROJECTION_NOT_VALID",
        ),
      );
    }

    const currentBlockRequiresHold =
      current.allowed !== true &&
      (postOrderPolicy === POST_ORDER_ELIGIBILITY_POLICY.RETROACTIVE_HOLD ||
        postOrderPolicy ===
          POST_ORDER_ELIGIBILITY_POLICY.CHECKOUT_INTEGRITY_ONLY ||
        postOrderPolicy === POST_ORDER_ELIGIBILITY_POLICY.MANUAL_REVIEW ||
        blockWasEffectiveAtOrder);

    if (currentBlockRequiresHold) {
      failures.push(
        buildPaidOrderEvidenceFailure(productId, "CURRENT_SALE_BLOCKED", {
          currentStatus: current.status,
          reasonCodes: current.reasonCodes,
          decisionReasonCodes,
          postOrderPolicy,
          blockEffectiveAt: blockEffectiveAt?.toISOString() || null,
          blockWasEffectiveAtOrder,
          triggerType: normalizeUpper(triggerType),
        }),
      );
    }
  }

  return {
    ok: failures.length === 0,
    reason:
      failures.length === 0
        ? null
        : "paid_order_sale_eligibility_review_required",
    failures,
    evidence,
    checkedAt: now.toISOString(),
    triggerType: normalizeUpper(triggerType),
    verifyOrderTimeProjection: verifyOrderTimeProjection === true,
  };
}

export async function inspectDraftOrderSaleEligibility(
  { shopDomain, lines = [], destinationCountry = "" },
  {
    prismaClient = prisma,
    env = process.env,
    operationalControl = null,
    now = new Date(),
  } = {},
) {
  const productIds = unique(
    lines.map((line) =>
      normalizeText(
        line?.lineId || line?.localProductId || line?.localProduct?.id,
      ),
    ),
  );
  const normalizedShopDomain = normalizeText(shopDomain);
  if (!normalizedShopDomain || productIds.length === 0) {
    return {
      ok: false,
      reason: "draft_order_products_missing",
      failures: ["DRAFT_ORDER_PRODUCTS_MISSING"],
    };
  }

  const [products, control] = await Promise.all([
    prismaClient.product.findMany({
      where: {
        id: { in: productIds },
        OR: [{ shopDomain: normalizedShopDomain }, { shopDomain: null }],
      },
      include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
    }),
    operationalControl
      ? Promise.resolve(operationalControl)
      : getPlatformOperationalControl({ prismaClient }),
  ]);
  if (products.length !== productIds.length) {
    return {
      ok: false,
      reason: "draft_order_product_mapping_incomplete",
      failures: ["DRAFT_ORDER_PRODUCT_MAPPING_INCOMPLETE"],
    };
  }

  const results = products.map((product) =>
    evaluateSaleEligibilitySnapshot({
      product,
      shopDomain: normalizedShopDomain,
      vendorStoreId: product.vendorStoreId,
      destinationCountry,
      salesChannel: SALE_ELIGIBILITY_CHANNEL.DRAFT_ORDER,
      operationalControl: control,
      env,
      evaluatedAt: now,
    }),
  );
  const blocked = results.filter((result) => result.allowed !== true);

  return {
    ok: blocked.length === 0,
    reason:
      blocked.length === 0 ? null : "draft_order_sale_eligibility_blocked",
    failures: blocked.flatMap((result) => result.reasonCodes),
    results,
  };
}

export async function evaluateProductsForRecovery(
  products,
  {
    prismaClient = prisma,
    env = process.env,
    operationalControl = null,
    evaluatedAt = new Date(),
  } = {},
) {
  const control =
    operationalControl ||
    (await getPlatformOperationalControl({ prismaClient }));
  const recoveryControl = {
    ...control,
    checkoutHold: false,
    checkoutControlState: "RECOVERING",
  };

  return Promise.all(
    products.map(async (product) => {
      const result = evaluateSaleEligibilitySnapshot({
        product,
        salesChannel: SALE_ELIGIBILITY_CHANNEL.PUBLICATION_SYNC,
        operationalControl: recoveryControl,
        env,
        evaluatedAt,
      });
      return { product, result };
    }),
  );
}
