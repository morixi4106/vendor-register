import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, moneyAmountToMinorUnits, normalizeLowercase, normalizeText, toPositiveInteger } from "../values.js";
import { createLedgerEntry, normalizeShopifyGid, reverseSalesCreditOffsetForRefund, runInTransaction } from "../shared.server.js";
import { buildProductCandidateMap, buildShopifyOrderPaidSettlementBuckets, findShopifyOrderLedgerEntries, getProductSeller, getProductVendor, getSalesCreditOffsetFromPaidEntries, getSellerOrderPaymentStatusAfterRefund, getShopifyLineVariantIdCandidates, summarizeShopifyOrderLedgerEntries, uniqueValues } from "./common.server.js";
function isMultiSellerShopifyRefundSettlementEnabled(env = process.env) {
  return normalizeLowercase(env.MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED) === "true";
}
function normalizeShopifyRefundId(payload) {
  return normalizeShopifyGid("Refund", payload?.admin_graphql_api_id) || normalizeShopifyGid("Refund", payload?.id);
}
function getShopifyRefundLineProductIdCandidates(refundLineItem) {
  const lineItem = refundLineItem?.line_item || refundLineItem;
  return uniqueValues([normalizeShopifyGid("Product", refundLineItem?.product_id), normalizeShopifyGid("Product", lineItem?.product_id), normalizeShopifyGid("Product", lineItem?.product?.id), normalizeShopifyGid("Product", lineItem?.product?.admin_graphql_api_id), normalizeText(refundLineItem?.product_id), normalizeText(lineItem?.product_id)]);
}
function getShopifyRefundLineVariantIdCandidates(refundLineItem) {
  const lineItem = refundLineItem?.line_item || refundLineItem;
  return uniqueValues([...getShopifyLineVariantIdCandidates(refundLineItem), ...getShopifyLineVariantIdCandidates(lineItem)]);
}
function getShopifyRefundLineProductMatchCandidates(refundLineItem) {
  return uniqueValues([...getShopifyRefundLineVariantIdCandidates(refundLineItem), ...getShopifyRefundLineProductIdCandidates(refundLineItem)]);
}
function getShopifyRefundCurrencyCode(payload, refundLineItems) {
  return normalizeLowercase(payload?.currency) || normalizeLowercase(refundLineItems[0]?.subtotal_set?.shop_money?.currency_code) || normalizeLowercase(refundLineItems[0]?.subtotal_set?.presentment_money?.currency_code) || DEFAULT_ORDER_CURRENCY;
}
function getShopifyRefundLineAmount(refundLineItem, currencyCode) {
  const subtotal = refundLineItem?.subtotal_set?.shop_money?.amount ?? refundLineItem?.subtotal_set?.presentment_money?.amount ?? refundLineItem?.subtotal;
  const subtotalAmount = moneyAmountToMinorUnits(subtotal, currencyCode);
  if (subtotalAmount > 0) {
    return subtotalAmount;
  }
  const lineItem = refundLineItem?.line_item || refundLineItem;
  const quantity = toPositiveInteger(refundLineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(lineItem?.price_set?.shop_money?.amount ?? lineItem?.price_set?.presentment_money?.amount ?? lineItem?.price, currencyCode);
  return Math.max(0, unitAmount * quantity);
}
function getShopifyRefundLineItemIdCandidates(refundLineItem) {
  const lineItem = refundLineItem?.line_item || refundLineItem;
  return uniqueValues([normalizeShopifyGid("LineItem", refundLineItem?.line_item_id), normalizeShopifyGid("LineItem", refundLineItem?.admin_graphql_api_id), normalizeShopifyGid("LineItem", lineItem?.id), normalizeShopifyGid("LineItem", lineItem?.admin_graphql_api_id), normalizeText(refundLineItem?.line_item_id), normalizeText(refundLineItem?.id), normalizeText(lineItem?.id)]);
}
async function updateSellerOrderShadowForRefund({
  shopDomain,
  shopifyOrderId,
  sellerId,
  matchedLines,
  settlementAmount
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.sellerOrder?.findFirst || !prismaClient?.sellerOrder?.update || !prismaClient?.sellerOrderLine?.findMany || !prismaClient?.sellerOrderLine?.update) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_models_unavailable"
    };
  }
  const sellerOrder = await prismaClient.sellerOrder.findFirst({
    where: {
      shopifyOrderId,
      sellerId,
      marketplaceOrder: {
        shopDomain
      }
    },
    select: {
      id: true,
      sellerRefundAmount: true,
      sellerPayableAmount: true,
      sellerNetAmount: true,
      paymentStatus: true
    }
  });
  if (!sellerOrder?.id) {
    return {
      ok: true,
      skipped: true,
      reason: "seller_order_not_found"
    };
  }
  const lineIdCandidates = uniqueValues((Array.isArray(matchedLines) ? matchedLines : []).flatMap(({
    refundLineItem
  }) => getShopifyRefundLineItemIdCandidates(refundLineItem)));
  const sellerOrderLines = lineIdCandidates.length > 0 ? await prismaClient.sellerOrderLine.findMany({
    where: {
      sellerOrderId: sellerOrder.id,
      shopifyLineItemId: {
        in: lineIdCandidates
      }
    },
    select: {
      id: true,
      shopifyLineItemId: true,
      refundedQuantity: true
    }
  }) : [];
  const sellerOrderLineByShopifyLineItemId = new Map(sellerOrderLines.map(line => [line.shopifyLineItemId, line]));
  let updatedLineCount = 0;
  for (const {
    refundLineItem
  } of Array.isArray(matchedLines) ? matchedLines : []) {
    const matchedLine = getShopifyRefundLineItemIdCandidates(refundLineItem).map(candidate => sellerOrderLineByShopifyLineItemId.get(candidate)).find(Boolean);
    if (!matchedLine?.id) {
      continue;
    }
    const refundQuantity = toPositiveInteger(refundLineItem?.quantity) || 0;
    await prismaClient.sellerOrderLine.update({
      where: {
        id: matchedLine.id
      },
      data: {
        refundedQuantity: clampInteger(matchedLine.refundedQuantity) + refundQuantity
      }
    });
    updatedLineCount += 1;
  }
  const nextRefundAmount = clampInteger(sellerOrder.sellerRefundAmount) + clampInteger(settlementAmount);
  const paidAmount = clampInteger(sellerOrder.sellerPayableAmount) || clampInteger(sellerOrder.sellerNetAmount);
  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id
    },
    data: {
      sellerRefundAmount: nextRefundAmount,
      paymentStatus: getSellerOrderPaymentStatusAfterRefund({
        paidAmount,
        refundAmount: nextRefundAmount,
        fallback: sellerOrder.paymentStatus
      })
    }
  });
  return {
    ok: true,
    sellerOrder: updatedSellerOrder,
    updatedLineCount,
    refundAmount: nextRefundAmount
  };
}
function capShopifyOrderReversalAmount(requestedAmount, orderLedgerSummary) {
  const normalizedAmount = clampInteger(requestedAmount);
  if (!orderLedgerSummary?.hasPaidEntry) {
    return 0;
  }
  return Math.min(normalizedAmount, orderLedgerSummary.remainingAmount);
}
export async function processShopifyRefundSettlement({
  payload,
  shop
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const shopDomain = normalizeLowercase(shop || payload?.shop_domain || payload?.shop);
  const shopifyRefundId = normalizeShopifyRefundId(payload);
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.order_id);
  const refundLineItems = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];
  const currencyCode = getShopifyRefundCurrencyCode(payload, refundLineItems);
  const multiSellerRefundSettlementEnabled = isMultiSellerShopifyRefundSettlementEnabled(env);
  if (!shopDomain || !shopifyRefundId || refundLineItems.length === 0) {
    return {
      ok: false,
      terminal: true,
      expectedSkip: true,
      reason: "invalid_shopify_refund_payload"
    };
  }
  const existingLedgerEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "refund",
      stripeObjectId: shopifyRefundId
    }
  });
  if (existingLedgerEntry && !multiSellerRefundSettlementEnabled) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingLedgerEntry
    };
  }
  const variantIdCandidates = uniqueValues(refundLineItems.flatMap(getShopifyRefundLineVariantIdCandidates));
  const productIdCandidates = uniqueValues(refundLineItems.flatMap(getShopifyRefundLineProductIdCandidates));
  const productReferenceClauses = [];
  if (variantIdCandidates.length > 0) {
    productReferenceClauses.push({
      shopifyVariantId: {
        in: variantIdCandidates
      }
    });
  }
  if (productIdCandidates.length > 0) {
    productReferenceClauses.push({
      shopifyProductId: {
        in: productIdCandidates
      }
    });
  }
  if (productReferenceClauses.length === 0) {
    return {
      ok: false,
      terminal: true,
      expectedSkip: true,
      reason: "shopify_refund_products_missing"
    };
  }
  const products = await prismaClient.product.findMany({
    where: {
      AND: [{
        OR: productReferenceClauses
      }, {
        OR: [{
          shopDomain
        }, {
          shopDomain: null
        }]
      }]
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
  });
  const productMap = buildProductCandidateMap(products, shopDomain);
  const matchedLines = [];
  const unmatchedProductIds = [];
  for (const refundLineItem of refundLineItems) {
    const candidates = getShopifyRefundLineProductMatchCandidates(refundLineItem);
    const product = candidates.map(candidate => productMap.get(candidate)).find(Boolean);
    if (!product) {
      unmatchedProductIds.push(candidates[0] || normalizeText(refundLineItem?.line_item?.product_id) || normalizeText(refundLineItem?.product_id) || null);
      continue;
    }
    matchedLines.push({
      refundLineItem,
      product,
      amount: getShopifyRefundLineAmount(refundLineItem, currencyCode)
    });
  }
  if (matchedLines.length === 0) {
    return {
      ok: false,
      reason: "shopify_refund_no_matching_products",
      unmatchedProductIds: unmatchedProductIds.filter(Boolean)
    };
  }
  const sellerIds = uniqueValues(matchedLines.map(({
    product
  }) => getProductSeller(product)?.id));
  if (sellerIds.length === 0) {
    return {
      ok: false,
      reason: "shopify_refund_seller_missing"
    };
  }
  if (sellerIds.length > 1 && !multiSellerRefundSettlementEnabled) {
    return {
      ok: false,
      reason: "multi_seller_shopify_refund_unsupported",
      sellerIds
    };
  }
  const orderLedgerEntries = await findShopifyOrderLedgerEntries(shopifyOrderId, prismaClient);
  if (sellerIds.length > 1) {
    const existingRefundEntries = orderLedgerEntries.filter(entry => entry?.entryType === "refund" && entry?.stripeObjectId === shopifyRefundId);
    if (existingRefundEntries.length > 0 || existingLedgerEntry?.stripeObjectId === shopifyRefundId) {
      return {
        ok: true,
        duplicate: true,
        multiSeller: true,
        ledgerEntries: existingRefundEntries.length > 0 ? existingRefundEntries : [existingLedgerEntry]
      };
    }
    const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(orderLedgerEntries.filter(entry => entry?.entryType === "shopify_order_paid"));
    if (salesCreditOffset?.offsetId) {
      return {
        ok: false,
        reason: "multi_seller_sales_credit_refund_unsupported",
        sellerIds
      };
    }
    const sellerBuckets = buildShopifyOrderPaidSettlementBuckets(matchedLines);
    const occurredAt = payload?.processed_at ? new Date(payload.processed_at) : payload?.created_at ? new Date(payload.created_at) : new Date();
    return runInTransaction(prismaClient, async tx => {
      const ledgerEntries = [];
      const sellerOrderShadowRefunds = [];
      let settlementAmount = 0;
      for (const bucket of sellerBuckets) {
        const seller = bucket.seller;
        if (!seller?.id) {
          continue;
        }
        const requestedSellerRefundAmount = bucket.matchedLines.reduce((total, matchedLine) => total + clampInteger(matchedLine?.amount), 0);
        const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(orderLedgerEntries, seller.id);
        const sellerSettlementAmount = capShopifyOrderReversalAmount(requestedSellerRefundAmount, orderLedgerSummary);
        if (sellerSettlementAmount <= 0) {
          continue;
        }
        const vendor = bucket.vendor || getProductVendor(bucket.matchedLines[0]?.product);
        const ledgerEntry = await createLedgerEntry({
          sellerId: seller.id,
          sellerStripeAccountId: seller.stripeAccount?.id || null,
          stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
          entryType: "refund",
          stripeObjectId: shopifyRefundId,
          amount: sellerSettlementAmount,
          currencyCode,
          direction: "debit",
          description: "Shopify refund",
          metadataJson: {
            shopDomain,
            shopifyRefundId,
            shopifyRefundNumericId: normalizeText(payload?.id),
            shopifyOrderId,
            shopifyOrderNumericId: normalizeText(payload?.order_id),
            vendorId: normalizeText(vendor?.id),
            vendorHandle: normalizeText(vendor?.handle),
            settlementMode: "shopify_refund_to_monthly_settlement",
            multiSellerRefundSettlement: true,
            matchedLineCount: bucket.matchedLines.length,
            unmatchedProductIds: unmatchedProductIds.filter(Boolean),
            lineItems: bucket.matchedLines.map(({
              refundLineItem,
              product,
              amount
            }) => ({
              shopifyRefundLineItemId: normalizeText(refundLineItem?.id),
              shopifyLineItemId: normalizeText(refundLineItem?.line_item_id),
              shopifyProductId: normalizeText(product.shopifyProductId),
              localProductId: product.id,
              localProductName: product.name,
              quantity: toPositiveInteger(refundLineItem?.quantity) || 0,
              amount
            }))
          },
          occurredAt
        }, {
          prismaClient: tx
        });
        const sellerOrderShadowRefund = await updateSellerOrderShadowForRefund({
          shopDomain,
          shopifyOrderId,
          sellerId: seller.id,
          matchedLines: bucket.matchedLines,
          settlementAmount: sellerSettlementAmount
        }, {
          prismaClient: tx
        });
        ledgerEntries.push(ledgerEntry);
        sellerOrderShadowRefunds.push({
          sellerId: seller.id,
          ...sellerOrderShadowRefund
        });
        settlementAmount += sellerSettlementAmount;
      }
      if (ledgerEntries.length === 0) {
        return {
          ok: true,
          reason: "shopify_refund_order_already_reversed",
          multiSeller: true,
          sellerIds,
          amount: 0,
          currencyCode
        };
      }
      return {
        ok: true,
        duplicate: false,
        multiSeller: true,
        ledgerEntries,
        sellerIds,
        amount: settlementAmount,
        currencyCode,
        matchedLineCount: matchedLines.length,
        unmatchedProductIds: unmatchedProductIds.filter(Boolean),
        sellerOrderShadowRefunds
      };
    });
  }
  if (existingLedgerEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingLedgerEntry
    };
  }
  const seller = getProductSeller(matchedLines[0].product);
  const requestedSettlementAmount = matchedLines.reduce((total, matchedLine) => total + matchedLine.amount, 0);
  const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(orderLedgerEntries, seller.id);
  const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(orderLedgerEntries.filter(entry => entry?.entryType === "shopify_order_paid"));
  const salesCreditRefundAmount = clampInteger(salesCreditOffset?.amount);
  const cashRemainingAmount = Math.max(0, orderLedgerSummary.remainingAmount - salesCreditRefundAmount);
  const shouldReverseSalesCredit = Boolean(salesCreditOffset?.offsetId) && requestedSettlementAmount >= cashRemainingAmount;
  const settlementAmount = capShopifyOrderReversalAmount(requestedSettlementAmount + (shouldReverseSalesCredit ? salesCreditRefundAmount : 0), orderLedgerSummary);
  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_refund_order_already_reversed",
      sellerId: seller.id,
      amount: 0,
      currencyCode
    };
  }
  const occurredAt = payload?.processed_at ? new Date(payload.processed_at) : payload?.created_at ? new Date(payload.created_at) : new Date();
  const vendor = getProductVendor(matchedLines[0].product);
  return runInTransaction(prismaClient, async tx => {
    const ledgerEntry = await createLedgerEntry({
      sellerId: seller.id,
      sellerStripeAccountId: seller.stripeAccount?.id || null,
      stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
      entryType: "refund",
      stripeObjectId: shopifyRefundId,
      amount: settlementAmount,
      currencyCode,
      direction: "debit",
      description: "Shopify refund",
      metadataJson: {
        shopDomain,
        shopifyRefundId,
        shopifyRefundNumericId: normalizeText(payload?.id),
        shopifyOrderId,
        shopifyOrderNumericId: normalizeText(payload?.order_id),
        vendorId: normalizeText(vendor?.id),
        vendorHandle: normalizeText(vendor?.handle),
        settlementMode: "shopify_refund_to_monthly_settlement",
        salesCreditOffsetId: salesCreditOffset?.offsetId || null,
        salesCreditOffsetReversed: shouldReverseSalesCredit,
        matchedLineCount: matchedLines.length,
        unmatchedProductIds: unmatchedProductIds.filter(Boolean),
        lineItems: matchedLines.map(({
          refundLineItem,
          product,
          amount
        }) => ({
          shopifyRefundLineItemId: normalizeText(refundLineItem?.id),
          shopifyLineItemId: normalizeText(refundLineItem?.line_item_id),
          shopifyProductId: normalizeText(product.shopifyProductId),
          localProductId: product.id,
          localProductName: product.name,
          quantity: toPositiveInteger(refundLineItem?.quantity) || 0,
          amount
        }))
      },
      occurredAt
    }, {
      prismaClient: tx
    });
    const salesCreditReversal = shouldReverseSalesCredit ? await reverseSalesCreditOffsetForRefund({
      offsetId: salesCreditOffset.offsetId,
      metadataJson: {
        shopDomain,
        shopifyRefundId,
        shopifyOrderId,
        reversalReason: "shopify_refund"
      }
    }, {
      prismaClient: tx,
      now: occurredAt
    }) : null;
    const sellerOrderShadowRefund = await updateSellerOrderShadowForRefund({
      shopDomain,
      shopifyOrderId,
      sellerId: seller.id,
      matchedLines,
      settlementAmount
    }, {
      prismaClient: tx
    });
    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode,
      matchedLineCount: matchedLines.length,
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
      salesCreditReversal,
      sellerOrderShadowRefund
    };
  });
}
