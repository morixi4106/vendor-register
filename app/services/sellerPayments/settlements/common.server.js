import prisma from "../../../db.server.js";
import { JAPAN_POST_AIR_PACKET_RATE_SOURCE, JAPAN_POST_AIR_PACKET_RATE_VERSION } from "../../japanPostAirPacket.server.js";
import { buildProductComplianceSnapshot, buildSellerGovernanceSnapshot } from "../../marketplaceGovernance.server.js";
import { DEFAULT_ORDER_CURRENCY, SALES_CREDIT_PAYMENT_RISK_CLASSES, SALES_CREDIT_PAYMENT_RISK_RATE_BPS } from "../constants.js";
import { clampInteger, isPlainObject, moneyAmountToMinorUnits, normalizeLowercase, normalizeText, toPositiveInteger } from "../values.js";
import { SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES, normalizeShopifyGid } from "../shared.server.js";
export const SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES = ["shopify_order_paid", ...SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES];
export const SELLER_ORDER_SHADOW_CHECK_STATUSES = {
  MATCHED: "matched",
  AMOUNT_MISMATCH: "amount_mismatch",
  SELLER_MISMATCH: "seller_mismatch",
  MULTI_SELLER_DETECTED: "multi_seller_detected",
  SHADOW_WRITTEN: "shadow_written",
  FAILED: "failed"
};
export function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
export function isSellerOrderShadowWriteEnabled(env = process.env) {
  return normalizeLowercase(env.SELLER_ORDER_SHADOW_WRITE_ENABLED) === "true";
}
export function hasSellerOrderShadowModels(prismaClient) {
  return Boolean(prismaClient?.marketplaceOrder?.upsert && prismaClient?.sellerOrder?.upsert && prismaClient?.sellerOrderLine?.upsert && prismaClient?.sellerOrderShadowCheck?.create);
}
export function normalizeShopifyOrderId(payload) {
  return normalizeShopifyGid("Order", payload?.admin_graphql_api_id) || normalizeShopifyGid("Order", payload?.id);
}
export function getShopifyOrderAttribute(payload, key) {
  const targetKey = normalizeText(key);
  if (!targetKey) {
    return null;
  }
  const candidates = [...(Array.isArray(payload?.note_attributes) ? payload.note_attributes : []), ...(Array.isArray(payload?.custom_attributes) ? payload.custom_attributes : []), ...(Array.isArray(payload?.customAttributes) ? payload.customAttributes : [])];
  for (const attribute of candidates) {
    const attributeKey = normalizeText(attribute?.name || attribute?.key);
    if (attributeKey === targetKey) {
      return normalizeText(attribute?.value);
    }
  }
  return null;
}
export function getSalesCreditOffsetFromPaidEntries(entries = []) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const metadata = isPlainObject(entry?.metadataJson) ? entry.metadataJson : null;
    const offsetId = normalizeText(metadata?.salesCreditOffsetId);
    const amount = toPositiveInteger(metadata?.salesCreditOffsetAmount);
    if (offsetId && amount != null) {
      return {
        offsetId,
        amount,
        buyerSellerId: normalizeText(metadata?.salesCreditBuyerSellerId)
      };
    }
  }
  return null;
}
export function getShopifyLineProductIdCandidates(lineItem) {
  return uniqueValues([normalizeShopifyGid("Product", lineItem?.product_id), normalizeShopifyGid("Product", lineItem?.product?.id), normalizeShopifyGid("Product", lineItem?.product?.admin_graphql_api_id), normalizeText(lineItem?.product_id)]);
}
export function getShopifyLineVariantIdCandidates(lineItem) {
  const normalizedVariantId = normalizeShopifyVariantId(lineItem);
  return uniqueValues([normalizedVariantId, normalizedVariantId?.replace("gid://shopify/ProductVariant/", ""), normalizeShopifyGid("ProductVariant", lineItem?.variant_id), normalizeShopifyGid("ProductVariant", lineItem?.variant?.id), normalizeShopifyGid("ProductVariant", lineItem?.variant?.admin_graphql_api_id), normalizeText(lineItem?.variant_id)]);
}
export function getLineDiscountAmount(lineItem, currencyCode) {
  const discountAllocations = Array.isArray(lineItem?.discount_allocations) ? lineItem.discount_allocations : [];
  if (discountAllocations.length > 0) {
    return discountAllocations.reduce((total, allocation) => {
      const amount = allocation?.amount_set?.shop_money?.amount ?? allocation?.amount_set?.presentment_money?.amount ?? allocation?.amount;
      return total + moneyAmountToMinorUnits(amount, currencyCode);
    }, 0);
  }
  return moneyAmountToMinorUnits(lineItem?.total_discount, currencyCode);
}
export function normalizeStringList(values = []) {
  return uniqueValues((Array.isArray(values) ? values : [values]).map(value => normalizeText(value)).filter(Boolean));
}
export function collectShopifyPaymentGatewayNames(payload) {
  return normalizeStringList([...(Array.isArray(payload?.payment_gateway_names) ? payload.payment_gateway_names : []), payload?.gateway, payload?.payment_gateway_name, payload?.processing_method, payload?.source_name, ...(Array.isArray(payload?.transactions) ? payload.transactions.flatMap(transaction => [transaction?.gateway, transaction?.payment_gateway_name, transaction?.source_name]) : [])]);
}
export function isTruthyPaymentRiskValue(value) {
  if (value === true) {
    return true;
  }
  const normalized = normalizeLowercase(value);
  return ["1", "true", "yes", "y", "authenticated", "successful", "success", "passed"].includes(normalized);
}
export function isThreeDSecureAuthenticatedValue(value) {
  if (isTruthyPaymentRiskValue(value)) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (isTruthyPaymentRiskValue(value.liability_shifted) || isTruthyPaymentRiskValue(value.liabilityShifted) || isTruthyPaymentRiskValue(value.authenticated)) {
    return true;
  }
  const statusCandidates = [value.status, value.result, value.authentication_status, value.authenticationStatus, value.trans_status, value.transStatus];
  if (statusCandidates.some(isTruthyPaymentRiskValue)) {
    return true;
  }
  const eci = normalizeText(value.eci);
  return eci === "05" || eci === "02";
}
export function collectThreeDSecureCandidates(value, depth = 0) {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return [];
    }
    try {
      return collectThreeDSecureCandidates(JSON.parse(trimmed), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectThreeDSecureCandidates(item, depth + 1));
  }
  if (!isPlainObject(value)) {
    return [];
  }
  const candidates = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizeLowercase(key) || "";
    if (normalizedKey.includes("3d") || normalizedKey.includes("three_d") || normalizedKey.includes("threed") || normalizedKey.includes("liability_shift") || normalizedKey === "eci") {
      candidates.push(nestedValue);
      if (isPlainObject(nestedValue)) {
        candidates.push(nestedValue);
      }
    }
    candidates.push(...collectThreeDSecureCandidates(nestedValue, depth + 1));
  }
  return candidates;
}
export function hasThreeDSecureAuthentication(payload) {
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const candidates = [payload?.three_d_secure, payload?.threeDSecure, payload?.payment_details?.three_d_secure, payload?.payment_details?.threeDSecure, payload?.paymentDetails?.three_d_secure, payload?.paymentDetails?.threeDSecure, ...transactions.flatMap(transaction => [transaction?.three_d_secure, transaction?.threeDSecure, transaction?.payment_details?.three_d_secure, transaction?.payment_details?.threeDSecure, transaction?.paymentDetails?.three_d_secure, transaction?.paymentDetails?.threeDSecure, transaction?.receipt?.three_d_secure, transaction?.receipt?.threeDSecure, transaction?.receiptJson?.three_d_secure, transaction?.receiptJson?.threeDSecure]), ...collectThreeDSecureCandidates(payload?.receiptJson), ...transactions.flatMap(transaction => collectThreeDSecureCandidates(transaction?.receiptJson))];
  return candidates.some(isThreeDSecureAuthenticatedValue);
}
export function gatewayNamesContainAny(gatewayNames, needles) {
  const normalizedNames = gatewayNames.map(name => normalizeLowercase(name));
  return normalizedNames.some(name => needles.some(needle => name?.includes(needle)));
}
export function inferShopifyOrderSalesCreditPaymentRisk(payload = {}) {
  const gatewayNames = collectShopifyPaymentGatewayNames(payload);
  const threeDSecureAuthenticated = hasThreeDSecureAuthentication(payload);
  if (threeDSecureAuthenticated) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
      rateBps: SALES_CREDIT_PAYMENT_RISK_RATE_BPS[SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED],
      reason: "three_d_secure_authenticated",
      gatewayNames,
      threeDSecureAuthenticated
    };
  }
  if (gatewayNamesContainAny(gatewayNames, ["bank transfer", "bank_transfer", "furikomi", "convenience", "konbini", "cash on delivery", "cod", "manual", "銀行振込", "コンビニ"])) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED,
      rateBps: SALES_CREDIT_PAYMENT_RISK_RATE_BPS[SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED],
      reason: "non_card_confirmed_gateway",
      gatewayNames,
      threeDSecureAuthenticated
    };
  }
  if (gatewayNamesContainAny(gatewayNames, ["card", "visa", "mastercard", "master card", "jcb", "american express", "amex", "shopify payments", "shopify_payments"])) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED,
      rateBps: SALES_CREDIT_PAYMENT_RISK_RATE_BPS[SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED],
      reason: "card_without_3ds_signal",
      gatewayNames,
      threeDSecureAuthenticated
    };
  }
  return {
    riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN,
    rateBps: SALES_CREDIT_PAYMENT_RISK_RATE_BPS[SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN],
    reason: "payment_risk_unknown",
    gatewayNames,
    threeDSecureAuthenticated
  };
}
export function getSellerOrderPaymentStatusAfterRefund({
  paidAmount,
  refundAmount,
  fallback = "paid"
}) {
  const normalizedPaidAmount = clampInteger(paidAmount);
  const normalizedRefundAmount = clampInteger(refundAmount);
  if (normalizedPaidAmount > 0 && normalizedRefundAmount >= normalizedPaidAmount) {
    return "refunded";
  }
  if (normalizedRefundAmount > 0) {
    return "partially_refunded";
  }
  return fallback || "paid";
}
export async function findShopifyOrderLedgerEntries(shopifyOrderId, prismaClient) {
  if (!shopifyOrderId) {
    return [];
  }
  return prismaClient.ledgerEntry.findMany({
    where: {
      entryType: {
        in: SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES
      },
      OR: [{
        stripeObjectId: shopifyOrderId
      }, {
        metadataJson: {
          path: ["shopifyOrderId"],
          equals: shopifyOrderId
        }
      }]
    }
  });
}
export function summarizeShopifyOrderLedgerEntries(entries, sellerId = null) {
  const sellerLedgerEntries = sellerId ? entries.filter(entry => entry?.sellerId === sellerId) : entries;
  const paidAmount = sellerLedgerEntries.filter(entry => entry?.entryType === "shopify_order_paid").reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const reversedAmount = sellerLedgerEntries.filter(entry => SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES.includes(entry?.entryType)).reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  return {
    paidAmount,
    reversedAmount,
    remainingAmount: Math.max(0, paidAmount - reversedAmount),
    hasPaidEntry: paidAmount > 0
  };
}
export function compareProductMatchPriority(a, b, shopDomain) {
  const aExact = normalizeLowercase(a?.shopDomain) === shopDomain ? 0 : 1;
  const bExact = normalizeLowercase(b?.shopDomain) === shopDomain ? 0 : 1;
  return aExact - bExact;
}
export function getProductSeller(product) {
  return product?.vendorStore?.seller || product?.vendorStore?.vendorAuth?.seller || null;
}
export function getProductVendor(product) {
  return product?.vendorStore?.vendorAuth || getProductSeller(product)?.vendor || null;
}
export function buildProductCandidateMap(products, shopDomain) {
  const sortedProducts = [...products].sort((a, b) => compareProductMatchPriority(a, b, shopDomain));
  const productMap = new Map();
  for (const product of sortedProducts) {
    for (const candidate of uniqueValues([product?.shopifyVariantId, product?.shopifyVariantId?.replace("gid://shopify/ProductVariant/", ""), product?.shopifyProductId, product?.shopifyProductId?.replace("gid://shopify/Product/", "")])) {
      if (!productMap.has(candidate)) {
        productMap.set(candidate, product);
      }
    }
  }
  return productMap;
}
export function normalizeShopifyLineItemId(lineItem, index = 0) {
  return normalizeShopifyGid("LineItem", lineItem?.admin_graphql_api_id) || normalizeShopifyGid("LineItem", lineItem?.id) || normalizeText(lineItem?.id) || `line:${index + 1}`;
}
export function normalizeShopifyVariantId(lineItem) {
  return normalizeShopifyGid("ProductVariant", lineItem?.variant_id) || normalizeShopifyGid("ProductVariant", lineItem?.variant?.id) || normalizeShopifyGid("ProductVariant", lineItem?.variant?.admin_graphql_api_id) || normalizeText(lineItem?.variant_id);
}
export function getShopifyLineTaxAmount(lineItem, currencyCode) {
  const taxLines = Array.isArray(lineItem?.tax_lines) ? lineItem.tax_lines : [];
  return taxLines.reduce((total, taxLine) => {
    const amount = taxLine?.price_set?.shop_money?.amount ?? taxLine?.price_set?.presentment_money?.amount ?? taxLine?.price;
    return total + moneyAmountToMinorUnits(amount, currencyCode);
  }, 0);
}
export function getShopifyLineAmountBreakdown(lineItem, currencyCode) {
  const quantity = toPositiveInteger(lineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(lineItem?.price_set?.shop_money?.amount ?? lineItem?.price_set?.presentment_money?.amount ?? lineItem?.price, currencyCode);
  const lineSubtotalAmount = unitAmount * quantity;
  const discountAmount = getLineDiscountAmount(lineItem, currencyCode);
  const taxAmount = getShopifyLineTaxAmount(lineItem, currencyCode);
  return {
    quantity,
    unitAmount,
    lineSubtotalAmount,
    discountAmount,
    taxAmount,
    netAmount: Math.max(0, lineSubtotalAmount - discountAmount)
  };
}
export function getShopifyOrderShippingAmount(payload, currencyCode) {
  const shippingLines = Array.isArray(payload?.shipping_lines) ? payload.shipping_lines : [];
  return shippingLines.reduce((total, shippingLine) => {
    const amount = shippingLine?.price_set?.shop_money?.amount ?? shippingLine?.price_set?.presentment_money?.amount ?? shippingLine?.price;
    return total + moneyAmountToMinorUnits(amount, currencyCode);
  }, 0);
}
export function buildCarrierShippingRateSnapshot(payload, currencyCode) {
  const shippingLines = Array.isArray(payload?.shipping_lines) ? payload.shipping_lines : [];
  const airPacketLines = shippingLines.filter(shippingLine => {
    const code = normalizeLowercase(shippingLine?.code || shippingLine?.source || shippingLine?.title);
    return code.includes("shipping_v2_jp_air_packet_");
  });
  if (airPacketLines.length === 0) {
    return null;
  }
  const bandQuantities = new Map();
  const zones = new Set();
  for (const shippingLine of airPacketLines) {
    const code = normalizeLowercase(shippingLine?.code || shippingLine?.source || shippingLine?.title);
    const metadataMatch = code.match(/_z([1-5])_b([0-9a-z]+x[0-9a-z]+(?:\.[0-9a-z]+x[0-9a-z]+)*)$/);
    if (!metadataMatch) {
      continue;
    }
    zones.add(Number.parseInt(metadataMatch[1], 36));
    for (const token of metadataMatch[2].split(".")) {
      const [bandToken, quantityToken] = token.split("x");
      const bandUnits = Number.parseInt(bandToken, 36);
      const quantity = Number.parseInt(quantityToken, 36);
      if (!Number.isInteger(bandUnits) || bandUnits <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
        continue;
      }
      const weightBandGrams = bandUnits * 100;
      bandQuantities.set(weightBandGrams, (bandQuantities.get(weightBandGrams) || 0) + quantity);
    }
  }
  const encodedQuoteMetadata = zones.size === 1 && bandQuantities.size > 0 ? {
    zone: Array.from(zones)[0],
    weightBands: Array.from(bandQuantities.entries()).sort(([left], [right]) => left - right).map(([weightBandGrams, quantity]) => ({
      weightBandGrams,
      quantity
    }))
  } : {};
  return {
    source: JAPAN_POST_AIR_PACKET_RATE_SOURCE,
    rateVersion: JAPAN_POST_AIR_PACKET_RATE_VERSION,
    currencyCode,
    chargedAmount: airPacketLines.reduce((total, shippingLine) => {
      const amount = shippingLine?.price_set?.shop_money?.amount ?? shippingLine?.price_set?.presentment_money?.amount ?? shippingLine?.price;
      return total + moneyAmountToMinorUnits(amount, currencyCode);
    }, 0),
    serviceCodes: airPacketLines.map(shippingLine => normalizeText(shippingLine?.code || shippingLine?.source)).filter(Boolean),
    lineCount: airPacketLines.length,
    snapshotSource: "shopify_shipping_lines",
    ...encodedQuoteMetadata
  };
}
export function normalizeDateValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function normalizeBuyerName(payload) {
  const customer = isPlainObject(payload?.customer) ? payload.customer : {};
  return normalizeText([payload?.billing_address?.first_name || payload?.shipping_address?.first_name || customer?.first_name, payload?.billing_address?.last_name || payload?.shipping_address?.last_name || customer?.last_name].filter(Boolean).join(" "));
}
export function buildMarketplaceOrderSnapshot({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode
}) {
  const rawShippingRateSnapshot = getShopifyOrderAttribute(payload, "shipping_v2_snapshot");
  let shippingRateSnapshot = null;
  if (rawShippingRateSnapshot) {
    try {
      const parsedSnapshot = JSON.parse(rawShippingRateSnapshot);
      shippingRateSnapshot = isPlainObject(parsedSnapshot) ? parsedSnapshot : null;
    } catch {
      shippingRateSnapshot = {
        invalid: true
      };
    }
  } else {
    shippingRateSnapshot = buildCarrierShippingRateSnapshot(payload, currencyCode);
  }
  return {
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    shopifyOrderNumber: normalizeText(payload?.order_number),
    buyerEmail: normalizeText(payload?.email || payload?.customer?.email),
    buyerName: normalizeBuyerName(payload),
    totalAmount: moneyAmountToMinorUnits(payload?.total_price_set?.shop_money?.amount ?? payload?.total_price_set?.presentment_money?.amount ?? payload?.total_price, currencyCode),
    subtotalAmount: moneyAmountToMinorUnits(payload?.subtotal_price_set?.shop_money?.amount ?? payload?.subtotal_price_set?.presentment_money?.amount ?? payload?.subtotal_price, currencyCode),
    shippingAmount: getShopifyOrderShippingAmount(payload, currencyCode),
    discountAmount: moneyAmountToMinorUnits(payload?.total_discounts_set?.shop_money?.amount ?? payload?.total_discounts_set?.presentment_money?.amount ?? payload?.total_discounts, currencyCode),
    taxAmount: moneyAmountToMinorUnits(payload?.total_tax_set?.shop_money?.amount ?? payload?.total_tax_set?.presentment_money?.amount ?? payload?.total_tax, currencyCode),
    currencyCode,
    financialStatus: normalizeLowercase(payload?.financial_status),
    fulfillmentStatus: normalizeLowercase(payload?.fulfillment_status),
    processedAt: normalizeDateValue(payload?.processed_at || payload?.created_at),
    cancelledAt: normalizeDateValue(payload?.cancelled_at),
    metadataJson: {
      source: "shopify_order_paid_shadow",
      shopifyOrderNumericId: normalizeText(payload?.id),
      lineItemCount: Array.isArray(payload?.line_items) ? payload.line_items.length : 0,
      shippingRateSnapshot
    }
  };
}
export function buildSellerOrderShadowBuckets({
  matchedLines,
  currencyCode,
  salesCreditOffset
}) {
  const bucketsBySellerId = new Map();
  matchedLines.forEach(({
    lineItem,
    product
  }, index) => {
    const seller = getProductSeller(product);
    const sellerId = normalizeText(seller?.id);
    if (!sellerId) {
      return;
    }
    const vendor = getProductVendor(product);
    const vendorStoreId = normalizeText(product?.vendorStoreId || product?.vendorStore?.id);
    const breakdown = getShopifyLineAmountBreakdown(lineItem, currencyCode);
    const bucket = bucketsBySellerId.get(sellerId) || {
      sellerId,
      vendorStoreId,
      vendorId: normalizeText(vendor?.id),
      vendorHandle: normalizeText(vendor?.handle),
      sellerSubtotalAmount: 0,
      sellerDiscountAmount: 0,
      sellerTaxAmount: 0,
      sellerNetItemAmount: 0,
      sellerNetAmount: 0,
      sellerPayableAmount: 0,
      salesCreditOffsetAmount: 0,
      lines: []
    };
    bucket.sellerSubtotalAmount += breakdown.lineSubtotalAmount;
    bucket.sellerDiscountAmount += breakdown.discountAmount;
    bucket.sellerTaxAmount += breakdown.taxAmount;
    bucket.sellerNetItemAmount += breakdown.netAmount;
    bucket.sellerNetAmount += breakdown.netAmount;
    bucket.sellerPayableAmount += breakdown.netAmount;
    bucket.lines.push({
      shopifyLineItemId: normalizeShopifyLineItemId(lineItem, index),
      shopifyProductId: normalizeText(product?.shopifyProductId) || getShopifyLineProductIdCandidates(lineItem)[0] || null,
      shopifyVariantId: normalizeShopifyVariantId(lineItem),
      productId: normalizeText(product?.id),
      title: normalizeText(lineItem?.title || product?.name),
      sku: normalizeText(lineItem?.sku),
      ...breakdown,
      currencyCode,
      metadataJson: {
        shopifyProductIdFromLine: normalizeText(lineItem?.product_id),
        localProductName: normalizeText(product?.name)
      }
    });
    bucketsBySellerId.set(sellerId, bucket);
  });
  const buckets = Array.from(bucketsBySellerId.values());
  const salesCreditAmount = clampInteger(salesCreditOffset?.amount);
  if (salesCreditAmount > 0 && buckets.length === 1) {
    buckets[0].salesCreditOffsetAmount = salesCreditAmount;
    buckets[0].sellerNetAmount += salesCreditAmount;
    buckets[0].sellerPayableAmount += salesCreditAmount;
  }
  return buckets;
}
export function buildSellerOrderShadowStatus({
  ledgerEntry,
  sellerBuckets,
  multiSellerDetected
}) {
  if (multiSellerDetected) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.MULTI_SELLER_DETECTED;
  }
  if (!ledgerEntry) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.SHADOW_WRITTEN;
  }
  const calculatedAmount = sellerBuckets.reduce((total, bucket) => total + bucket.sellerPayableAmount, 0);
  const sellerIds = uniqueValues(sellerBuckets.map(bucket => bucket.sellerId));
  if (ledgerEntry.sellerId && sellerIds.length === 1 && sellerIds[0] !== ledgerEntry.sellerId) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.SELLER_MISMATCH;
  }
  if (ledgerEntry.amount !== calculatedAmount) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.AMOUNT_MISMATCH;
  }
  return SELLER_ORDER_SHADOW_CHECK_STATUSES.MATCHED;
}
export function buildShopifyOrderPaidSettlementBuckets(matchedLines) {
  const bucketsBySellerId = new Map();
  for (const matchedLine of Array.isArray(matchedLines) ? matchedLines : []) {
    const seller = getProductSeller(matchedLine?.product);
    const sellerId = normalizeText(seller?.id);
    if (!sellerId) {
      continue;
    }
    const vendor = getProductVendor(matchedLine?.product);
    const bucket = bucketsBySellerId.get(sellerId) || {
      seller,
      sellerId,
      vendor,
      amount: 0,
      matchedLines: []
    };
    bucket.amount += clampInteger(matchedLine?.amount);
    bucket.matchedLines.push(matchedLine);
    bucketsBySellerId.set(sellerId, bucket);
  }
  return Array.from(bucketsBySellerId.values());
}
export async function createSellerOrderShadowFailureCheck({
  prismaClient,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode = DEFAULT_ORDER_CURRENCY,
  error
}) {
  if (!prismaClient?.sellerOrderShadowCheck?.create) {
    return null;
  }
  try {
    return await prismaClient.sellerOrderShadowCheck.create({
      data: {
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        currencyCode: normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
        errorMessage: normalizeText(error?.message) || "seller_order_shadow_failed"
      }
    });
  } catch (shadowError) {
    console.error("seller order shadow failure check error:", shadowError);
    return null;
  }
}
export async function recordShopifyOrderSellerOrderShadow({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  matchedLines,
  ledgerEntry = null,
  salesCreditOffset = null,
  multiSellerDetected = false,
  writeSellerOrders = true,
  forceWrite = false,
  settlementStatus = "shadow",
  riskStatus = "normal",
  riskMetadata = null
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  if (!forceWrite && !isSellerOrderShadowWriteEnabled(env)) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_write_disabled"
    };
  }
  if (!hasSellerOrderShadowModels(prismaClient)) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_models_unavailable"
    };
  }
  try {
    const normalizedCurrencyCode = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
    const marketplaceData = buildMarketplaceOrderSnapshot({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode: normalizedCurrencyCode
    });
    const sellerBuckets = buildSellerOrderShadowBuckets({
      matchedLines,
      currencyCode: normalizedCurrencyCode,
      salesCreditOffset
    });
    const calculatedAmount = sellerBuckets.reduce((total, bucket) => total + bucket.sellerPayableAmount, 0);
    const sellerIds = uniqueValues(sellerBuckets.map(bucket => bucket.sellerId));
    const productIds = uniqueValues(sellerBuckets.flatMap(bucket => bucket.lines.map(line => line.productId).filter(Boolean)));
    // Never manufacture checkout evidence from the configuration that happens
    // to be current when a delayed paid webhook arrives.
    const checkoutReference = getShopifyOrderAttribute(payload, "checkout_reference") || null;
    const checkoutEvidence = checkoutReference && prismaClient?.marketplaceCheckoutEvidence?.findUnique ? await prismaClient.marketplaceCheckoutEvidence.findUnique({
      where: {
        checkoutReference
      }
    }) : null;
    const agreementVersion = checkoutEvidence?.sellerAgreementVersion || getShopifyOrderAttribute(payload, "seller_agreement_version") || "UNRECORDED";
    const buyerTermsVersion = checkoutEvidence?.buyerTermsVersion || getShopifyOrderAttribute(payload, "buyer_terms_version") || null;
    const buyerTermsHash = checkoutEvidence?.buyerTermsHash || getShopifyOrderAttribute(payload, "buyer_terms_hash") || null;
    const buyerTermsUrl = checkoutEvidence?.buyerTermsUrl || getShopifyOrderAttribute(payload, "buyer_terms_url") || null;
    const buyerTermsLocale = checkoutEvidence?.buyerTermsLocale || getShopifyOrderAttribute(payload, "buyer_terms_locale") || null;
    const buyerTermsPresentedAt = normalizeDateValue(checkoutEvidence?.presentedAt) || normalizeDateValue(getShopifyOrderAttribute(payload, "buyer_terms_presented_at"));
    const buyerTermsEvidenceComplete = Boolean(buyerTermsVersion && /^[a-f0-9]{64}$/i.test(buyerTermsHash || "") && buyerTermsUrl && buyerTermsLocale && buyerTermsPresentedAt && checkoutReference);
    Object.assign(marketplaceData, {
      buyerTermsVersion,
      buyerTermsHash,
      buyerTermsUrl,
      buyerTermsLocale,
      buyerTermsPresentedAt,
      checkoutReference,
      metadataJson: {
        ...(marketplaceData.metadataJson || {}),
        buyerTermsEvidenceStatus: buyerTermsEvidenceComplete ? checkoutEvidence ? "DATABASE_CHECKOUT_CAPTURED" : "ORDER_ATTRIBUTE_CAPTURED" : "MISSING_OR_INCOMPLETE"
      }
    });
    const capturedSellerSnapshotById = new Map((Array.isArray(checkoutEvidence?.sellerSnapshotsJson) ? checkoutEvidence.sellerSnapshotsJson : []).filter(entry => normalizeText(entry?.sellerId) && entry?.snapshot).map(entry => [normalizeText(entry.sellerId), entry.snapshot]));
    const capturedProductSnapshotById = new Map((Array.isArray(checkoutEvidence?.productSnapshotsJson) ? checkoutEvidence.productSnapshotsJson : []).filter(entry => normalizeText(entry?.productId) && entry?.snapshot).map(entry => [normalizeText(entry.productId), entry.snapshot]));
    const sourceSellerById = new Map();
    const sourceProductById = new Map();
    for (const {
      product
    } of matchedLines) {
      const sourceSeller = getProductSeller(product);
      if (sourceSeller?.id) {
        sourceSellerById.set(sourceSeller.id, {
          ...sourceSeller,
          vendorStore: product?.vendorStore || sourceSeller.vendorStore || null
        });
      }
      if (product?.id) sourceProductById.set(product.id, product);
    }
    const [sellerProfiles, agreementAcceptances, productProfiles] = await Promise.all([prismaClient?.sellerComplianceProfile?.findMany ? prismaClient.sellerComplianceProfile.findMany({
      where: {
        sellerId: {
          in: sellerIds
        }
      }
    }) : [], prismaClient?.sellerAgreementAcceptance?.findMany ? checkoutEvidence?.sellerAgreementHash ? prismaClient.sellerAgreementAcceptance.findMany({
      where: {
        sellerId: {
          in: sellerIds
        },
        agreementType: "SELLER_MASTER",
        version: agreementVersion,
        documentHash: checkoutEvidence.sellerAgreementHash,
        revokedAt: null
      }
    }) : [] : [], prismaClient?.productComplianceProfile?.findMany ? prismaClient.productComplianceProfile.findMany({
      where: {
        productId: {
          in: productIds
        }
      }
    }) : []]);
    const sellerProfileById = new Map(sellerProfiles.map(profile => [profile.sellerId, profile]));
    const agreementsBySellerId = new Map();
    for (const acceptance of agreementAcceptances) {
      const current = agreementsBySellerId.get(acceptance.sellerId) || [];
      current.push(acceptance);
      agreementsBySellerId.set(acceptance.sellerId, current);
    }
    const productProfileById = new Map(productProfiles.map(profile => [profile.productId, profile]));
    const sellerSnapshotById = new Map(sellerIds.map(sellerId => [sellerId, capturedSellerSnapshotById.get(sellerId) || buildSellerGovernanceSnapshot({
      ...sourceSellerById.get(sellerId),
      id: sellerId,
      complianceProfile: sellerProfileById.get(sellerId) || null,
      agreementAcceptances: agreementsBySellerId.get(sellerId) || []
    }, {
      agreementVersion,
      agreementDocumentHash: checkoutEvidence?.sellerAgreementHash,
      buyerTermsVersion
    })]));
    const productSnapshotById = new Map(productIds.map(productId => [productId, capturedProductSnapshotById.get(productId) || buildProductComplianceSnapshot({
      ...sourceProductById.get(productId),
      id: productId,
      complianceProfile: productProfileById.get(productId) || null
    })]));
    const marketplaceOrder = await prismaClient.marketplaceOrder.upsert({
      where: {
        shopDomain_shopifyOrderId: {
          shopDomain,
          shopifyOrderId
        }
      },
      update: {
        financialStatus: marketplaceData.financialStatus,
        fulfillmentStatus: marketplaceData.fulfillmentStatus,
        cancelledAt: marketplaceData.cancelledAt
      },
      create: marketplaceData
    });
    const writtenSellerOrders = [];
    if (checkoutEvidence && prismaClient.marketplaceCheckoutEvidence?.update) {
      await prismaClient.marketplaceCheckoutEvidence.update({
        where: {
          id: checkoutEvidence.id
        },
        data: {
          status: "ORDER_CAPTURED",
          shopifyOrderId,
          orderCapturedAt: new Date()
        }
      });
    }
    if (writeSellerOrders && !multiSellerDetected) {
      for (const bucket of sellerBuckets) {
        const governanceSnapshot = sellerSnapshotById.get(bucket.sellerId) || {
          governanceSnapshotVersion: null,
          buyerTermsVersion,
          legalSellerSnapshotJson: null,
          sellerAgreementSnapshotJson: null
        };
        const sellerOrderData = {
          marketplaceOrderId: marketplaceOrder.id,
          shopifyOrderId,
          shopifyOrderName,
          sellerId: bucket.sellerId,
          vendorStoreId: bucket.vendorStoreId,
          sellerSubtotalAmount: bucket.sellerSubtotalAmount,
          sellerDiscountAmount: bucket.sellerDiscountAmount,
          sellerRefundAmount: 0,
          sellerNetAmount: bucket.sellerNetAmount,
          sellerPayableAmount: bucket.sellerPayableAmount,
          shippingQuotedAmount: 0,
          shippingChargedAmount: 0,
          shippingAllocationMethod: "not_allocated",
          currencyCode: normalizedCurrencyCode,
          paymentStatus: "paid",
          fulfillmentStatus: "unfulfilled",
          settlementStatus,
          riskStatus,
          governanceSnapshotVersion: governanceSnapshot.governanceSnapshotVersion,
          legalSellerSnapshotJson: governanceSnapshot.legalSellerSnapshotJson,
          sellerAgreementSnapshotJson: governanceSnapshot.sellerAgreementSnapshotJson,
          buyerTermsVersion: governanceSnapshot.buyerTermsVersion,
          buyerTermsHash,
          buyerTermsUrl,
          buyerTermsLocale,
          buyerTermsPresentedAt,
          checkoutReference,
          metadataJson: {
            vendorId: bucket.vendorId,
            vendorHandle: bucket.vendorHandle,
            sellerNetItemAmount: bucket.sellerNetItemAmount,
            sellerTaxAmount: bucket.sellerTaxAmount,
            salesCreditOffsetId: salesCreditOffset?.offsetId || null,
            salesCreditOffsetAmount: bucket.salesCreditOffsetAmount,
            ...(riskMetadata && typeof riskMetadata === "object" ? {
              saleEligibilityReview: riskMetadata
            } : {})
          }
        };
        const sellerOrder = await prismaClient.sellerOrder.upsert({
          where: {
            marketplaceOrderId_sellerId: {
              marketplaceOrderId: marketplaceOrder.id,
              sellerId: bucket.sellerId
            }
          },
          update: {
            shopifyOrderName: sellerOrderData.shopifyOrderName,
            ...(forceWrite ? {
              settlementStatus,
              riskStatus,
              metadataJson: sellerOrderData.metadataJson
            } : {})
          },
          create: sellerOrderData
        });
        writtenSellerOrders.push(sellerOrder);
        for (const line of bucket.lines) {
          const complianceSnapshot = line.productId ? productSnapshotById.get(line.productId) || null : null;
          const governedLine = {
            ...line,
            legalSellerSnapshotJson: governanceSnapshot.legalSellerSnapshotJson,
            complianceSnapshotJson: complianceSnapshot,
            sellerAgreementVersion: agreementVersion
          };
          await prismaClient.sellerOrderLine.upsert({
            where: {
              sellerOrderId_shopifyLineItemId: {
                sellerOrderId: sellerOrder.id,
                shopifyLineItemId: line.shopifyLineItemId
              }
            },
            update: {},
            create: {
              ...governedLine,
              sellerOrderId: sellerOrder.id
            }
          });
        }
      }
    }
    const status = buildSellerOrderShadowStatus({
      ledgerEntry,
      sellerBuckets,
      multiSellerDetected
    });
    const shadowCheck = await prismaClient.sellerOrderShadowCheck.create({
      data: {
        marketplaceOrderId: marketplaceOrder.id,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        status,
        currencyCode: normalizedCurrencyCode,
        legacyLedgerAmount: ledgerEntry?.amount ?? null,
        sellerOrderCalculatedAmount: calculatedAmount,
        legacySellerIdsJson: ledgerEntry?.sellerId ? [ledgerEntry.sellerId] : [],
        sellerOrderSellerIdsJson: sellerIds,
        differencesJson: {
          legacyLedgerEntryId: ledgerEntry?.id || null,
          multiSellerDetected,
          sellerOrderCount: writtenSellerOrders.length,
          lineCount: sellerBuckets.reduce((total, bucket) => total + bucket.lines.length, 0)
        }
      }
    });
    return {
      ok: true,
      marketplaceOrder,
      sellerOrders: writtenSellerOrders,
      shadowCheck,
      status
    };
  } catch (error) {
    console.error("seller order shadow write error:", error);
    await createSellerOrderShadowFailureCheck({
      prismaClient,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      error
    });
    return {
      ok: false,
      reason: "seller_order_shadow_write_failed",
      errorMessage: normalizeText(error?.message)
    };
  }
}
