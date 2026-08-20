import prisma from "../db.server.js";
import {
  evaluateProductGovernanceReadiness,
  evaluateSellerGovernanceReadiness,
  getMarketplaceGovernanceConfiguration,
  getSellerAgreementReadinessOptions,
  getShopifyMarketplacePaymentsApproval,
  isMarketplaceGovernanceGateEnabled,
} from "./marketplaceGovernance.server.js";

export const DOMESTIC_MARKETPLACE_PILOT_ENV =
  "DOMESTIC_MARKETPLACE_PILOT_ENABLED";
export const DOMESTIC_MARKETPLACE_PILOT_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  PREPARED: "PREPARED",
  ACTIVE: "ACTIVE",
  RESERVED: "RESERVED",
  ORDER_CREATED: "ORDER_CREATED",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeLower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function envEnabled(env, key) {
  return ENABLED_VALUES.has(normalizeLower(env?.[key]));
}

function configuredPaymentProviders(env) {
  return String(env?.PAYMENT_PROVIDERS || env?.PAYMENT_PROVIDER || "")
    .split(",")
    .map(normalizeLower)
    .filter(Boolean);
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeOperatorDate(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const includesTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return normalizeDate(includesTimezone ? normalized : `${normalized}+09:00`);
}

function pilotInclude() {
  return {
    vendorStore: {
      include: {
        returnAddresses: true,
        vendorAuth: {
          include: {
            seller: {
              include: {
                complianceProfile: true,
                agreementAcceptances: true,
                settlementControl: true,
              },
            },
          },
        },
        seller: {
          include: {
            complianceProfile: true,
            agreementAcceptances: true,
            settlementControl: true,
          },
        },
      },
    },
    product: {
      include: {
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
      },
    },
  };
}

function pilotSeller(pilot) {
  return (
    pilot?.vendorStore?.seller ||
    pilot?.vendorStore?.vendorAuth?.seller ||
    null
  );
}

export function isDomesticMarketplacePilotEnabled(env = process.env) {
  return ENABLED_VALUES.has(
    String(env?.[DOMESTIC_MARKETPLACE_PILOT_ENV] || "")
      .trim()
      .toLowerCase(),
  );
}

export function evaluateDomesticMarketplacePilot(
  pilot,
  {
    env = process.env,
    now = new Date(),
    requireActive = true,
    requireEnvironment = true,
  } = {},
) {
  const reasons = [];
  const currentTime = normalizeDate(now) || new Date();
  const store = pilot?.vendorStore || null;
  const product = pilot?.product || null;
  const seller = pilotSeller(pilot);
  const governanceConfiguration =
    getMarketplaceGovernanceConfiguration(env);
  const paymentsApproval = getShopifyMarketplacePaymentsApproval(env);

  if (!pilot?.id) reasons.push("pilot_missing");
  if (
    requireActive &&
    pilot?.status !== DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE
  ) {
    reasons.push("pilot_not_active");
  }
  if (requireEnvironment && !isDomesticMarketplacePilotEnabled(env)) {
    reasons.push("pilot_environment_disabled");
  }
  if (
    requireEnvironment &&
    !ENABLED_VALUES.has(
      String(env.PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED || "")
        .trim()
        .toLowerCase(),
    )
  ) {
    reasons.push("public_draft_order_checkout_disabled");
  }
  if (requireEnvironment && !isMarketplaceGovernanceGateEnabled(env)) {
    reasons.push("marketplace_governance_gate_disabled");
  }
  if (
    requireEnvironment &&
    !envEnabled(env, "SELLER_ORDER_SHADOW_WRITE_ENABLED")
  ) {
    reasons.push("seller_order_shadow_write_disabled");
  }
  if (
    requireEnvironment &&
    !envEnabled(env, "VENDOR_ORDERS_USE_SELLER_ORDERS")
  ) {
    reasons.push("seller_order_vendor_reads_disabled");
  }
  if (
    requireEnvironment &&
    normalizeLower(env.SELLER_PAYOUT_PROVIDER) !== "manual"
  ) {
    reasons.push("manual_seller_payout_not_configured");
  }
  if (
    requireEnvironment &&
    !configuredPaymentProviders(env).includes("komoju")
  ) {
    reasons.push("komoju_payment_provider_missing");
  }
  if (
    requireEnvironment &&
    !envEnabled(env, "KOMOJU_PAYMENT_OPERATIONS_ENABLED")
  ) {
    reasons.push("komoju_payment_operations_disabled");
  }
  if (
    requireEnvironment &&
    !envEnabled(env, "PAYMENT_REFUND_CONFIRMATION_ENFORCED")
  ) {
    reasons.push("payment_refund_confirmation_disabled");
  }
  if (!governanceConfiguration.ready) {
    reasons.push(...governanceConfiguration.reasons);
  }
  if (!paymentsApproval.ready) reasons.push(...paymentsApproval.reasons);

  const startsAt = normalizeDate(pilot?.startsAt);
  const expiresAt = normalizeDate(pilot?.expiresAt);
  if (!startsAt) reasons.push("pilot_start_missing");
  if (!expiresAt) reasons.push("pilot_expiry_missing");
  if (startsAt && startsAt.getTime() > currentTime.getTime()) {
    reasons.push("pilot_not_started");
  }
  if (expiresAt && expiresAt.getTime() <= currentTime.getTime()) {
    reasons.push("pilot_expired");
  }
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    reasons.push("pilot_period_invalid");
  }
  if (
    startsAt &&
    expiresAt &&
    expiresAt.getTime() - startsAt.getTime() > 7 * 24 * 60 * 60 * 1000
  ) {
    reasons.push("pilot_period_exceeds_seven_days");
  }
  if (normalizeUpper(pilot?.countryCode) !== "JP") {
    reasons.push("pilot_country_not_jp");
  }
  if (Number(pilot?.maxQuantityPerOrder) !== 1) {
    reasons.push("pilot_quantity_must_be_one");
  }
  if (!positiveInteger(pilot?.maxOrderSubtotalAmount)) {
    reasons.push("pilot_amount_limit_invalid");
  }
  if (!normalizeText(pilot?.approvalReference)) {
    reasons.push("pilot_approval_reference_missing");
  }
  if (!SHA256_PATTERN.test(normalizeText(pilot?.approvalEvidenceHash) || "")) {
    reasons.push("pilot_approval_evidence_hash_invalid");
  }
  if (!pilot?.approvedAt || !normalizeText(pilot?.approvedBy)) {
    reasons.push("pilot_approval_missing");
  }

  if (!store?.id) reasons.push("pilot_store_missing");
  if (store?.isTestStore) reasons.push("pilot_store_is_test");
  if (store?.isPlatformStore) reasons.push("pilot_store_is_platform");
  if (store?.vendorAuth?.status !== "active") {
    reasons.push("pilot_vendor_not_active");
  }
  if (!product?.id) reasons.push("pilot_product_missing");
  if (product && product.vendorStoreId !== store?.id) {
    reasons.push("pilot_product_store_mismatch");
  }

  const sellerReadiness = evaluateSellerGovernanceReadiness(
    seller ? { ...seller, vendorStore: store } : null,
    getSellerAgreementReadinessOptions(env),
  );
  const productReadiness = evaluateProductGovernanceReadiness(product);
  if (!sellerReadiness.ready) {
    reasons.push(...sellerReadiness.reasons.map((reason) => `seller:${reason}`));
  }
  if (!productReadiness.ready) {
    reasons.push(
      ...productReadiness.reasons.map((reason) => `product:${reason}`),
    );
  }
  if (normalizeUpper(seller?.complianceProfile?.countryCode) !== "JP") {
    reasons.push("seller_country_not_jp");
  }
  if (normalizeUpper(product?.productEuStatus) !== "DISABLED") {
    reasons.push("pilot_product_eu_enabled");
  }
  if (product?.euSaleRequested) reasons.push("pilot_product_eu_requested");

  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    store,
    product,
    seller,
    sellerReadiness,
    productReadiness,
    paymentsApproval,
    governanceConfiguration,
  };
}

export async function getDomesticMarketplacePilot(
  { id = null, vendorStoreId = null, productId = null } = {},
  { prismaClient = prisma } = {},
) {
  const where = id
    ? { id }
    : vendorStoreId
      ? { vendorStoreId }
      : productId
        ? { productId }
        : null;
  if (!where) return null;
  return prismaClient.domesticMarketplacePilot.findUnique({
    where,
    include: pilotInclude(),
  });
}

export async function getActiveDomesticMarketplacePilot(
  { vendorStoreId = null, productId = null, vendorHandle = null } = {},
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  if (!isDomesticMarketplacePilotEnabled(env)) return null;

  const where = {
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
    ...(vendorStoreId ? { vendorStoreId } : {}),
    ...(productId ? { productId } : {}),
    ...(vendorHandle
      ? { vendorStore: { vendorAuth: { is: { handle: vendorHandle } } } }
      : {}),
  };
  const pilots = await prismaClient.domesticMarketplacePilot.findMany({
    where,
    include: pilotInclude(),
    take: 2,
  });
  if (pilots.length !== 1) return null;
  const pilot = pilots[0];

  const evaluation = evaluateDomesticMarketplacePilot(pilot, {
    env,
    now,
  });
  return evaluation.ready ? { ...pilot, evaluation } : null;
}

export function evaluateDomesticMarketplacePilotCheckout({
  pilot,
  vendorStoreId,
  items = [],
  shippingCountry,
  subtotalAmount,
  salesCreditRequested = false,
}) {
  const reasons = [];
  const normalizedItems = Array.isArray(items) ? items : [];
  const item = normalizedItems[0] || null;

  if (!pilot?.id) reasons.push("pilot_missing");
  if (pilot?.vendorStoreId !== vendorStoreId) {
    reasons.push("pilot_store_mismatch");
  }
  if (normalizedItems.length !== 1) reasons.push("pilot_single_item_required");
  if (item?.productId !== pilot?.productId) {
    reasons.push("pilot_product_mismatch");
  }
  if (
    !positiveInteger(item?.quantity) ||
    item.quantity > Number(pilot?.maxQuantityPerOrder || 0)
  ) {
    reasons.push("pilot_quantity_exceeded");
  }
  if (normalizeUpper(shippingCountry) !== "JP") {
    reasons.push("pilot_domestic_shipping_required");
  }
  if (
    !positiveInteger(subtotalAmount) ||
    subtotalAmount > Number(pilot?.maxOrderSubtotalAmount || 0)
  ) {
    reasons.push("pilot_amount_exceeded");
  }
  if (salesCreditRequested) reasons.push("pilot_sales_credit_not_allowed");

  return { ready: reasons.length === 0, reasons };
}

export async function prepareDomesticMarketplacePilot(
  {
    vendorStoreId,
    productId,
    maxQuantityPerOrder,
    maxOrderSubtotalAmount,
    startsAt,
    expiresAt,
    approvalReference,
    approvalEvidenceHash,
    actor,
  },
  { prismaClient = prisma } = {},
) {
  const storeId = normalizeText(vendorStoreId);
  const localProductId = normalizeText(productId);
  const quantityLimit = positiveInteger(maxQuantityPerOrder);
  const amountLimit = positiveInteger(maxOrderSubtotalAmount);
  const start = normalizeOperatorDate(startsAt);
  const expiry = normalizeOperatorDate(expiresAt);
  const reference = normalizeText(approvalReference);
  const evidenceHash = normalizeText(approvalEvidenceHash)?.toLowerCase();
  const approvedBy = normalizeText(actor);

  if (
    !storeId ||
    !localProductId ||
    quantityLimit !== 1 ||
    !amountLimit ||
    !start ||
    !expiry ||
    expiry.getTime() <= start.getTime() ||
    expiry.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000 ||
    !reference ||
    !evidenceHash ||
    !SHA256_PATTERN.test(evidenceHash) ||
    !approvedBy
  ) {
    return { ok: false, reason: "invalid_pilot_configuration" };
  }

  const product = await prismaClient.product.findUnique({
    where: { id: localProductId },
    select: { vendorStoreId: true },
  });
  if (!product || product.vendorStoreId !== storeId) {
    return { ok: false, reason: "pilot_product_store_mismatch" };
  }

  const [existing, consumedPilot] = await Promise.all([
    prismaClient.domesticMarketplacePilot.findFirst({
      where: { OR: [{ vendorStoreId: storeId }, { productId: localProductId }] },
    }),
    prismaClient.domesticMarketplacePilot.findFirst({
      where: {
        OR: [
          { status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED },
          { status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.COMPLETED },
          { draftOrderId: { not: null } },
          { shopifyOrderId: { not: null } },
        ],
      },
      select: { id: true },
    }),
  ]);
  if (consumedPilot) {
    return { ok: false, reason: "pilot_order_already_exists" };
  }
  if (
    existing &&
    ![
      DOMESTIC_MARKETPLACE_PILOT_STATUSES.DRAFT,
      DOMESTIC_MARKETPLACE_PILOT_STATUSES.PREPARED,
      DOMESTIC_MARKETPLACE_PILOT_STATUSES.BLOCKED,
    ].includes(existing.status)
  ) {
    return { ok: false, reason: "pilot_not_editable" };
  }

  const data = {
    vendorStoreId: storeId,
    productId: localProductId,
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.PREPARED,
    countryCode: "JP",
    maxQuantityPerOrder: quantityLimit,
    maxOrderSubtotalAmount: amountLimit,
    startsAt: start,
    expiresAt: expiry,
    approvalReference: reference,
    approvalEvidenceHash: evidenceHash,
    approvedAt: new Date(),
    approvedBy,
    checkoutClaimReference: null,
    checkoutClaimedAt: null,
    draftOrderId: null,
    draftOrderCreatedAt: null,
    blockedAt: null,
    blockedBy: null,
    blockReason: null,
    completedAt: null,
    completedBy: null,
    revision: { increment: 1 },
  };
  const pilot = existing
    ? await prismaClient.domesticMarketplacePilot.update({
        where: { id: existing.id },
        data,
      })
    : await prismaClient.domesticMarketplacePilot.create({
        data: { ...data, revision: 1 },
      });
  return { ok: true, pilot };
}

export async function activateDomesticMarketplacePilot(
  { id, actor },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const pilot = await getDomesticMarketplacePilot(
    { id: normalizeText(id) },
    { prismaClient },
  );
  if (!pilot) return { ok: false, reason: "pilot_not_found" };

  const candidate = {
    ...pilot,
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
  };
  const evaluation = evaluateDomesticMarketplacePilot(candidate, {
    env,
    now,
  });
  if (!evaluation.ready) {
    return { ok: false, reason: "pilot_not_ready", reasons: evaluation.reasons };
  }

  const conflictingPilot =
    await prismaClient.domesticMarketplacePilot.findFirst({
      where: {
        id: { not: pilot.id },
        status: {
          in: [
            DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
            DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
            DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
          ],
        },
      },
      select: { id: true },
    });
  if (conflictingPilot) {
    return { ok: false, reason: "another_pilot_is_active" };
  }

  try {
    const result = await prismaClient.domesticMarketplacePilot.updateMany({
      where: {
        id: pilot.id,
        status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.PREPARED,
        revision: pilot.revision,
      },
      data: {
        status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
        approvedAt: new Date(),
        approvedBy: normalizeText(actor) || pilot.approvedBy,
        revision: { increment: 1 },
      },
    });
    return result.count === 1
      ? { ok: true, pilotId: pilot.id }
      : { ok: false, reason: "pilot_activation_conflict" };
  } catch (error) {
    if (error?.code === "P2002") {
      return { ok: false, reason: "another_pilot_is_active" };
    }
    throw error;
  }
}

export async function blockDomesticMarketplacePilot(
  { id, actor, reason },
  { prismaClient = prisma } = {},
) {
  const pilotId = normalizeText(id);
  const blockReason = normalizeText(reason);
  if (!pilotId || !blockReason) {
    return { ok: false, reason: "block_reason_required" };
  }
  const result = await prismaClient.domesticMarketplacePilot.updateMany({
    where: {
      id: pilotId,
      status: {
        in: [
          DOMESTIC_MARKETPLACE_PILOT_STATUSES.PREPARED,
          DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
          DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
        ],
      },
    },
    data: {
      status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.BLOCKED,
      blockedAt: new Date(),
      blockedBy: normalizeText(actor),
      blockReason,
      revision: { increment: 1 },
    },
  });
  return result.count === 1
    ? { ok: true, pilotId }
    : { ok: false, reason: "pilot_not_blockable" };
}

export async function claimDomesticMarketplacePilotCheckout(
  { pilotId, checkoutReference },
  { prismaClient = prisma } = {},
) {
  const id = normalizeText(pilotId);
  const reference = normalizeText(checkoutReference);
  if (!id || !reference) return { ok: false, reason: "invalid_claim" };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await prismaClient.domesticMarketplacePilot.updateMany({
        where: {
          id,
          status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
          checkoutClaimReference: null,
          startsAt: { lte: new Date() },
          expiresAt: { gt: new Date() },
        },
        data: {
          status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
          checkoutClaimReference: reference,
          checkoutClaimedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (result.count === 1) {
        return { ok: true, pilotId: id, checkoutReference: reference };
      }
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (prismaClient.domesticMarketplacePilot.findUnique) {
    const existing = await prismaClient.domesticMarketplacePilot.findUnique({
      where: { checkoutClaimReference: reference },
      select: { id: true, status: true, draftOrderId: true },
    });
    if (
      existing?.id === id &&
      existing.status === DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED &&
      !existing.draftOrderId
    ) {
      return {
        ok: true,
        idempotent: true,
        pilotId: id,
        checkoutReference: reference,
      };
    }
  }
  if (lastError) throw lastError;
  return { ok: false, reason: "pilot_checkout_unavailable" };
}

export async function releaseDomesticMarketplacePilotCheckout(
  { pilotId, checkoutReference },
  { prismaClient = prisma } = {},
) {
  const result = await prismaClient.domesticMarketplacePilot.updateMany({
    where: {
      id: normalizeText(pilotId) || "",
      status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
      checkoutClaimReference: normalizeText(checkoutReference) || "",
      draftOrderId: null,
    },
    data: {
      status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
      checkoutClaimReference: null,
      checkoutClaimedAt: null,
      revision: { increment: 1 },
    },
  });
  return { ok: result.count === 1 };
}

export async function markDomesticMarketplacePilotDraftOrderCreated(
  { pilotId, checkoutReference, draftOrderId },
  { prismaClient = prisma } = {},
) {
  const normalizedPilotId = normalizeText(pilotId) || "";
  const normalizedReference = normalizeText(checkoutReference) || "";
  const normalizedDraftOrderId = normalizeText(draftOrderId);
  if (!normalizedDraftOrderId) {
    return { ok: false, reason: "pilot_draft_order_id_required" };
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await prismaClient.domesticMarketplacePilot.updateMany({
        where: {
          id: normalizedPilotId,
          status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
          checkoutClaimReference: normalizedReference,
        },
        data: {
          status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
          draftOrderId: normalizedDraftOrderId,
          draftOrderCreatedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (result.count === 1) return { ok: true };
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (prismaClient.domesticMarketplacePilot.findUnique) {
    const existing = await prismaClient.domesticMarketplacePilot.findUnique({
      where: { checkoutClaimReference: normalizedReference },
      select: { id: true, status: true, draftOrderId: true },
    });
    if (
      existing?.id === normalizedPilotId &&
      existing.status === DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED &&
      existing.draftOrderId === normalizedDraftOrderId
    ) {
      return { ok: true, idempotent: true };
    }
  }
  if (lastError) throw lastError;
  return { ok: false, reason: "pilot_draft_order_record_conflict" };
}

export async function completeDomesticMarketplacePilotForPaidOrder(
  {
    checkoutReference,
    shopifyOrderId,
    paidAt = new Date(),
    sellerOrderRecorded = false,
  },
  { prismaClient = prisma } = {},
) {
  const reference = normalizeText(checkoutReference);
  const orderId = normalizeText(shopifyOrderId);
  const paidDate = normalizeDate(paidAt) || new Date();
  if (!reference || !orderId) return { ok: true, skipped: true };
  if (!prismaClient?.domesticMarketplacePilot?.findUnique) {
    return { ok: true, skipped: true };
  }

  const pilot = await prismaClient.domesticMarketplacePilot.findUnique({
    where: { checkoutClaimReference: reference },
    select: {
      id: true,
      status: true,
      shopifyOrderId: true,
      checkoutClaimReference: true,
    },
  });
  if (!pilot) return { ok: true, skipped: true };
  const paymentAttempt = prismaClient?.marketplacePaymentAttempt?.findFirst
    ? await prismaClient.marketplacePaymentAttempt.findFirst({
        where: {
          shopifyOrderId: orderId,
          provider: "KOMOJU",
          paymentMethod: "CARD",
          status: "CAPTURED",
          transactionKind: { in: ["SALE", "CAPTURE"] },
          transactionStatus: "SUCCESS",
          test: false,
          requiresReview: false,
        },
        select: {
          id: true,
          metadataJson: true,
        },
      })
    : null;
  const paymentMetadata = paymentAttempt?.metadataJson;
  const structuredKomojuCardConfirmed =
    paymentAttempt?.id &&
    paymentMetadata &&
    typeof paymentMetadata === "object" &&
    paymentMetadata.paymentDetailsType === "CardPaymentDetails" &&
    !normalizeText(paymentMetadata.paymentWallet);
  if (!structuredKomojuCardConfirmed) {
    return { ok: false, reason: "pilot_komoju_card_not_confirmed" };
  }
  let hasSellerOrder = sellerOrderRecorded === true;
  if (!hasSellerOrder && prismaClient?.sellerOrder?.findFirst) {
    hasSellerOrder = Boolean(
      await prismaClient.sellerOrder.findFirst({
        where: {
          shopifyOrderId: orderId,
          checkoutReference: reference,
        },
        select: { id: true },
      }),
    );
  }
  if (!hasSellerOrder) {
    return { ok: false, reason: "pilot_seller_order_not_recorded" };
  }
  if (
    pilot.status === DOMESTIC_MARKETPLACE_PILOT_STATUSES.COMPLETED &&
    pilot.shopifyOrderId === orderId
  ) {
    return { ok: true, idempotent: true, pilotId: pilot.id };
  }
  if (pilot.status !== DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED) {
    return { ok: false, reason: "pilot_paid_order_state_conflict" };
  }

  const result = await prismaClient.domesticMarketplacePilot.updateMany({
    where: {
      id: pilot.id,
      status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
      checkoutClaimReference: reference,
      shopifyOrderId: null,
    },
    data: {
      status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.COMPLETED,
      shopifyOrderId: orderId,
      paidAt: paidDate,
      completedAt: paidDate,
      completedBy: "shopify_orders_paid",
      revision: { increment: 1 },
    },
  });
  return result.count === 1
    ? { ok: true, pilotId: pilot.id }
    : { ok: false, reason: "pilot_paid_order_completion_conflict" };
}

export async function getDomesticMarketplacePilotDashboard(
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const [pilots, stores] = await Promise.all([
    prismaClient.domesticMarketplacePilot.findMany({
      include: pilotInclude(),
      orderBy: { updatedAt: "desc" },
    }),
    prismaClient.vendorStore.findMany({
      where: {
        isTestStore: false,
        isPlatformStore: false,
        vendorAuth: { is: { status: "active" } },
      },
      select: {
        id: true,
        storeName: true,
        vendorAuth: { select: { handle: true } },
        products: {
          where: { approvalStatus: "approved" },
          select: { id: true, name: true, approvalStatus: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    enabled: isDomesticMarketplacePilotEnabled(env),
    publicDraftOrderCheckoutEnabled: ENABLED_VALUES.has(
      String(env.PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED || "")
        .trim()
        .toLowerCase(),
    ),
    stores,
    pilots: pilots.map((pilot) => ({
      ...pilot,
      evaluation: evaluateDomesticMarketplacePilot(pilot, {
        env,
        now,
        requireActive: pilot.status === DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
      }),
    })),
  };
}
