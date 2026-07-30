import crypto from "node:crypto";

import prisma from "../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";
import {
  LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  OPERATIONAL_ATTESTATION_STATUS,
  recordOperationalReadinessAttestation,
} from "./operationalReadiness.server.js";
import {
  buildProductionReleaseFingerprint,
  buildProductionReleaseExpectation,
} from "./productionRelease.server.js";

export const PRODUCTION_TRANSACTION_PROBE_STATUS = Object.freeze({
  AWAITING_ORDER: "AWAITING_ORDER",
  AWAITING_SETTLEMENT: "AWAITING_SETTLEMENT",
  AWAITING_REFUND: "AWAITING_REFUND",
  PASSED: "PASSED",
  INVALIDATED: "INVALIDATED",
  CANCELLED: "CANCELLED",
});

const ACTIVE_PROBE_STATUSES = [
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND,
];
const SHOPIFY_API_VERSION = "2026-04";
const ORDER_CREATED_TOLERANCE_MS = 5 * 60 * 1000;
const SETTLEMENT_ENTRY_TYPES = [
  "shopify_order_paid",
  "refund",
  "shopify_order_cancelled",
];
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const ORDER_FIELDS = `#graphql
  fragment ProductionProbeOrderFields on Order {
    id
    name
    createdAt
    updatedAt
    test
    cancelledAt
    currencyCode
    displayFinancialStatus
    displayFulfillmentStatus
    subtotalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalShippingPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalTaxSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalRefundedSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    refunds {
      id
      createdAt
    }
    lineItems(first: 250) {
      nodes {
        id
        title
        quantity
        currentQuantity
        sku
        product {
          id
        }
        variant {
          id
        }
        originalUnitPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountedTotalSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const ORDER_BY_ID_QUERY = `#graphql
  ${ORDER_FIELDS}
  query ProductionProbeOrderById($id: ID!) {
    order(id: $id) {
      ...ProductionProbeOrderFields
    }
  }
`;

const ORDER_BY_NAME_QUERY = `#graphql
  ${ORDER_FIELDS}
  query ProductionProbeOrderByName($query: String!) {
    orders(first: 2, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ...ProductionProbeOrderFields
      }
    }
  }
`;

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeShop(value) {
  return clean(value).toLowerCase();
}

function normalizeCurrency(value) {
  return clean(value).toUpperCase() || "JPY";
}

function toMinorUnits(value, currencyCode) {
  const numeric = Number(clean(value).replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return 0;
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currencyCode))
    ? Math.round(numeric)
    : Math.round(numeric * 100);
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function parseDate(value) {
  if (!clean(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function hashEvidence(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function normalizeOrderReference(value) {
  const reference = clean(value);
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(reference)) {
    return { kind: "id", value: reference };
  }
  const numeric = reference.replace(/^#/, "");
  if (/^\d{1,20}$/.test(numeric)) {
    return { kind: "name", value: `#${numeric}` };
  }
  return null;
}

function lineSnapshot(line, currencyCode) {
  const quantity = toNonNegativeInteger(line?.quantity);
  return {
    id: clean(line?.id) || null,
    productId: clean(line?.product?.id) || null,
    variantId: clean(line?.variant?.id) || null,
    quantity,
    unitAmount: toMinorUnits(
      line?.originalUnitPriceSet?.shopMoney?.amount,
      line?.originalUnitPriceSet?.shopMoney?.currencyCode || currencyCode,
    ),
    discountedTotalAmount: toMinorUnits(
      line?.discountedTotalSet?.shopMoney?.amount,
      line?.discountedTotalSet?.shopMoney?.currencyCode || currencyCode,
    ),
  };
}

export function buildShopifyProbeOrderSnapshot(order) {
  const currencyCode = normalizeCurrency(order?.currencyCode);
  const lines = Array.isArray(order?.lineItems?.nodes)
    ? order.lineItems.nodes.map((line) => lineSnapshot(line, currencyCode))
    : [];
  const commercialEvidence = {
    currencyCode,
    subtotalAmount: toMinorUnits(
      order?.subtotalPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    shippingAmount: toMinorUnits(
      order?.totalShippingPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    taxAmount: toMinorUnits(
      order?.totalTaxSet?.shopMoney?.amount,
      currencyCode,
    ),
    totalAmount: toMinorUnits(
      order?.totalPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    lines,
  };
  return {
    shopifyOrderId: clean(order?.id) || null,
    shopifyOrderName: clean(order?.name) || null,
    createdAt: parseDate(order?.createdAt)?.toISOString() || null,
    updatedAt: parseDate(order?.updatedAt)?.toISOString() || null,
    test: order?.test === true,
    cancelledAt: parseDate(order?.cancelledAt)?.toISOString() || null,
    financialStatus: clean(order?.displayFinancialStatus).toUpperCase(),
    fulfillmentStatus: clean(order?.displayFulfillmentStatus).toUpperCase(),
    refundedAmount: toMinorUnits(
      order?.totalRefundedSet?.shopMoney?.amount,
      currencyCode,
    ),
    refundIds: Array.isArray(order?.refunds)
      ? unique(order.refunds.map((refund) => clean(refund?.id))).sort()
      : [],
    lineItemsComplete: order?.lineItems?.pageInfo?.hasNextPage !== true,
    commercialEvidence,
    commercialFingerprint: hashEvidence(commercialEvidence),
  };
}

export async function fetchShopifyOrderForProductionProbe(
  { shopDomain, orderReference },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const reference = normalizeOrderReference(orderReference);
  if (!reference) {
    return { ok: false, reason: "order_reference_invalid" };
  }
  const request =
    reference.kind === "id"
      ? {
          query: ORDER_BY_ID_QUERY,
          variables: { id: reference.value },
        }
      : {
          query: ORDER_BY_NAME_QUERY,
          variables: { query: `name:${reference.value}` },
        };
  const response = await graphQL({
    shopDomain: normalizeShop(shopDomain),
    apiVersion: SHOPIFY_API_VERSION,
    ...request,
  });
  const nodes =
    reference.kind === "id"
      ? response?.data?.order
        ? [response.data.order]
        : []
      : Array.isArray(response?.data?.orders?.nodes)
        ? response.data.orders.nodes
        : [];
  if (nodes.length === 0) {
    return { ok: false, reason: "shopify_order_not_found" };
  }
  if (nodes.length !== 1) {
    return { ok: false, reason: "shopify_order_reference_ambiguous" };
  }
  const snapshot = buildShopifyProbeOrderSnapshot(nodes[0]);
  if (!snapshot.shopifyOrderId || !snapshot.lineItemsComplete) {
    return {
      ok: false,
      reason: snapshot.shopifyOrderId
        ? "shopify_order_line_items_incomplete"
        : "shopify_order_not_found",
    };
  }
  return { ok: true, order: nodes[0], snapshot };
}

function buildReleaseContext(releaseExpectation) {
  const expected = releaseExpectation || buildProductionReleaseExpectation();
  const releaseFingerprint = buildProductionReleaseFingerprint(expected);
  return {
    expected,
    releaseId: clean(expected?.releaseId),
    releaseFingerprint,
    configured: expected?.configured === true && Boolean(releaseFingerprint),
  };
}

function activeKey(shopDomain) {
  return `production-transaction-probe:${normalizeShop(shopDomain)}`;
}

export async function createProductionTransactionProbe(
  { shopDomain, startedBy, releaseExpectation },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!prismaClient?.productionTransactionProbe?.findUnique) {
    return { ok: false, reason: "production_transaction_probe_unavailable" };
  }
  const shop = normalizeShop(shopDomain);
  const actor = clean(startedBy);
  const release = buildReleaseContext(releaseExpectation);
  if (!shop || !actor || !release.configured) {
    return { ok: false, reason: "production_transaction_probe_input_invalid" };
  }
  const key = activeKey(shop);
  const existing = await prismaClient.productionTransactionProbe.findUnique({
    where: { activeKey: key },
  });
  if (existing) {
    if (existing.releaseFingerprint === release.releaseFingerprint) {
      return { ok: true, existing: true, probe: existing };
    }
    await prismaClient.productionTransactionProbe.update({
      where: { id: existing.id },
      data: {
        activeKey: null,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.INVALIDATED,
        invalidatedAt: now,
        lastCheckedAt: now,
        lastErrorCode: "release_changed",
      },
    });
  }
  try {
    const probe = await prismaClient.productionTransactionProbe.create({
      data: {
        activeKey: key,
        shopDomain: shop,
        releaseId: release.releaseId,
        releaseFingerprint: release.releaseFingerprint,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER,
        startedBy: actor,
        startedAt: now,
        lastCheckedAt: now,
      },
    });
    return { ok: true, existing: false, probe };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const concurrent = await prismaClient.productionTransactionProbe.findUnique(
      {
        where: { activeKey: key },
      },
    );
    return concurrent
      ? { ok: true, existing: true, probe: concurrent }
      : { ok: false, reason: "production_transaction_probe_conflict" };
  }
}

async function resolvePlatformProducts(
  { shopDomain, snapshot },
  { prismaClient },
) {
  const clauses = [];
  const variantIds = unique(
    snapshot.commercialEvidence.lines.map((line) => line.variantId),
  );
  const productIds = unique(
    snapshot.commercialEvidence.lines.map((line) => line.productId),
  );
  if (variantIds.length > 0)
    clauses.push({ shopifyVariantId: { in: variantIds } });
  if (productIds.length > 0)
    clauses.push({ shopifyProductId: { in: productIds } });
  if (clauses.length === 0) {
    return { ok: false, reason: "shopify_order_products_missing" };
  }
  const products = await prismaClient.product.findMany({
    where: {
      shopDomain: normalizeShop(shopDomain),
      OR: clauses,
    },
    include: {
      vendorStore: {
        select: {
          id: true,
          isPlatformStore: true,
          isTestStore: true,
        },
      },
    },
  });
  const byVariantId = new Map(
    products
      .filter((product) => product.shopifyVariantId)
      .map((product) => [product.shopifyVariantId, product]),
  );
  const byProductId = new Map(
    products
      .filter((product) => product.shopifyProductId)
      .map((product) => [product.shopifyProductId, product]),
  );
  const matched = [];
  for (const line of snapshot.commercialEvidence.lines) {
    const product =
      (line.variantId && byVariantId.get(line.variantId)) ||
      (line.productId && byProductId.get(line.productId)) ||
      null;
    if (!product) {
      return { ok: false, reason: "local_product_mapping_missing" };
    }
    if (
      product.approvalStatus !== "approved" ||
      product.vendorStore?.isPlatformStore !== true ||
      product.vendorStore?.isTestStore === true
    ) {
      return { ok: false, reason: "order_contains_non_platform_product" };
    }
    matched.push({
      shopifyLineItemId: line.id,
      productId: product.id,
      vendorStoreId: product.vendorStoreId,
      quantity: line.quantity,
    });
  }
  return {
    ok: true,
    products: matched,
    vendorStoreIds: unique(matched.map((product) => product.vendorStoreId)),
  };
}

export async function attachOrderToProductionTransactionProbe(
  { probeId, orderReference, actorKey, releaseExpectation },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    now = new Date(),
  } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (
    !probe ||
    probe.status !== PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER ||
    probe.activeKey !== activeKey(probe.shopDomain)
  ) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  const release = buildReleaseContext(releaseExpectation);
  if (
    !release.configured ||
    release.releaseFingerprint !== probe.releaseFingerprint
  ) {
    return invalidateProbeForReleaseChange(probe, { prismaClient, now });
  }
  const fetched = await fetchShopifyOrderForProductionProbe(
    { shopDomain: probe.shopDomain, orderReference },
    { graphQL },
  );
  if (!fetched.ok) return fetched;
  const { snapshot } = fetched;
  const createdAt = parseDate(snapshot.createdAt);
  if (snapshot.test) {
    return { ok: false, reason: "shopify_test_order_not_allowed" };
  }
  if (
    !createdAt ||
    createdAt.getTime() < probe.startedAt.getTime() - ORDER_CREATED_TOLERANCE_MS
  ) {
    return { ok: false, reason: "order_predates_probe" };
  }
  if (snapshot.cancelledAt) {
    return { ok: false, reason: "order_already_cancelled" };
  }
  if (
    !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
      snapshot.financialStatus,
    )
  ) {
    return { ok: false, reason: "order_not_paid" };
  }
  if (
    snapshot.commercialEvidence.totalAmount <= 0 ||
    snapshot.commercialEvidence.lines.length === 0
  ) {
    return { ok: false, reason: "order_has_no_payable_lines" };
  }
  const platformProducts = await resolvePlatformProducts(
    { shopDomain: probe.shopDomain, snapshot },
    { prismaClient },
  );
  if (!platformProducts.ok) return platformProducts;
  const orderEvidenceJson = {
    shopifyOrderId: snapshot.shopifyOrderId,
    shopifyOrderName: snapshot.shopifyOrderName,
    createdAt: snapshot.createdAt,
    commercialFingerprint: snapshot.commercialFingerprint,
    commercialEvidence: snapshot.commercialEvidence,
    products: platformProducts.products,
    vendorStoreIds: platformProducts.vendorStoreIds,
    attachedBy: clean(actorKey) || probe.startedBy,
    attachedAt: now.toISOString(),
  };
  const updated = await prismaClient.productionTransactionProbe.update({
    where: { id: probe.id },
    data: {
      shopifyOrderId: snapshot.shopifyOrderId,
      status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
      orderAttachedAt: now,
      lastCheckedAt: now,
      lastErrorCode: null,
      orderEvidenceJson,
    },
  });
  return { ok: true, probe: updated, snapshot };
}

async function loadLocalOrderEvidence(probe, prismaClient) {
  const marketplaceOrder = await prismaClient.marketplaceOrder.findUnique({
    where: {
      shopDomain_shopifyOrderId: {
        shopDomain: probe.shopDomain,
        shopifyOrderId: probe.shopifyOrderId,
      },
    },
    include: {
      sellerOrders: {
        include: {
          lines: true,
        },
      },
    },
  });
  const ledgerEntries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: { in: SETTLEMENT_ENTRY_TYPES },
      OR: [
        { stripeObjectId: probe.shopifyOrderId },
        {
          metadataJson: {
            path: ["shopifyOrderId"],
            equals: probe.shopifyOrderId,
          },
        },
      ],
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const shadowCheck = prismaClient?.sellerOrderShadowCheck?.findFirst
    ? await prismaClient.sellerOrderShadowCheck.findFirst({
        where: {
          shopDomain: probe.shopDomain,
          shopifyOrderId: probe.shopifyOrderId,
        },
        orderBy: { checkedAt: "desc" },
      })
    : null;
  const storeIds = unique(
    (marketplaceOrder?.sellerOrders || []).map(
      (sellerOrder) => sellerOrder.vendorStoreId,
    ),
  );
  const stores =
    storeIds.length > 0
      ? await prismaClient.vendorStore.findMany({
          where: { id: { in: storeIds } },
          select: {
            id: true,
            isPlatformStore: true,
            isTestStore: true,
          },
        })
      : [];
  return { marketplaceOrder, ledgerEntries, shadowCheck, stores };
}

function check(id, passed, code, details = {}) {
  return {
    id,
    passed: passed === true,
    code: passed === true ? null : code,
    ...details,
  };
}

function sellerOrderExpectedPaidAmount(sellerOrders) {
  return sellerOrders.reduce(
    (sum, sellerOrder) =>
      sum + toNonNegativeInteger(sellerOrder.sellerPayableAmount),
    0,
  );
}

function buildPaidInspection({ probe, snapshot, local }) {
  const marketplaceOrder = local.marketplaceOrder;
  const sellerOrders = marketplaceOrder?.sellerOrders || [];
  const sellerOrderLines = sellerOrders.flatMap(
    (sellerOrder) => sellerOrder.lines,
  );
  const expectedLines = snapshot.commercialEvidence.lines;
  const actualLineByShopifyId = new Map(
    sellerOrderLines.map((line) => [line.shopifyLineItemId, line]),
  );
  const lineSnapshotsMatch =
    sellerOrderLines.length === expectedLines.length &&
    expectedLines.every((expectedLine) => {
      const actualLine = actualLineByShopifyId.get(expectedLine.id);
      return Boolean(
        actualLine &&
        actualLine.quantity === expectedLine.quantity &&
        actualLine.shopifyProductId === expectedLine.productId &&
        (expectedLine.variantId
          ? actualLine.shopifyVariantId === expectedLine.variantId
          : true) &&
        actualLine.unitAmount === expectedLine.unitAmount &&
        actualLine.netAmount === expectedLine.discountedTotalAmount,
      );
    });
  const paidEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "shopify_order_paid",
  );
  const expectedPaidAmount = sellerOrderExpectedPaidAmount(sellerOrders);
  const actualPaidAmount = paidEntries.reduce(
    (sum, entry) => sum + toNonNegativeInteger(entry.amount),
    0,
  );
  const currencyCode = snapshot.commercialEvidence.currencyCode.toLowerCase();
  const checks = [
    check(
      "commercial_fingerprint",
      asObject(probe.orderEvidenceJson).commercialFingerprint ===
        snapshot.commercialFingerprint,
      "shopify_order_changed_after_attachment",
    ),
    check(
      "marketplace_order",
      Boolean(marketplaceOrder),
      "marketplace_order_missing",
    ),
    check(
      "marketplace_currency",
      marketplaceOrder?.currencyCode?.toLowerCase() === currencyCode,
      "marketplace_order_currency_mismatch",
    ),
    check(
      "marketplace_total",
      marketplaceOrder?.totalAmount === snapshot.commercialEvidence.totalAmount,
      "marketplace_order_total_mismatch",
    ),
    check(
      "seller_orders",
      sellerOrders.length === 1,
      "seller_order_count_mismatch",
      { actualCount: sellerOrders.length },
    ),
    check(
      "platform_store",
      local.stores.length > 0 &&
        local.stores.every(
          (store) =>
            store.isPlatformStore === true && store.isTestStore !== true,
        ),
      "seller_order_not_platform_direct",
    ),
    check(
      "seller_order_lines",
      sellerOrders.length > 0 && lineSnapshotsMatch,
      "seller_order_lines_mismatch",
      {
        expectedCount: expectedLines.length,
        actualCount: sellerOrderLines.length,
      },
    ),
    check(
      "paid_ledger_count",
      paidEntries.length === sellerOrders.length && paidEntries.length === 1,
      "paid_ledger_count_mismatch",
      { actualCount: paidEntries.length },
    ),
    check(
      "paid_ledger_direction",
      paidEntries.length > 0 &&
        paidEntries.every((entry) => entry.direction === "credit"),
      "paid_ledger_direction_mismatch",
    ),
    check(
      "paid_ledger_currency",
      paidEntries.length > 0 &&
        paidEntries.every(
          (entry) => entry.currencyCode?.toLowerCase() === currencyCode,
        ),
      "paid_ledger_currency_mismatch",
    ),
    check(
      "paid_ledger_amount",
      expectedPaidAmount > 0 && actualPaidAmount === expectedPaidAmount,
      "paid_ledger_amount_mismatch",
      { expectedAmount: expectedPaidAmount, actualAmount: actualPaidAmount },
    ),
    check(
      "seller_order_shadow",
      local.shadowCheck?.status === "matched",
      "seller_order_shadow_not_matched",
      { actualStatus: local.shadowCheck?.status || null },
    ),
  ];
  return {
    passed: checks.every((entry) => entry.passed),
    checks,
    expectedPaidAmount,
    actualPaidAmount,
    currencyCode: normalizeCurrency(snapshot.commercialEvidence.currencyCode),
    marketplaceOrderId: marketplaceOrder?.id || null,
    sellerOrderIds: sellerOrders.map((sellerOrder) => sellerOrder.id).sort(),
    paidLedgerEntryIds: paidEntries.map((entry) => entry.id).sort(),
  };
}

function buildRefundInspection({ snapshot, local, paidInspection }) {
  const sellerOrders = local.marketplaceOrder?.sellerOrders || [];
  const refundEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "refund",
  );
  const cancellationEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "shopify_order_cancelled",
  );
  const reversalEntries = [...refundEntries, ...cancellationEntries];
  const reversalAmount = reversalEntries.reduce(
    (sum, entry) => sum + toNonNegativeInteger(entry.amount),
    0,
  );
  const expectedAmount = paidInspection.expectedPaidAmount;
  const refundIds = refundEntries.map((entry) =>
    clean(asObject(entry.metadataJson).shopifyRefundId),
  );
  const nonEmptyRefundIds = refundIds.filter(Boolean);
  const ledgerRefundIds = [...new Set(nonEmptyRefundIds)].sort();
  const shopifyRefundIds = [...snapshot.refundIds].sort();
  const fullLineRefund = sellerOrders.every((sellerOrder) =>
    sellerOrder.lines.every(
      (line) =>
        toNonNegativeInteger(line.refundedQuantity) ===
        toNonNegativeInteger(line.quantity),
    ),
  );
  const checks = [
    check(
      "shopify_financial_status",
      snapshot.financialStatus === "REFUNDED",
      "shopify_order_not_fully_refunded",
      { actualStatus: snapshot.financialStatus },
    ),
    check(
      "shopify_refund_total",
      snapshot.refundedAmount === snapshot.commercialEvidence.totalAmount,
      "shopify_refund_total_mismatch",
      {
        expectedAmount: snapshot.commercialEvidence.totalAmount,
        actualAmount: snapshot.refundedAmount,
      },
    ),
    check(
      "shopify_refund_record",
      snapshot.refundIds.length === 1,
      "shopify_refund_count_mismatch",
      { actualCount: snapshot.refundIds.length },
    ),
    check(
      "seller_order_refund_amount",
      sellerOrders.length > 0 &&
        sellerOrders.every(
          (sellerOrder) =>
            toNonNegativeInteger(sellerOrder.sellerRefundAmount) ===
            toNonNegativeInteger(sellerOrder.sellerPayableAmount),
        ),
      "seller_order_refund_amount_mismatch",
    ),
    check(
      "seller_order_refund_quantity",
      sellerOrders.length > 0 && fullLineRefund,
      "seller_order_refund_quantity_mismatch",
    ),
    check(
      "refund_ledger_count",
      refundEntries.length === 1,
      "refund_ledger_count_mismatch",
      { actualCount: refundEntries.length },
    ),
    check(
      "refund_ledger_direction",
      refundEntries.length > 0 &&
        refundEntries.every((entry) => entry.direction === "debit"),
      "refund_ledger_direction_mismatch",
    ),
    check(
      "refund_ledger_currency",
      refundEntries.length > 0 &&
        refundEntries.every(
          (entry) =>
            normalizeCurrency(entry.currencyCode) ===
            paidInspection.currencyCode,
        ),
      "refund_ledger_currency_mismatch",
    ),
    check(
      "refund_ledger_identifiers",
      nonEmptyRefundIds.length === refundEntries.length &&
        ledgerRefundIds.length === refundEntries.length &&
        ledgerRefundIds.length === shopifyRefundIds.length &&
        ledgerRefundIds.every(
          (refundId, index) => refundId === shopifyRefundIds[index],
        ),
      "refund_ledger_identifier_mismatch",
    ),
    check(
      "reversal_amount",
      expectedAmount > 0 && reversalAmount === expectedAmount,
      "order_reversal_amount_mismatch",
      { expectedAmount, actualAmount: reversalAmount },
    ),
    check(
      "cancellation_no_double_debit",
      cancellationEntries.length <= 1 && reversalAmount <= expectedAmount,
      "order_cancellation_double_debit",
      { cancellationCount: cancellationEntries.length },
    ),
  ];
  return {
    passed: checks.every((entry) => entry.passed),
    checks,
    expectedAmount,
    actualAmount: reversalAmount,
    refundLedgerEntryIds: refundEntries.map((entry) => entry.id).sort(),
    cancellationLedgerEntryIds: cancellationEntries
      .map((entry) => entry.id)
      .sort(),
    shopifyRefundIds: snapshot.refundIds,
  };
}

function pendingReason(inspection) {
  return inspection.checks.find((entry) => !entry.passed)?.code || null;
}

async function invalidateProbeForReleaseChange(probe, { prismaClient, now }) {
  const updated = await prismaClient.productionTransactionProbe.update({
    where: { id: probe.id },
    data: {
      activeKey: null,
      status: PRODUCTION_TRANSACTION_PROBE_STATUS.INVALIDATED,
      invalidatedAt: now,
      lastCheckedAt: now,
      lastErrorCode: "release_changed",
    },
  });
  return { ok: false, reason: "release_changed", probe: updated };
}

export async function refreshProductionTransactionProbe(
  { probeId, actorKey, releaseExpectation },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    now = new Date(),
  } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (!probe || !ACTIVE_PROBE_STATUSES.includes(probe.status)) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  const release = buildReleaseContext(releaseExpectation);
  if (
    !release.configured ||
    release.releaseFingerprint !== probe.releaseFingerprint
  ) {
    return invalidateProbeForReleaseChange(probe, { prismaClient, now });
  }
  if (!probe.shopifyOrderId) {
    return { ok: true, pending: true, probe };
  }
  const fetched = await fetchShopifyOrderForProductionProbe(
    { shopDomain: probe.shopDomain, orderReference: probe.shopifyOrderId },
    { graphQL },
  );
  if (!fetched.ok) {
    const updated = await prismaClient.productionTransactionProbe.update({
      where: { id: probe.id },
      data: {
        lastCheckedAt: now,
        lastErrorCode: fetched.reason,
      },
    });
    return { ...fetched, probe: updated };
  }
  const local = await loadLocalOrderEvidence(probe, prismaClient);
  const paidInspection = buildPaidInspection({
    probe,
    snapshot: fetched.snapshot,
    local,
  });
  if (!paidInspection.passed) {
    const updated = await prismaClient.productionTransactionProbe.update({
      where: { id: probe.id },
      data: {
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
        lastCheckedAt: now,
        lastErrorCode: pendingReason(paidInspection),
        paidEvidenceJson: paidInspection,
        marketplaceOrderId: paidInspection.marketplaceOrderId,
      },
    });
    return {
      ok: true,
      pending: true,
      stage: "settlement",
      probe: updated,
      paidInspection,
    };
  }
  const refundInspection = buildRefundInspection({
    snapshot: fetched.snapshot,
    local,
    paidInspection,
  });
  if (!refundInspection.passed) {
    const updated = await prismaClient.productionTransactionProbe.update({
      where: { id: probe.id },
      data: {
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND,
        paidVerifiedAt: probe.paidVerifiedAt || now,
        lastCheckedAt: now,
        lastErrorCode: pendingReason(refundInspection),
        paidEvidenceJson: paidInspection,
        refundEvidenceJson: refundInspection,
        marketplaceOrderId: paidInspection.marketplaceOrderId,
      },
    });
    return {
      ok: true,
      pending: true,
      stage: "refund",
      probe: updated,
      paidInspection,
      refundInspection,
    };
  }
  const finalEvidence = {
    version: 1,
    probeId: probe.id,
    shopDomain: probe.shopDomain,
    releaseId: probe.releaseId,
    releaseFingerprint: probe.releaseFingerprint,
    shopifyOrderId: probe.shopifyOrderId,
    marketplaceOrderId: paidInspection.marketplaceOrderId,
    commercialFingerprint: fetched.snapshot.commercialFingerprint,
    paidInspection,
    refundInspection,
    completedAt: now.toISOString(),
    verifiedBy: clean(actorKey) || probe.startedBy,
  };
  const evidenceHash = hashEvidence(finalEvidence);
  const complete = async (tx) => {
    const updated = await tx.productionTransactionProbe.update({
      where: { id: probe.id },
      data: {
        activeKey: null,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.PASSED,
        paidVerifiedAt: probe.paidVerifiedAt || now,
        refundVerifiedAt: now,
        completedAt: now,
        lastCheckedAt: now,
        lastErrorCode: null,
        evidenceHash,
        paidEvidenceJson: paidInspection,
        refundEvidenceJson: refundInspection,
        finalEvidenceJson: finalEvidence,
        marketplaceOrderId: paidInspection.marketplaceOrderId,
      },
    });
    const attestation = await recordOperationalReadinessAttestation(
      {
        checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
        status: OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
        evidenceReference: `production-transaction-probe:${probe.id}`,
        evidenceHash,
        confirmedBy: "system:production-transaction-probe",
        notes: "Shopify実注文、SellerOrder、売上台帳、全額返金を自動照合",
        metadataJson: {
          verificationSource: "production_transaction_probe",
          probeId: probe.id,
          releaseId: probe.releaseId,
          releaseFingerprint: probe.releaseFingerprint,
          completedAt: now.toISOString(),
        },
      },
      { prismaClient: tx, now },
    );
    if (!attestation.ok) {
      throw new Error(
        `production_transaction_probe_attestation_failed:${attestation.reason}`,
      );
    }
    return { updated, attestation };
  };
  const transactionResult =
    typeof prismaClient.$transaction === "function"
      ? await prismaClient.$transaction(complete)
      : await complete(prismaClient);
  return {
    ok: true,
    pending: false,
    stage: "complete",
    probe: transactionResult.updated,
    attestation: transactionResult.attestation.attestation,
    paidInspection,
    refundInspection,
  };
}

export async function cancelProductionTransactionProbe(
  { probeId, actorKey },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (!probe || !ACTIVE_PROBE_STATUSES.includes(probe.status)) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  const updated = await prismaClient.productionTransactionProbe.update({
    where: { id: probe.id },
    data: {
      activeKey: null,
      status: PRODUCTION_TRANSACTION_PROBE_STATUS.CANCELLED,
      lastCheckedAt: now,
      lastErrorCode: `cancelled_by:${clean(actorKey) || "unknown"}`,
    },
  });
  return { ok: true, probe: updated };
}

export async function getProductionTransactionProbePageData(
  { shopDomain, releaseExpectation },
  { prismaClient = prisma } = {},
) {
  const release = buildReleaseContext(releaseExpectation);
  if (!prismaClient?.productionTransactionProbe?.findMany) {
    return {
      available: false,
      reason: "production_transaction_probe_unavailable",
      release,
      activeProbe: null,
      recentProbes: [],
    };
  }
  const shop = normalizeShop(shopDomain);
  const probes = await prismaClient.productionTransactionProbe.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return {
    available: true,
    release,
    activeProbe:
      probes.find(
        (probe) =>
          probe.activeKey === activeKey(shop) &&
          ACTIVE_PROBE_STATUSES.includes(probe.status),
      ) || null,
    recentProbes: probes,
  };
}

export function serializeProductionTransactionProbe(probe) {
  if (!probe) return null;
  return {
    id: probe.id,
    status: probe.status,
    releaseId: probe.releaseId,
    shopDomain: probe.shopDomain,
    shopifyOrderId: probe.shopifyOrderId,
    marketplaceOrderId: probe.marketplaceOrderId,
    startedBy: probe.startedBy,
    startedAt: probe.startedAt,
    orderAttachedAt: probe.orderAttachedAt,
    paidVerifiedAt: probe.paidVerifiedAt,
    refundVerifiedAt: probe.refundVerifiedAt,
    completedAt: probe.completedAt,
    invalidatedAt: probe.invalidatedAt,
    lastCheckedAt: probe.lastCheckedAt,
    lastErrorCode: probe.lastErrorCode,
    evidenceHash: probe.evidenceHash,
    orderEvidence: asObject(probe.orderEvidenceJson),
    paidEvidence: asObject(probe.paidEvidenceJson),
    refundEvidence: asObject(probe.refundEvidenceJson),
  };
}

export function buildProductionTransactionProbePage({
  activeProbe,
  release,
} = {}) {
  const status =
    activeProbe?.status ||
    (release?.configured ? "NOT_STARTED" : "RELEASE_UNCONFIGURED");
  const copy = {
    RELEASE_UNCONFIGURED: {
      tone: "warning",
      statusLabel: "Release未設定",
      instruction:
        "Render commitとShopify App versionを設定し、現在のReleaseを特定できる状態にしてください。",
    },
    NOT_STARTED: {
      tone: "neutral",
      statusLabel: "未開始",
      instruction:
        "確認を開始してから、Shopify標準商品ページで運営直販商品を1点だけ実カードで購入してください。",
    },
    AWAITING_ORDER: {
      tone: "warning",
      statusLabel: "注文待ち",
      instruction:
        "Shopify Paymentsが本番モードであることを確認し、少額の運営直販商品を1点購入して注文番号を入力してください。",
    },
    AWAITING_SETTLEMENT: {
      tone: "warning",
      statusLabel: "売上反映待ち",
      instruction:
        "注文Webhook、SellerOrder、売上台帳の反映を待っています。Shopify側ではまだ返金しないでください。",
    },
    AWAITING_REFUND: {
      tone: "warning",
      statusLabel: "全額返金待ち",
      instruction:
        "売上反映は一致しました。同じ注文をShopify管理画面から全額返金し、在庫戻しは運用方針どおり選択してください。",
    },
    PASSED: {
      tone: "success",
      statusLabel: "完了",
      instruction:
        "注文、売上、全額返金、台帳差引が一致し、本番確認の証跡を自動登録しました。",
    },
    INVALIDATED: {
      tone: "warning",
      statusLabel: "無効",
      instruction:
        "確認中または確認後にReleaseが変わりました。現在のReleaseで新しく確認してください。",
    },
    CANCELLED: {
      tone: "neutral",
      statusLabel: "中止",
      instruction: "必要なときに新しい確認を開始してください。",
    },
  };
  const statusCopy = copy[status] || copy.NOT_STARTED;
  const progress = {
    NOT_STARTED: 0,
    RELEASE_UNCONFIGURED: 0,
    AWAITING_ORDER: 1,
    AWAITING_SETTLEMENT: 2,
    AWAITING_REFUND: 3,
    PASSED: 4,
    INVALIDATED: 0,
    CANCELLED: 0,
  }[status];
  const stepDefinitions = [
    {
      id: "start",
      label: "確認を開始",
      detail: "現在のRelease IDと開始時刻を固定します。",
    },
    {
      id: "order",
      label: "実注文を登録",
      detail:
        "テスト注文、開始前の注文、第三者商品を含む注文は受け付けません。",
    },
    {
      id: "settlement",
      label: "売上反映を照合",
      detail:
        "MarketplaceOrder、SellerOrder、旧計算、売上台帳の件数・金額・通貨を比較します。",
    },
    {
      id: "refund",
      label: "全額返金を照合",
      detail:
        "Shopify返金、商品数量、返金台帳、二重差引の有無を比較して証跡を確定します。",
    },
  ];
  return {
    status,
    ...statusCopy,
    steps: stepDefinitions.map((step, index) => ({
      ...step,
      done: progress > index,
    })),
  };
}

export const PRODUCTION_TRANSACTION_PROBE = Object.freeze({
  apiVersion: SHOPIFY_API_VERSION,
  activeStatuses: ACTIVE_PROBE_STATUSES,
});
