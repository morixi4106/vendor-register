import prisma from "../db.server.js";
import { syncShopKomojuLimitedLaunchControl } from "./marketplaceCheckoutGate.server.js";

export const KOMOJU_LIMITED_LAUNCH_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
});

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function amount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isPaidOrder(order) {
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
    clean(order?.financialStatus).toUpperCase(),
  );
}

function toDateString(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function paidRefundAmount(order) {
  const providerRefund = asArray(order?.paymentRefundOperations)
    .filter(
      (refund) =>
        refund?.ledgerAppliedAt ||
        refund?.providerConfirmedAt ||
        ["LEDGER_APPLIED", "PROVIDER_CONFIRMED"].includes(
          clean(refund?.status).toUpperCase(),
        ),
    )
    .reduce((total, refund) => total + amount(refund?.amount), 0);
  const directRefund =
    clean(order?.directCustomerRefund?.status).toUpperCase() === "COMPLETED"
      ? amount(order.directCustomerRefund.amount)
      : 0;
  return Math.min(amount(order?.totalAmount), providerRefund + directRefund);
}

export function buildKomojuLimitedLaunchProjection(control) {
  const status = clean(control?.status).toUpperCase();
  const active = status === KOMOJU_LIMITED_LAUNCH_STATUS.ACTIVE;
  return {
    v: 1,
    s:
      status === KOMOJU_LIMITED_LAUNCH_STATUS.COMPLETED
        ? "INACTIVE"
        : active
          ? "ACTIVE"
          : "BLOCKED",
    e: toDateString(control?.expiresAt),
    p: asArray(control?.allowedShopifyProductIdsJson).map(clean).filter(Boolean),
    m: amount(control?.maxSingleOrderAmount),
    o: active ? Math.max(0, amount(control?.maxOrderCount) - amount(control?.orderCount)) : 0,
    g: active ? Math.max(0, amount(control?.maxGrossAmount) - amount(control?.grossAmount)) : 0,
    l: active
      ? Math.max(
          0,
          amount(control?.maxOutstandingLiability) -
            amount(control?.outstandingLiabilityAmount),
        )
      : 0,
    c: "JPY",
  };
}

export async function calculateKomojuLimitedLaunchExposure(
  control,
  { prismaClient = prisma } = {},
) {
  const seedOrderId = clean(control?.metadataJson?.seedMarketplaceOrderId);
  const orders = await prismaClient.marketplaceOrder.findMany({
    where: {
      shopDomain: control.shopDomain,
      OR: [
        ...(seedOrderId ? [{ id: seedOrderId }] : []),
        { processedAt: { gte: control.startsAt } },
        { createdAt: { gte: control.startsAt } },
      ],
    },
    select: {
      id: true,
      totalAmount: true,
      financialStatus: true,
      sellerOrders: {
        select: {
          lines: { select: { productId: true, shopifyProductId: true } },
        },
      },
      paymentRefundOperations: {
        select: {
          amount: true,
          status: true,
          providerConfirmedAt: true,
          ledgerAppliedAt: true,
        },
      },
      directCustomerRefund: { select: { amount: true, status: true } },
    },
  });
  const allowedProductIds = new Set(
    asArray(control.allowedProductIdsJson).map(clean).filter(Boolean),
  );
  const paidOrders = orders.filter(isPaidOrder);
  const disallowedProductOrderIds = paidOrders
    .filter((order) => {
      const productIds = order.sellerOrders.flatMap((sellerOrder) =>
        sellerOrder.lines.map((line) => clean(line.productId)).filter(Boolean),
      );
      return (
        productIds.length === 0 ||
        productIds.some((productId) => !allowedProductIds.has(productId))
      );
    })
    .map((order) => order.id);
  return paidOrders.reduce(
    (summary, order) => {
      const total = amount(order.totalAmount);
      const refunded = paidRefundAmount(order);
      summary.orderCount += 1;
      summary.grossAmount += total;
      summary.outstandingLiabilityAmount += Math.max(0, total - refunded);
      summary.marketplaceOrderIds.push(order.id);
      return summary;
    },
    {
      orderCount: 0,
      grossAmount: 0,
      outstandingLiabilityAmount: 0,
      marketplaceOrderIds: [],
      disallowedProductOrderIds,
    },
  );
}

function limitReason(control, exposure, now) {
  if (clean(control.status).toUpperCase() === KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED) {
    return clean(control.blockReason) || "komoju_limited_launch_blocked";
  }
  if (now.getTime() >= new Date(control.expiresAt).getTime()) {
    return "komoju_limited_launch_expired";
  }
  if (exposure.disallowedProductOrderIds.length > 0) {
    return "komoju_limited_launch_product_allowlist_violated";
  }
  if (exposure.orderCount >= control.maxOrderCount) {
    return "komoju_limited_launch_order_limit_reached";
  }
  if (exposure.grossAmount >= control.maxGrossAmount) {
    return "komoju_limited_launch_gross_limit_reached";
  }
  if (
    exposure.outstandingLiabilityAmount >= control.maxOutstandingLiability ||
    exposure.outstandingLiabilityAmount > control.companyRefundReserveAmount
  ) {
    return "komoju_limited_launch_liability_limit_reached";
  }
  return null;
}

export async function refreshKomojuLimitedLaunchControl(
  { shopDomain, applyEmergencyHold = true },
  {
    prismaClient = prisma,
    syncProjection = syncShopKomojuLimitedLaunchControl,
    emergencyHold = null,
    now = new Date(),
  } = {},
) {
  const control = await prismaClient.komojuLimitedLaunchControl.findUnique({
    where: { shopDomain: clean(shopDomain).toLowerCase() },
  });
  if (!control) return { ok: true, skipped: true, reason: "limited_launch_not_active" };

  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: control.probeId },
    select: { status: true },
  });
  const exposure = await calculateKomojuLimitedLaunchExposure(control, {
    prismaClient,
  });
  const completed = probe?.status === "PASSED";
  const blockReason = completed ? null : limitReason(control, exposure, now);
  const status = completed
    ? KOMOJU_LIMITED_LAUNCH_STATUS.COMPLETED
    : blockReason
      ? KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED
      : KOMOJU_LIMITED_LAUNCH_STATUS.ACTIVE;
  const updated = await prismaClient.komojuLimitedLaunchControl.update({
    where: { id: control.id },
    data: {
      status,
      orderCount: exposure.orderCount,
      grossAmount: exposure.grossAmount,
      outstandingLiabilityAmount: exposure.outstandingLiabilityAmount,
      lastEvaluatedAt: now,
      blockedAt: blockReason ? control.blockedAt || now : null,
      blockReason,
      metadataJson: {
        ...(control.metadataJson || {}),
        marketplaceOrderIds: exposure.marketplaceOrderIds,
        disallowedProductOrderIds: exposure.disallowedProductOrderIds,
        lastEvaluatedAt: now.toISOString(),
      },
    },
  });
  const projection = buildKomojuLimitedLaunchProjection(updated);
  let holdResult = null;
  if (blockReason && applyEmergencyHold) {
    const hold =
      emergencyHold ||
      (await import("./operationalReadiness.server.js"))
        .applyPlatformCheckoutEmergencyHold;
    try {
      holdResult = await hold(
        {
          reason: blockReason,
          changedBy: "system:komoju-limited-launch",
          shopDomain: updated.shopDomain,
        },
        { prismaClient, now },
      );
    } catch {
      holdResult = { ok: false, reason: "limited_launch_emergency_hold_failed" };
    }
  }
  let syncResult;
  try {
    syncResult = await syncProjection({
      shopDomain: updated.shopDomain,
      projection,
    });
  } catch {
    syncResult = { ok: false, reason: "limited_launch_projection_sync_failed" };
  }
  if (syncResult?.ok === false) {
    return {
      ok: false,
      reason: syncResult.reason || "limited_launch_projection_sync_failed",
      control: updated,
      exposure,
      projection,
      blockReason,
      holdResult,
    };
  }
  const synced = await prismaClient.komojuLimitedLaunchControl.update({
    where: { id: updated.id },
    data: { projectionSyncedAt: now },
  });
  return {
    ok: holdResult?.ok === false && holdResult.reason !== "purchase_stop_already_active" ? false : true,
    control: synced,
    exposure,
    projection,
    blockReason,
    holdResult,
  };
}
