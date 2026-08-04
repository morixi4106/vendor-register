import crypto from "node:crypto";
import prisma from "../../db.server.js";
import { formatPublicCountryLabel, normalizeCountryCode } from "../../utils/deliveryEligibility.js";
import { normalizeShopDomain } from "../../utils/shopifyAdmin.server.js";
import { WITHDRAWAL_STATUSES, getWithdrawalEligibilityLabel } from "../../utils/withdrawalStatus.js";
import { getWithdrawalDictionary, resolveWithdrawalLocale } from "../../utils/withdrawalLocale.js";
import { buildWithdrawalSubmissionIdempotencyKey, hashWithdrawalValue, resolveWithdrawalConsumerLawContext, resolveWithdrawalLegalBundle, WITHDRAWAL_DEADLINE_RULE_VERSION, WITHDRAWAL_PAYLOAD_SCHEMA_VERSION } from "../withdrawalCompliance.server.js";
import { buildWithdrawalAcknowledgementSnapshot } from "../withdrawalEmailTemplates.js";
import { buildWithdrawalOutboxRecord, processWithdrawalEmailOutbox } from "../withdrawalEmailOutbox.server.js";
import { hashPrivateIdentifier } from "../../utils/privacyHash.server.js";
import { evaluateWithdrawalEligibility, findOrderForWithdrawal, getClientIp, isFutureDate, isWithdrawalIdentityReviewStatus, normalizeEmail, normalizeOrderNumber, normalizeText, parseDateInput, sendWithdrawalAcknowledgementEmail, sendWithdrawalVendorNotificationEmails } from "./common.js";
const ONE_HOUR_MS = 60 * 60 * 1000;
const RECEIPT_TOKEN_BYTES = 32;
const RECEIPT_TOKEN_TTL_HOURS = 24;
const EMAIL_RATE_LIMIT_PER_HOUR = 5;
const IP_RATE_LIMIT_PER_HOUR = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeWithdrawalFormData(formData, {
  locale = "en-GB"
} = {}) {
  const dictionary = getWithdrawalDictionary(locale);
  const customerName = normalizeText(formData.get("customerName"), 120);
  const customerEmail = normalizeEmail(formData.get("customerEmail"));
  const customerPhone = normalizeText(formData.get("customerPhone"));
  const orderNumber = normalizeOrderNumber(formData.get("orderNumber"));
  const countryCode = normalizeCountryCode(formData.get("countryCode"));
  const countryLabel = normalizeText(formData.get("countryLabel")) || formatPublicCountryLabel(countryCode) || countryCode;
  const withdrawalScope = String(formData.get("withdrawalScope") || "FULL").toUpperCase() === "PARTIAL" ? "PARTIAL" : "FULL";
  const itemText = normalizeText(formData.get("itemText"), 1000);
  const itemCondition = normalizeText(formData.get("itemCondition"), 1000);
  const reason = normalizeText(formData.get("reason"), 1000);
  const receivedDate = parseDateInput(formData.get("receivedDate"));
  const selectedLineItems = formData.getAll("selectedLineItems").map(value => normalizeText(value)).filter(Boolean);
  const errors = {};
  if (!customerName) errors.customerName = dictionary.errors.customerName;
  if (!customerEmail) errors.customerEmail = dictionary.errors.customerEmail;
  if (customerEmail && !EMAIL_PATTERN.test(customerEmail)) {
    errors.customerEmail = dictionary.errors.customerEmail;
  }
  if (!orderNumber) errors.orderNumber = dictionary.errors.orderNumber;
  if (orderNumber && orderNumber.length > 80) {
    errors.orderNumber = dictionary.errors.orderNumberTooLong;
  }
  if (customerPhone && customerPhone.length > 40) {
    errors.customerPhone = dictionary.errors.customerPhoneTooLong;
  }
  if (receivedDate && isFutureDate(receivedDate)) {
    errors.receivedDate = dictionary.errors.receivedDate;
  }
  if (withdrawalScope === "PARTIAL" && !itemText && selectedLineItems.length === 0) {
    errors.itemText = dictionary.errors.itemText;
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      customerName,
      customerEmail,
      customerPhone,
      orderNumber,
      countryCode,
      countryLabel,
      receivedDate,
      withdrawalScope,
      itemText,
      itemCondition,
      reason,
      selectedLineItems
    }
  };
}
export function hashWithdrawalReceiptToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}
function issueWithdrawalReceiptToken(now = new Date()) {
  const token = crypto.randomBytes(RECEIPT_TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashWithdrawalReceiptToken(token),
    expiresAt: new Date(now.getTime() + RECEIPT_TOKEN_TTL_HOURS * ONE_HOUR_MS)
  };
}
export async function createWithdrawalRequestFromForm({
  request,
  formData,
  shopDomain,
  prismaClient = prisma
} = {}) {
  const localeResolution = resolveWithdrawalLocale({
    urlLocale: formData.get("correspondenceLocale") || formData.get("lang"),
    shopifyLocale: formData.get("shopifyLocale"),
    acceptLanguage: request?.headers?.get("accept-language"),
    userSelected: Boolean(formData.get("correspondenceLocale"))
  });
  const normalized = normalizeWithdrawalFormData(formData, {
    locale: localeResolution.locale
  });
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      errors: normalized.errors,
      values: normalized.values
    };
  }
  const values = normalized.values;
  const normalizedShopDomain = normalizeShopDomain(shopDomain) || getShopDomainFromRequest(request);
  const ipAddress = getClientIp(request);
  const userAgent = request?.headers?.get("user-agent") || null;
  const ipHash = hashPrivateIdentifier(ipAddress);
  const userAgentHash = hashPrivateIdentifier(userAgent);
  const rateLimitResult = await checkWithdrawalRateLimit({
    prismaClient,
    email: values.customerEmail,
    ipAddress,
    ipHash
  });
  if (!rateLimitResult.ok) {
    const dictionary = getWithdrawalDictionary(localeResolution.locale);
    return {
      ok: false,
      status: 429,
      errors: {
        form: dictionary.errors.rateLimited
      },
      values
    };
  }
  const orderLookup = await findOrderForWithdrawal({
    prismaClient,
    shopDomain: normalizedShopDomain,
    orderNumber: values.orderNumber,
    customerEmail: values.customerEmail
  });
  const eligibility = evaluateWithdrawalEligibility({
    values,
    orderSnapshot: orderLookup.orderSnapshot
  });
  const selectedLineItemsJson = buildSelectedLineItemsJson(values, orderLookup);
  const submittedPayloadJson = buildSubmittedPayloadJson(values);
  const submittedAt = new Date();
  const submissionNonce = normalizeText(formData.get("submissionNonce"), 200);
  const idempotencyKey = submissionNonce ? buildWithdrawalSubmissionIdempotencyKey({
    shopDomain: normalizedShopDomain,
    submissionNonce,
    fallbackPayload: submittedPayloadJson
  }) : buildWithdrawalIdempotencyKey({
    shopDomain: normalizedShopDomain,
    orderNumber: values.orderNumber,
    email: values.customerEmail,
    withdrawalScope: values.withdrawalScope,
    itemText: values.itemText,
    selectedLineItems: values.selectedLineItems
  });
  const lawContext = resolveWithdrawalConsumerLawContext({
    orderSnapshot: orderLookup.orderSnapshot,
    submittedCountryCode: values.countryCode,
    shopifyMarketCountry: formData.get("shopifyMarketCountry")
  });
  const legalBundle = await resolveWithdrawalLegalBundle({
    prismaClient,
    consumerLawCountry: lawContext.consumerLawCountry,
    locale: localeResolution.locale
  });
  const submittedPayloadHash = hashWithdrawalValue(submittedPayloadJson);
  const existing = await prismaClient.withdrawalRequest.findUnique({
    where: {
      idempotencyKey
    },
    include: {
      emailLogs: {
        orderBy: {
          createdAt: "desc"
        },
        take: 5
      },
      statusHistory: {
        orderBy: {
          createdAt: "desc"
        },
        take: 5
      }
    }
  });
  if (existing) {
    const receipt = issueWithdrawalReceiptToken();
    await prismaClient.withdrawalRequest.update({
      where: {
        id: existing.id
      },
      data: {
        receiptTokenHash: receipt.tokenHash,
        receiptTokenExpiresAt: receipt.expiresAt,
        receiptTokenRevokedAt: null,
        receiptTokenFirstUsedAt: null,
        receiptTokenLastUsedAt: null
      }
    });
    const hasSentAcknowledgement = existing.emailLogs.some(log => log.emailType === "acknowledgement" && log.status === "sent");
    const identityReviewRequired = isWithdrawalIdentityReviewStatus(existing.eligibilityStatus);
    if (!identityReviewRequired && Number(existing.workflowVersion || 1) === 1) {
      const {
        initializeWithdrawalDirectReturnWorkflow
      } = await import("../withdrawalDirectReturns.server.js");
      await initializeWithdrawalDirectReturnWorkflow({
        withdrawalRequestId: existing.id,
        prismaClient
      });
    }
    if (!hasSentAcknowledgement && prismaClient.withdrawalEmailOutbox?.findFirst) {
      await processWithdrawalEmailOutbox({
        prismaClient,
        limit: 1
      });
    } else if (!hasSentAcknowledgement) {
      await sendWithdrawalAcknowledgementEmail({
        withdrawalRequestId: existing.id,
        prismaClient
      });
    }
    if (!identityReviewRequired) {
      await sendWithdrawalVendorNotificationEmails({
        withdrawalRequestId: existing.id,
        prismaClient
      });
    }
    return {
      ok: true,
      duplicate: true,
      withdrawalRequest: existing,
      receiptToken: receipt.token,
      identityReviewRequired
    };
  }
  const receipt = issueWithdrawalReceiptToken(submittedAt);
  const identityReviewRequired = isWithdrawalIdentityReviewStatus(eligibility.status);
  const withdrawalRequest = await prismaClient.$transaction(async tx => {
    const created = await tx.withdrawalRequest.create({
      data: {
        shopDomain: normalizedShopDomain,
        marketplaceOrderId: orderLookup.marketplaceOrder?.id || null,
        shopifyOrderId: orderLookup.orderSnapshot?.shopifyOrderId || null,
        shopifyOrderName: orderLookup.orderSnapshot?.shopifyOrderName || values.orderNumber,
        shopifyOrderNumber: orderLookup.orderSnapshot?.shopifyOrderNumber || values.orderNumber.replace(/^#/, ""),
        customerName: values.customerName,
        customerEmail: values.customerEmail,
        customerPhone: values.customerPhone,
        countryCode: values.countryCode,
        countryLabel: values.countryLabel,
        receivedDate: values.receivedDate,
        withdrawalScope: values.withdrawalScope,
        itemCondition: values.itemCondition,
        reason: values.reason,
        status: WITHDRAWAL_STATUSES.REQUESTED,
        eligibilityStatus: eligibility.status,
        deadlineAt: eligibility.deadlineAt,
        deadlineSource: eligibility.deadlineSource,
        selectedLineItemsJson,
        submittedPayloadJson,
        orderSnapshotJson: orderLookup.orderSnapshot,
        eligibilityJson: serializeEligibilityForJson(eligibility),
        submittedAt,
        submittedViewLocale: localeResolution.locale,
        correspondenceLocale: localeResolution.locale,
        localeSource: localeResolution.source,
        ...lawContext,
        withdrawalDeadlineRuleVersion: WITHDRAWAL_DEADLINE_RULE_VERSION,
        submissionLegalBundleVersion: legalBundle.version,
        submissionLegalBundleHash: legalBundle.hash,
        submittedPayloadSchemaVersion: WITHDRAWAL_PAYLOAD_SCHEMA_VERSION,
        submittedPayloadHash,
        source: "app_proxy",
        ipAddress: null,
        userAgent: null,
        ipHash,
        userAgentHash,
        idempotencyKey,
        receiptTokenHash: receipt.tokenHash,
        receiptTokenExpiresAt: receipt.expiresAt,
        ...(identityReviewRequired ? {
          progressStatus: "REVIEW_REQUIRED",
          v2ReviewReason: "identity_verification_required"
        } : {})
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: created.id,
        fromStatus: null,
        toStatus: WITHDRAWAL_STATUSES.REQUESTED,
        changedBy: "buyer",
        reason: "submitted",
        metadataJson: {
          eligibilityStatus: eligibility.status,
          eligibilityLabel: getWithdrawalEligibilityLabel(eligibility.status)
        }
      }
    });
    if (tx.withdrawalEvent?.create && tx.withdrawalEmailOutbox?.create) {
      const event = await tx.withdrawalEvent.create({
        data: {
          withdrawalRequestId: created.id,
          type: "WITHDRAWAL_SUBMITTED",
          occurredAt: submittedAt,
          actorType: "BUYER",
          actorId: values.customerEmail,
          payloadJson: {
            schemaVersion: WITHDRAWAL_PAYLOAD_SCHEMA_VERSION,
            submittedPayloadHash,
            legalBundleVersion: legalBundle.version,
            legalReviewRequired: legalBundle.requiresLegalReview
          },
          payloadHash: submittedPayloadHash,
          idempotencyKey: `withdrawal-submitted:${created.id}`
        }
      });
      const email = buildWithdrawalAcknowledgementSnapshot(created);
      await tx.withdrawalEmailOutbox.create({
        data: buildWithdrawalOutboxRecord({
          withdrawalRequest: created,
          withdrawalEventId: event.id,
          email
        })
      });
    }
    return created;
  });
  let directReturnResult = {
    ok: false,
    skipped: true,
    reason: "identity_review_required"
  };
  if (!identityReviewRequired) {
    const {
      initializeWithdrawalDirectReturnWorkflow
    } = await import("../withdrawalDirectReturns.server.js");
    directReturnResult = await initializeWithdrawalDirectReturnWorkflow({
      withdrawalRequestId: withdrawalRequest.id,
      prismaClient
    });
  }
  const emailResult = prismaClient.withdrawalEmailOutbox?.findFirst ? await processWithdrawalEmailOutbox({
    prismaClient,
    limit: 1
  }) : await sendWithdrawalAcknowledgementEmail({
    withdrawalRequestId: withdrawalRequest.id,
    prismaClient
  });
  const vendorNotificationResult = identityReviewRequired ? {
    ok: true,
    skipped: true,
    reason: "identity_review_required"
  } : await sendWithdrawalVendorNotificationEmails({
    withdrawalRequestId: withdrawalRequest.id,
    prismaClient
  });
  const reloaded = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequest.id
    },
    include: {
      emailLogs: {
        orderBy: {
          createdAt: "desc"
        },
        take: 5
      },
      statusHistory: {
        orderBy: {
          createdAt: "desc"
        },
        take: 5
      }
    }
  });
  return {
    ok: true,
    duplicate: false,
    withdrawalRequest: reloaded || withdrawalRequest,
    emailResult,
    vendorNotificationResult,
    directReturnResult,
    receiptToken: receipt.token,
    identityReviewRequired
  };
}
export function buildWithdrawalIdempotencyKey({
  shopDomain,
  orderNumber,
  email,
  withdrawalScope,
  itemText,
  selectedLineItems
} = {}) {
  const source = JSON.stringify({
    shopDomain: normalizeShopDomain(shopDomain) || "",
    orderNumber: normalizeOrderNumber(orderNumber),
    email: normalizeEmail(email),
    withdrawalScope: String(withdrawalScope || "FULL").toUpperCase(),
    itemText: normalizeText(itemText) || "",
    selectedLineItems: Array.isArray(selectedLineItems) ? selectedLineItems.map(value => normalizeText(value)).filter(Boolean).sort() : []
  });
  return crypto.createHash("sha256").update(source).digest("hex");
}
export function getShopDomainFromRequest(request) {
  if (!request?.url) {
    return normalizeShopDomain(process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || process.env.SHOPIFY_SHOP);
  }
  const url = new URL(request.url);
  return normalizeShopDomain(url.searchParams.get("shop") || process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || process.env.SHOPIFY_SHOP);
}
async function checkWithdrawalRateLimit({
  prismaClient,
  email,
  ipAddress,
  ipHash
}) {
  const since = new Date(Date.now() - ONE_HOUR_MS);
  const conditions = [];
  if (email) {
    conditions.push({
      label: "email",
      limit: EMAIL_RATE_LIMIT_PER_HOUR,
      where: {
        customerEmail: email,
        createdAt: {
          gte: since
        }
      }
    });
  }
  if (ipHash || ipAddress) {
    conditions.push({
      label: "ip",
      limit: IP_RATE_LIMIT_PER_HOUR,
      where: {
        OR: [...(ipHash ? [{
          ipHash
        }] : []), ...(ipAddress ? [{
          ipAddress
        }] : [])],
        createdAt: {
          gte: since
        }
      }
    });
  }
  for (const condition of conditions) {
    const count = await prismaClient.withdrawalRequest.count({
      where: condition.where
    });
    if (count >= condition.limit) {
      return {
        ok: false,
        reason: `${condition.label}_rate_limited`
      };
    }
  }
  return {
    ok: true
  };
}
function serializeEligibilityForJson(eligibility) {
  return {
    ...eligibility,
    deadlineAt: eligibility.deadlineAt?.toISOString?.() || null
  };
}
function buildSubmittedPayloadJson(values) {
  return {
    customerName: values.customerName,
    customerEmail: values.customerEmail,
    customerPhone: values.customerPhone,
    orderNumber: values.orderNumber,
    countryCode: values.countryCode,
    countryLabel: values.countryLabel,
    receivedDate: values.receivedDate?.toISOString?.() || null,
    withdrawalScope: values.withdrawalScope,
    itemText: values.itemText,
    itemCondition: values.itemCondition,
    reason: values.reason,
    selectedLineItems: values.selectedLineItems,
    submittedAt: new Date().toISOString()
  };
}
function buildSelectedLineItemsJson(values, orderLookup) {
  return {
    scope: values.withdrawalScope,
    freeText: values.itemText,
    selectedLineItems: values.selectedLineItems,
    orderLineItems: orderLookup.orderSnapshot?.lineItems || []
  };
}
