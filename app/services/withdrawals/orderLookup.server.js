import { normalizeShopDomain, shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { normalizeText, sanitizeShopifyLiveStatusError } from "./common.js";
const WITHDRAWAL_ORDER_LIVE_STATUS_QUERY = `#graphql
  query WithdrawalOrderLiveStatus($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        name
        email
        createdAt
        processedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalPriceSet {
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
      }
    }
  }
`;
export async function getWithdrawalShopifyLiveOrderStatus({
  withdrawalRequest,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const shopDomain = normalizeShopDomain(withdrawalRequest?.shopDomain);
  const shopifyOrderId = normalizeShopifyOrderGid(withdrawalRequest?.shopifyOrderId || withdrawalRequest?.orderSnapshotJson?.shopifyOrderId || withdrawalRequest?.orderSnapshotJson?.admin_graphql_api_id || withdrawalRequest?.orderSnapshotJson?.id);
  if (!shopDomain || !shopifyOrderId) {
    return {
      ok: false,
      error: !shopDomain ? "missing_shop_domain" : "missing_shopify_order_id",
      order: null,
      checkedAt: new Date().toISOString()
    };
  }
  try {
    const {
      data,
      shopDomain: resolvedShopDomain
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      query: WITHDRAWAL_ORDER_LIVE_STATUS_QUERY,
      variables: {
        id: shopifyOrderId
      }
    });
    const order = data?.node || null;
    if (!order) {
      return {
        ok: false,
        error: "shopify_order_not_found",
        shopDomain: resolvedShopDomain || shopDomain,
        shopifyOrderId,
        order: null,
        checkedAt: new Date().toISOString()
      };
    }
    return {
      ok: true,
      error: null,
      shopDomain: resolvedShopDomain || shopDomain,
      shopifyOrderId,
      order: serializeLiveShopifyOrderStatus(order),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeShopifyLiveStatusError(error),
      shopDomain,
      shopifyOrderId,
      order: null,
      checkedAt: new Date().toISOString()
    };
  }
}
function normalizeShopifyOrderGid(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/Order/")) return raw;
  const gidMatch = raw.match(/\/Order\/(\d+)/);
  if (gidMatch) return `gid://shopify/Order/${gidMatch[1]}`;
  const numericMatch = raw.match(/\d{6,}/);
  return numericMatch ? `gid://shopify/Order/${numericMatch[0]}` : null;
}
function serializeLiveShopifyOrderStatus(order) {
  const totalPrice = serializeShopifyMoneySet(order.totalPriceSet);
  const currentTotalPrice = serializeShopifyMoneySet(order.currentTotalPriceSet);
  const totalRefunded = serializeShopifyMoneySet(order.totalRefundedSet);
  return {
    id: order.id,
    name: order.name,
    email: order.email,
    createdAt: order.createdAt || null,
    processedAt: order.processedAt || null,
    cancelledAt: order.cancelledAt || null,
    cancelReason: order.cancelReason || null,
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    totalAmount: totalPrice.amount,
    currentTotalAmount: currentTotalPrice.amount,
    totalRefundedAmount: totalRefunded.amount,
    currencyCode: currentTotalPrice.currencyCode || totalPrice.currencyCode || totalRefunded.currencyCode || null
  };
}
function serializeShopifyMoneySet(value) {
  const money = value?.shopMoney || value?.presentmentMoney || null;
  const amount = Number(money?.amount);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currencyCode: money?.currencyCode || null
  };
}
