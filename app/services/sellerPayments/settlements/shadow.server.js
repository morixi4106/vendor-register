import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, decimalAmountFromMinorUnits, isPlainObject, normalizeBooleanInput, normalizeLowercase, normalizeText, normalizeUppercase, subtractDays, toPositiveInteger } from "../values.js";
import { normalizeShopifyGid } from "../shared.server.js";
import { SELLER_ORDER_SHADOW_CHECK_STATUSES, buildProductCandidateMap, hasSellerOrderShadowModels, recordShopifyOrderSellerOrderShadow, uniqueValues } from "./common.server.js";
function getLedgerMetadataJson(ledgerEntry) {
  return isPlainObject(ledgerEntry?.metadataJson) ? ledgerEntry.metadataJson : {};
}
function getBackfillLedgerShopifyOrderId(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return normalizeText(ledgerEntry?.stripeObjectId) || normalizeText(metadata.shopifyOrderId);
}
function getBackfillLedgerShopDomain(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return normalizeLowercase(metadata.shopDomain);
}
function getBackfillLedgerLineItems(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return Array.isArray(metadata.lineItems) ? metadata.lineItems : [];
}
function buildSyntheticShopifyOrderPayloadFromLedger({
  ledgerEntry,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  lineItems
}) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  const processedAt = ledgerEntry?.occurredAt || ledgerEntry?.createdAt || new Date();
  const totalAmount = decimalAmountFromMinorUnits(ledgerEntry?.amount, currencyCode);
  return {
    id: normalizeText(metadata.shopifyOrderNumericId),
    admin_graphql_api_id: shopifyOrderId,
    name: shopifyOrderName,
    order_number: normalizeText(metadata.shopifyOrderNumber),
    shop_domain: shopDomain,
    currency: normalizeUppercase(currencyCode),
    financial_status: "paid",
    processed_at: processedAt instanceof Date ? processedAt.toISOString() : normalizeText(processedAt),
    total_price: totalAmount,
    subtotal_price: totalAmount,
    total_discounts: "0",
    total_tax: "0",
    line_items: lineItems
  };
}
function buildSyntheticShopifyLineItemFromLedgerLine({
  line,
  product,
  currencyCode,
  index
}) {
  const lineAmount = clampInteger(line?.amount);
  const quantity = toPositiveInteger(line?.quantity) || 1;
  const unitAmount = quantity > 0 ? Math.ceil(lineAmount / quantity) : lineAmount;
  const discountAmount = Math.max(0, unitAmount * quantity - lineAmount);
  const shopifyLineItemId = normalizeShopifyGid("LineItem", line?.shopifyLineItemId) || normalizeText(line?.shopifyLineItemId) || `backfill:${index + 1}`;
  return {
    id: shopifyLineItemId,
    admin_graphql_api_id: shopifyLineItemId,
    product_id: normalizeText(line?.shopifyProductId || product?.shopifyProductId),
    variant_id: normalizeText(line?.shopifyVariantId || product?.shopifyVariantId),
    title: normalizeText(line?.localProductName || product?.name),
    sku: normalizeText(line?.sku),
    price: decimalAmountFromMinorUnits(unitAmount, currencyCode),
    quantity,
    discount_allocations: discountAmount > 0 ? [{
      amount: decimalAmountFromMinorUnits(discountAmount, currencyCode)
    }] : [],
    tax_lines: [],
    properties: [{
      name: "backfill_ledger_line_amount",
      value: String(lineAmount)
    }]
  };
}
function buildSalesCreditOffsetFromLedger(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  const amount = clampInteger(metadata.salesCreditOffsetAmount);
  if (amount <= 0) {
    return null;
  }
  return {
    offsetId: normalizeText(metadata.salesCreditOffsetId),
    amount,
    buyerSellerId: normalizeText(metadata.salesCreditBuyerSellerId)
  };
}
async function createSellerOrderShadowBackfillFailureCheck({
  prismaClient,
  ledgerEntry,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  reason,
  differences = {}
}) {
  if (!prismaClient?.sellerOrderShadowCheck?.create) {
    return null;
  }
  return prismaClient.sellerOrderShadowCheck.create({
    data: {
      shopDomain: shopDomain || "unknown",
      shopifyOrderId: shopifyOrderId || `ledger:${ledgerEntry?.id || "unknown"}`,
      shopifyOrderName,
      status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
      currencyCode: normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
      legacyLedgerAmount: clampInteger(ledgerEntry?.amount),
      sellerOrderCalculatedAmount: 0,
      legacySellerIdsJson: ledgerEntry?.sellerId ? [ledgerEntry.sellerId] : [],
      sellerOrderSellerIdsJson: [],
      differencesJson: {
        source: "seller_order_shadow_backfill",
        legacyLedgerEntryId: ledgerEntry?.id || null,
        reason,
        ...differences
      },
      errorMessage: reason
    }
  });
}
export async function backfillSellerOrderShadowChecks({
  days = 30,
  limit = 100,
  retryFailed = false,
  now = new Date()
} = {}, {
  prismaClient = prisma
} = {}) {
  if (!hasSellerOrderShadowModels(prismaClient) || !prismaClient?.sellerOrderShadowCheck?.findFirst || !prismaClient?.ledgerEntry?.findMany || !prismaClient?.product?.findMany) {
    return {
      ok: false,
      reason: "seller_order_shadow_backfill_unavailable",
      scanned: 0,
      created: 0,
      skippedExisting: 0,
      failed: 0,
      results: []
    };
  }
  const normalizedLimit = Math.min(Math.max(clampInteger(limit, 100), 1), 300);
  const normalizedDays = Math.min(Math.max(clampInteger(days, 30), 1), 365);
  const shouldRetryFailed = normalizeBooleanInput(retryFailed);
  const since = subtractDays(now, normalizedDays);
  const ledgerEntries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "shopify_order_paid",
      direction: "credit",
      occurredAt: {
        gte: since
      }
    },
    orderBy: {
      occurredAt: "desc"
    },
    take: normalizedLimit
  });
  const results = [];
  let created = 0;
  let skippedExisting = 0;
  let failed = 0;
  for (const ledgerEntry of ledgerEntries) {
    const metadata = getLedgerMetadataJson(ledgerEntry);
    const shopDomain = getBackfillLedgerShopDomain(ledgerEntry);
    const shopifyOrderId = getBackfillLedgerShopifyOrderId(ledgerEntry);
    const shopifyOrderName = normalizeText(metadata.shopifyOrderName);
    const currencyCode = normalizeLowercase(ledgerEntry?.currencyCode || metadata.currencyCode) || DEFAULT_ORDER_CURRENCY;
    if (!shopDomain || !shopifyOrderId) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason: "backfill_order_identity_missing"
      });
      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: "backfill_order_identity_missing",
        ledgerEntryId: ledgerEntry?.id,
        shadowCheckId: shadowCheck?.id || null
      });
      continue;
    }
    const existingShadowCheck = await prismaClient.sellerOrderShadowCheck.findFirst({
      where: {
        shopDomain,
        shopifyOrderId
      },
      orderBy: {
        checkedAt: "desc"
      }
    });
    if (existingShadowCheck && !(shouldRetryFailed && existingShadowCheck.status === SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED)) {
      skippedExisting += 1;
      results.push({
        ok: true,
        skipped: true,
        reason: "shadow_check_exists",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: existingShadowCheck.id
      });
      continue;
    }
    const ledgerLineItems = getBackfillLedgerLineItems(ledgerEntry);
    if (ledgerLineItems.length === 0) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason: "backfill_line_items_missing"
      });
      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: "backfill_line_items_missing",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowCheck?.id || null
      });
      continue;
    }
    const localProductIds = uniqueValues(ledgerLineItems.map(line => line?.localProductId));
    const shopifyProductIds = uniqueValues(ledgerLineItems.flatMap(line => [line?.shopifyProductId, normalizeShopifyGid("Product", line?.shopifyProductId)]));
    const shopifyVariantIds = uniqueValues(ledgerLineItems.flatMap(line => [line?.shopifyVariantId, normalizeShopifyGid("ProductVariant", line?.shopifyVariantId)]));
    const productWhereClauses = [];
    if (localProductIds.length > 0) {
      productWhereClauses.push({
        id: {
          in: localProductIds
        }
      });
    }
    if (shopifyProductIds.length > 0) {
      productWhereClauses.push({
        shopifyProductId: {
          in: shopifyProductIds
        }
      });
    }
    if (shopifyVariantIds.length > 0) {
      productWhereClauses.push({
        shopifyVariantId: {
          in: shopifyVariantIds
        }
      });
    }
    const products = productWhereClauses.length > 0 ? await prismaClient.product.findMany({
      where: {
        OR: productWhereClauses
      },
      select: {
        id: true,
        name: true,
        approvalStatus: true,
        shopifyProductId: true,
        shopifyVariantId: true,
        shopDomain: true,
        vendorStoreId: true,
        vendorStore: {
          select: {
            id: true,
            storeName: true,
            seller: {
              select: {
                id: true,
                status: true,
                stripeAccount: true
              }
            },
            vendorAuth: {
              select: {
                id: true,
                handle: true,
                storeName: true,
                seller: {
                  select: {
                    id: true,
                    status: true,
                    stripeAccount: true
                  }
                }
              }
            }
          }
        }
      }
    }) : [];
    const productsByLocalId = new Map(products.map(product => [normalizeText(product?.id), product]));
    const productMap = buildProductCandidateMap(products, shopDomain);
    const matchedLines = [];
    const unmatchedLines = [];
    const syntheticLineItems = [];
    ledgerLineItems.forEach((line, index) => {
      const product = productsByLocalId.get(normalizeText(line?.localProductId)) || productMap.get(normalizeText(line?.shopifyVariantId)) || productMap.get(normalizeShopifyGid("ProductVariant", line?.shopifyVariantId)) || productMap.get(normalizeText(line?.shopifyProductId)) || productMap.get(normalizeShopifyGid("Product", line?.shopifyProductId));
      if (!product) {
        unmatchedLines.push({
          index,
          shopifyLineItemId: normalizeText(line?.shopifyLineItemId),
          shopifyProductId: normalizeText(line?.shopifyProductId),
          localProductId: normalizeText(line?.localProductId)
        });
        return;
      }
      const lineItem = buildSyntheticShopifyLineItemFromLedgerLine({
        line,
        product,
        currencyCode,
        index
      });
      syntheticLineItems.push(lineItem);
      matchedLines.push({
        lineItem,
        product,
        amount: clampInteger(line?.amount)
      });
    });
    if (matchedLines.length === 0 || unmatchedLines.length > 0) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason: matchedLines.length === 0 ? "backfill_no_matching_products" : "backfill_unmatched_products",
        differences: {
          unmatchedLines,
          matchedLineCount: matchedLines.length
        }
      });
      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: matchedLines.length === 0 ? "backfill_no_matching_products" : "backfill_unmatched_products",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowCheck?.id || null
      });
      continue;
    }
    const payload = buildSyntheticShopifyOrderPayloadFromLedger({
      ledgerEntry,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      lineItems: syntheticLineItems
    });
    const shadowResult = await recordShopifyOrderSellerOrderShadow({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      matchedLines,
      ledgerEntry,
      salesCreditOffset: buildSalesCreditOffsetFromLedger(ledgerEntry)
    }, {
      prismaClient,
      env: {
        SELLER_ORDER_SHADOW_WRITE_ENABLED: "true"
      }
    });
    if (shadowResult.ok) {
      created += 1;
      results.push({
        ok: true,
        status: shadowResult.status,
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowResult.shadowCheck?.id || null
      });
    } else {
      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: shadowResult.reason,
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        errorMessage: shadowResult.errorMessage
      });
    }
  }
  return {
    ok: true,
    days: normalizedDays,
    limit: normalizedLimit,
    retryFailed: shouldRetryFailed,
    scanned: ledgerEntries.length,
    created,
    skippedExisting,
    failed,
    results
  };
}
