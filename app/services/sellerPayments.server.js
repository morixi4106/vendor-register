import { createRequire } from "node:module";

import Stripe from "stripe";
import isoCountries from "i18n-iso-countries";

import prisma from "../db.server.js";

const require = createRequire(import.meta.url);
const jaLocale = require("i18n-iso-countries/langs/ja.json");

isoCountries.registerLocale(jaLocale);

export const SELLER_STATUSES = [
  "pending",
  "active",
  "review",
  "restricted",
  "banned",
];

export const PAYOUT_RUN_STATUSES = [
  "draft",
  "approved",
  "executed",
  "failed",
];

export const ORDER_STATUSES = [
  "draft",
  "payment_intent_created",
  "paid",
  "refunded",
  "disputed",
  "failed",
];

export const LEDGER_ENTRY_TYPES = [
  "charge",
  "application_fee",
  "application_fee_refund",
  "refund",
  "dispute_created",
  "dispute_updated",
  "dispute_closed",
  "dispute_funds_withdrawn",
  "dispute_funds_reinstated",
  "payout_created",
  "payout_paid",
  "payout_failed",
];

const DEFAULT_PLATFORM_FEE_BPS = 1000;
const DEFAULT_ORDER_CURRENCY = "jpy";
const SELLER_REVIEW_REASON_PAYOUT_FAILED =
  "payout_external_account_update_required";
const SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED =
  "payout_external_account_admin_review_required";
const SELLER_REVIEW_REASON_DISPUTE = "dispute_review_required";

let stripeClientSingleton = null;

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeLowercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeUppercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.round(numeric));
}

function toIsoCountryCode(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "JP";
  }

  if (/^[A-Za-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return (
    isoCountries.getAlpha2Code(normalized, "ja") ||
    isoCountries.getAlpha2Code(normalized, "en") ||
    "JP"
  );
}

function toDisplayPrice(product) {
  const calculatedPrice = Number(product?.calculatedPrice);
  if (Number.isFinite(calculatedPrice) && calculatedPrice > 0) {
    return Math.round(calculatedPrice);
  }

  const basePrice = Number(product?.price);
  if (Number.isFinite(basePrice) && basePrice > 0) {
    return Math.round(basePrice);
  }

  return 0;
}

function calculatePlatformFeeAmount(totalAmount, feeBps = DEFAULT_PLATFORM_FEE_BPS) {
  const normalizedTotal = clampInteger(totalAmount, 0);
  const normalizedBps = Number.isFinite(Number(feeBps))
    ? Math.max(0, Math.round(Number(feeBps)))
    : DEFAULT_PLATFORM_FEE_BPS;

  return Math.min(
    normalizedTotal,
    Math.floor((normalizedTotal * normalizedBps) / 10000),
  );
}

export function getPlatformFeeBps() {
  return Number(process.env.STRIPE_PLATFORM_FEE_BPS || DEFAULT_PLATFORM_FEE_BPS);
}

function getStripeSecretKey() {
  const secretKey = normalizeText(process.env.STRIPE_SECRET_KEY);

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY_MISSING");
  }

  return secretKey;
}

export function getStripePublishableKey() {
  return normalizeText(process.env.STRIPE_PUBLISHABLE_KEY);
}

function getStripeWebhookSecrets() {
  const secrets = [
    {
      type: "connect",
      secret: normalizeText(process.env.STRIPE_CONNECT_WEBHOOK_SECRET),
    },
    {
      type: "platform",
      secret: normalizeText(process.env.STRIPE_WEBHOOK_SECRET),
    },
  ].filter((item) => item.secret);
  const uniqueSecrets = [];

  for (const item of secrets) {
    if (!uniqueSecrets.some((existing) => existing.secret === item.secret)) {
      uniqueSecrets.push(item);
    }
  }

  if (uniqueSecrets.length === 0) {
    throw new Error("STRIPE_WEBHOOK_SECRET_MISSING");
  }

  return uniqueSecrets;
}

export function getStripeClient() {
  if (!stripeClientSingleton) {
    stripeClientSingleton = new Stripe(getStripeSecretKey());
  }

  return stripeClientSingleton;
}

function createSellerStatusLabel(status) {
  switch (status) {
    case "pending":
      return "未設定";
    case "active":
      return "有効";
    case "review":
      return "確認中";
    case "restricted":
      return "制限中";
    case "banned":
      return "停止中";
    default:
      return status || "-";
  }
}

function createPayoutRunStatusLabel(status) {
  switch (status) {
    case "draft":
      return "下書き";
    case "approved":
      return "承認済み";
    case "executed":
      return "実行済み";
    case "failed":
      return "失敗";
    default:
      return status || "-";
  }
}

function serializeStripeAccountSummary(stripeAccount) {
  if (!stripeAccount) {
    return null;
  }

  return {
    id: stripeAccount.id,
    sellerId: stripeAccount.sellerId,
    stripeAccountId: stripeAccount.stripeAccountId,
    countryCode: stripeAccount.countryCode || null,
    defaultCurrency: stripeAccount.defaultCurrency || null,
    detailsSubmitted: Boolean(stripeAccount.detailsSubmitted),
    chargesEnabled: Boolean(stripeAccount.chargesEnabled),
    payoutsEnabled: Boolean(stripeAccount.payoutsEnabled),
    payoutSchedule: stripeAccount.payoutSchedule || "manual",
    dashboardType: stripeAccount.dashboardType || "none",
    onboardingCompletedAt: stripeAccount.onboardingCompletedAt || null,
    updatedAt: stripeAccount.updatedAt,
  };
}

function serializeSellerSummary(vendor) {
  const seller = vendor?.seller;
  const stripeAccount = seller?.stripeAccount;

  return {
    vendorId: vendor.id,
    vendorStoreId: vendor.vendorStoreId,
    vendorHandle: vendor.handle,
    vendorStoreName: vendor.storeName,
    managementEmail: vendor.managementEmail,
    sellerId: seller?.id || null,
    sellerStatus: seller?.status || null,
    sellerStatusLabel: createSellerStatusLabel(seller?.status),
    stripeAccount: serializeStripeAccountSummary(stripeAccount),
    createdAt: seller?.createdAt || vendor.createdAt,
    updatedAt: seller?.updatedAt || vendor.updatedAt,
  };
}

async function loadVendorForSellerInitialization(vendorId, prismaClient = prisma) {
  return prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });
}

export async function ensureSellerForVendor(
  vendorId,
  {
    prismaClient = prisma,
    defaultStatus = "pending",
    changedBy = "system",
    reason = "seller_initialized",
  } = {},
) {
  const vendor = await loadVendorForSellerInitialization(vendorId, prismaClient);

  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }

  if (vendor.seller) {
    return {
      created: false,
      seller: vendor.seller,
      vendor,
    };
  }

  const seller = await prismaClient.$transaction(async (tx) => {
    const createdSeller = await tx.seller.create({
      data: {
        vendorId: vendor.id,
        vendorStoreId: vendor.vendorStoreId,
        status: defaultStatus,
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId: createdSeller.id,
        fromStatus: null,
        toStatus: defaultStatus,
        changedBy,
        reason,
      },
    });

    return tx.seller.findUnique({
      where: { id: createdSeller.id },
      include: {
        stripeAccount: true,
      },
    });
  });

  return {
    created: true,
    seller,
    vendor,
  };
}

export async function listAdminSellerRows({ prismaClient = prisma } = {}) {
  const vendors = await prismaClient.vendor.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  return vendors.map(serializeSellerSummary);
}

export async function getAdminSellerDetail(sellerId, { prismaClient = prisma } = {}) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
      stripeAccount: true,
      statusHistory: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      orders: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      payoutRuns: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      ledgerEntries: {
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        take: 50,
      },
    },
  });

  if (!seller?.vendor?.vendorStore) {
    return null;
  }

  const stripeEvents = seller.stripeAccount?.stripeAccountId
    ? await prismaClient.stripeEvent.findMany({
        where: {
          stripeAccountId: seller.stripeAccount.stripeAccountId,
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
      })
    : [];

  return {
    seller: {
      id: seller.id,
      status: seller.status,
      statusLabel: createSellerStatusLabel(seller.status),
      statusReason: seller.statusReason || null,
      createdAt: seller.createdAt,
      updatedAt: seller.updatedAt,
    },
    vendor: {
      id: seller.vendor.id,
      handle: seller.vendor.handle,
      storeName: seller.vendor.storeName,
      managementEmail: seller.vendor.managementEmail,
      vendorStoreId: seller.vendor.vendorStoreId,
    },
    store: {
      id: seller.vendor.vendorStore.id,
      storeName: seller.vendor.vendorStore.storeName,
      ownerName: seller.vendor.vendorStore.ownerName,
      email: seller.vendor.vendorStore.email,
      phone: seller.vendor.vendorStore.phone,
      address: seller.vendor.vendorStore.address,
      country: seller.vendor.vendorStore.country,
      category: seller.vendor.vendorStore.category,
    },
    stripeAccount: serializeStripeAccountSummary(seller.stripeAccount),
    statusHistory: seller.statusHistory,
    orders: seller.orders,
    payoutRuns: seller.payoutRuns.map((run) => ({
      ...run,
      statusLabel: createPayoutRunStatusLabel(run.status),
    })),
    ledgerEntries: seller.ledgerEntries,
    stripeEvents,
  };
}

export async function updateSellerStatus(
  { sellerId, nextStatus, changedBy = "admin", reason = null },
  { prismaClient = prisma } = {},
) {
  if (!SELLER_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      reason: "invalid_status",
    };
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
  });

  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (seller.status === nextStatus && seller.statusReason === reason) {
    return {
      ok: true,
      changed: false,
      seller,
    };
  }

  const updatedSeller = await prismaClient.$transaction(async (tx) => {
    const nextSeller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: nextStatus,
        statusReason: normalizeText(reason),
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: nextStatus,
        changedBy,
        reason: normalizeText(reason),
      },
    });

    return nextSeller;
  });

  return {
    ok: true,
    changed: true,
    seller: updatedSeller,
  };
}

async function setSellerReviewStatus(
  { sellerId, reason, changedBy = "system.stripe" },
  { prismaClient = prisma } = {},
) {
  if (!sellerId) {
    return null;
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
  });

  if (!seller) {
    return null;
  }

  const normalizedReason = normalizeText(reason);

  if (seller.status === "review" && seller.statusReason === normalizedReason) {
    return seller;
  }

  if (typeof prismaClient.$transaction === "function") {
    return prismaClient.$transaction(async (tx) => {
      const updatedSeller = await tx.seller.update({
        where: { id: sellerId },
        data: {
          status: "review",
          statusReason: normalizedReason,
        },
      });

      await tx.sellerStatusHistory.create({
        data: {
          sellerId,
          fromStatus: seller.status,
          toStatus: "review",
          changedBy,
          reason: normalizedReason,
        },
      });

      return updatedSeller;
    });
  }

  const updatedSeller = await prismaClient.seller.update({
    where: { id: sellerId },
    data: {
      status: "review",
      statusReason: normalizedReason,
    },
  });

  if (prismaClient.sellerStatusHistory?.create) {
    await prismaClient.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: "review",
        changedBy,
        reason: normalizedReason,
      },
    });
  }

  return updatedSeller;
}

async function loadSellerWithStripeContext(sellerId, prismaClient = prisma) {
  return prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
      stripeAccount: true,
    },
  });
}

function buildStripeConnectedAccountCreateParams(seller) {
  const countryCode = toIsoCountryCode(seller?.vendor?.vendorStore?.country);

  return {
    country: countryCode,
    email: seller.vendor.managementEmail,
    business_profile: {
      name: seller.vendor.storeName,
    },
    controller: {
      fees: {
        payer: "account",
      },
      losses: {
        payments: "stripe",
      },
      requirement_collection: "stripe",
      stripe_dashboard: {
        type: "none",
      },
    },
    capabilities: {
      card_payments: {
        requested: true,
      },
      transfers: {
        requested: true,
      },
    },
    metadata: {
      sellerId: seller.id,
      vendorId: seller.vendor.id,
      vendorHandle: seller.vendor.handle,
      vendorStoreId: seller.vendor.vendorStore.id,
    },
  };
}

function normalizeStripeError(error) {
  const raw = error?.raw || {};
  const message = normalizeText(raw.message || error?.message);

  return {
    message: message || "Stripe API request failed.",
    type: normalizeText(raw.type || error?.type),
    code: normalizeText(raw.code || error?.code),
    param: normalizeText(raw.param || error?.param),
    requestId: normalizeText(raw.requestId || error?.requestId),
  };
}

async function setConnectedAccountManualPayouts(stripeClient, stripeAccountId) {
  try {
    await stripeClient.balanceSettings.update(
      {
        payments: {
          payouts: {
            schedule: {
              interval: "manual",
            },
          },
        },
      },
      {
        stripeAccount: stripeAccountId,
      },
    );

    return {
      ok: true,
      method: "balance_settings",
    };
  } catch (balanceSettingsError) {
    const balanceSettingsStripeError = normalizeStripeError(balanceSettingsError);

    if (!stripeClient.accounts?.update) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: balanceSettingsStripeError,
      };
    }

    try {
      await stripeClient.accounts.update(
        stripeAccountId,
        {
          settings: {
            payouts: {
              schedule: {
                interval: "manual",
              },
            },
          },
        },
      );

      return {
        ok: true,
        method: "account_settings",
        fallbackFrom: balanceSettingsStripeError,
      };
    } catch (accountSettingsError) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: normalizeStripeError(accountSettingsError),
        fallbackFrom: balanceSettingsStripeError,
      };
    }
  }
}

export async function createSellerStripeAccount(
  { sellerId },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  const seller = await loadSellerWithStripeContext(sellerId, prismaClient);

  if (!seller?.vendor?.vendorStore) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (seller.stripeAccount) {
    return {
      ok: true,
      created: false,
      seller,
      stripeAccount: serializeStripeAccountSummary(seller.stripeAccount),
    };
  }

  let account = null;

  try {
    account = await stripeClient.accounts.create(
      buildStripeConnectedAccountCreateParams(seller),
    );
  } catch (error) {
    const stripeError = normalizeStripeError(error);

    return {
      ok: false,
      reason: "stripe_account_create_failed",
      message: stripeError.message,
      stripeError,
    };
  }

  const manualPayoutResult = await setConnectedAccountManualPayouts(
    stripeClient,
    account.id,
  );

  if (!manualPayoutResult.ok) {
    return {
      ok: false,
      reason: manualPayoutResult.reason,
      message: manualPayoutResult.stripeError?.message,
      stripeAccountId: account.id,
      stripeError: manualPayoutResult.stripeError,
      fallbackFrom: manualPayoutResult.fallbackFrom,
    };
  }

  const savedStripeAccount = await prismaClient.sellerStripeAccount.create({
    data: {
      sellerId: seller.id,
      stripeAccountId: account.id,
      countryCode: account.country || null,
      defaultCurrency: account.default_currency || DEFAULT_ORDER_CURRENCY,
      detailsSubmitted: Boolean(account.details_submitted),
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      payoutSchedule: "manual",
      dashboardType: "none",
      onboardingCompletedAt: account.details_submitted ? new Date() : null,
      requirementsJson: isPlainObject(account.requirements) ? account.requirements : null,
    },
  });

  return {
    ok: true,
    created: true,
    seller,
    stripeAccount: serializeStripeAccountSummary(savedStripeAccount),
  };
}

export async function syncSellerStripeAccountFromAccountUpdate(
  account,
  { prismaClient = prisma } = {},
) {
  const stripeAccountId = normalizeText(account?.id);

  if (!stripeAccountId) {
    return null;
  }

  const existing = await prismaClient.sellerStripeAccount.findUnique({
    where: { stripeAccountId },
  });

  if (!existing) {
    return null;
  }

  return prismaClient.sellerStripeAccount.update({
    where: { stripeAccountId },
    data: {
      countryCode: normalizeUppercase(account?.country),
      defaultCurrency: normalizeLowercase(account?.default_currency),
      detailsSubmitted: Boolean(account?.details_submitted),
      chargesEnabled: Boolean(account?.charges_enabled),
      payoutsEnabled: Boolean(account?.payouts_enabled),
      onboardingCompletedAt:
        account?.details_submitted && !existing.onboardingCompletedAt
          ? new Date()
          : existing.onboardingCompletedAt,
      requirementsJson: isPlainObject(account?.requirements) ? account.requirements : null,
    },
  });
}

async function processAccountUpdated(
  event,
  { prismaClient = prisma } = {},
) {
  const updatedStripeAccount = await syncSellerStripeAccountFromAccountUpdate(
    event.data?.object,
    { prismaClient },
  );

  if (!updatedStripeAccount?.sellerId) {
    return;
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: updatedStripeAccount.sellerId },
  });

  if (
    seller?.status === "review" &&
    seller.statusReason === SELLER_REVIEW_REASON_PAYOUT_FAILED &&
    event.data?.object?.payouts_enabled === true
  ) {
    await setSellerReviewStatus(
      {
        sellerId: updatedStripeAccount.sellerId,
        reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
        changedBy: "stripe.account.updated",
      },
      { prismaClient },
    );
  }
}

async function processExternalAccountUpdated(
  event,
  { prismaClient = prisma } = {},
) {
  const stripeAccountId = normalizeText(event.account);

  if (!stripeAccountId) {
    return;
  }

  const stripeAccount = await prismaClient.sellerStripeAccount.findUnique({
    where: { stripeAccountId },
  });

  if (!stripeAccount?.sellerId) {
    return;
  }

  await setSellerReviewStatus(
    {
      sellerId: stripeAccount.sellerId,
      reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
      changedBy: "stripe.account.external_account.updated",
    },
    { prismaClient },
  );
}

export async function getSellerPaymentsPageData(
  { vendorId },
  { prismaClient = prisma } = {},
) {
  const vendor = await prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }

  return {
    vendor: {
      id: vendor.id,
      handle: vendor.handle,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail,
    },
    store: {
      id: vendor.vendorStore.id,
      storeName: vendor.vendorStore.storeName,
    },
    seller: vendor.seller
      ? {
          id: vendor.seller.id,
          status: vendor.seller.status,
          statusLabel: createSellerStatusLabel(vendor.seller.status),
          statusReason: vendor.seller.statusReason || null,
        }
      : null,
    stripeAccount: serializeStripeAccountSummary(vendor.seller?.stripeAccount),
    stripePublishableKey: getStripePublishableKey(),
  };
}

function buildAccountSessionComponents() {
  return {
    notification_banner: {
      enabled: true,
      features: {},
    },
    account_onboarding: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
    account_management: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
  };
}

export async function createSellerAccountSession(
  { vendorId },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  const vendor = await prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  if (!vendor?.seller?.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  const accountSession = await stripeClient.accountSessions.create({
    account: vendor.seller.stripeAccount.stripeAccountId,
    components: buildAccountSessionComponents(),
  });

  return {
    ok: true,
    clientSecret: accountSession.client_secret,
    expiresAt: accountSession.expires_at,
  };
}

function normalizeCheckoutItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      const productId = normalizeText(
        item?.productId || item?.id || item?.localProductId,
      );
      const quantity = toPositiveInteger(item?.quantity || item?.qty);

      if (!productId || quantity == null) {
        return null;
      }

      return {
        productId,
        quantity,
      };
    })
    .filter(Boolean);
}

function normalizeShippingAddress(address) {
  if (!isPlainObject(address)) {
    return null;
  }

  const normalized = {
    firstName: normalizeText(address.firstName),
    lastName: normalizeText(address.lastName),
    address1: normalizeText(address.address1),
    address2: normalizeText(address.address2),
    city: normalizeText(address.city),
    province: normalizeText(address.province),
    postalCode: normalizeText(address.postalCode),
    country: normalizeText(address.country),
    phone: normalizeText(address.phone),
  };

  return normalized.address1 &&
    normalized.city &&
    normalized.postalCode &&
    normalized.country
    ? normalized
    : null;
}

function normalizeCheckoutCustomer(customer) {
  if (!isPlainObject(customer)) {
    return null;
  }

  const normalized = {
    firstName: normalizeText(customer.firstName),
    lastName: normalizeText(customer.lastName),
    email: normalizeLowercase(customer.email),
    phone: normalizeText(customer.phone),
  };

  return normalized.email ? normalized : null;
}

function serializeOrderLineItems(productsById, items) {
  return items.map((item) => {
    const product = productsById.get(item.productId);
    const unitAmount = toDisplayPrice(product);

    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitAmount,
      totalAmount: unitAmount * item.quantity,
    };
  });
}

async function loadVendorForCheckout(handle, prismaClient = prisma) {
  const normalizedHandle = normalizeText(handle);

  if (!normalizedHandle) {
    return null;
  }

  return prismaClient.vendor.findUnique({
    where: { handle: normalizedHandle },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });
}

export async function createCheckoutOrder(
  payload,
  { prismaClient = prisma } = {},
) {
  const vendorHandle = normalizeText(payload?.vendorHandle || payload?.handle);
  const items = normalizeCheckoutItems(payload?.items);
  const customer = normalizeCheckoutCustomer(payload?.customer);
  const shippingAddress = normalizeShippingAddress(payload?.shippingAddress);

  if (!vendorHandle || items.length === 0 || !customer || !shippingAddress) {
    return {
      ok: false,
      reason: "invalid_payload",
    };
  }

  const vendor = await loadVendorForCheckout(vendorHandle, prismaClient);

  if (!vendor?.vendorStore?.id || !vendor?.seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (vendor.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  if (!vendor.seller.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  const uniqueProductIds = Array.from(new Set(items.map((item) => item.productId)));
  const products = await prismaClient.product.findMany({
    where: {
      id: { in: uniqueProductIds },
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved",
    },
    select: {
      id: true,
      name: true,
      price: true,
      calculatedPrice: true,
    },
  });

  if (products.length !== uniqueProductIds.length) {
    return {
      ok: false,
      reason: "invalid_items",
    };
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const lineItems = serializeOrderLineItems(productsById, items);
  const subtotalAmount = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.totalAmount,
    0,
  );
  const applicationFeeAmount = calculatePlatformFeeAmount(
    subtotalAmount,
    getPlatformFeeBps(),
  );

  const order = await prismaClient.order.create({
    data: {
      sellerId: vendor.seller.id,
      sellerStripeAccountId: vendor.seller.stripeAccount.id,
      stripeAccountId: vendor.seller.stripeAccount.stripeAccountId,
      status: "draft",
      currencyCode: DEFAULT_ORDER_CURRENCY,
      subtotalAmount,
      applicationFeeAmount,
      totalAmount: subtotalAmount,
      customerEmail: customer.email,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      customerPhone: customer.phone,
      shippingAddressJson: shippingAddress,
      lineItemsJson: lineItems,
    },
  });

  return {
    ok: true,
    order: {
      id: order.id,
      status: order.status,
      currencyCode: order.currencyCode,
      subtotalAmount: order.subtotalAmount,
      applicationFeeAmount: order.applicationFeeAmount,
      totalAmount: order.totalAmount,
      lineItems,
    },
  };
}

async function loadCheckoutOrder(orderId, prismaClient = prisma) {
  return prismaClient.order.findUnique({
    where: { id: orderId },
    include: {
      seller: {
        include: {
          vendor: true,
          stripeAccount: true,
        },
      },
      sellerStripeAccount: true,
    },
  });
}

export async function createCheckoutOrderPaymentIntent(
  { orderId },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  const order = await loadCheckoutOrder(orderId, prismaClient);

  if (!order?.seller) {
    return {
      ok: false,
      reason: "order_not_found",
    };
  }

  if (order.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  const stripeAccountId =
    order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;

  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  if (order.stripePaymentIntentId) {
    try {
      const existingIntent = await stripeClient.paymentIntents.retrieve(
        order.stripePaymentIntentId,
        {
          stripeAccount: stripeAccountId,
        },
      );

      return {
        ok: true,
        created: false,
        paymentIntentId: existingIntent.id,
        clientSecret: existingIntent.client_secret,
        status: existingIntent.status,
        publishableKey: getStripePublishableKey(),
      };
    } catch (error) {
      const code = normalizeText(error?.code);

      if (code !== "resource_missing") {
        throw error;
      }
    }
  }

  const paymentIntent = await stripeClient.paymentIntents.create(
    {
      amount: order.totalAmount,
      currency: normalizeLowercase(order.currencyCode) || DEFAULT_ORDER_CURRENCY,
      application_fee_amount: order.applicationFeeAmount,
      automatic_payment_methods: {
        enabled: true,
      },
      receipt_email: order.customerEmail,
      metadata: {
        orderId: order.id,
        sellerId: order.sellerId,
        vendorId: order.seller.vendorId,
      },
    },
    {
      stripeAccount: stripeAccountId,
    },
  );

  await prismaClient.order.update({
    where: { id: order.id },
    data: {
      status: "payment_intent_created",
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  return {
    ok: true,
    created: true,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
    publishableKey: getStripePublishableKey(),
  };
}

export async function createOrderRefund(
  { orderId, amount = null, refundApplicationFee },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  if (typeof refundApplicationFee !== "boolean") {
    return {
      ok: false,
      reason: "refund_application_fee_required",
    };
  }

  const order = await loadCheckoutOrder(orderId, prismaClient);

  if (!order) {
    return {
      ok: false,
      reason: "order_not_found",
    };
  }

  const stripeAccountId =
    order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;

  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  if (!order.stripeChargeId) {
    return {
      ok: false,
      reason: "charge_missing",
    };
  }

  const refundParams = {
    charge: order.stripeChargeId,
    refund_application_fee: refundApplicationFee,
    metadata: {
      orderId: order.id,
      sellerId: order.sellerId,
    },
  };
  const refundAmount = toPositiveInteger(amount);

  if (refundAmount != null) {
    refundParams.amount = refundAmount;
  }

  const refund = await stripeClient.refunds.create(refundParams, {
    stripeAccount: stripeAccountId,
  });

  return {
    ok: true,
    refund,
  };
}

async function createLedgerEntry(
  data,
  { prismaClient = prisma } = {},
) {
  return prismaClient.ledgerEntry.create({ data });
}

async function markStripeEventProcessed(
  stripeEventId,
  { prismaClient = prisma } = {},
) {
  return prismaClient.stripeEvent.update({
    where: { stripeEventId },
    data: {
      processingStatus: "processed",
      processedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function markStripeEventFailed(
  stripeEventId,
  message,
  { prismaClient = prisma } = {},
) {
  return prismaClient.stripeEvent.update({
    where: { stripeEventId },
    data: {
      processingStatus: "failed",
      errorMessage: normalizeText(message) || "stripe_event_processing_failed",
    },
  });
}

async function findOrderByChargeId(chargeId, prismaClient = prisma) {
  if (!chargeId) {
    return null;
  }

  return prismaClient.order.findFirst({
    where: { stripeChargeId: chargeId },
  });
}

async function findOrderByPaymentIntentId(paymentIntentId, prismaClient = prisma) {
  if (!paymentIntentId) {
    return null;
  }

  return prismaClient.order.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
  });
}

async function findPayoutRunByStripeReference(
  { stripePayoutId, payoutRunId },
  prismaClient = prisma,
) {
  if (stripePayoutId) {
    const byPayoutId = await prismaClient.payoutRun.findFirst({
      where: { stripePayoutId },
    });

    if (byPayoutId) {
      return byPayoutId;
    }
  }

  if (payoutRunId) {
    return prismaClient.payoutRun.findUnique({
      where: { id: payoutRunId },
    });
  }

  return null;
}

async function processPaymentIntentSucceeded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const paymentIntent = event.data?.object;
  const paymentIntentId = normalizeText(paymentIntent?.id);
  const orderId = normalizeText(paymentIntent?.metadata?.orderId);
  const latestChargeId =
    normalizeText(paymentIntent?.latest_charge?.id) ||
    normalizeText(paymentIntent?.latest_charge);
  const stripeAccountId = normalizeText(event.account);
  const occurredAt = new Date((paymentIntent?.created || event.created) * 1000);

  const order = orderId
    ? await prismaClient.order.findUnique({ where: { id: orderId } })
    : await findOrderByPaymentIntentId(paymentIntentId, prismaClient);

  if (!order) {
    return;
  }

  await prismaClient.order.update({
    where: { id: order.id },
    data: {
      status: "paid",
      paidAt: order.paidAt || new Date(),
      stripePaymentIntentId: paymentIntentId || order.stripePaymentIntentId,
      stripeChargeId: latestChargeId || order.stripeChargeId,
      stripeAccountId: stripeAccountId || order.stripeAccountId,
    },
  });

  await createLedgerEntry(
    {
      sellerId: order.sellerId,
      sellerStripeAccountId: order.sellerStripeAccountId,
      orderId: order.id,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: stripeAccountId || order.stripeAccountId,
      entryType: "charge",
      stripeObjectId: latestChargeId || paymentIntentId,
      amount: clampInteger(paymentIntent?.amount_received ?? paymentIntent?.amount),
      currencyCode: normalizeLowercase(paymentIntent?.currency) || order.currencyCode,
      direction: "credit",
      description: "Direct charge paid",
      metadataJson: {
        paymentIntentId,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processApplicationFeeCreated(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const applicationFee = event.data?.object;
  const chargeId = normalizeText(applicationFee?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((applicationFee?.created || event.created) * 1000);

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "application_fee",
      stripeObjectId: normalizeText(applicationFee?.id),
      amount: clampInteger(applicationFee?.amount),
      currencyCode: normalizeLowercase(applicationFee?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "credit",
      description: "Application fee created",
      metadataJson: {
        chargeId,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processApplicationFeeRefunded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const object = event.data?.object;
  const chargeId = normalizeText(object?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((object?.created || event.created) * 1000);

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "application_fee_refund",
      stripeObjectId: normalizeText(object?.id),
      amount: clampInteger(object?.amount_refunded ?? object?.amount),
      currencyCode: normalizeLowercase(object?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Application fee refunded",
      metadataJson: {
        chargeId,
        feeId: normalizeText(object?.fee),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processChargeRefunded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const charge = event.data?.object;
  const chargeId = normalizeText(charge?.id);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((charge?.created || event.created) * 1000);

  if (order) {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status: "refunded",
      },
    });
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "refund",
      stripeObjectId: chargeId,
      amount: clampInteger(charge?.amount_refunded),
      currencyCode: normalizeLowercase(charge?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Charge refunded",
      metadataJson: {
        refunded: Boolean(charge?.refunded),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processRefundEvent(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const refund = event.data?.object;
  const chargeId = normalizeText(refund?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((refund?.created || event.created) * 1000);

  if (order && normalizeText(refund?.status) === "succeeded") {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status: "refunded",
      },
    });
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "refund",
      stripeObjectId: normalizeText(refund?.id),
      amount: clampInteger(refund?.amount),
      currencyCode: normalizeLowercase(refund?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Refund updated",
      metadataJson: {
        chargeId,
        refundStatus: normalizeText(refund?.status),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processDisputeEvent(
  event,
  type,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const dispute = event.data?.object;
  const chargeId = normalizeText(dispute?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((dispute?.created || event.created) * 1000);
  const disputeStatus = normalizeText(dispute?.status);

  if (order) {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status:
          type === "dispute_created"
            ? "disputed"
            : disputeStatus === "won"
              ? "paid"
              : "disputed",
      },
    });

    if (
      type === "dispute_created" ||
      type === "dispute_updated" ||
      type === "dispute_funds_withdrawn" ||
      (type === "dispute_closed" && disputeStatus !== "won")
    ) {
      await setSellerReviewStatus(
        {
          sellerId: order.sellerId,
          reason: SELLER_REVIEW_REASON_DISPUTE,
          changedBy: `stripe.${event.type}`,
        },
        { prismaClient },
      );
    }
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: type,
      stripeObjectId: normalizeText(dispute?.id),
      amount: clampInteger(dispute?.amount),
      currencyCode: normalizeLowercase(dispute?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: type === "dispute_funds_reinstated" ? "credit" : "debit",
      description:
        type === "dispute_created"
          ? "Charge dispute opened"
          : type === "dispute_funds_withdrawn"
            ? "Dispute funds withdrawn"
            : type === "dispute_funds_reinstated"
              ? "Dispute funds reinstated"
              : "Charge dispute updated",
      metadataJson: {
        chargeId,
        disputeStatus,
        disputeEventType: event.type,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processPayoutEvent(
  event,
  type,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const payout = event.data?.object;
  const payoutRun = await findPayoutRunByStripeReference(
    {
      stripePayoutId: normalizeText(payout?.id),
      payoutRunId: normalizeText(payout?.metadata?.payoutRunId),
    },
    prismaClient,
  );
  const occurredAt = new Date((payout?.created || event.created) * 1000);
  const nextStatus =
    type === "payout_failed"
      ? "failed"
      : payoutRun?.status === "approved"
        ? "executed"
        : payoutRun?.status || "executed";

  if (payoutRun) {
    await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        stripePayoutId: normalizeText(payout?.id) || payoutRun.stripePayoutId,
        status: nextStatus,
        failureCode:
          type === "payout_failed"
            ? normalizeText(payout?.failure_code)
            : payoutRun.failureCode,
        failureMessage:
          type === "payout_failed"
            ? normalizeText(payout?.failure_message)
            : payoutRun.failureMessage,
      },
    });

    if (type === "payout_failed") {
      await setSellerReviewStatus(
        {
          sellerId: payoutRun.sellerId,
          reason: SELLER_REVIEW_REASON_PAYOUT_FAILED,
          changedBy: "stripe.payout.failed",
        },
        { prismaClient },
      );
    }
  }

  await createLedgerEntry(
    {
      sellerId: payoutRun?.sellerId || null,
      sellerStripeAccountId: payoutRun?.sellerStripeAccountId || null,
      stripeEventId: stripeEventRecordId,
      payoutRunId: payoutRun?.id || null,
      stripeAccountId: normalizeText(event.account) || payoutRun?.stripeAccountId || null,
      entryType: type,
      stripeObjectId: normalizeText(payout?.id),
      amount: clampInteger(payout?.amount),
      currencyCode: normalizeLowercase(payout?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: `Payout ${type}`,
      metadataJson: {
        destination: normalizeText(payout?.destination),
        arrivalDate: payout?.arrival_date || null,
        failureCode: normalizeText(payout?.failure_code),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processStripeEventByType(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  switch (event.type) {
    case "account.updated":
      await processAccountUpdated(event, { prismaClient });
      return;
    case "account.external_account.updated":
      await processExternalAccountUpdated(event, { prismaClient });
      return;
    case "payment_intent.succeeded":
      await processPaymentIntentSucceeded(event, { prismaClient, stripeEventRecordId });
      return;
    case "application_fee.created":
      await processApplicationFeeCreated(event, { prismaClient, stripeEventRecordId });
      return;
    case "application_fee.refunded":
    case "application_fee.refund.updated":
      await processApplicationFeeRefunded(event, { prismaClient, stripeEventRecordId });
      return;
    case "charge.refunded":
      await processChargeRefunded(event, { prismaClient, stripeEventRecordId });
      return;
    case "refund.created":
    case "refund.updated":
      await processRefundEvent(event, { prismaClient, stripeEventRecordId });
      return;
    case "charge.dispute.created":
      await processDisputeEvent(event, "dispute_created", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.updated":
      await processDisputeEvent(event, "dispute_updated", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.funds_withdrawn":
      await processDisputeEvent(event, "dispute_funds_withdrawn", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.funds_reinstated":
      await processDisputeEvent(event, "dispute_funds_reinstated", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.closed":
      await processDisputeEvent(event, "dispute_closed", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.created":
      await processPayoutEvent(event, "payout_created", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.paid":
      await processPayoutEvent(event, "payout_paid", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.failed":
      await processPayoutEvent(event, "payout_failed", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    default:
      return;
  }
}

export async function handleStripeWebhook(
  { rawBody, signature },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  const webhookSecrets = getStripeWebhookSecrets();
  let event = null;
  let webhookSecretType = null;
  let signatureError = null;

  for (const webhookSecret of webhookSecrets) {
    try {
      event = stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret.secret,
      );
      webhookSecretType = webhookSecret.type;
      break;
    } catch (error) {
      signatureError = error;
    }
  }

  if (!event) {
    throw signatureError || new Error("STRIPE_WEBHOOK_SIGNATURE_INVALID");
  }

  const existingEvent = await prismaClient.stripeEvent.findUnique({
    where: { stripeEventId: event.id },
  });

  if (existingEvent) {
    return {
      ok: true,
      duplicate: true,
      eventId: event.id,
      webhookSecretType,
    };
  }

  const savedEvent = await prismaClient.stripeEvent.create({
    data: {
      stripeEventId: event.id,
      stripeAccountId: normalizeText(event.account),
      type: event.type,
      livemode: Boolean(event.livemode),
      payloadJson: {
        ...event,
        webhookSecretType,
      },
      processingStatus: "pending",
    },
  });

  try {
    await processStripeEventByType(event, {
      prismaClient,
      stripeEventRecordId: savedEvent.id,
    });
    await markStripeEventProcessed(event.id, { prismaClient });

    return {
      ok: true,
      duplicate: false,
      eventId: event.id,
      webhookSecretType,
    };
  } catch (error) {
    console.error("stripe webhook processing error:", error);
    await markStripeEventFailed(
      event.id,
      error instanceof Error ? error.message : String(error),
      { prismaClient },
    );
    throw error;
  }
}

export async function listPayoutRuns({ prismaClient = prisma } = {}) {
  const runs = await prismaClient.payoutRun.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: {
      seller: {
        include: {
          vendor: true,
        },
      },
    },
  });

  return runs.map((run) => ({
    ...run,
    statusLabel: createPayoutRunStatusLabel(run.status),
    sellerStoreName: run.seller?.vendor?.storeName || "-",
  }));
}

export async function getPayoutRunDetail(payoutRunId, { prismaClient = prisma } = {}) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          vendor: true,
          stripeAccount: true,
        },
      },
      ledgerEntries: {
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  if (!payoutRun?.seller?.vendor) {
    return null;
  }

  return {
    ...payoutRun,
    statusLabel: createPayoutRunStatusLabel(payoutRun.status),
    sellerStoreName: payoutRun.seller.vendor.storeName,
    stripeAccount: serializeStripeAccountSummary(payoutRun.seller.stripeAccount),
  };
}

async function assertPayoutEligibleSeller(
  sellerId,
  { prismaClient = prisma } = {},
) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: true,
      stripeAccount: true,
    },
  });

  if (!seller?.vendor || !seller?.stripeAccount) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  if (["restricted", "banned"].includes(seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  if (seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  return {
    ok: true,
    seller,
  };
}

export async function createPayoutRun(
  { sellerId, amount, currencyCode },
  { prismaClient = prisma } = {},
) {
  const eligibility = await assertPayoutEligibleSeller(sellerId, { prismaClient });

  if (!eligibility.ok) {
    return eligibility;
  }

  const normalizedAmount = toPositiveInteger(amount);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;

  if (normalizedAmount == null) {
    return {
      ok: false,
      reason: "invalid_amount",
    };
  }

  const payoutRun = await prismaClient.payoutRun.create({
    data: {
      sellerId: eligibility.seller.id,
      sellerStripeAccountId: eligibility.seller.stripeAccount.id,
      stripeAccountId: eligibility.seller.stripeAccount.stripeAccountId,
      amount: normalizedAmount,
      currencyCode: normalizedCurrency,
      status: "draft",
    },
  });

  return {
    ok: true,
    payoutRun,
  };
}

export async function approvePayoutRun(
  { payoutRunId, approvedBy = "admin" },
  { prismaClient = prisma } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: true,
    },
  });

  if (!payoutRun?.seller) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "draft") {
    return {
      ok: false,
      reason: "payout_run_not_approvable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  const updated = await prismaClient.payoutRun.update({
    where: { id: payoutRunId },
    data: {
      status: "approved",
      approvedAt: new Date(),
      approvedBy,
    },
  });

  return {
    ok: true,
    payoutRun: updated,
  };
}

async function getConnectedAccountAvailableBalanceAmount(
  { stripeClient, stripeAccountId, currencyCode },
) {
  if (!stripeClient?.balance?.retrieve || !stripeAccountId) {
    return null;
  }

  const balance = await stripeClient.balance.retrieve({
    stripeAccount: stripeAccountId,
  });
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const availableRows = Array.isArray(balance?.available) ? balance.available : [];

  return availableRows
    .filter((row) => normalizeLowercase(row?.currency) === normalizedCurrency)
    .reduce((total, row) => total + clampInteger(row?.amount), 0);
}

export async function executePayoutRun(
  { payoutRunId, executedBy = "admin" },
  {
    prismaClient = prisma,
    stripeClient = getStripeClient(),
  } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  if (!payoutRun?.seller?.stripeAccount) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "approved") {
    return {
      ok: false,
      reason: "payout_run_not_executable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  if (!payoutRun.seller.stripeAccount.payoutsEnabled) {
    return {
      ok: false,
      reason: "payouts_not_enabled",
    };
  }

  try {
    const availableBalance = await getConnectedAccountAvailableBalanceAmount({
      stripeClient,
      stripeAccountId: payoutRun.stripeAccountId,
      currencyCode: payoutRun.currencyCode,
    });

    if (availableBalance != null && availableBalance < payoutRun.amount) {
      return {
        ok: false,
        reason: "insufficient_stripe_available_balance",
        availableBalance,
        payoutRun,
      };
    }

    const payout = await stripeClient.payouts.create(
      {
        amount: payoutRun.amount,
        currency: payoutRun.currencyCode,
        metadata: {
          payoutRunId: payoutRun.id,
          sellerId: payoutRun.sellerId,
        },
        description: `Manual payout ${payoutRun.id}`,
      },
      {
        stripeAccount: payoutRun.stripeAccountId,
      },
    );

    const updated = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "executed",
        executedAt: new Date(),
        executedBy,
        stripePayoutId: payout.id,
      },
    });

    return {
      ok: true,
      payoutRun: updated,
      stripePayoutId: payout.id,
    };
  } catch (error) {
    const code = normalizeText(error?.code);
    const message = error instanceof Error ? error.message : String(error);

    const updated = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: normalizeText(message),
      },
    });

    return {
      ok: false,
      reason: "payout_execution_failed",
      payoutRun: updated,
    };
  }
}
