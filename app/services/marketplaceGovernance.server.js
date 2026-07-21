import crypto from "node:crypto";

import prisma from "../db.server.js";
import { hashPrivateIdentifier } from "../utils/privacyHash.server.js";

export const GOVERNANCE_SNAPSHOT_VERSION = "marketplace-governance-v1";
export const SELLER_AGREEMENT_TYPE = "SELLER_MASTER";
export const SELLER_ENTITY_TYPES = ["INDIVIDUAL", "CORPORATION"];
export const SELLER_COMPLIANCE_REVIEW_STATUSES = [
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
];
export const PRODUCT_COMPLIANCE_STATUSES = [
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "HOLD",
];
export const PRODUCT_CONDITION_STATUSES = ["NEW", "USED"];
export const OPERATIONAL_CASE_TYPES = [
  "SELLER_DISCLOSURE",
  "TAX_INVOICE",
  "WITHDRAWAL",
  "REFUND",
  "DELIVERY",
  "DAMAGE",
  "COUNTERFEIT",
  "COMPLIANCE",
  "CHARGEBACK",
  "OTHER",
];
export const OPERATIONAL_CASE_STATUSES = [
  "OPEN",
  "TRIAGE",
  "WAITING_FOR_SELLER",
  "EVIDENCE_REVIEW",
  "RESPONSIBILITY_CONFIRMED",
  "ACTION_REQUIRED",
  "RESOLVED",
  "CLOSED",
];
export const SETTLEMENT_ADJUSTMENT_TYPES = [
  "RESERVE",
  "SET_OFF",
  "DIRECT_INVOICE",
  "RELEASE",
];

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeLower(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function runSerializableGovernanceTransaction(
  prismaClient,
  callback,
  { maxAttempts = 3 } = {},
) {
  if (typeof prismaClient?.$transaction !== "function") {
    return callback(prismaClient);
  }

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await prismaClient.$transaction(callback, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (error?.code !== "P2034" || attempt >= maxAttempts) throw error;
    }
  }
  throw new Error("Serializable settlement transaction retry exhausted.");
}

function hasText(value) {
  return Boolean(normalizeText(value));
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const normalized = normalizeText(value);
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { note: normalized };
  } catch {
    return { note: normalized };
  }
}

export function isMarketplaceGovernanceGateEnabled(env = process.env) {
  return normalizeBoolean(env.MARKETPLACE_GOVERNANCE_GATE_ENABLED);
}

export function isMarketplaceSettlementActionsEnabled(env = process.env) {
  return normalizeBoolean(env.MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED);
}

export function isDomesticSellerSettlementEnabled(env = process.env) {
  return normalizeBoolean(env.DOMESTIC_SELLER_SETTLEMENT_ENABLED);
}

export function isCrossBorderSellerSettlementEnabled(env = process.env) {
  return normalizeBoolean(env.CROSS_BORDER_SELLER_SETTLEMENT_ENABLED);
}

export function getShopifyMarketplacePaymentsApproval(env = process.env) {
  const confirmed = normalizeBoolean(
    env.SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_CONFIRMED,
  );
  const reference = normalizeText(
    env.SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_REFERENCE,
  );

  return {
    ready: Boolean(confirmed && reference),
    confirmed,
    reference,
    reasons: [
      ...(!confirmed
        ? ["shopify_marketplace_payments_approval_not_confirmed"]
        : []),
      ...(!reference
        ? ["shopify_marketplace_payments_approval_reference_missing"]
        : []),
    ],
  };
}

export function evaluateSellerSettlementExecutionReadiness(
  seller,
  { env = process.env } = {},
) {
  const reasons = [];
  const paymentsApproval = getShopifyMarketplacePaymentsApproval(env);
  const countryCode = normalizeUpper(seller?.complianceProfile?.countryCode);
  const settlementScope = countryCode === "JP" ? "domestic" : "cross_border";

  if (!isMarketplaceSettlementActionsEnabled(env)) {
    reasons.push("marketplace_settlement_actions_disabled");
  }
  if (!paymentsApproval.ready) {
    reasons.push(...paymentsApproval.reasons);
  }
  if (!countryCode) {
    reasons.push("seller_settlement_country_unknown");
  } else if (
    settlementScope === "domestic" &&
    !isDomesticSellerSettlementEnabled(env)
  ) {
    reasons.push("domestic_seller_settlement_disabled");
  } else if (
    settlementScope === "cross_border" &&
    !isCrossBorderSellerSettlementEnabled(env)
  ) {
    reasons.push("cross_border_seller_settlement_disabled");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    countryCode: countryCode || null,
    settlementScope,
  };
}

export function getCurrentSellerAgreementVersion(env = process.env) {
  return normalizeText(env.SELLER_AGREEMENT_VERSION) || "UNCONFIGURED";
}

function normalizePublicHttpUrl(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function getCurrentSellerAgreementDocumentHash(env = process.env) {
  const documentHash = normalizeLower(env.SELLER_AGREEMENT_DOCUMENT_HASH);
  return /^[a-f0-9]{64}$/.test(documentHash) ? documentHash : null;
}

export function getCurrentSellerAgreementUrl(env = process.env) {
  return normalizePublicHttpUrl(env.SELLER_AGREEMENT_URL);
}

export function getCurrentBuyerTermsVersion(env = process.env) {
  return normalizeText(env.BUYER_TERMS_VERSION) || "UNCONFIGURED";
}

export function getCurrentBuyerTermsDocumentHash(env = process.env) {
  const documentHash = normalizeLower(env.BUYER_TERMS_DOCUMENT_HASH);
  return /^[a-f0-9]{64}$/.test(documentHash) ? documentHash : null;
}

export function getCurrentBuyerTermsUrl(env = process.env) {
  return normalizePublicHttpUrl(env.BUYER_TERMS_URL);
}

export function getMarketplaceGovernanceConfiguration(env = process.env) {
  const sellerAgreementVersion = getCurrentSellerAgreementVersion(env);
  const sellerAgreementDocumentHash =
    getCurrentSellerAgreementDocumentHash(env);
  const sellerAgreementUrl = getCurrentSellerAgreementUrl(env);
  const buyerTermsVersion = getCurrentBuyerTermsVersion(env);
  const buyerTermsDocumentHash = getCurrentBuyerTermsDocumentHash(env);
  const buyerTermsUrl = getCurrentBuyerTermsUrl(env);
  const reasons = [];

  if (sellerAgreementVersion === "UNCONFIGURED") {
    reasons.push("agreement_version_unconfigured");
  }
  if (!sellerAgreementDocumentHash) {
    reasons.push("agreement_document_hash_unconfigured");
  }
  if (!sellerAgreementUrl) reasons.push("agreement_url_unconfigured");
  if (buyerTermsVersion === "UNCONFIGURED") {
    reasons.push("buyer_terms_version_unconfigured");
  }
  if (!buyerTermsDocumentHash) {
    reasons.push("buyer_terms_document_hash_unconfigured");
  }
  if (!buyerTermsUrl) reasons.push("buyer_terms_url_unconfigured");

  return {
    ready: reasons.length === 0,
    reasons,
    sellerAgreementVersion,
    sellerAgreementDocumentHash,
    sellerAgreementUrl,
    buyerTermsVersion,
    buyerTermsDocumentHash,
    buyerTermsUrl,
  };
}

export function getSellerAgreementReadinessOptions(
  env = process.env,
  extra = {},
) {
  const configuration = getMarketplaceGovernanceConfiguration(env);
  return {
    agreementVersion: configuration.sellerAgreementVersion,
    agreementDocumentHash: configuration.sellerAgreementDocumentHash,
    agreementUrl: configuration.sellerAgreementUrl,
    requireAgreementConfiguration: true,
    ...extra,
  };
}

export function evaluateSellerGovernanceReadiness(
  seller,
  {
    agreementVersion = "UNCONFIGURED",
    agreementDocumentHash = null,
    agreementUrl = null,
    requireAgreementConfiguration = false,
    requirePayoutReadiness = false,
  } = {},
) {
  const reasons = [];
  const profile = seller?.complianceProfile || null;
  const store = seller?.vendor?.vendorStore || seller?.vendorStore || null;
  const agreements = asArray(seller?.agreementAcceptances);
  const activeAgreement = agreements.find(
    (entry) =>
      entry.agreementType === SELLER_AGREEMENT_TYPE &&
      entry.version === agreementVersion &&
      (!agreementDocumentHash ||
        normalizeLower(entry.documentHash) === agreementDocumentHash) &&
      !entry.revokedAt,
  );
  const activeReturnAddress = asArray(store?.returnAddresses).find(
    (entry) =>
      entry.status === "ACTIVE" &&
      entry.activatedAt &&
      entry.confirmedAt &&
      entry.canReceiveReturnsConfirmed &&
      entry.buyerDisclosureConfirmed &&
      entry.legalRecipientConfirmed,
  );

  if (!seller?.id) reasons.push("seller_missing");
  if (store?.isTestStore) reasons.push("test_store");
  if (seller?.status !== "active") reasons.push("seller_not_active");
  if (!profile) reasons.push("legal_profile_missing");
  if (profile && profile.reviewStatus !== "APPROVED") {
    reasons.push("legal_profile_not_approved");
  }
  if (profile && !SELLER_ENTITY_TYPES.includes(profile.entityType)) {
    reasons.push("entity_type_missing");
  }
  if (profile && !hasText(profile.legalName))
    reasons.push("legal_name_missing");
  if (profile && !hasText(profile.countryCode))
    reasons.push("legal_country_missing");
  if (profile && !hasText(profile.address1))
    reasons.push("legal_address_missing");
  if (profile && !profile.antisocialDeclarationAt) {
    reasons.push("antisocial_declaration_missing");
  }
  if (profile && !profile.shipFromConfirmedAt) {
    reasons.push("ship_from_confirmation_missing");
  }
  if (agreementVersion === "UNCONFIGURED") {
    reasons.push("agreement_version_unconfigured");
  } else if (requireAgreementConfiguration && !agreementDocumentHash) {
    reasons.push("agreement_document_hash_unconfigured");
  } else if (requireAgreementConfiguration && !agreementUrl) {
    reasons.push("agreement_url_unconfigured");
  } else if (!activeAgreement) {
    reasons.push("agreement_not_accepted");
  }
  if (!activeReturnAddress) reasons.push("active_return_address_missing");
  if (seller?.settlementControl?.salesHold) reasons.push("sales_hold");

  if (requirePayoutReadiness) {
    if (seller?.settlementControl?.payoutHold) reasons.push("payout_hold");
    if (
      normalizeNonNegativeInteger(
        seller?.settlementControl?.directInvoiceBalance,
      ) > 0
    ) {
      reasons.push("direct_invoice_balance_due");
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    agreementVersion,
    activeAgreement: activeAgreement || null,
    activeReturnAddress: activeReturnAddress || null,
  };
}

export function evaluateProductGovernanceReadiness(product) {
  const reasons = [];
  const profile = product?.complianceProfile || null;

  if (!product?.id) reasons.push("product_missing");
  if (product?.approvalStatus !== "approved")
    reasons.push("product_not_approved");
  if (!hasText(product?.shopifyProductId))
    reasons.push("shopify_product_missing");
  if (!profile) reasons.push("product_compliance_missing");
  if (profile && profile.approvalStatus !== "APPROVED") {
    reasons.push("product_compliance_not_approved");
  }
  if (
    profile &&
    !PRODUCT_CONDITION_STATUSES.includes(profile.conditionStatus)
  ) {
    reasons.push("product_condition_missing");
  }
  if (profile && !hasText(profile.countryOfOriginCode)) {
    reasons.push("country_of_origin_missing");
  }
  if (profile && !hasText(profile.customsDescriptionEn)) {
    reasons.push("customs_description_missing");
  }
  if (profile && !profile.authenticityConfirmedAt) {
    reasons.push("authenticity_confirmation_missing");
  }
  if (profile && !profile.ipRightsConfirmedAt) {
    reasons.push("ip_rights_confirmation_missing");
  }

  return { ready: reasons.length === 0, reasons };
}

export function calculateGovernedPayoutAvailability(
  ledgerBalance,
  settlementControl = null,
) {
  const balance = Math.max(0, Math.trunc(Number(ledgerBalance) || 0));
  const reserveAmount = normalizeNonNegativeInteger(
    settlementControl?.reserveAmount,
  );
  const directInvoiceBalance = normalizeNonNegativeInteger(
    settlementControl?.directInvoiceBalance,
  );
  const held = Boolean(settlementControl?.payoutHold);
  const availableAmount = held
    ? 0
    : Math.max(0, balance - reserveAmount - directInvoiceBalance);

  return {
    ledgerBalance: balance,
    reserveAmount,
    directInvoiceBalance,
    payoutHold: held,
    availableAmount,
  };
}

export function buildSellerGovernanceSnapshot(
  seller,
  {
    agreementVersion = "UNCONFIGURED",
    agreementDocumentHash = null,
    buyerTermsVersion = "UNCONFIGURED",
  } = {},
) {
  const profile = seller?.complianceProfile || null;
  const acceptance = asArray(seller?.agreementAcceptances).find(
    (entry) =>
      entry.agreementType === SELLER_AGREEMENT_TYPE &&
      entry.version === agreementVersion &&
      (!agreementDocumentHash ||
        normalizeLower(entry.documentHash) ===
          normalizeLower(agreementDocumentHash)) &&
      !entry.revokedAt,
  );
  const store = seller?.vendor?.vendorStore || seller?.vendorStore || null;

  return {
    governanceSnapshotVersion: GOVERNANCE_SNAPSHOT_VERSION,
    buyerTermsVersion,
    legalSellerSnapshotJson: {
      sellerId: seller?.id || null,
      legalRole: seller?.sellerLegalRole || "MARKETPLACE_SELLER",
      entityType: profile?.entityType || null,
      legalName: profile?.legalName || store?.storeName || null,
      representativeName: profile?.representativeName || null,
      countryCode: profile?.countryCode || null,
      invoiceRegistrationNumber: profile?.invoiceRegistrationNumber || null,
      capturedAt: new Date().toISOString(),
    },
    sellerAgreementSnapshotJson: acceptance
      ? {
          agreementType: acceptance.agreementType,
          version: acceptance.version,
          documentHash: acceptance.documentHash,
          acceptedAt: acceptance.acceptedAt,
        }
      : {
          agreementType: SELLER_AGREEMENT_TYPE,
          version: agreementVersion,
          missing: true,
        },
  };
}

export function buildProductComplianceSnapshot(product) {
  const profile = product?.complianceProfile || null;
  return {
    productId: product?.id || null,
    shopifyProductId: product?.shopifyProductId || null,
    shopifyVariantId: product?.shopifyVariantId || null,
    legalSellerType: profile?.legalSellerType || null,
    conditionStatus: profile?.conditionStatus || null,
    countryOfOriginCode: profile?.countryOfOriginCode || null,
    hsCode: profile?.hsCode || null,
    customsDescriptionEn: profile?.customsDescriptionEn || null,
    regulatoryCategory: profile?.regulatoryCategory || null,
    approvalStatus: profile?.approvalStatus || "MISSING",
    reviewedAt: profile?.reviewedAt || null,
    capturedAt: new Date().toISOString(),
  };
}

export function sellerComplianceProfileFromFormData(
  formData,
  { admin = false } = {},
) {
  const entityType = normalizeUpper(formData.get("entityType"));
  const reviewStatus = admin
    ? normalizeUpper(formData.get("reviewStatus")) || "DRAFT"
    : "PENDING";

  return {
    entityType: SELLER_ENTITY_TYPES.includes(entityType) ? entityType : "UNSET",
    legalName: normalizeText(formData.get("legalName")),
    representativeName: normalizeText(formData.get("representativeName")),
    postalCode: normalizeText(formData.get("postalCode")),
    countryCode: normalizeUpper(formData.get("countryCode")),
    region: normalizeText(formData.get("region")),
    city: normalizeText(formData.get("city")),
    address1: normalizeText(formData.get("address1")),
    address2: normalizeText(formData.get("address2")),
    phone: normalizeText(formData.get("phone")),
    invoiceRegistrationNumber: normalizeText(
      formData.get("invoiceRegistrationNumber"),
    ),
    permitsJson: parseJsonObject(formData.get("permitsJson")),
    antisocialDeclarationAt: normalizeBoolean(
      formData.get("antisocialDeclarationConfirmed"),
    )
      ? new Date()
      : null,
    shipFromConfirmedAt: normalizeBoolean(formData.get("shipFromConfirmed"))
      ? new Date()
      : null,
    privacyNoticeAcceptedAt: normalizeBoolean(
      formData.get("privacyNoticeAccepted"),
    )
      ? new Date()
      : null,
    reviewStatus: SELLER_COMPLIANCE_REVIEW_STATUSES.includes(reviewStatus)
      ? reviewStatus
      : "DRAFT",
    reviewNotes: admin ? normalizeText(formData.get("reviewNotes")) : null,
  };
}

export function productComplianceProfileFromFormData(
  formData,
  { admin = false } = {},
) {
  const conditionStatus = normalizeUpper(formData.get("conditionStatus"));
  const approvalStatus = admin
    ? normalizeUpper(formData.get("complianceApprovalStatus")) || "DRAFT"
    : "PENDING";

  return {
    legalSellerType:
      normalizeUpper(formData.get("legalSellerType")) === "PLATFORM"
        ? "PLATFORM"
        : "VENDOR",
    conditionStatus: PRODUCT_CONDITION_STATUSES.includes(conditionStatus)
      ? conditionStatus
      : "UNSET",
    countryOfOriginCode: normalizeUpper(formData.get("countryOfOriginCode")),
    hsCode: normalizeText(formData.get("hsCode")),
    customsDescriptionEn: normalizeText(formData.get("customsDescriptionEn")),
    regulatoryCategory: normalizeText(formData.get("regulatoryCategory")),
    regulatoryMarksJson: parseJsonObject(formData.get("regulatoryMarksJson")),
    ageRestriction: normalizeText(formData.get("ageRestriction")),
    authenticityConfirmedAt: normalizeBoolean(
      formData.get("authenticityConfirmed"),
    )
      ? new Date()
      : null,
    ipRightsConfirmedAt: normalizeBoolean(formData.get("ipRightsConfirmed"))
      ? new Date()
      : null,
    approvalStatus: PRODUCT_COMPLIANCE_STATUSES.includes(approvalStatus)
      ? approvalStatus
      : "DRAFT",
    reviewNotes: admin
      ? normalizeText(formData.get("complianceReviewNotes"))
      : null,
  };
}

export async function getVendorGovernanceSettings(
  { vendorId, vendorStoreId },
  { prismaClient = prisma, env = process.env } = {},
) {
  const seller = await prismaClient.seller.findFirst({
    where: { vendorId, vendorStoreId },
    include: {
      complianceProfile: true,
      agreementAcceptances: { orderBy: { acceptedAt: "desc" } },
      settlementControl: true,
      vendor: {
        include: { vendorStore: { include: { returnAddresses: true } } },
      },
    },
  });
  if (!seller) return null;
  const agreementVersion = getCurrentSellerAgreementVersion(env);
  const configuration = getMarketplaceGovernanceConfiguration(env);
  return {
    seller,
    agreementVersion,
    agreementUrl: configuration.sellerAgreementUrl,
    agreementDocumentHashConfigured: Boolean(
      configuration.sellerAgreementDocumentHash,
    ),
    readiness: evaluateSellerGovernanceReadiness(
      seller,
      getSellerAgreementReadinessOptions(env),
    ),
  };
}

export async function upsertSellerComplianceProfile(
  { sellerId, values, reviewedBy = null },
  { prismaClient = prisma } = {},
) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
  });
  if (!seller) return { ok: false, reason: "seller_not_found" };
  const now = new Date();
  const data = {
    ...values,
    reviewedAt: values.reviewStatus === "APPROVED" ? now : null,
    reviewedBy: values.reviewStatus === "APPROVED" ? reviewedBy : null,
  };
  const profile = await prismaClient.sellerComplianceProfile.upsert({
    where: { sellerId },
    create: { sellerId, ...data },
    update: data,
  });
  return { ok: true, profile };
}

export async function recordSellerAgreementAcceptance(
  {
    sellerId,
    version,
    documentHash,
    acceptedBy,
    source = "ADMIN_RECORDED",
    ipAddress = null,
    userAgent = null,
    acceptedByUserId = null,
    acceptedByEmail = null,
    evidenceUrl = null,
    evidenceHash = null,
  },
  { prismaClient = prisma } = {},
) {
  const normalizedVersion = normalizeText(version);
  const normalizedHash = normalizeLower(documentHash);
  const normalizedAcceptedBy = normalizeText(acceptedBy);
  const normalizedSource = normalizeUpper(source) || "ADMIN_RECORDED";
  const normalizedEvidenceUrl = normalizePublicHttpUrl(evidenceUrl);
  const normalizedEvidenceHash = normalizeLower(evidenceHash);
  if (
    !normalizedVersion ||
    !/^[a-f0-9]{64}$/.test(normalizedHash) ||
    !normalizedAcceptedBy ||
    (normalizedEvidenceHash && !/^[a-f0-9]{64}$/.test(normalizedEvidenceHash))
  ) {
    return { ok: false, reason: "invalid_agreement_acceptance" };
  }
  if (
    normalizedSource === "ADMIN_RECORDED" &&
    !normalizedEvidenceUrl &&
    !normalizedEvidenceHash
  ) {
    return { ok: false, reason: "agreement_evidence_required" };
  }

  const acceptanceKey = hashValue(
    JSON.stringify({
      sellerId,
      agreementType: SELLER_AGREEMENT_TYPE,
      version: normalizedVersion,
      documentHash: normalizedHash,
      acceptedBy: normalizedAcceptedBy,
      acceptedByUserId: normalizeText(acceptedByUserId),
      acceptedByEmail: normalizeLower(acceptedByEmail),
      source: normalizedSource,
      evidenceUrl: normalizedEvidenceUrl,
      evidenceHash: normalizedEvidenceHash || null,
    }),
  );
  const existing = await prismaClient.sellerAgreementAcceptance.findUnique({
    where: { acceptanceKey },
  });
  if (existing) return { ok: true, unchanged: true, acceptance: existing };

  const acceptance = await prismaClient.sellerAgreementAcceptance.create({
    data: {
      acceptanceKey,
      sellerId,
      agreementType: SELLER_AGREEMENT_TYPE,
      version: normalizedVersion,
      documentHash: normalizedHash,
      acceptedBy: normalizedAcceptedBy,
      acceptedByUserId: normalizeText(acceptedByUserId),
      acceptedByEmail: normalizeLower(acceptedByEmail),
      source: normalizedSource,
      ipHash: hashPrivateIdentifier(ipAddress),
      userAgentHash: hashPrivateIdentifier(userAgent),
      evidenceUrl: normalizedEvidenceUrl,
      evidenceHash: normalizedEvidenceHash || null,
    },
  });
  return { ok: true, acceptance };
}

export async function upsertSellerSettlementControl(
  { sellerId, values, reviewedBy = "admin" },
  { prismaClient = prisma } = {},
) {
  const data = {
    salesHold: normalizeBoolean(values.salesHold),
    payoutHold: normalizeBoolean(values.payoutHold),
    holdReason: normalizeText(values.holdReason),
    futureSetoffEnabled: normalizeBoolean(values.futureSetoffEnabled),
    reviewedAt: new Date(),
    reviewedBy,
  };
  const control = await prismaClient.sellerSettlementControl.upsert({
    where: { sellerId },
    create: { sellerId, ...data },
    update: data,
  });
  return { ok: true, control };
}

export async function upsertProductComplianceProfile(
  { productId, values, reviewedBy = null },
  { prismaClient = prisma } = {},
) {
  const product = await prismaClient.product.findUnique({
    where: { id: productId },
  });
  if (!product) return { ok: false, reason: "product_not_found" };
  const now = new Date();
  const data = {
    ...values,
    reviewedAt: values.approvalStatus === "APPROVED" ? now : null,
    reviewedBy: values.approvalStatus === "APPROVED" ? reviewedBy : null,
  };
  const profile = await prismaClient.productComplianceProfile.upsert({
    where: { productId },
    create: { productId, ...data },
    update: data,
  });
  return { ok: true, profile };
}

export async function getMarketplaceGovernanceDashboard({
  prismaClient = prisma,
  env = process.env,
} = {}) {
  const configuration = getMarketplaceGovernanceConfiguration(env);
  const agreementVersion = configuration.sellerAgreementVersion;
  const [
    sellers,
    products,
    productReadinessCandidates,
    cases,
    criticalCaseCount,
  ] = await Promise.all([
    prismaClient.seller.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        complianceProfile: true,
        agreementAcceptances: { orderBy: { acceptedAt: "desc" } },
        settlementControl: true,
        vendor: {
          include: { vendorStore: { include: { returnAddresses: true } } },
        },
      },
    }),
    prismaClient.product.findMany({
      where: { approvalStatus: { in: ["pending", "review", "approved"] } },
      orderBy: { updatedAt: "desc" },
      include: { complianceProfile: true, vendorStore: true },
      take: 200,
    }),
    prismaClient.product.findMany({
      where: { approvalStatus: { in: ["pending", "review", "approved"] } },
      select: {
        id: true,
        approvalStatus: true,
        shopifyProductId: true,
        complianceProfile: true,
        vendorStore: { select: { isTestStore: true } },
      },
    }),
    prismaClient.marketplaceOperationalCase.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        seller: { include: { vendor: true } },
        responsibilitySeller: { include: { vendor: true } },
        settlementAdjustments: true,
        events: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      take: 100,
    }),
    prismaClient.marketplaceOperationalCase.count({
      where: {
        priority: "CRITICAL",
        status: { notIn: ["RESOLVED", "CLOSED"] },
      },
    }),
  ]);

  const sellerRows = sellers.map((seller) => ({
    seller,
    readiness: evaluateSellerGovernanceReadiness(
      seller,
      getSellerAgreementReadinessOptions(env),
    ),
  }));
  const productRows = products.map((product) => ({
    product,
    readiness: evaluateProductGovernanceReadiness(product),
  }));
  const productionProductReadiness = productReadinessCandidates
    .filter((product) => !product.vendorStore?.isTestStore)
    .map((product) => evaluateProductGovernanceReadiness(product));
  const blockedProductionProductCount = productionProductReadiness.filter(
    (readiness) => !readiness.ready,
  ).length;

  return {
    agreementVersion,
    buyerTermsVersion: configuration.buyerTermsVersion,
    configuration,
    gateEnabled: isMarketplaceGovernanceGateEnabled(env),
    sellers: sellerRows,
    products: productRows,
    cases,
    inspection: {
      productionProductCount: productionProductReadiness.length,
      blockedProductionProductCount,
      criticalCaseCount,
    },
    summary: {
      sellerCount: sellerRows.length,
      sellerReadyCount: sellerRows.filter((row) => row.readiness.ready).length,
      productCount: productRows.length,
      productReadyCount: productRows.filter((row) => row.readiness.ready)
        .length,
      openCaseCount: await prismaClient.marketplaceOperationalCase.count({
        where: { status: { notIn: ["RESOLVED", "CLOSED"] } },
      }),
    },
  };
}

function createCaseNumber(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `CASE-${stamp}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function createMarketplaceOperationalCase(
  values,
  { prismaClient = prisma, actor = "admin", actorMetadata = null } = {},
) {
  const caseType = normalizeUpper(values.caseType);
  const summary = normalizeText(values.summary);
  if (!OPERATIONAL_CASE_TYPES.includes(caseType) || !summary) {
    return { ok: false, reason: "invalid_case" };
  }
  const dueAt = values.dueAt ? new Date(values.dueAt) : null;
  if (values.dueAt && Number.isNaN(dueAt?.getTime())) {
    return { ok: false, reason: "invalid_case_due_at" };
  }
  const detailsJson = parseJsonObject(values.detailsJson) || {};
  if (caseType === "SELLER_DISCLOSURE") {
    const legalBasis = normalizeText(
      values.legalBasis || detailsJson.legalBasis,
    );
    const claimantIdentityStatus = normalizeUpper(
      values.claimantIdentityStatus || detailsJson.claimantIdentityStatus,
    );
    if (!dueAt || !legalBasis || !claimantIdentityStatus) {
      return { ok: false, reason: "seller_disclosure_details_required" };
    }
    detailsJson.legalBasis = legalBasis;
    detailsJson.claimantIdentityStatus = claimantIdentityStatus;
    detailsJson.relatedOrderReference = normalizeText(
      values.relatedOrderReference || detailsJson.relatedOrderReference,
    );
    detailsJson.requestedFields = normalizeText(
      values.requestedFields || detailsJson.requestedFields,
    );
  }
  const created = await prismaClient.$transaction(async (tx) => {
    const entry = await tx.marketplaceOperationalCase.create({
      data: {
        caseNumber: createCaseNumber(),
        caseType,
        priority: ["LOW", "NORMAL", "HIGH", "CRITICAL"].includes(
          normalizeUpper(values.priority),
        )
          ? normalizeUpper(values.priority)
          : "NORMAL",
        marketplaceOrderId: normalizeText(values.marketplaceOrderId),
        sellerOrderId: normalizeText(values.sellerOrderId),
        sellerId: normalizeText(values.sellerId),
        vendorStoreId: normalizeText(values.vendorStoreId),
        productId: normalizeText(values.productId),
        currencyCode: normalizeLower(values.currencyCode) || "jpy",
        claimedAmount: normalizeNonNegativeInteger(values.claimedAmount),
        summary,
        detailsJson,
        dueAt,
        assignedTo: normalizeText(values.assignedTo),
        openedBy: actor,
      },
    });
    await tx.marketplaceOperationalCaseEvent.create({
      data: {
        caseId: entry.id,
        eventType: "CREATED",
        toStatus: entry.status,
        actor,
        note: summary,
        metadataJson: actorMetadata,
      },
    });
    return entry;
  });
  return { ok: true, case: created };
}

export async function updateMarketplaceOperationalCase(
  {
    caseId,
    status,
    responsibilitySellerId,
    responsibilityStatus,
    confirmedSellerLiabilityAmount,
    platformLiabilityAmount,
    resolutionType,
    resolutionNotes,
    evidenceJson,
    decisionReasonCode,
  },
  { prismaClient = prisma, actor = "admin", actorMetadata = null } = {},
) {
  const current = await prismaClient.marketplaceOperationalCase.findUnique({
    where: { id: caseId },
    include: { settlementAdjustments: true },
  });
  if (!current) return { ok: false, reason: "case_not_found" };
  const nextStatus = normalizeUpper(status) || current.status;
  if (!OPERATIONAL_CASE_STATUSES.includes(nextStatus)) {
    return { ok: false, reason: "invalid_case_status" };
  }
  const nextResponsibilitySellerId =
    normalizeText(responsibilitySellerId) || current.responsibilitySellerId;
  const nextResponsibilityStatus =
    normalizeUpper(responsibilityStatus) || current.responsibilityStatus;
  const nextEvidenceJson =
    parseJsonObject(evidenceJson) || current.evidenceJson;
  const nextResolutionNotes =
    normalizeText(resolutionNotes) || current.resolutionNotes;
  const nextDecisionReasonCode =
    normalizeUpper(decisionReasonCode) || current.decisionReasonCode;
  const isResponsibilityConfirmation =
    nextStatus === "RESPONSIBILITY_CONFIRMED" ||
    (current.responsibilityConfirmedAt &&
      ["ACTION_REQUIRED", "RESOLVED", "CLOSED"].includes(nextStatus));

  if (isResponsibilityConfirmation) {
    if (
      !nextResponsibilitySellerId ||
      !["SELLER", "SHARED"].includes(nextResponsibilityStatus)
    ) {
      return { ok: false, reason: "responsibility_details_required" };
    }
    if (
      !nextEvidenceJson ||
      Object.keys(nextEvidenceJson).length === 0 ||
      !nextResolutionNotes ||
      !nextDecisionReasonCode
    ) {
      return { ok: false, reason: "responsibility_evidence_required" };
    }

    const sellerParticipates = await sellerParticipatesInOperationalCase(
      current,
      nextResponsibilitySellerId,
      prismaClient,
    );
    if (!sellerParticipates) {
      return { ok: false, reason: "responsibility_seller_not_related" };
    }
  }
  const nextLiabilityAmount = normalizeNonNegativeInteger(
    confirmedSellerLiabilityAmount,
  );
  const committedLiability = asArray(current.settlementAdjustments)
    .filter(
      (entry) =>
        entry.direction === "debit" &&
        ["SET_OFF", "DIRECT_INVOICE"].includes(entry.adjustmentType) &&
        ["PENDING", "APPROVED", "APPLIED"].includes(entry.status),
    )
    .reduce(
      (total, entry) => total + normalizeNonNegativeInteger(entry.amount),
      0,
    );
  if (nextLiabilityAmount < committedLiability) {
    return { ok: false, reason: "liability_below_committed_adjustments" };
  }
  const next = await prismaClient.$transaction(async (tx) => {
    const updated = await tx.marketplaceOperationalCase.update({
      where: { id: caseId },
      data: {
        status: nextStatus,
        responsibilitySellerId: nextResponsibilitySellerId,
        responsibilityStatus: nextResponsibilityStatus,
        confirmedSellerLiabilityAmount: nextLiabilityAmount,
        platformLiabilityAmount: normalizeNonNegativeInteger(
          platformLiabilityAmount,
        ),
        resolutionType: normalizeText(resolutionType),
        resolutionNotes: nextResolutionNotes,
        evidenceJson: nextEvidenceJson,
        decisionReasonCode: nextDecisionReasonCode,
        responsibilityConfirmedAt: isResponsibilityConfirmation
          ? current.responsibilityConfirmedAt || new Date()
          : current.responsibilityConfirmedAt,
        responsibilityConfirmedBy: isResponsibilityConfirmation
          ? current.responsibilityConfirmedBy || actor
          : current.responsibilityConfirmedBy,
        resolvedAt: ["RESOLVED", "CLOSED"].includes(nextStatus)
          ? new Date()
          : null,
      },
    });
    await tx.marketplaceOperationalCaseEvent.create({
      data: {
        caseId,
        eventType: "STATUS_UPDATED",
        fromStatus: current.status,
        toStatus: nextStatus,
        actor,
        note: nextResolutionNotes,
        metadataJson: {
          ...(actorMetadata || {}),
          decisionReasonCode: nextDecisionReasonCode,
          responsibilitySellerId: nextResponsibilitySellerId,
          responsibilityStatus: nextResponsibilityStatus,
        },
      },
    });
    return updated;
  });
  return { ok: true, case: next };
}

async function sellerParticipatesInOperationalCase(
  caseEntry,
  sellerId,
  prismaClient,
) {
  if (caseEntry.sellerOrderId) {
    const sellerOrder = await prismaClient.sellerOrder.findUnique({
      where: { id: caseEntry.sellerOrderId },
      select: { sellerId: true },
    });
    return sellerOrder?.sellerId === sellerId;
  }
  if (caseEntry.productId) {
    const product = await prismaClient.product.findUnique({
      where: { id: caseEntry.productId },
      select: { vendorStore: { select: { seller: { select: { id: true } } } } },
    });
    return product?.vendorStore?.seller?.id === sellerId;
  }
  if (caseEntry.vendorStoreId) {
    const seller = await prismaClient.seller.findUnique({
      where: { vendorStoreId: caseEntry.vendorStoreId },
      select: { id: true },
    });
    return seller?.id === sellerId;
  }
  if (caseEntry.marketplaceOrderId) {
    const count = await prismaClient.sellerOrder.count({
      where: { marketplaceOrderId: caseEntry.marketplaceOrderId, sellerId },
    });
    return count > 0;
  }
  return caseEntry.sellerId === sellerId;
}

export async function createSettlementAdjustment(
  {
    sellerId,
    caseId = null,
    originalAdjustmentId = null,
    adjustmentType,
    direction = "debit",
    amount,
    currencyCode = "jpy",
    reason,
    createdBy = "admin",
    createdByJson = null,
  },
  { prismaClient = prisma } = {},
) {
  const normalizedType = normalizeUpper(adjustmentType);
  const normalizedAmount = normalizePositiveInteger(amount);
  const normalizedReason = normalizeText(reason);
  const normalizedDirection =
    normalizeLower(direction) === "credit" ? "credit" : "debit";
  const normalizedCaseId = normalizeText(caseId);
  const normalizedOriginalAdjustmentId = normalizeText(originalAdjustmentId);
  const normalizedCurrency = normalizeLower(currencyCode) || "jpy";
  if (
    !SETTLEMENT_ADJUSTMENT_TYPES.includes(normalizedType) ||
    !normalizedAmount ||
    !normalizedReason
  ) {
    return { ok: false, reason: "invalid_adjustment" };
  }
  if (normalizedType === "SET_OFF" && normalizedDirection !== "debit") {
    return { ok: false, reason: "invalid_adjustment_direction" };
  }
  if (normalizedCurrency !== "jpy") {
    return { ok: false, reason: "unsupported_settlement_currency" };
  }
  if (!normalizedCaseId) {
    return { ok: false, reason: "case_required" };
  }
  const adjustment = await runSerializableGovernanceTransaction(
    prismaClient,
    async (tx) => {
      const seller = await tx.seller.findUnique({
        where: { id: sellerId },
        include: { settlementControl: true, complianceProfile: true },
      });
      if (!seller) return { error: "seller_not_found" };
      if (normalizeUpper(seller.complianceProfile?.countryCode) !== "JP") {
        return { error: "unsupported_settlement_country" };
      }

      const caseEntry = normalizedCaseId
        ? await tx.marketplaceOperationalCase.findUnique({
            where: { id: normalizedCaseId },
            include: { settlementAdjustments: true },
          })
        : null;
      if (normalizedCaseId && !caseEntry) return { error: "case_not_found" };
      if (
        caseEntry &&
        normalizeLower(caseEntry.currencyCode) !== normalizedCurrency
      ) {
        return { error: "case_currency_mismatch" };
      }

      if (
        normalizedDirection === "debit" &&
        ["SET_OFF", "DIRECT_INVOICE"].includes(normalizedType)
      ) {
        const responsibilityConfirmed =
          caseEntry &&
          caseEntry.responsibilitySellerId === sellerId &&
          ["SELLER", "SHARED"].includes(caseEntry.responsibilityStatus) &&
          [
            "RESPONSIBILITY_CONFIRMED",
            "ACTION_REQUIRED",
            "RESOLVED",
            "CLOSED",
          ].includes(caseEntry.status);
        if (!responsibilityConfirmed) {
          return { error: "responsibility_not_confirmed" };
        }

        const committedLiability = asArray(caseEntry.settlementAdjustments)
          .filter(
            (entry) =>
              entry.direction === "debit" &&
              ["SET_OFF", "DIRECT_INVOICE"].includes(entry.adjustmentType) &&
              ["PENDING", "APPROVED", "APPLYING", "APPLIED"].includes(
                entry.status,
              ),
          )
          .reduce(
            (total, entry) => total + normalizeNonNegativeInteger(entry.amount),
            0,
          );
        if (
          committedLiability + normalizedAmount >
          normalizeNonNegativeInteger(caseEntry.confirmedSellerLiabilityAmount)
        ) {
          return { error: "liability_amount_exceeded" };
        }
      }

      if (
        normalizedType === "SET_OFF" &&
        normalizedDirection === "debit" &&
        !seller.settlementControl?.futureSetoffEnabled
      ) {
        return { error: "future_setoff_not_authorized" };
      }

      if (normalizedType === "RESERVE" && normalizedOriginalAdjustmentId) {
        return { error: "original_adjustment_not_allowed" };
      }
      if (normalizedType === "RELEASE") {
        if (!normalizedOriginalAdjustmentId) {
          return { error: "original_reserve_required" };
        }
        const original = await tx.sellerSettlementAdjustment.findUnique({
          where: { id: normalizedOriginalAdjustmentId },
          include: { releaseAdjustments: true },
        });
        if (
          !original ||
          original.adjustmentType !== "RESERVE" ||
          original.status !== "APPLIED" ||
          original.sellerId !== sellerId ||
          original.caseId !== normalizedCaseId ||
          normalizeLower(original.currencyCode) !== normalizedCurrency
        ) {
          return { error: "original_reserve_invalid" };
        }
        const releasedAmount = asArray(original.releaseAdjustments)
          .filter((entry) =>
            ["PENDING", "APPROVED", "APPLYING", "APPLIED"].includes(
              entry.status,
            ),
          )
          .reduce(
            (total, entry) => total + normalizeNonNegativeInteger(entry.amount),
            0,
          );
        if (releasedAmount + normalizedAmount > original.amount) {
          return { error: "reserve_release_amount_exceeded" };
        }
      }

      return tx.sellerSettlementAdjustment.create({
        data: {
          sellerId,
          caseId: normalizedCaseId,
          originalAdjustmentId:
            normalizedType === "RELEASE"
              ? normalizedOriginalAdjustmentId
              : null,
          adjustmentType: normalizedType,
          direction:
            normalizedType === "RELEASE"
              ? "credit"
              : normalizedType === "RESERVE"
                ? "debit"
                : normalizedDirection,
          amount: normalizedAmount,
          currencyCode: normalizedCurrency,
          reason: normalizedReason,
          metadataJson: {
            createdBy: normalizeText(createdBy),
            createdByJson,
          },
        },
      });
    },
  );
  if (adjustment?.error) return { ok: false, reason: adjustment.error };
  return { ok: true, adjustment };
}

export async function applySettlementAdjustment(
  { adjustmentId, actor = "admin", actorMetadata = null },
  { prismaClient = prisma, env = process.env } = {},
) {
  return runSerializableGovernanceTransaction(prismaClient, async (tx) => {
    const adjustment = await tx.sellerSettlementAdjustment.findUnique({
      where: { id: adjustmentId },
      include: { seller: { include: { complianceProfile: true } } },
    });
    if (!adjustment) return { ok: false, reason: "adjustment_not_found" };
    if (adjustment.status === "APPLIED") {
      return { ok: true, unchanged: true, adjustment };
    }
    const adjustmentCreator = normalizeText(
      adjustment.metadataJson?.createdBy ||
        adjustment.metadataJson?.createdByJson?.actorKey,
    );
    if (!adjustmentCreator) {
      return { ok: false, reason: "adjustment_creator_missing" };
    }
    if (adjustmentCreator === actor) {
      return { ok: false, reason: "adjustment_maker_checker_required" };
    }
    if (
      normalizeLower(adjustment.currencyCode) !== "jpy" ||
      normalizeUpper(adjustment.seller?.complianceProfile?.countryCode) !== "JP"
    ) {
      return { ok: false, reason: "unsupported_settlement_currency" };
    }
    if (!["PENDING", "APPROVED"].includes(adjustment.status)) {
      return { ok: false, reason: "adjustment_not_applicable" };
    }
    const settlementReadiness = evaluateSellerSettlementExecutionReadiness(
      adjustment.seller,
      { env },
    );
    if (!settlementReadiness.ready) {
      return {
        ok: false,
        reason: "seller_settlement_disabled",
        settlementReasons: settlementReadiness.reasons,
      };
    }
    if (adjustment.adjustmentType === "RELEASE") {
      const original = adjustment.originalAdjustmentId
        ? await tx.sellerSettlementAdjustment.findUnique({
            where: { id: adjustment.originalAdjustmentId },
            include: { releaseAdjustments: true },
          })
        : null;
      if (
        !original ||
        original.adjustmentType !== "RESERVE" ||
        original.status !== "APPLIED" ||
        original.sellerId !== adjustment.sellerId ||
        original.caseId !== adjustment.caseId ||
        normalizeLower(original.currencyCode) !==
          normalizeLower(adjustment.currencyCode)
      ) {
        return { ok: false, reason: "original_reserve_invalid" };
      }
      const otherReleasedAmount = asArray(original.releaseAdjustments)
        .filter(
          (entry) =>
            entry.id !== adjustment.id &&
            ["APPROVED", "APPLYING", "APPLIED"].includes(entry.status),
        )
        .reduce(
          (total, entry) => total + normalizeNonNegativeInteger(entry.amount),
          0,
        );
      if (otherReleasedAmount + adjustment.amount > original.amount) {
        return { ok: false, reason: "reserve_release_amount_exceeded" };
      }
    }
    if (
      adjustment.direction === "debit" &&
      ["SET_OFF", "DIRECT_INVOICE"].includes(adjustment.adjustmentType)
    ) {
      const caseEntry = adjustment.caseId
        ? await tx.marketplaceOperationalCase.findUnique({
            where: { id: adjustment.caseId },
            include: { settlementAdjustments: true },
          })
        : null;
      const responsibilityStillConfirmed =
        caseEntry &&
        caseEntry.responsibilitySellerId === adjustment.sellerId &&
        ["SELLER", "SHARED"].includes(caseEntry.responsibilityStatus) &&
        [
          "RESPONSIBILITY_CONFIRMED",
          "ACTION_REQUIRED",
          "RESOLVED",
          "CLOSED",
        ].includes(caseEntry.status);
      if (!responsibilityStillConfirmed) {
        return { ok: false, reason: "responsibility_not_confirmed" };
      }
      const committedLiability = asArray(caseEntry.settlementAdjustments)
        .filter(
          (entry) =>
            entry.id !== adjustment.id &&
            entry.direction === "debit" &&
            ["SET_OFF", "DIRECT_INVOICE"].includes(entry.adjustmentType) &&
            ["PENDING", "APPROVED", "APPLYING", "APPLIED"].includes(
              entry.status,
            ),
        )
        .reduce(
          (total, entry) => total + normalizeNonNegativeInteger(entry.amount),
          0,
        );
      if (
        committedLiability + normalizeNonNegativeInteger(adjustment.amount) >
        normalizeNonNegativeInteger(caseEntry.confirmedSellerLiabilityAmount)
      ) {
        return { ok: false, reason: "liability_amount_exceeded" };
      }
      if (adjustment.adjustmentType === "SET_OFF") {
        const control = await tx.sellerSettlementControl.findUnique({
          where: { sellerId: adjustment.sellerId },
        });
        if (!control?.futureSetoffEnabled) {
          return { ok: false, reason: "future_setoff_not_authorized" };
        }
      }
    }
    const claimed = await tx.sellerSettlementAdjustment.updateMany({
      where: {
        id: adjustment.id,
        status: { in: ["PENDING", "APPROVED"] },
      },
      data: { status: "APPLYING" },
    });
    if (claimed.count !== 1) {
      const latest = await tx.sellerSettlementAdjustment.findUnique({
        where: { id: adjustment.id },
      });
      if (latest?.status === "APPLIED") {
        return { ok: true, unchanged: true, adjustment: latest };
      }
      return { ok: false, reason: "adjustment_application_in_progress" };
    }
    let ledgerEntry = null;
    let controlChange = null;

    if (adjustment.adjustmentType === "SET_OFF") {
      ledgerEntry = await tx.ledgerEntry.create({
        data: {
          sellerId: adjustment.sellerId,
          entryType: "case_adjustment",
          amount: adjustment.amount,
          currencyCode: adjustment.currencyCode,
          direction: adjustment.direction,
          description: adjustment.reason,
          metadataJson: {
            adjustmentId: adjustment.id,
            caseId: adjustment.caseId,
            adjustmentType: adjustment.adjustmentType,
            appliedBy: actor,
            actorMetadata,
          },
          occurredAt: new Date(),
        },
      });
    } else {
      const currentControl = await tx.sellerSettlementControl.findUnique({
        where: { sellerId: adjustment.sellerId },
      });
      const currentReserve = normalizeNonNegativeInteger(
        currentControl?.reserveAmount,
      );
      const currentInvoice = normalizeNonNegativeInteger(
        currentControl?.directInvoiceBalance,
      );
      let reserveAmount = currentReserve;
      let directInvoiceBalance = currentInvoice;

      if (adjustment.adjustmentType === "RESERVE") {
        reserveAmount =
          adjustment.direction === "credit"
            ? Math.max(0, currentReserve - adjustment.amount)
            : currentReserve + adjustment.amount;
      } else if (adjustment.adjustmentType === "RELEASE") {
        reserveAmount = Math.max(0, currentReserve - adjustment.amount);
      } else if (adjustment.adjustmentType === "DIRECT_INVOICE") {
        directInvoiceBalance =
          adjustment.direction === "credit"
            ? Math.max(0, currentInvoice - adjustment.amount)
            : currentInvoice + adjustment.amount;
      }

      controlChange = await tx.sellerSettlementControl.upsert({
        where: { sellerId: adjustment.sellerId },
        create: {
          sellerId: adjustment.sellerId,
          reserveAmount,
          directInvoiceBalance,
          reviewedAt: new Date(),
          reviewedBy: actor,
        },
        update: {
          reserveAmount,
          directInvoiceBalance,
          reviewedAt: new Date(),
          reviewedBy: actor,
        },
      });
    }
    const updated = await tx.sellerSettlementAdjustment.update({
      where: { id: adjustment.id },
      data: {
        status: "APPLIED",
        approvedAt: adjustment.approvedAt || new Date(),
        approvedBy: adjustment.approvedBy || actor,
        appliedAt: new Date(),
        appliedBy: actor,
        ledgerEntryId: ledgerEntry?.id || null,
      },
    });
    if (adjustment.caseId) {
      await tx.marketplaceOperationalCaseEvent.create({
        data: {
          caseId: adjustment.caseId,
          eventType: "SETTLEMENT_ADJUSTMENT_APPLIED",
          actor,
          note: `${adjustment.adjustmentType}: ${adjustment.amount} ${adjustment.currencyCode}`,
          metadataJson: {
            ...(actorMetadata || {}),
            adjustmentId: adjustment.id,
            ledgerEntryId: ledgerEntry?.id || null,
            reserveAmount: controlChange?.reserveAmount ?? null,
            directInvoiceBalance: controlChange?.directInvoiceBalance ?? null,
          },
        },
      });
    }
    return {
      ok: true,
      adjustment: updated,
      ledgerEntry,
      settlementControl: controlChange,
    };
  });
}
