import prisma from "../../../db.server.js";
import { createMarketplaceOperationalCase, getMarketplaceGovernanceConfiguration, getShopifyMarketplacePaymentsApproval, isMarketplaceGovernanceGateEnabled } from "../../marketplaceGovernance.server.js";
import { inspectPaidOrderSaleEligibility, POST_ORDER_ELIGIBILITY_TRIGGER } from "../../saleEligibility.server.js";
import { applyShopifyOrderQuarantine } from "../../shopifyOrderQuarantine.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, moneyAmountToMinorUnits, normalizeLowercase, normalizeText, normalizeUppercase, toPositiveInteger } from "../values.js";
import { captureSalesCreditOffset, createLedgerEntry, runInTransaction, runSerializableTransaction } from "../shared.server.js";
import { SELLER_ORDER_SHADOW_CHECK_STATUSES, buildProductCandidateMap, buildShopifyOrderPaidSettlementBuckets, createSellerOrderShadowFailureCheck, getLineDiscountAmount, getProductSeller, getProductVendor, getShopifyLineProductIdCandidates, getShopifyLineVariantIdCandidates, getShopifyOrderAttribute, hasSellerOrderShadowModels, inferShopifyOrderSalesCreditPaymentRisk, isSellerOrderShadowWriteEnabled, normalizeDateValue, normalizeShopifyOrderId, normalizeStringList, recordShopifyOrderSellerOrderShadow, uniqueValues } from "./common.server.js";
const SHOPIFY_ORDER_PAYMENT_RISK_QUERY = `#graphql
  query SalesCreditOrderPaymentRisk($id: ID!) {
    order(id: $id) {
      id
      paymentGatewayNames
      sourceName
      transactions {
        id
        kind
        status
        gateway
        formattedGateway
        receiptJson
        paymentDetails {
          __typename
          ... on CardPaymentDetails {
            company
            paymentMethodName
            wallet
            avsResultCode
            cvvResultCode
          }
        }
      }
    }
  }
`;
const SHOPIFY_ORDER_SETTLEMENT_SELLER_STATUSES = new Set(["pending", "active"]);
function canSellerReceiveShopifyOrderSettlement(seller) {
  return SHOPIFY_ORDER_SETTLEMENT_SELLER_STATUSES.has(normalizeLowercase(seller?.status));
}
function isMultiSellerShopifyOrderSettlementEnabled(env = process.env) {
  return normalizeLowercase(env.MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED) === "true";
}
function getShopifyOrderSalesCreditOffset(payload) {
  const offsetId = getShopifyOrderAttribute(payload, "sales_credit_offset_id");
  const amount = toPositiveInteger(getShopifyOrderAttribute(payload, "sales_credit_offset_amount"));
  if (!offsetId || amount == null) {
    return null;
  }
  return {
    offsetId,
    amount,
    buyerSellerId: getShopifyOrderAttribute(payload, "sales_credit_buyer_seller_id")
  };
}
function getShopifyLineProductMatchCandidates(lineItem) {
  return uniqueValues([...getShopifyLineVariantIdCandidates(lineItem), ...getShopifyLineProductIdCandidates(lineItem)]);
}
function getShopifyLineNetAmount(lineItem, currencyCode) {
  const quantity = toPositiveInteger(lineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(lineItem?.price_set?.shop_money?.amount ?? lineItem?.price_set?.presentment_money?.amount ?? lineItem?.price, currencyCode);
  const grossAmount = unitAmount * quantity;
  const discountAmount = getLineDiscountAmount(lineItem, currencyCode);
  return Math.max(0, grossAmount - discountAmount);
}
function buildShopifyOrderPaymentRiskPayload(payload, orderData) {
  const transactions = Array.isArray(orderData?.transactions) ? orderData.transactions.map(transaction => ({
    gateway: transaction?.gateway,
    payment_gateway_name: transaction?.formattedGateway,
    source_name: transaction?.paymentDetails?.paymentMethodName,
    manualPaymentGateway: transaction?.manualPaymentGateway,
    kind: transaction?.kind,
    status: transaction?.status,
    payment_details: transaction?.paymentDetails,
    receiptJson: transaction?.receiptJson
  })) : [];
  return {
    ...payload,
    payment_gateway_names: normalizeStringList([...(Array.isArray(payload?.payment_gateway_names) ? payload.payment_gateway_names : []), ...(Array.isArray(orderData?.paymentGatewayNames) ? orderData.paymentGatewayNames : [])]),
    source_name: payload?.source_name || orderData?.sourceName,
    transactions: [...(Array.isArray(payload?.transactions) ? payload.transactions : []), ...transactions]
  };
}
async function resolveShopifyOrderSalesCreditPaymentRisk({
  payload,
  shopDomain,
  shopifyOrderId
}, {
  shopifyGraphQLWithOfflineSessionImpl = null
} = {}) {
  const payloadRisk = inferShopifyOrderSalesCreditPaymentRisk(payload);
  if (payloadRisk.rateBps > 0 || typeof shopifyGraphQLWithOfflineSessionImpl !== "function" || !shopDomain || !shopifyOrderId) {
    return payloadRisk;
  }
  try {
    const {
      data
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: "2026-04",
      query: SHOPIFY_ORDER_PAYMENT_RISK_QUERY,
      variables: {
        id: shopifyOrderId
      }
    });
    const orderPayload = buildShopifyOrderPaymentRiskPayload(payload, data?.order);
    const adminRisk = inferShopifyOrderSalesCreditPaymentRisk(orderPayload);
    return {
      ...adminRisk,
      reason: adminRisk.rateBps > payloadRisk.rateBps ? `${adminRisk.reason}_from_admin_transaction` : adminRisk.reason,
      adminLookupAttempted: true,
      adminLookupSucceeded: Boolean(data?.order),
      payloadRiskClass: payloadRisk.riskClass,
      payloadRiskRateBps: payloadRisk.rateBps
    };
  } catch (error) {
    return {
      ...payloadRisk,
      adminLookupAttempted: true,
      adminLookupSucceeded: false,
      adminLookupError: error instanceof Error ? error.message : String(error || "")
    };
  }
}
async function findLatestSellerOrderShadowCheck({
  prismaClient,
  shopDomain,
  shopifyOrderId
}) {
  if (!prismaClient?.sellerOrderShadowCheck?.findFirst) {
    return null;
  }
  return prismaClient.sellerOrderShadowCheck.findFirst({
    where: {
      shopDomain,
      shopifyOrderId
    },
    orderBy: {
      checkedAt: "desc"
    }
  });
}
async function recordMissingShopifyOrderSellerOrderShadowForDuplicate({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  ledgerEntry,
  salesCreditOffset = null
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  if (!isSellerOrderShadowWriteEnabled(env)) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_write_disabled"
    };
  }
  if (!hasSellerOrderShadowModels(prismaClient) || !prismaClient?.sellerOrderShadowCheck?.findFirst || !prismaClient?.product?.findMany) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_models_unavailable"
    };
  }
  try {
    const existingShadowCheck = await findLatestSellerOrderShadowCheck({
      prismaClient,
      shopDomain,
      shopifyOrderId
    });
    if (existingShadowCheck && existingShadowCheck.status !== SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED) {
      return {
        ok: true,
        skipped: true,
        reason: "shadow_check_exists",
        shadowCheck: existingShadowCheck
      };
    }
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    const variantIdCandidates = uniqueValues(lineItems.flatMap(getShopifyLineVariantIdCandidates));
    const productIdCandidates = uniqueValues(lineItems.flatMap(getShopifyLineProductIdCandidates));
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
        ok: true,
        skipped: true,
        reason: "shadow_product_ids_missing"
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
    for (const lineItem of lineItems) {
      const candidates = getShopifyLineProductMatchCandidates(lineItem);
      const product = candidates.map(candidate => productMap.get(candidate)).find(Boolean);
      if (!product) {
        continue;
      }
      matchedLines.push({
        lineItem,
        product,
        amount: getShopifyLineNetAmount(lineItem, currencyCode)
      });
    }
    if (matchedLines.length === 0) {
      const shadowCheck = await createSellerOrderShadowFailureCheck({
        prismaClient,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        error: new Error("duplicate_shadow_no_matching_products")
      });
      return {
        ok: false,
        reason: "duplicate_shadow_no_matching_products",
        shadowCheck
      };
    }
    const sellerIds = uniqueValues(matchedLines.map(({
      product
    }) => getProductSeller(product)?.id));
    if (sellerIds.length === 0) {
      const shadowCheck = await createSellerOrderShadowFailureCheck({
        prismaClient,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        error: new Error("duplicate_shadow_seller_missing")
      });
      return {
        ok: false,
        reason: "duplicate_shadow_seller_missing",
        shadowCheck
      };
    }
    const multiSellerDetected = sellerIds.length > 1;
    return recordShopifyOrderSellerOrderShadow({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      matchedLines,
      ledgerEntry,
      salesCreditOffset,
      multiSellerDetected,
      writeSellerOrders: !multiSellerDetected
    }, {
      prismaClient,
      env
    });
  } catch (error) {
    console.error("duplicate seller order shadow retry error:", error);
    const shadowCheck = await createSellerOrderShadowFailureCheck({
      prismaClient,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      error
    });
    return {
      ok: false,
      reason: "duplicate_shadow_retry_failed",
      errorMessage: normalizeText(error?.message),
      shadowCheck
    };
  }
}
function isProductionThirdPartyMarketplaceProduct(product) {
  if (product?.vendorStore?.isTestStore === true) return false;
  if (product?.vendorStore?.isPlatformStore === true) return false;
  return normalizeUppercase(product?.complianceProfile?.legalSellerType) !== "PLATFORM";
}
function getMarketplaceOrderGovernanceScope(matchedLines) {
  const governedLines = matchedLines.filter(({
    product
  }) => isProductionThirdPartyMarketplaceProduct(product));
  return {
    requiresMarketplaceGovernance: governedLines.length > 0,
    sellerIds: uniqueValues(governedLines.map(({
      product
    }) => getProductSeller(product)?.id)),
    productIds: uniqueValues(governedLines.map(({
      product
    }) => normalizeText(product?.id)))
  };
}
function validateMarketplaceCheckoutEvidence({
  checkoutEvidence,
  checkoutReference,
  shopDomain,
  shopifyOrderId,
  sellerIds,
  productIds,
  env
}) {
  const reasons = [];
  const configuration = getMarketplaceGovernanceConfiguration(env);
  const paymentsApproval = getShopifyMarketplacePaymentsApproval(env);
  if (!isMarketplaceGovernanceGateEnabled(env)) {
    reasons.push("marketplace_governance_gate_disabled");
  }
  if (!paymentsApproval.ready) reasons.push(...paymentsApproval.reasons);
  if (!configuration.ready) reasons.push(...configuration.reasons);
  if (!checkoutReference) reasons.push("checkout_reference_missing");
  if (!checkoutEvidence) reasons.push("checkout_evidence_missing");
  if (checkoutEvidence) {
    if (normalizeText(checkoutEvidence.checkoutReference) !== checkoutReference) {
      reasons.push("checkout_reference_mismatch");
    }
    if (normalizeLowercase(checkoutEvidence.shopDomain) !== shopDomain) {
      reasons.push("checkout_shop_mismatch");
    }
    if (!["PREPARED", "ORDER_CAPTURED"].includes(checkoutEvidence.status)) {
      reasons.push("checkout_evidence_inactive");
    }
    if (checkoutEvidence.shopifyOrderId && normalizeText(checkoutEvidence.shopifyOrderId) !== shopifyOrderId) {
      reasons.push("checkout_order_mismatch");
    }
    if (checkoutEvidence.sellerAgreementVersion !== configuration.sellerAgreementVersion) {
      reasons.push("seller_agreement_version_mismatch");
    }
    if (normalizeLowercase(checkoutEvidence.sellerAgreementHash) !== configuration.sellerAgreementDocumentHash) {
      reasons.push("seller_agreement_hash_mismatch");
    }
    if (checkoutEvidence.sellerAgreementUrl !== configuration.sellerAgreementUrl) {
      reasons.push("seller_agreement_url_mismatch");
    }
    if (checkoutEvidence.buyerTermsVersion !== configuration.buyerTermsVersion) {
      reasons.push("buyer_terms_version_mismatch");
    }
    if (normalizeLowercase(checkoutEvidence.buyerTermsHash) !== configuration.buyerTermsDocumentHash) {
      reasons.push("buyer_terms_hash_mismatch");
    }
    if (checkoutEvidence.buyerTermsUrl !== configuration.buyerTermsUrl) {
      reasons.push("buyer_terms_url_mismatch");
    }
    if (!normalizeText(checkoutEvidence.buyerTermsLocale)) {
      reasons.push("buyer_terms_locale_missing");
    }
    if (!normalizeDateValue(checkoutEvidence.presentedAt)) {
      reasons.push("buyer_terms_presented_at_missing");
    }
    const sellerSnapshots = Array.isArray(checkoutEvidence.sellerSnapshotsJson) ? checkoutEvidence.sellerSnapshotsJson : [];
    const sellerSnapshotById = new Map(sellerSnapshots.filter(entry => normalizeText(entry?.sellerId)).map(entry => [normalizeText(entry.sellerId), entry]));
    for (const sellerId of sellerIds) {
      const entry = sellerSnapshotById.get(sellerId);
      const agreement = entry?.snapshot?.sellerAgreementSnapshotJson;
      if (!entry?.snapshot) {
        reasons.push(`seller_snapshot_missing:${sellerId}`);
        continue;
      }
      if (agreement?.missing === true || agreement?.version !== configuration.sellerAgreementVersion || normalizeLowercase(agreement?.documentHash) !== configuration.sellerAgreementDocumentHash) {
        reasons.push(`seller_agreement_snapshot_invalid:${sellerId}`);
      }
    }
    const productSnapshots = Array.isArray(checkoutEvidence.productSnapshotsJson) ? checkoutEvidence.productSnapshotsJson : [];
    const productSnapshotById = new Map(productSnapshots.filter(entry => normalizeText(entry?.productId)).map(entry => [normalizeText(entry.productId), entry]));
    for (const productId of productIds) {
      const entry = productSnapshotById.get(productId);
      if (!entry?.snapshot || !normalizeText(entry?.sellerId)) {
        reasons.push(`product_snapshot_missing:${productId}`);
      }
    }
  }
  return {
    ok: reasons.length === 0,
    reasons: uniqueValues(reasons),
    checkoutEvidence,
    configuration,
    paymentsApproval
  };
}
async function recordMarketplaceOrderGovernanceReview({
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  sellerIds,
  productIds,
  checkoutReference,
  reasons
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.marketplaceOperationalCase?.findFirst) return null;
  const summary = `Shopify order governance review: ${shopDomain}/${shopifyOrderId}`;
  const existing = await prismaClient.marketplaceOperationalCase.findFirst({
    where: {
      caseType: "COMPLIANCE",
      summary,
      status: {
        notIn: ["RESOLVED", "CLOSED"]
      }
    }
  });
  if (existing) return existing;
  const created = await createMarketplaceOperationalCase({
    caseType: "COMPLIANCE",
    priority: "CRITICAL",
    currencyCode,
    summary,
    detailsJson: {
      reason: "marketplace_order_governance_review_required",
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      checkoutReference,
      sellerIds,
      productIds,
      governanceReasons: reasons,
      settlementWritten: false
    }
  }, {
    prismaClient,
    actor: "orders.paid.governance",
    actorMetadata: {
      source: "shopify_orders_paid_webhook"
    }
  });
  return created?.case || null;
}
async function evaluateMarketplaceOrderGovernance({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  matchedLines
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const scope = getMarketplaceOrderGovernanceScope(matchedLines);
  if (!scope.requiresMarketplaceGovernance) {
    return {
      ok: true,
      required: false,
      reasons: []
    };
  }
  const checkoutReference = getShopifyOrderAttribute(payload, "checkout_reference") || null;
  const checkoutEvidence = checkoutReference && prismaClient?.marketplaceCheckoutEvidence?.findUnique ? await prismaClient.marketplaceCheckoutEvidence.findUnique({
    where: {
      checkoutReference
    }
  }) : null;
  const validation = validateMarketplaceCheckoutEvidence({
    checkoutEvidence,
    checkoutReference,
    shopDomain,
    shopifyOrderId,
    sellerIds: scope.sellerIds,
    productIds: scope.productIds,
    env
  });
  if (!validation.ok) {
    const operationalCase = await recordMarketplaceOrderGovernanceReview({
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      sellerIds: scope.sellerIds,
      productIds: scope.productIds,
      checkoutReference,
      reasons: validation.reasons
    }, {
      prismaClient
    }).catch(() => null);
    return {
      ok: false,
      required: true,
      reason: "marketplace_order_governance_review_required",
      reasons: validation.reasons,
      checkoutReference,
      operationalCaseId: operationalCase?.id || null
    };
  }
  return {
    ok: true,
    required: true,
    reasons: [],
    checkoutReference,
    checkoutEvidence
  };
}
function getShopifyOrderOccurredAt(payload) {
  const value = payload?.created_at || payload?.processed_at || payload?.updated_at || null;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
function getShopifyOrderDestinationCountry(payload) {
  return normalizeText(payload?.shipping_address?.country_code || payload?.billing_address?.country_code || payload?.customer?.default_address?.country_code);
}
async function quarantinePaidShopifyOrder({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  matchedLines,
  sellerIds,
  failures,
  evidence,
  unmatchedProductIds = [],
  integrityTrigger = POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_PAID
}, {
  prismaClient = prisma,
  env = process.env,
  shopifyGraphQLWithOfflineSessionImpl = null,
  now = new Date()
} = {}) {
  const adminReviewDueAt = new Date(now.getTime() + 15 * 60 * 1000);
  const refundDecisionDueAt = new Date(now.getTime() + 60 * 60 * 1000);
  const buyerContactDueAt = endOfBusinessDayInJapan(now);
  const riskMetadata = {
    reason: "paid_order_sale_eligibility_review_required",
    failures,
    evidence,
    unmatchedProductIds,
    quarantinedAt: now.toISOString(),
    shipmentProhibited: true,
    ledgerHold: true,
    adminReviewDueAt: adminReviewDueAt.toISOString(),
    refundDecisionDueAt: refundDecisionDueAt.toISOString(),
    buyerContactDueAt: buyerContactDueAt.toISOString(),
    integrityTrigger
  };
  if (prismaClient?.sellerSettlementControl?.upsert) {
    await runSerializableTransaction(prismaClient, async tx => {
      for (const sellerId of sellerIds) {
        await tx.sellerSettlementControl.upsert({
          where: {
            sellerId
          },
          create: {
            sellerId,
            salesHold: true,
            payoutHold: true,
            holdReason: "paid_order_sale_eligibility_review_required",
            metadataJson: {
              shopDomain,
              shopifyOrderId,
              integrityTrigger,
              operationalCasePending: true,
              heldAt: now.toISOString()
            }
          },
          update: {
            salesHold: true,
            payoutHold: true,
            holdReason: "paid_order_sale_eligibility_review_required",
            metadataJson: {
              shopDomain,
              shopifyOrderId,
              integrityTrigger,
              operationalCasePending: true,
              heldAt: now.toISOString()
            }
          }
        });
      }
    });
  }
  const sellerOrderShadow = await recordShopifyOrderSellerOrderShadow({
    payload,
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    currencyCode,
    matchedLines,
    multiSellerDetected: false,
    writeSellerOrders: true,
    forceWrite: true,
    settlementStatus: "held",
    riskStatus: "review",
    riskMetadata
  }, {
    prismaClient,
    env
  });
  const marketplaceOrderId = sellerOrderShadow?.marketplaceOrder?.id || null;
  let operationalCase = null;
  if (prismaClient?.marketplaceOperationalCase?.findFirst) {
    operationalCase = (await prismaClient.marketplaceOperationalCase.findFirst({
      where: {
        marketplaceOrderId,
        caseType: "COMPLIANCE",
        status: {
          notIn: ["RESOLVED", "CLOSED"]
        }
      }
    })) || null;
  }
  if (!operationalCase) {
    const created = await createMarketplaceOperationalCase({
      caseType: "COMPLIANCE",
      priority: "CRITICAL",
      marketplaceOrderId,
      sellerId: sellerIds[0] || null,
      vendorStoreId: matchedLines[0]?.product?.vendorStoreId || null,
      currencyCode,
      summary: "Paid Shopify order requires sale eligibility review before settlement or shipment.",
      detailsJson: {
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        sellerIds,
        ...riskMetadata
      },
      dueAt: refundDecisionDueAt,
      assignedTo: normalizeText(env.SALE_ELIGIBILITY_QUARANTINE_ASSIGNEE) || normalizeText(env.ADMIN_EMAIL) || "INCIDENT_COMMANDER"
    }, {
      prismaClient,
      actor: "system:orders_paid_sale_eligibility"
    }).catch(() => null);
    operationalCase = created?.case || null;
  }
  const shopifyQuarantine = await applyShopifyOrderQuarantine({
    shopDomain,
    shopifyOrderId,
    operationalCaseId: operationalCase?.id || null,
    requiresShipping: matchedLines.some(({
      lineItem
    }) => lineItem?.requires_shipping !== false)
  }, {
    graphQL: shopifyGraphQLWithOfflineSessionImpl,
    prismaClient
  });
  if (operationalCase && prismaClient?.marketplaceOperationalCase?.update) {
    const existingDetails = operationalCase.detailsJson && typeof operationalCase.detailsJson === "object" && !Array.isArray(operationalCase.detailsJson) ? operationalCase.detailsJson : {};
    operationalCase = await prismaClient.marketplaceOperationalCase.update({
      where: {
        id: operationalCase.id
      },
      data: {
        priority: "CRITICAL",
        dueAt: refundDecisionDueAt,
        assignedTo: operationalCase.assignedTo || normalizeText(env.SALE_ELIGIBILITY_QUARANTINE_ASSIGNEE) || normalizeText(env.ADMIN_EMAIL) || "INCIDENT_COMMANDER",
        detailsJson: {
          ...existingDetails,
          ...riskMetadata,
          quarantineStatus: shopifyQuarantine.status,
          shopifyQuarantine
        }
      }
    });
    if (prismaClient?.marketplaceOperationalCaseEvent?.create) {
      await prismaClient.marketplaceOperationalCaseEvent.create({
        data: {
          caseId: operationalCase.id,
          eventType: shopifyQuarantine.ok === true ? "SHOPIFY_QUARANTINE_APPLIED" : "SHOPIFY_QUARANTINE_PARTIAL_FAILURE",
          actor: "system:orders_paid_sale_eligibility",
          note: shopifyQuarantine.ok === true ? "Shopify fulfillment holds and quarantine tag were applied." : "Shopify order quarantine requires immediate manual completion.",
          metadataJson: {
            quarantineStatus: shopifyQuarantine.status,
            fulfillmentOrderCount: shopifyQuarantine.fulfillmentOrders?.length || 0,
            failedFulfillmentOrderCount: (shopifyQuarantine.fulfillmentOrders || []).filter(entry => entry?.ok !== true).length,
            orderTagApplied: shopifyQuarantine.tag?.ok === true
          }
        }
      });
    }
  }
  if (prismaClient?.sellerOrder?.update && Array.isArray(sellerOrderShadow?.sellerOrders)) {
    for (const sellerOrder of sellerOrderShadow.sellerOrders) {
      const metadata = sellerOrder?.metadataJson && typeof sellerOrder.metadataJson === "object" && !Array.isArray(sellerOrder.metadataJson) ? sellerOrder.metadataJson : {};
      const currentReview = metadata.saleEligibilityReview && typeof metadata.saleEligibilityReview === "object" && !Array.isArray(metadata.saleEligibilityReview) ? metadata.saleEligibilityReview : {};
      await prismaClient.sellerOrder.update({
        where: {
          id: sellerOrder.id
        },
        data: {
          settlementStatus: "held",
          riskStatus: "review",
          metadataJson: {
            ...metadata,
            saleEligibilityReview: {
              ...currentReview,
              ...riskMetadata,
              quarantineStatus: shopifyQuarantine.status,
              shopifyQuarantine
            }
          }
        }
      });
    }
  }
  return {
    ok: false,
    quarantined: true,
    reason: "paid_order_sale_eligibility_review_required",
    sellerIds,
    failures,
    unmatchedProductIds,
    sellerOrderShadow,
    operationalCaseId: operationalCase?.id || null,
    shopifyQuarantine
  };
}
function endOfBusinessDayInJapan(value) {
  const date = value instanceof Date ? value : new Date(value);
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCHours(23, 59, 59, 999);
  return new Date(jst.getTime() - 9 * 60 * 60 * 1000);
}
export async function processShopifyOrderPaidSettlement({
  payload,
  shop
}, {
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = null,
  inspectPaidOrderSaleEligibilityImpl = inspectPaidOrderSaleEligibility,
  env = process.env,
  integrityOnly = false,
  integrityTrigger = POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_PAID,
  verifyOrderTimeProjection = !integrityOnly
} = {}) {
  const shopDomain = normalizeLowercase(shop || payload?.shop_domain || payload?.shop);
  const shopifyOrderId = normalizeShopifyOrderId(payload);
  const shopifyOrderName = normalizeText(payload?.name || payload?.order_number);
  const currencyCode = normalizeLowercase(payload?.currency || payload?.presentment_currency) || DEFAULT_ORDER_CURRENCY;
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const salesCreditOffset = getShopifyOrderSalesCreditOffset(payload);
  if (!shopDomain || !shopifyOrderId || lineItems.length === 0) {
    return {
      ok: false,
      terminal: true,
      expectedSkip: true,
      reason: "invalid_shopify_order_payload"
    };
  }
  const paymentRisk = integrityOnly ? null : await resolveShopifyOrderSalesCreditPaymentRisk({
    payload,
    shopDomain,
    shopifyOrderId
  }, {
    shopifyGraphQLWithOfflineSessionImpl
  });
  const existingLedgerEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "shopify_order_paid",
      stripeObjectId: shopifyOrderId
    }
  });
  if (existingLedgerEntry && !integrityOnly) {
    let salesCreditCapture = null;
    if (salesCreditOffset?.offsetId) {
      salesCreditCapture = await captureSalesCreditOffset({
        offsetId: salesCreditOffset.offsetId,
        expectedSellerId: salesCreditOffset.buyerSellerId,
        expectedAmount: salesCreditOffset.amount,
        expectedCurrencyCode: currencyCode,
        metadataJson: {
          shopDomain,
          shopifyOrderId,
          shopifyOrderName,
          shopifyOrderNumericId: normalizeText(payload?.id)
        }
      }, {
        prismaClient,
        now: new Date()
      });
    }
    const response = {
      ok: true,
      duplicate: true,
      ledgerEntry: existingLedgerEntry
    };
    if (salesCreditCapture) {
      response.salesCreditCapture = salesCreditCapture;
    }
    const sellerOrderShadow = await recordMissingShopifyOrderSellerOrderShadowForDuplicate({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      ledgerEntry: existingLedgerEntry,
      salesCreditOffset
    }, {
      prismaClient,
      env,
      shopifyGraphQLWithOfflineSessionImpl
    });
    if (!sellerOrderShadow?.skipped) {
      response.sellerOrderShadow = sellerOrderShadow;
    }
    return response;
  }
  const variantIdCandidates = uniqueValues(lineItems.flatMap(getShopifyLineVariantIdCandidates));
  const productIdCandidates = uniqueValues(lineItems.flatMap(getShopifyLineProductIdCandidates));
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
      reason: "shopify_order_products_missing"
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
      complianceProfile: {
        select: {
          legalSellerType: true
        }
      },
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          isTestStore: true,
          isPlatformStore: true,
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
  for (const lineItem of lineItems) {
    const candidates = getShopifyLineProductMatchCandidates(lineItem);
    const product = candidates.map(candidate => productMap.get(candidate)).find(Boolean);
    if (!product) {
      unmatchedProductIds.push(candidates[0] || normalizeText(lineItem?.product_id) || null);
      continue;
    }
    matchedLines.push({
      lineItem,
      product,
      amount: getShopifyLineNetAmount(lineItem, currencyCode)
    });
  }
  if (matchedLines.length === 0) {
    return {
      ok: false,
      reason: "shopify_order_no_matching_products",
      unmatchedProductIds: unmatchedProductIds.filter(Boolean)
    };
  }
  const sellerIds = uniqueValues(matchedLines.map(({
    product
  }) => getProductSeller(product)?.id));
  if (sellerIds.length === 0) {
    return {
      ok: false,
      reason: "shopify_order_seller_missing"
    };
  }
  const governance = await evaluateMarketplaceOrderGovernance({
    payload,
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    currencyCode,
    matchedLines
  }, {
    prismaClient,
    env
  });
  if (!governance.ok) {
    const quarantine = await quarantinePaidShopifyOrder({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      matchedLines,
      sellerIds,
      failures: (governance.reasons || []).map(reason => ({
        productId: null,
        code: "MARKETPLACE_GOVERNANCE_REVIEW_REQUIRED",
        reason
      })),
      evidence: [],
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
      integrityTrigger
    }, {
      prismaClient,
      env,
      shopifyGraphQLWithOfflineSessionImpl
    });
    return {
      ...quarantine,
      reason: governance.reason,
      quarantineReason: quarantine.reason,
      governanceReasons: governance.reasons
    };
  }
  const postOrderEligibilityEnabled = String(env.POST_ORDER_SALE_ELIGIBILITY_ENFORCEMENT_ENABLED ?? process.env.POST_ORDER_SALE_ELIGIBILITY_ENFORCEMENT_ENABLED ?? "true").trim().toLowerCase() !== "false";
  if (postOrderEligibilityEnabled) {
    const orderOccurredAt = getShopifyOrderOccurredAt(payload);
    const eligibility = await inspectPaidOrderSaleEligibilityImpl({
      shopDomain,
      matchedLines,
      orderOccurredAt,
      destinationCountry: getShopifyOrderDestinationCountry(payload),
      triggerType: integrityTrigger,
      verifyOrderTimeProjection
    }, {
      prismaClient,
      env
    });
    const failures = [...(Array.isArray(eligibility?.failures) ? eligibility.failures : []), ...unmatchedProductIds.filter(Boolean).map(productId => ({
      productId,
      code: "ORDER_LINE_PRODUCT_UNMATCHED"
    }))];
    if (!eligibility?.ok || failures.length > 0) {
      return quarantinePaidShopifyOrder({
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        sellerIds,
        failures,
        evidence: Array.isArray(eligibility?.evidence) ? eligibility.evidence : [],
        unmatchedProductIds: unmatchedProductIds.filter(Boolean),
        integrityTrigger
      }, {
        prismaClient,
        env,
        shopifyGraphQLWithOfflineSessionImpl
      });
    }
  }
  if (integrityOnly) {
    return {
      ok: true,
      integrityOnly: true,
      duplicate: Boolean(existingLedgerEntry),
      shopifyOrderId,
      sellerIds,
      matchedLineCount: matchedLines.length,
      unmatchedProductIds: unmatchedProductIds.filter(Boolean)
    };
  }
  if (sellerIds.length > 1) {
    if (!isMultiSellerShopifyOrderSettlementEnabled(env)) {
      const sellerOrderShadow = await recordShopifyOrderSellerOrderShadow({
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        salesCreditOffset,
        multiSellerDetected: true,
        writeSellerOrders: false
      }, {
        prismaClient,
        env
      });
      return {
        ok: false,
        reason: "multi_seller_shopify_order_unsupported",
        sellerIds,
        sellerOrderShadow
      };
    }
    if (salesCreditOffset?.offsetId) {
      const sellerOrderShadow = await recordShopifyOrderSellerOrderShadow({
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        salesCreditOffset,
        multiSellerDetected: true,
        writeSellerOrders: false
      }, {
        prismaClient,
        env
      });
      return {
        ok: false,
        reason: "multi_seller_sales_credit_unsupported",
        sellerIds,
        amount: 0,
        currencyCode,
        sellerOrderShadow
      };
    }
    const sellerBuckets = buildShopifyOrderPaidSettlementBuckets(matchedLines);
    const inactiveSeller = sellerBuckets.find(bucket => !canSellerReceiveShopifyOrderSettlement(bucket?.seller));
    if (inactiveSeller) {
      return {
        ok: false,
        reason: "seller_not_active",
        sellerId: inactiveSeller.sellerId,
        sellerIds
      };
    }
    const settlementAmount = sellerBuckets.reduce((total, bucket) => total + clampInteger(bucket.amount), 0);
    if (settlementAmount <= 0) {
      return {
        ok: false,
        reason: "shopify_order_settlement_amount_empty",
        sellerIds
      };
    }
    const occurredAt = payload?.processed_at ? new Date(payload.processed_at) : payload?.created_at ? new Date(payload.created_at) : new Date();
    return runInTransaction(prismaClient, async tx => {
      const ledgerEntries = [];
      for (const bucket of sellerBuckets) {
        if (bucket.amount <= 0) {
          continue;
        }
        const ledgerEntry = await createLedgerEntry({
          sellerId: bucket.sellerId,
          sellerStripeAccountId: bucket.seller?.stripeAccount?.id || null,
          stripeAccountId: bucket.seller?.stripeAccount?.stripeAccountId || null,
          entryType: "shopify_order_paid",
          stripeObjectId: shopifyOrderId,
          amount: bucket.amount,
          currencyCode,
          direction: "credit",
          description: "Shopify order paid",
          metadataJson: {
            shopDomain,
            shopifyOrderId,
            shopifyOrderName,
            shopifyOrderNumericId: normalizeText(payload?.id),
            vendorId: normalizeText(bucket.vendor?.id),
            vendorHandle: normalizeText(bucket.vendor?.handle),
            settlementMode: "shopify_order_to_monthly_settlement",
            multiSellerSettlement: true,
            cashSettlementAmount: bucket.amount,
            salesCreditOffsetId: null,
            salesCreditOffsetAmount: 0,
            salesCreditBuyerSellerId: null,
            matchedLineCount: bucket.matchedLines.length,
            unmatchedProductIds: unmatchedProductIds.filter(Boolean),
            lineItems: bucket.matchedLines.map(({
              lineItem,
              product,
              amount
            }) => ({
              shopifyLineItemId: normalizeText(lineItem?.id),
              shopifyProductId: normalizeText(product.shopifyProductId),
              localProductId: product.id,
              localProductName: product.name,
              quantity: toPositiveInteger(lineItem?.quantity) || 0,
              amount
            }))
          },
          occurredAt
        }, {
          prismaClient: tx
        });
        ledgerEntries.push(ledgerEntry);
      }
      const writtenSellerOrderShadow = await recordShopifyOrderSellerOrderShadow({
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        salesCreditOffset: null,
        multiSellerDetected: false,
        writeSellerOrders: true
      }, {
        prismaClient: tx,
        env
      });
      return {
        ok: true,
        duplicate: false,
        multiSeller: true,
        ledgerEntries,
        sellerIds,
        amount: settlementAmount,
        currencyCode,
        paymentRisk,
        matchedLineCount: matchedLines.length,
        unmatchedProductIds: unmatchedProductIds.filter(Boolean),
        sellerOrderShadow: writtenSellerOrderShadow
      };
    });
  }
  const seller = getProductSeller(matchedLines[0].product);
  if (!canSellerReceiveShopifyOrderSettlement(seller)) {
    return {
      ok: false,
      reason: "seller_not_active",
      sellerId: seller.id
    };
  }
  const cashSettlementAmount = matchedLines.reduce((total, matchedLine) => total + matchedLine.amount, 0);
  const salesCreditSettlementAmount = clampInteger(salesCreditOffset?.amount);
  const settlementAmount = cashSettlementAmount + salesCreditSettlementAmount;
  if (settlementAmount <= 0) {
    return {
      ok: false,
      reason: "shopify_order_settlement_amount_empty",
      sellerId: seller.id
    };
  }
  if (salesCreditOffset?.offsetId && !salesCreditOffset.buyerSellerId) {
    return {
      ok: false,
      reason: "sales_credit_buyer_seller_missing",
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode
    };
  }
  const occurredAt = payload?.processed_at ? new Date(payload.processed_at) : payload?.created_at ? new Date(payload.created_at) : new Date();
  const vendor = getProductVendor(matchedLines[0].product);
  return runInTransaction(prismaClient, async tx => {
    let salesCreditCapture = null;
    if (salesCreditOffset?.offsetId) {
      if (salesCreditOffset.buyerSellerId === seller.id) {
        return {
          ok: false,
          reason: "sales_credit_self_purchase_detected",
          sellerId: seller.id,
          amount: settlementAmount,
          currencyCode
        };
      }
      salesCreditCapture = await captureSalesCreditOffset({
        offsetId: salesCreditOffset.offsetId,
        expectedSellerId: salesCreditOffset.buyerSellerId,
        expectedAmount: salesCreditSettlementAmount,
        expectedCurrencyCode: currencyCode,
        expectedTargetSellerId: seller.id,
        metadataJson: {
          shopDomain,
          shopifyOrderId,
          shopifyOrderName,
          shopifyOrderNumericId: normalizeText(payload?.id),
          settlementSellerId: seller.id
        }
      }, {
        prismaClient: tx,
        now: occurredAt
      });
      if (!salesCreditCapture.ok) {
        return {
          ok: false,
          reason: "sales_credit_capture_failed",
          sellerId: seller.id,
          amount: settlementAmount,
          currencyCode,
          salesCreditCapture
        };
      }
    }
    const ledgerEntry = await createLedgerEntry({
      sellerId: seller.id,
      sellerStripeAccountId: seller.stripeAccount?.id || null,
      stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
      entryType: "shopify_order_paid",
      stripeObjectId: shopifyOrderId,
      amount: settlementAmount,
      currencyCode,
      direction: "credit",
      description: "Shopify order paid",
      metadataJson: {
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        shopifyOrderNumericId: normalizeText(payload?.id),
        vendorId: normalizeText(vendor?.id),
        vendorHandle: normalizeText(vendor?.handle),
        settlementMode: "shopify_order_to_monthly_settlement",
        cashSettlementAmount,
        salesCreditPaymentRiskClass: paymentRisk.riskClass,
        salesCreditPaymentRiskRateBps: paymentRisk.rateBps,
        salesCreditPaymentRiskReason: paymentRisk.reason,
        shopifyPaymentGatewayNames: paymentRisk.gatewayNames,
        threeDSecureAuthenticated: paymentRisk.threeDSecureAuthenticated,
        salesCreditPaymentRiskAdminLookupAttempted: Boolean(paymentRisk.adminLookupAttempted),
        salesCreditPaymentRiskAdminLookupSucceeded: Boolean(paymentRisk.adminLookupSucceeded),
        salesCreditOffsetId: salesCreditOffset?.offsetId || null,
        salesCreditOffsetAmount: salesCreditSettlementAmount,
        salesCreditBuyerSellerId: salesCreditOffset?.buyerSellerId || null,
        matchedLineCount: matchedLines.length,
        unmatchedProductIds: unmatchedProductIds.filter(Boolean),
        lineItems: matchedLines.map(({
          lineItem,
          product,
          amount
        }) => ({
          shopifyLineItemId: normalizeText(lineItem?.id),
          shopifyProductId: normalizeText(product.shopifyProductId),
          localProductId: product.id,
          localProductName: product.name,
          quantity: toPositiveInteger(lineItem?.quantity) || 0,
          amount
        }))
      },
      occurredAt
    }, {
      prismaClient: tx
    });
    const sellerOrderShadow = await recordShopifyOrderSellerOrderShadow({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      matchedLines,
      ledgerEntry,
      salesCreditOffset
    }, {
      prismaClient: tx,
      env
    });
    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode,
      paymentRisk,
      matchedLineCount: matchedLines.length,
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
      salesCreditCapture,
      sellerOrderShadow
    };
  });
}
