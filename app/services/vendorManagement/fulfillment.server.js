import prisma from "../../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { buildCarrierTrackingUrl, getShippingCarrierById } from "../../utils/shippingCarriers.js";
import { SHOPIFY_API_VERSION } from "../../utils/shopifyApiVersion.js";
import { createOrderSettlementSummary, createSellerOrderSettlementSummary, getFirstUserErrorMessage, getLedgerMetadata, isReconnectableShopifyError, listVendorStoreShopDomains } from "./common.js";
const VENDOR_ORDER_FULFILLMENT_TARGET_QUERY = `
  query VendorOrderFulfillmentTarget($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      tags
      displayFinancialStatus
      displayFulfillmentStatus
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              totalQuantity
              lineItem {
                id
              }
            }
          }
          assignedLocation {
            name
            location {
              id
              name
            }
          }
        }
      }
    }
  }
`;
const VENDOR_ORDER_FULFILLMENT_CREATE_MUTATION = `
  mutation VendorOrderFulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
    fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
async function listVendorOrderSettlementLedgerEntries({
  storeId,
  orderId
}, {
  prismaClient = prisma
} = {}) {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    return [];
  }
  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      seller: {
        is: {
          vendorStoreId: storeId
        }
      },
      OR: [{
        entryType: "shopify_order_paid",
        stripeObjectId: normalizedOrderId
      }, {
        entryType: "refund"
      }]
    },
    orderBy: [{
      occurredAt: "desc"
    }, {
      createdAt: "desc"
    }],
    take: 200,
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true
    }
  });
  return entries.filter(entry => {
    if (entry.entryType === "shopify_order_paid") {
      return String(entry.stripeObjectId || "").trim() === normalizedOrderId;
    }
    if (entry.entryType === "refund") {
      return String(getLedgerMetadata(entry).shopifyOrderId || "").trim() === normalizedOrderId;
    }
    return false;
  });
}
function parseTrackingUrl(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return null;
  try {
    const url = new URL(normalizedValue);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    return url.toString();
  } catch {
    return false;
  }
}
export function parseShipmentRegistrationInput(formLike) {
  const getValue = typeof formLike?.get === "function" ? key => formLike.get(key) : key => formLike?.[key];
  const orderId = String(getValue("orderId") || "").trim();
  const sellerOrderId = String(getValue("sellerOrderId") || "").trim();
  const trackingNumber = String(getValue("trackingNumber") || "").trim();
  const trackingCarrierId = String(getValue("trackingCarrierId") || "").trim();
  const carrier = getShippingCarrierById(trackingCarrierId);
  const trackingUrlOverride = parseTrackingUrl(getValue("trackingUrl"));
  const notifyCustomer = String(getValue("notifyCustomer") || "") === "on";
  if (!orderId.startsWith("gid://shopify/Order/")) {
    return {
      ok: false,
      status: 400,
      error: "注文情報が不正です。"
    };
  }
  if (!trackingNumber) {
    return {
      ok: false,
      status: 400,
      error: "追跡番号を入力してください。"
    };
  }
  if (!carrier) {
    return {
      ok: false,
      status: 400,
      error: "配送会社を選択してください。"
    };
  }
  if (trackingNumber.length > 120) {
    return {
      ok: false,
      status: 400,
      error: "追跡番号は120文字以内で入力してください。"
    };
  }
  if (trackingUrlOverride === false) {
    return {
      ok: false,
      status: 400,
      error: "追跡URLは https:// から始まるURLで入力してください。"
    };
  }
  const trackingUrl = trackingUrlOverride || buildCarrierTrackingUrl(carrier, trackingNumber);
  return {
    ok: true,
    orderId,
    sellerOrderId: sellerOrderId || null,
    trackingNumber,
    trackingCarrierId: carrier.id,
    trackingCompany: carrier.shopifyCompany,
    trackingCompanyLabel: carrier.label,
    trackingUrl,
    notifyCustomer
  };
}
function toPublicFulfillmentError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (isReconnectableShopifyError(message)) {
    return "公開ストアとの接続確認が必要です。管理者に連絡してください。";
  }
  if (message.includes("ACCESS_DENIED") || message.includes("access denied") || message.includes("merchant_managed_fulfillment_orders") || message.includes("fulfill_and_ship_orders")) {
    return "発送登録に必要な権限が不足しています。管理者に連絡してください。";
  }
  return "発送登録に失敗しました。時間を置いて再度お試しください。";
}
function getFulfillableFulfillmentOrders(order) {
  const nodes = order?.fulfillmentOrders?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(fulfillmentOrder => {
    const status = String(fulfillmentOrder?.status || "").trim();
    const requestStatus = String(fulfillmentOrder?.requestStatus || "").trim();
    if (!["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(status)) {
      return false;
    }
    if (["SUBMITTED", "ACCEPTED", "CANCELLATION_REQUESTED", "CANCELLATION_REJECTED"].includes(requestStatus)) {
      return false;
    }
    return Boolean(fulfillmentOrder?.id);
  });
}
function toFulfillmentQuantity(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.floor(numberValue));
}
function getFulfillmentOrderLineItemNodes(fulfillmentOrder) {
  const nodes = fulfillmentOrder?.lineItems?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}
function buildSellerOrderFulfillmentGroups({
  fulfillmentOrders,
  sellerOrder
}) {
  const sellerLines = Array.isArray(sellerOrder?.lines) ? sellerOrder.lines : [];
  const remainingByShopifyLineItemId = new Map();
  for (const line of sellerLines) {
    const shopifyLineItemId = String(line?.shopifyLineItemId || "").trim();
    if (!shopifyLineItemId) continue;
    const quantity = toFulfillmentQuantity(line?.quantity);
    const fulfilledQuantity = toFulfillmentQuantity(line?.fulfilledQuantity);
    const refundedQuantity = toFulfillmentQuantity(line?.refundedQuantity);
    const remainingQuantity = Math.max(0, quantity - fulfilledQuantity - refundedQuantity);
    if (remainingQuantity > 0) {
      remainingByShopifyLineItemId.set(shopifyLineItemId, remainingQuantity);
    }
  }
  const groups = [];
  for (const fulfillmentOrder of fulfillmentOrders) {
    const fulfillmentOrderLineItems = [];
    for (const fulfillmentOrderLineItem of getFulfillmentOrderLineItemNodes(fulfillmentOrder)) {
      const shopifyLineItemId = String(fulfillmentOrderLineItem?.lineItem?.id || "").trim();
      const sellerRemainingQuantity = remainingByShopifyLineItemId.get(shopifyLineItemId) || 0;
      if (sellerRemainingQuantity <= 0) continue;
      const fulfillmentRemainingQuantity = toFulfillmentQuantity(fulfillmentOrderLineItem?.remainingQuantity);
      const fallbackTotalQuantity = toFulfillmentQuantity(fulfillmentOrderLineItem?.totalQuantity);
      const maxFulfillableQuantity = fulfillmentRemainingQuantity > 0 ? fulfillmentRemainingQuantity : fallbackTotalQuantity;
      const quantity = Math.min(sellerRemainingQuantity, maxFulfillableQuantity);
      if (quantity <= 0) continue;
      fulfillmentOrderLineItems.push({
        id: fulfillmentOrderLineItem.id,
        quantity,
        shopifyLineItemId
      });
      remainingByShopifyLineItemId.set(shopifyLineItemId, sellerRemainingQuantity - quantity);
    }
    if (fulfillmentOrderLineItems.length > 0) {
      groups.push({
        fulfillmentOrder,
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems
      });
    }
  }
  return groups;
}
function buildFulfillmentInput({
  fulfillmentOrders,
  shipment,
  sellerFulfillmentGroups = null
}) {
  const trackingInfo = {
    number: shipment.trackingNumber
  };
  if (shipment.trackingCompany) {
    trackingInfo.company = shipment.trackingCompany;
  }
  if (shipment.trackingUrl) {
    trackingInfo.url = shipment.trackingUrl;
  }
  const lineItemsByFulfillmentOrder = Array.isArray(sellerFulfillmentGroups) ? sellerFulfillmentGroups.map(group => ({
    fulfillmentOrderId: group.fulfillmentOrderId,
    fulfillmentOrderLineItems: group.fulfillmentOrderLineItems.map(line => ({
      id: line.id,
      quantity: line.quantity
    }))
  })) : fulfillmentOrders.map(fulfillmentOrder => ({
    fulfillmentOrderId: fulfillmentOrder.id
  }));
  return {
    lineItemsByFulfillmentOrder,
    notifyCustomer: shipment.notifyCustomer,
    trackingInfo
  };
}
async function findVendorSellerOrderForShipment({
  prismaClient,
  storeId,
  shipment
}) {
  const sellerOrderId = String(shipment?.sellerOrderId || "").trim();
  if (!sellerOrderId || !prismaClient?.sellerOrder?.findFirst) {
    return null;
  }
  return prismaClient.sellerOrder.findFirst({
    where: {
      id: sellerOrderId,
      vendorStoreId: storeId,
      shopifyOrderId: shipment.orderId
    },
    select: {
      id: true,
      shopifyOrderId: true,
      sellerRefundAmount: true,
      sellerNetAmount: true,
      sellerPayableAmount: true,
      currencyCode: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      settlementStatus: true,
      riskStatus: true,
      metadataJson: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          quantity: true,
          fulfilledQuantity: true,
          refundedQuantity: true
        }
      }
    }
  });
}
async function markSellerOrderShipmentRegistered({
  prismaClient,
  sellerOrder,
  sellerFulfillmentGroups,
  fulfillmentId,
  shipment
}) {
  if (!sellerOrder?.id || !prismaClient?.sellerOrder?.update || !prismaClient?.sellerOrderLine?.update) {
    return;
  }
  const fulfilledByShopifyLineItemId = new Map();
  const sellerLineByShopifyLineItemId = new Map();
  const sellerShipmentLines = [];
  for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
    const shopifyLineItemId = String(line?.shopifyLineItemId || "").trim();
    if (shopifyLineItemId) {
      sellerLineByShopifyLineItemId.set(shopifyLineItemId, line);
    }
  }
  for (const group of Array.isArray(sellerFulfillmentGroups) ? sellerFulfillmentGroups : []) {
    for (const line of group.fulfillmentOrderLineItems || []) {
      fulfilledByShopifyLineItemId.set(line.shopifyLineItemId, (fulfilledByShopifyLineItemId.get(line.shopifyLineItemId) || 0) + line.quantity);
      const sellerOrderLine = sellerLineByShopifyLineItemId.get(line.shopifyLineItemId);
      if (sellerOrderLine?.id && line?.id && group?.fulfillmentOrderId) {
        sellerShipmentLines.push({
          sellerOrderLineId: sellerOrderLine.id,
          shopifyLineItemId: line.shopifyLineItemId || null,
          shopifyFulfillmentOrderId: group.fulfillmentOrderId,
          shopifyFulfillmentOrderLineItemId: line.id,
          quantity: toFulfillmentQuantity(line.quantity)
        });
      }
    }
  }
  let fulfilledLineCount = 0;
  for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
    const fulfilledQuantity = fulfilledByShopifyLineItemId.get(line.shopifyLineItemId) || 0;
    if (fulfilledQuantity <= 0) continue;
    fulfilledLineCount += 1;
    await prismaClient.sellerOrderLine.update({
      where: {
        id: line.id
      },
      data: {
        fulfilledQuantity: Math.min(toFulfillmentQuantity(line.quantity), toFulfillmentQuantity(line.fulfilledQuantity) + fulfilledQuantity)
      }
    });
  }
  if (fulfilledLineCount === 0) return;
  const shippedAt = new Date();
  let sellerShipment = null;
  if (prismaClient?.sellerShipment?.create && sellerShipmentLines.length > 0) {
    sellerShipment = await prismaClient.sellerShipment.create({
      data: {
        sellerOrderId: sellerOrder.id,
        shopifyFulfillmentId: fulfillmentId || null,
        trackingNumber: shipment.trackingNumber || null,
        trackingCompany: shipment.trackingCompany || null,
        trackingUrl: shipment.trackingUrl || null,
        status: "registered",
        shippedAt,
        metadataJson: {
          source: "vendor_portal"
        },
        lines: {
          create: sellerShipmentLines
        }
      },
      select: {
        id: true
      }
    });
  }
  const existingMetadata = sellerOrder.metadataJson && typeof sellerOrder.metadataJson === "object" && !Array.isArray(sellerOrder.metadataJson) ? sellerOrder.metadataJson : {};
  await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id
    },
    data: {
      fulfillmentStatus: "fulfilled",
      metadataJson: {
        ...existingMetadata,
        lastShipment: {
          fulfillmentId: fulfillmentId || null,
          sellerShipmentId: sellerShipment?.id || null,
          trackingNumber: shipment.trackingNumber,
          trackingCompany: shipment.trackingCompany || null,
          trackingUrl: shipment.trackingUrl || null,
          shippedAt: shippedAt.toISOString()
        }
      }
    }
  });
}
export async function createVendorOrderFulfillment({
  storeId,
  vendorHandle,
  shipment,
  listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  prismaClient = prisma
}) {
  const shopDomains = await listVendorStoreShopDomainsImpl(storeId);
  if (shopDomains.length !== 1) {
    return {
      ok: false,
      status: 400,
      error: shopDomains.length === 0 ? "公開ストアとの接続情報を確認中です。" : "公開ストアの接続先を確認中です。"
    };
  }
  try {
    const shopDomain = shopDomains[0];
    const {
      data: targetData
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VENDOR_ORDER_FULFILLMENT_TARGET_QUERY,
      variables: {
        orderId: shipment.orderId
      }
    });
    const order = targetData?.order;
    if (!order?.id) {
      return {
        ok: false,
        status: 404,
        error: "注文が見つかりません。"
      };
    }
    const tags = Array.isArray(order.tags) ? order.tags : [];
    const hasVendorStorefrontTag = tags.includes("vendor-storefront");
    const hasMatchingVendorTag = tags.includes(`vendor:${vendorHandle}`);
    if (hasVendorStorefrontTag && !hasMatchingVendorTag) {
      return {
        ok: false,
        status: 403,
        error: "この注文は現在の店舗では発送登録できません。"
      };
    }
    const sellerOrder = await findVendorSellerOrderForShipment({
      prismaClient,
      storeId,
      shipment
    });
    if (shipment.sellerOrderId && !sellerOrder) {
      return {
        ok: false,
        status: 404,
        error: "この注文は現在の店舗では発送登録できません。"
      };
    }
    if (sellerOrder && (sellerOrder.riskStatus !== "normal" || ["held", "review", "quarantined"].includes(String(sellerOrder.settlementStatus || "").toLowerCase()))) {
      return {
        ok: false,
        status: 409,
        error: "この注文は確認中のため発送できません。運営の確認完了をお待ちください。"
      };
    }
    const settlementSummary = sellerOrder ? createSellerOrderSettlementSummary(sellerOrder) : createOrderSettlementSummary(shipment.orderId, await listVendorOrderSettlementLedgerEntries({
      storeId,
      orderId: shipment.orderId
    }, {
      prismaClient
    }));
    if (!sellerOrder && !hasVendorStorefrontTag) {
      if (!settlementSummary.hasPaidLedger) {
        return {
          ok: false,
          status: 403,
          error: "この注文は現在の店舗では発送登録できません。"
        };
      }
    }
    if (settlementSummary.fullyRefunded) {
      return {
        ok: false,
        status: 400,
        error: "返金済みの注文は発送登録できません。"
      };
    }
    if (order.displayFinancialStatus !== "PAID") {
      return {
        ok: false,
        status: 400,
        error: "支払い確認後に発送登録できます。"
      };
    }
    if (order.displayFulfillmentStatus === "FULFILLED") {
      return {
        ok: false,
        status: 400,
        error: "この注文はすでに発送済みです。"
      };
    }
    const fulfillmentOrders = getFulfillableFulfillmentOrders(order);
    if (fulfillmentOrders.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "発送できる注文行がありません。"
      };
    }
    const sellerFulfillmentGroups = sellerOrder ? buildSellerOrderFulfillmentGroups({
      fulfillmentOrders,
      sellerOrder
    }) : null;
    const fulfillmentOrdersForShipment = sellerFulfillmentGroups ? sellerFulfillmentGroups.map(group => group.fulfillmentOrder) : fulfillmentOrders;
    if (sellerOrder && sellerFulfillmentGroups.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "この店舗で発送できる未発送の商品がありません。"
      };
    }
    const locationKeys = Array.from(new Set(fulfillmentOrdersForShipment.map(fulfillmentOrder => fulfillmentOrder?.assignedLocation?.location?.id || fulfillmentOrder?.assignedLocation?.name || "unknown")));
    if (locationKeys.length > 1) {
      return {
        ok: false,
        status: 400,
        error: "複数の発送元に分かれた注文です。管理者側で発送登録してください。"
      };
    }
    const {
      data: createData
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VENDOR_ORDER_FULFILLMENT_CREATE_MUTATION,
      variables: {
        fulfillment: buildFulfillmentInput({
          fulfillmentOrders,
          shipment,
          sellerFulfillmentGroups
        }),
        message: "Shipment registered from vendor portal."
      }
    });
    const payload = createData?.fulfillmentCreate;
    const userError = getFirstUserErrorMessage(payload?.userErrors, null);
    if (!payload || userError) {
      return {
        ok: false,
        status: 400,
        error: userError || "発送登録に失敗しました。"
      };
    }
    await markSellerOrderShipmentRegistered({
      prismaClient,
      sellerOrder,
      sellerFulfillmentGroups,
      fulfillmentId: payload.fulfillment?.id || null,
      shipment
    });
    return {
      ok: true,
      orderId: order.id,
      orderName: order.name,
      fulfillmentId: payload.fulfillment?.id || null,
      message: `${order.name || "注文"}を発送済みにしました。`
    };
  } catch (error) {
    console.error("vendor fulfillment create error:", error);
    return {
      ok: false,
      status: 500,
      error: toPublicFulfillmentError(error)
    };
  }
}
