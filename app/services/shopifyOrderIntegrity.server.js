import prisma from "../db.server.js";
import { processShopifyOrderPaidSettlement } from "./sellerPayments.server.js";
import { POST_ORDER_ELIGIBILITY_TRIGGER } from "./saleEligibility.server.js";
import { recordOperationalHeartbeatSafely } from "./operationalHealth.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";

export const SHOPIFY_ORDER_INTEGRITY_HEARTBEAT_KEY =
  "shopify_order_integrity_reconciliation";

const SHOPIFY_API_VERSION = "2026-04";
const RECONCILIATION_LOOKBACK_HOURS = 48;
const RECONCILIATION_MAX_ORDERS = 100;

const ORDER_INTEGRITY_QUERY = `#graphql
  query OrderForIntegrityReconciliation($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      updatedAt
      cancelledAt
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      email
      customAttributes {
        key
        value
      }
      shippingAddress {
        countryCodeV2
      }
      billingAddress {
        countryCodeV2
      }
      lineItems(first: 250) {
        nodes {
          id
          name
          title
          quantity
          currentQuantity
          requiresShipping
          sku
          customAttributes {
            key
            value
          }
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
  }
`;

const RECENT_ORDERS_QUERY = `#graphql
  query RecentOrdersForIntegrityReconciliation(
    $first: Int!
    $after: String
    $query: String!
  ) {
    orders(
      first: $first
      after: $after
      query: $query
      sortKey: UPDATED_AT
      reverse: true
    ) {
      nodes {
        id
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function toAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function lineItemToWebhookShape(lineItem) {
  const quantity = Math.max(
    0,
    Number(lineItem?.currentQuantity ?? lineItem?.quantity ?? 0),
  );
  const unitAmount = toAmount(
    lineItem?.originalUnitPriceSet?.shopMoney?.amount,
  );
  const discountedTotal = toAmount(
    lineItem?.discountedTotalSet?.shopMoney?.amount,
  );
  const grossTotal = unitAmount * quantity;

  return {
    id: lineItem?.id || null,
    admin_graphql_api_id: lineItem?.id || null,
    product_id: lineItem?.product?.id || null,
    variant_id: lineItem?.variant?.id || null,
    product: lineItem?.product || null,
    variant: lineItem?.variant || null,
    title: lineItem?.title || lineItem?.name || "",
    name: lineItem?.name || lineItem?.title || "",
    sku: lineItem?.sku || null,
    quantity,
    requires_shipping: lineItem?.requiresShipping !== false,
    price: String(unitAmount),
    price_set: {
      shop_money: {
        amount: String(unitAmount),
        currency_code:
          lineItem?.originalUnitPriceSet?.shopMoney?.currencyCode || null,
      },
    },
    total_discount: String(Math.max(0, grossTotal - discountedTotal)),
    properties: Array.isArray(lineItem?.customAttributes)
      ? lineItem.customAttributes.map((attribute) => ({
          name: attribute?.key || "",
          value: attribute?.value || "",
        }))
      : [],
  };
}

export function shopifyOrderToIntegrityPayload(order) {
  if (!order?.id) return null;
  const lineItems = Array.isArray(order?.lineItems?.nodes)
    ? order.lineItems.nodes
        .map(lineItemToWebhookShape)
        .filter((lineItem) => lineItem.quantity > 0)
    : [];

  return {
    id: order.id,
    admin_graphql_api_id: order.id,
    name: order.name,
    created_at: order.createdAt,
    processed_at: order.processedAt || order.createdAt,
    updated_at: order.updatedAt,
    cancelled_at: order.cancelledAt,
    currency: order.currencyCode,
    presentment_currency: order.currencyCode,
    financial_status: normalizeText(order.displayFinancialStatus).toLowerCase(),
    fulfillment_status: normalizeText(
      order.displayFulfillmentStatus,
    ).toLowerCase(),
    email: order.email || null,
    note_attributes: Array.isArray(order.customAttributes)
      ? order.customAttributes.map((attribute) => ({
          name: attribute?.key || "",
          value: attribute?.value || "",
        }))
      : [],
    shipping_address: order.shippingAddress
      ? { country_code: order.shippingAddress.countryCodeV2 || null }
      : null,
    billing_address: order.billingAddress
      ? { country_code: order.billingAddress.countryCodeV2 || null }
      : null,
    line_items: lineItems,
  };
}

function isPaidOrder(order) {
  return ["PAID", "PARTIALLY_REFUNDED"].includes(
    normalizeText(order?.displayFinancialStatus).toUpperCase(),
  );
}

function isTerminalOrder(order) {
  const fulfillmentStatus = normalizeText(
    order?.displayFulfillmentStatus,
  ).toUpperCase();
  return Boolean(
    order?.cancelledAt ||
    ["FULFILLED", "RESTOCKED"].includes(fulfillmentStatus),
  );
}

export async function reconcileShopifyOrderIntegrity(
  {
    shopDomain,
    shopifyOrderId,
    triggerType = POST_ORDER_ELIGIBILITY_TRIGGER.PERIODIC_RECONCILIATION,
  },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    processPaidSettlement = processShopifyOrderPaidSettlement,
    env = process.env,
  } = {},
) {
  const normalizedShop = normalizeText(shopDomain).toLowerCase();
  const normalizedOrderId = normalizeText(shopifyOrderId);
  if (!normalizedShop || !normalizedOrderId) {
    return { ok: false, reason: "order_integrity_input_invalid" };
  }

  const response = await graphQL({
    shopDomain: normalizedShop,
    apiVersion: SHOPIFY_API_VERSION,
    query: ORDER_INTEGRITY_QUERY,
    variables: { id: normalizedOrderId },
  });
  const order = response?.data?.order || null;
  if (!order?.id) {
    return { ok: false, reason: "shopify_order_not_found" };
  }
  if (order.lineItems?.pageInfo?.hasNextPage) {
    return {
      ok: false,
      reason: "shopify_order_line_items_incomplete",
      shopifyOrderId: order.id,
    };
  }
  if (!isPaidOrder(order) || isTerminalOrder(order)) {
    return {
      ok: true,
      skipped: true,
      reason: !isPaidOrder(order) ? "order_not_paid" : "order_already_terminal",
      shopifyOrderId: order.id,
    };
  }

  const payload = shopifyOrderToIntegrityPayload(order);
  if (!payload?.line_items?.length) {
    return {
      ok: false,
      reason: "shopify_order_current_lines_empty",
      shopifyOrderId: order.id,
    };
  }

  return processPaidSettlement(
    { payload, shop: normalizedShop },
    {
      prismaClient,
      env,
      shopifyGraphQLWithOfflineSessionImpl: graphQL,
      integrityOnly: true,
      integrityTrigger: triggerType,
      verifyOrderTimeProjection: false,
    },
  );
}

export async function reconcileRecentShopifyOrderIntegrity(
  {
    shopDomain,
    lookbackHours = RECONCILIATION_LOOKBACK_HOURS,
    limit = RECONCILIATION_MAX_ORDERS,
  },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    reconcileOrder = reconcileShopifyOrderIntegrity,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const normalizedShop = normalizeText(shopDomain).toLowerCase();
  const boundedLimit = Math.max(
    1,
    Math.min(Number(limit) || RECONCILIATION_MAX_ORDERS, 250),
  );
  const boundedLookbackHours = Math.max(
    1,
    Math.min(Number(lookbackHours) || RECONCILIATION_LOOKBACK_HOURS, 168),
  );
  const since = new Date(now.getTime() - boundedLookbackHours * 60 * 60 * 1000);
  const query = `updated_at:>=${since.toISOString()}`;
  const orderIds = [];
  let after = null;
  let pageCount = 0;
  let paginationIncomplete = false;

  while (orderIds.length < boundedLimit && pageCount < 10) {
    pageCount += 1;
    const pageSize = Math.min(50, boundedLimit - orderIds.length);
    const response = await graphQL({
      shopDomain: normalizedShop,
      apiVersion: SHOPIFY_API_VERSION,
      query: RECENT_ORDERS_QUERY,
      variables: { first: pageSize, after, query },
    });
    const connection = response?.data?.orders;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    for (const order of nodes) {
      if (isPaidOrder(order) && !isTerminalOrder(order)) {
        orderIds.push(order.id);
      }
    }
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      break;
    }
    if (pageCount >= 10 && orderIds.length < boundedLimit) {
      paginationIncomplete = true;
      break;
    }
    after = connection.pageInfo.endCursor;
  }

  const results = [];
  for (const shopifyOrderId of orderIds.slice(0, boundedLimit)) {
    try {
      results.push(
        await reconcileOrder(
          {
            shopDomain: normalizedShop,
            shopifyOrderId,
            triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.PERIODIC_RECONCILIATION,
          },
          { prismaClient, graphQL, env },
        ),
      );
    } catch (error) {
      results.push({
        ok: false,
        shopifyOrderId,
        reason: "order_integrity_reconciliation_failed",
        errorCode: normalizeText(error?.code || error?.name || "error"),
      });
    }
  }

  const failedCount = results.filter((result) => result?.ok !== true).length;
  const quarantinedCount = results.filter(
    (result) => result?.quarantined === true,
  ).length;
  const summary = {
    ok: failedCount === 0 && !paginationIncomplete,
    shopDomain: normalizedShop,
    scanned: orderIds.length,
    pageCount,
    paginationIncomplete,
    failedCount,
    quarantinedCount,
    checkedAt: now.toISOString(),
  };

  await recordOperationalHeartbeatSafely(
    {
      key: SHOPIFY_ORDER_INTEGRITY_HEARTBEAT_KEY,
      status: summary.ok ? "succeeded" : "failed",
      errorCode: summary.ok
        ? null
        : "shopify_order_integrity_reconciliation_incomplete",
      metadataJson: summary,
    },
    { prismaClient },
  );

  return { ...summary, results };
}

export const SHOPIFY_ORDER_INTEGRITY = Object.freeze({
  apiVersion: SHOPIFY_API_VERSION,
  defaultLookbackHours: RECONCILIATION_LOOKBACK_HOURS,
  maxOrders: RECONCILIATION_MAX_ORDERS,
});
