import isoCountries from "i18n-iso-countries";
import prisma from "../../db.server.js";
import { isMarketplaceSeller } from "../../utils/sellerRoles.js";
import { DEFAULT_ORDER_CURRENCY, DOCUMENT_VERIFICATION_STATUSES, SELLER_STATUSES } from "./constants.js";
import { isPlainObject, normalizeBooleanInput, normalizeLowercase, normalizeText, normalizeUppercase } from "./values.js";
import { createDocumentVerificationStatusLabel, createPayoutRunStatusLabel, createSellerEuStatusLabel, createSellerVerificationStatusLabel, getConfiguredSellerPayoutProvider, getSellerPayoutVerificationState, getSellerSalesCreditSummary, getStripeClient, serializePayoutRecipientSummary, serializeStripeAccountSummary } from "./shared.server.js";
const STRIPE_ACCOUNT_RESET_REASON = "stripe_account_recreate_requested";
const STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES = new Set(["draft", "payment_intent_created", "failed"]);
function toIsoCountryCode(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "JP";
  }
  if (/^[A-Za-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  return isoCountries.getAlpha2Code(normalized, "ja") || isoCountries.getAlpha2Code(normalized, "en") || "JP";
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
function serializeSellerSummary(vendor) {
  const seller = vendor?.seller;
  const stripeAccount = seller?.stripeAccount;
  const payoutRecipient = seller?.payoutRecipient;
  const verification = getSellerPayoutVerificationState({
    ...seller,
    payoutRecipient
  });
  return {
    vendorId: vendor.id,
    vendorStoreId: vendor.vendorStoreId,
    vendorHandle: vendor.handle,
    vendorStoreName: vendor.storeName,
    isTestStore: Boolean(vendor.vendorStore?.isTestStore),
    managementEmail: vendor.managementEmail,
    sellerId: seller?.id || null,
    sellerStatus: seller?.status || null,
    sellerStatusLabel: createSellerStatusLabel(seller?.status),
    sellerVerificationStatus: verification.sellerVerificationStatus,
    sellerVerificationStatusLabel: verification.sellerVerificationStatusLabel,
    euSellerStatus: verification.euSellerStatus,
    euSellerStatusLabel: verification.euSellerStatusLabel,
    payoutVerification: verification,
    stripeAccount: serializeStripeAccountSummary(stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(payoutRecipient),
    createdAt: seller?.createdAt || vendor.createdAt,
    updatedAt: seller?.updatedAt || vendor.updatedAt
  };
}
async function loadVendorForSellerInitialization(vendorId, prismaClient = prisma) {
  return prismaClient.vendor.findUnique({
    where: {
      id: vendorId
    },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true,
          verificationRecords: {
            orderBy: [{
              createdAt: "desc"
            }],
            take: 3
          }
        }
      }
    }
  });
}
export async function ensureSellerForVendor(vendorId, {
  prismaClient = prisma,
  defaultStatus = "pending",
  changedBy = "system",
  reason = "seller_initialized"
} = {}) {
  const vendor = await loadVendorForSellerInitialization(vendorId, prismaClient);
  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }
  if (vendor.seller) {
    return {
      created: false,
      seller: vendor.seller,
      vendor
    };
  }
  const seller = await prismaClient.$transaction(async tx => {
    const createdSeller = await tx.seller.create({
      data: {
        vendorId: vendor.id,
        vendorStoreId: vendor.vendorStoreId,
        status: defaultStatus
      }
    });
    await tx.sellerStatusHistory.create({
      data: {
        sellerId: createdSeller.id,
        fromStatus: null,
        toStatus: defaultStatus,
        changedBy,
        reason
      }
    });
    return tx.seller.findUnique({
      where: {
        id: createdSeller.id
      },
      include: {
        stripeAccount: true
      }
    });
  });
  return {
    created: true,
    seller,
    vendor
  };
}
export async function listAdminSellerRows({
  prismaClient = prisma
} = {}) {
  const vendors = await prismaClient.vendor.findMany({
    orderBy: [{
      createdAt: "desc"
    }],
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true
        }
      }
    }
  });
  return vendors.filter(vendor => !vendor.seller || isMarketplaceSeller(vendor.seller)).map(serializeSellerSummary);
}
export async function getAdminSellerDetail(sellerId, {
  prismaClient = prisma
} = {}) {
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: sellerId
    },
    include: {
      vendor: {
        include: {
          vendorStore: {
            include: {
              returnAddresses: true
            }
          }
        }
      },
      stripeAccount: true,
      payoutRecipient: true,
      complianceProfile: true,
      agreementAcceptances: true,
      settlementControl: true,
      statusHistory: {
        orderBy: [{
          createdAt: "desc"
        }],
        take: 20
      },
      verificationRecords: {
        orderBy: [{
          createdAt: "desc"
        }],
        take: 10
      },
      orders: {
        orderBy: [{
          createdAt: "desc"
        }],
        take: 20
      },
      payoutRuns: {
        orderBy: [{
          createdAt: "desc"
        }],
        take: 20
      },
      ledgerEntries: {
        orderBy: [{
          occurredAt: "desc"
        }, {
          createdAt: "desc"
        }],
        take: 50
      }
    }
  });
  if (!seller?.vendor?.vendorStore) {
    return null;
  }
  const stripeEvents = seller.stripeAccount?.stripeAccountId ? await prismaClient.stripeEvent.findMany({
    where: {
      stripeAccountId: seller.stripeAccount.stripeAccountId
    },
    orderBy: [{
      createdAt: "desc"
    }],
    take: 50
  }) : [];
  return {
    seller: {
      id: seller.id,
      status: seller.status,
      statusLabel: createSellerStatusLabel(seller.status),
      statusReason: seller.statusReason || null,
      sellerLegalRole: seller.sellerLegalRole || "MARKETPLACE_SELLER",
      verificationStatus: seller.sellerVerificationStatus || "NONE",
      verificationStatusLabel: createSellerVerificationStatusLabel(seller.sellerVerificationStatus || "NONE"),
      euSellerStatus: seller.euSellerStatus || "DISABLED",
      euSellerStatusLabel: createSellerEuStatusLabel(seller.euSellerStatus || "DISABLED"),
      phoneVerifiedAt: seller.phoneVerifiedAt || null,
      documentVerificationStatus: seller.documentVerificationStatus || "NONE",
      documentVerificationStatusLabel: createDocumentVerificationStatusLabel(seller.documentVerificationStatus || "NONE"),
      documentVerifiedAt: seller.documentVerifiedAt || null,
      documentVerifiedBy: seller.documentVerifiedBy || null,
      verificationNameMatched: Boolean(seller.verificationNameMatched),
      payoutNameMatched: Boolean(seller.payoutNameMatched),
      verificationReviewNotes: seller.verificationReviewNotes || null,
      payoutVerification: getSellerPayoutVerificationState(seller),
      createdAt: seller.createdAt,
      updatedAt: seller.updatedAt
    },
    vendor: {
      id: seller.vendor.id,
      handle: seller.vendor.handle,
      storeName: seller.vendor.storeName,
      managementEmail: seller.vendor.managementEmail,
      vendorStoreId: seller.vendor.vendorStoreId
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
      isTestStore: Boolean(seller.vendor.vendorStore.isTestStore)
    },
    stripeAccount: serializeStripeAccountSummary(seller.stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(seller.payoutRecipient),
    statusHistory: seller.statusHistory,
    verificationRecords: seller.verificationRecords,
    orders: seller.orders,
    payoutRuns: seller.payoutRuns.map(run => ({
      ...run,
      statusLabel: createPayoutRunStatusLabel(run.status)
    })),
    ledgerEntries: seller.ledgerEntries,
    stripeEvents
  };
}
export async function updateSellerStatus({
  sellerId,
  nextStatus,
  changedBy = "admin",
  reason = null
}, {
  prismaClient = prisma
} = {}) {
  if (!SELLER_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      reason: "invalid_status"
    };
  }
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: sellerId
    }
  });
  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (seller.status === nextStatus && seller.statusReason === reason) {
    return {
      ok: true,
      changed: false,
      seller
    };
  }
  const updatedSeller = await prismaClient.$transaction(async tx => {
    const nextSeller = await tx.seller.update({
      where: {
        id: sellerId
      },
      data: {
        status: nextStatus,
        statusReason: normalizeText(reason)
      }
    });
    await tx.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: nextStatus,
        changedBy,
        reason: normalizeText(reason)
      }
    });
    return nextSeller;
  });
  return {
    ok: true,
    changed: true,
    seller: updatedSeller
  };
}
export async function upsertSellerWiseRecipient({
  sellerId,
  wiseRecipientId,
  currencyCode = DEFAULT_ORDER_CURRENCY,
  countryCode = null,
  accountHolderName = null,
  accountSummary = null,
  status = "active"
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedWiseRecipientId = normalizeText(wiseRecipientId);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const normalizedStatus = normalizeLowercase(status) || "active";
  if (!normalizedSellerId || !normalizedWiseRecipientId) {
    return {
      ok: false,
      reason: "invalid_wise_recipient"
    };
  }
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: normalizedSellerId
    }
  });
  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  const payoutRecipient = await prismaClient.sellerPayoutRecipient.upsert({
    where: {
      sellerId: normalizedSellerId
    },
    create: {
      sellerId: normalizedSellerId,
      provider: "wise",
      status: normalizedStatus,
      countryCode: normalizeUppercase(countryCode),
      currencyCode: normalizedCurrency,
      accountHolderName: normalizeText(accountHolderName),
      wiseProfileId: normalizeText(process.env.WISE_PROFILE_ID),
      wiseRecipientId: normalizedWiseRecipientId,
      accountSummary: normalizeText(accountSummary),
      lastSyncedAt: new Date()
    },
    update: {
      provider: "wise",
      status: normalizedStatus,
      countryCode: normalizeUppercase(countryCode),
      currencyCode: normalizedCurrency,
      accountHolderName: normalizeText(accountHolderName),
      wiseProfileId: normalizeText(process.env.WISE_PROFILE_ID),
      wiseRecipientId: normalizedWiseRecipientId,
      accountSummary: normalizeText(accountSummary),
      lastSyncedAt: new Date()
    }
  });
  return {
    ok: true,
    payoutRecipient
  };
}
function deriveSellerVerificationStatus({
  phoneVerified,
  documentVerificationStatus,
  nameMatched,
  payoutNameMatched
}) {
  const normalizedDocumentStatus = normalizeUppercase(documentVerificationStatus) || "NONE";
  if (normalizedDocumentStatus === "REJECTED") {
    return "REJECTED";
  }
  if (!phoneVerified) {
    return "PHONE_REQUIRED";
  }
  if (normalizedDocumentStatus === "PENDING") {
    return "DOCUMENT_PENDING";
  }
  if (normalizedDocumentStatus !== "VERIFIED") {
    return "DOCUMENT_REQUIRED";
  }
  if (!nameMatched || !payoutNameMatched) {
    return "DOCUMENT_PENDING";
  }
  return "VERIFIED";
}
export async function updateSellerVerification({
  sellerId,
  phoneVerified = false,
  documentVerificationStatus = "NONE",
  verificationNameMatched = false,
  payoutNameMatched = false,
  documentType = null,
  documentCountry = null,
  documentLast4 = null,
  reviewNotes = null,
  changedBy = "admin"
}, {
  prismaClient = prisma
} = {}) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedDocumentStatus = normalizeUppercase(documentVerificationStatus) || "NONE";
  if (!normalizedSellerId) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (!DOCUMENT_VERIFICATION_STATUSES.includes(normalizedDocumentStatus)) {
    return {
      ok: false,
      reason: "invalid_document_verification_status"
    };
  }
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: normalizedSellerId
    }
  });
  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  const now = new Date();
  const nextPhoneVerifiedAt = normalizeBooleanInput(phoneVerified) ? seller.phoneVerifiedAt || now : null;
  const nextDocumentVerifiedAt = normalizedDocumentStatus === "VERIFIED" ? seller.documentVerifiedAt || now : null;
  const nameMatched = normalizeBooleanInput(verificationNameMatched);
  const payoutMatched = normalizeBooleanInput(payoutNameMatched);
  const nextVerificationStatus = deriveSellerVerificationStatus({
    phoneVerified: Boolean(nextPhoneVerifiedAt),
    documentVerificationStatus: normalizedDocumentStatus,
    nameMatched,
    payoutNameMatched: payoutMatched
  });
  const updatedSeller = await prismaClient.$transaction(async tx => {
    const updated = await tx.seller.update({
      where: {
        id: normalizedSellerId
      },
      data: {
        sellerVerificationStatus: nextVerificationStatus,
        phoneVerifiedAt: nextPhoneVerifiedAt,
        documentVerificationStatus: normalizedDocumentStatus,
        documentVerifiedAt: nextDocumentVerifiedAt,
        documentVerifiedBy: normalizedDocumentStatus === "VERIFIED" ? normalizeText(changedBy) || seller.documentVerifiedBy : null,
        verificationNameMatched: nameMatched,
        payoutNameMatched: payoutMatched,
        verificationReviewNotes: normalizeText(reviewNotes)
      }
    });
    await tx.sellerVerificationRecord.create({
      data: {
        sellerId: normalizedSellerId,
        status: nextVerificationStatus,
        verifiedAt: nextVerificationStatus === "VERIFIED" ? now : null,
        verifiedBy: nextVerificationStatus === "VERIFIED" ? normalizeText(changedBy) || "admin" : null,
        verificationMethod: "admin_review",
        documentType: normalizeText(documentType),
        documentCountry: normalizeUppercase(documentCountry),
        documentLast4: normalizeText(documentLast4),
        nameMatched,
        payoutNameMatched: payoutMatched,
        phoneVerifiedAt: nextPhoneVerifiedAt,
        reviewNotes: normalizeText(reviewNotes)
      }
    });
    return updated;
  });
  return {
    ok: true,
    seller: updatedSeller,
    verification: getSellerPayoutVerificationState(updatedSeller)
  };
}
function createStripeAccountResetBlockers(seller) {
  const blockingOrders = (seller?.orders || []).filter(order => {
    if (order.paidAt || order.stripeChargeId) return true;
    return !STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES.has(order.status);
  });
  const blockingPayoutRuns = seller?.payoutRuns || [];
  const blockingLedgerEntries = seller?.ledgerEntries || [];
  return {
    orders: blockingOrders.map(order => ({
      id: order.id,
      status: order.status
    })),
    payoutRuns: blockingPayoutRuns.map(run => ({
      id: run.id,
      status: run.status
    })),
    ledgerEntries: blockingLedgerEntries.map(entry => ({
      id: entry.id,
      entryType: entry.entryType
    }))
  };
}
function hasStripeAccountResetBlockers(blockers) {
  return blockers.orders.length > 0 || blockers.payoutRuns.length > 0 || blockers.ledgerEntries.length > 0;
}
export async function resetSellerStripeAccountForRecreate({
  sellerId,
  changedBy = "admin",
  reason = STRIPE_ACCOUNT_RESET_REASON
}, {
  prismaClient = prisma
} = {}) {
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: sellerId
    },
    include: {
      stripeAccount: true,
      orders: {
        select: {
          id: true,
          status: true,
          paidAt: true,
          stripeChargeId: true
        }
      },
      payoutRuns: {
        select: {
          id: true,
          status: true
        }
      },
      ledgerEntries: {
        select: {
          id: true,
          entryType: true
        },
        take: 10
      }
    }
  });
  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (!seller.stripeAccount) {
    return {
      ok: true,
      reset: false,
      reason: "stripe_account_missing",
      seller
    };
  }
  const blockers = createStripeAccountResetBlockers(seller);
  if (hasStripeAccountResetBlockers(blockers)) {
    return {
      ok: false,
      reason: "stripe_account_reset_blocked",
      blockers
    };
  }
  const normalizedReason = normalizeText(reason) || STRIPE_ACCOUNT_RESET_REASON;
  const resetInTransaction = async tx => {
    const staleOrders = await tx.order.updateMany({
      where: {
        sellerId: seller.id,
        sellerStripeAccountId: seller.stripeAccount.id,
        status: {
          in: Array.from(STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES)
        },
        paidAt: null,
        stripeChargeId: null
      },
      data: {
        status: "failed",
        sellerStripeAccountId: null,
        stripeAccountId: null
      }
    });
    await tx.sellerStripeAccount.delete({
      where: {
        id: seller.stripeAccount.id
      }
    });
    const updatedSeller = await tx.seller.update({
      where: {
        id: seller.id
      },
      data: {
        status: "pending",
        statusReason: normalizedReason
      }
    });
    await tx.sellerStatusHistory.create({
      data: {
        sellerId: seller.id,
        fromStatus: seller.status,
        toStatus: "pending",
        changedBy,
        reason: normalizedReason
      }
    });
    return {
      ok: true,
      reset: true,
      seller: updatedSeller,
      removedStripeAccountId: seller.stripeAccount.stripeAccountId,
      staleOrdersUpdated: staleOrders.count || 0
    };
  };
  if (typeof prismaClient.$transaction === "function") {
    return prismaClient.$transaction(resetInTransaction);
  }
  return resetInTransaction(prismaClient);
}
async function loadSellerWithStripeContext(sellerId, prismaClient = prisma) {
  return prismaClient.seller.findUnique({
    where: {
      id: sellerId
    },
    include: {
      vendor: {
        include: {
          vendorStore: {
            include: {
              returnAddresses: true
            }
          }
        }
      },
      stripeAccount: true
    }
  });
}
function buildStripeConnectedAccountCreateParams(seller) {
  const countryCode = toIsoCountryCode(seller?.vendor?.vendorStore?.country);
  return {
    country: countryCode,
    email: seller.vendor.managementEmail,
    business_profile: {
      name: seller.vendor.storeName
    },
    controller: {
      fees: {
        payer: "account"
      },
      losses: {
        payments: "stripe"
      },
      requirement_collection: "stripe",
      stripe_dashboard: {
        type: "none"
      }
    },
    capabilities: {
      card_payments: {
        requested: true
      },
      transfers: {
        requested: true
      }
    },
    metadata: {
      sellerId: seller.id,
      vendorId: seller.vendor.id,
      vendorHandle: seller.vendor.handle,
      vendorStoreId: seller.vendor.vendorStore.id
    }
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
    requestId: normalizeText(raw.requestId || error?.requestId)
  };
}
async function setConnectedAccountManualPayouts(stripeClient, stripeAccountId) {
  try {
    await stripeClient.balanceSettings.update({
      payments: {
        payouts: {
          schedule: {
            interval: "manual"
          }
        }
      }
    }, {
      stripeAccount: stripeAccountId
    });
    return {
      ok: true,
      method: "balance_settings"
    };
  } catch (balanceSettingsError) {
    const balanceSettingsStripeError = normalizeStripeError(balanceSettingsError);
    if (!stripeClient.accounts?.update) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: balanceSettingsStripeError
      };
    }
    try {
      await stripeClient.accounts.update(stripeAccountId, {
        settings: {
          payouts: {
            schedule: {
              interval: "manual"
            }
          }
        }
      });
      return {
        ok: true,
        method: "account_settings",
        fallbackFrom: balanceSettingsStripeError
      };
    } catch (accountSettingsError) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: normalizeStripeError(accountSettingsError),
        fallbackFrom: balanceSettingsStripeError
      };
    }
  }
}
export async function createSellerStripeAccount({
  sellerId
}, {
  prismaClient = prisma,
  stripeClient = getStripeClient()
} = {}) {
  const seller = await loadSellerWithStripeContext(sellerId, prismaClient);
  if (!seller?.vendor?.vendorStore) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (seller.stripeAccount) {
    return {
      ok: true,
      created: false,
      seller,
      stripeAccount: serializeStripeAccountSummary(seller.stripeAccount)
    };
  }
  let account = null;
  try {
    account = await stripeClient.accounts.create(buildStripeConnectedAccountCreateParams(seller));
  } catch (error) {
    const stripeError = normalizeStripeError(error);
    return {
      ok: false,
      reason: "stripe_account_create_failed",
      message: stripeError.message,
      stripeError
    };
  }
  const manualPayoutResult = await setConnectedAccountManualPayouts(stripeClient, account.id);
  if (!manualPayoutResult.ok) {
    return {
      ok: false,
      reason: manualPayoutResult.reason,
      message: manualPayoutResult.stripeError?.message,
      stripeAccountId: account.id,
      stripeError: manualPayoutResult.stripeError,
      fallbackFrom: manualPayoutResult.fallbackFrom
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
      requirementsJson: isPlainObject(account.requirements) ? account.requirements : null
    }
  });
  return {
    ok: true,
    created: true,
    seller,
    stripeAccount: serializeStripeAccountSummary(savedStripeAccount)
  };
}
export async function getSellerPaymentsPageData({
  vendorId
}, {
  prismaClient = prisma
} = {}) {
  const vendor = await prismaClient.vendor.findUnique({
    where: {
      id: vendorId
    },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true
        }
      }
    }
  });
  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }
  const salesCreditSummary = vendor.seller ? await getSellerSalesCreditSummary({
    sellerId: vendor.seller.id,
    currencyCode: DEFAULT_ORDER_CURRENCY
  }, {
    prismaClient
  }) : await getSellerSalesCreditSummary({
    sellerId: null,
    currencyCode: DEFAULT_ORDER_CURRENCY
  }, {
    prismaClient
  });
  return {
    vendor: {
      id: vendor.id,
      handle: vendor.handle,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail
    },
    store: {
      id: vendor.vendorStore.id,
      storeName: vendor.vendorStore.storeName
    },
    seller: vendor.seller ? {
      id: vendor.seller.id,
      status: vendor.seller.status,
      statusLabel: createSellerStatusLabel(vendor.seller.status),
      statusReason: vendor.seller.statusReason || null,
      verificationStatus: vendor.seller.sellerVerificationStatus || "NONE",
      verificationStatusLabel: createSellerVerificationStatusLabel(vendor.seller.sellerVerificationStatus || "NONE"),
      euSellerStatus: vendor.seller.euSellerStatus || "DISABLED",
      euSellerStatusLabel: createSellerEuStatusLabel(vendor.seller.euSellerStatus || "DISABLED"),
      payoutVerification: getSellerPayoutVerificationState(vendor.seller)
    } : null,
    stripeAccount: serializeStripeAccountSummary(vendor.seller?.stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(vendor.seller?.payoutRecipient),
    payoutProvider: getConfiguredSellerPayoutProvider(),
    salesCreditSummary
  };
}
function buildAccountSessionComponents() {
  return {
    notification_banner: {
      enabled: true,
      features: {}
    },
    account_onboarding: {
      enabled: true,
      features: {
        external_account_collection: true
      }
    },
    account_management: {
      enabled: true,
      features: {
        external_account_collection: true
      }
    }
  };
}
export async function createSellerAccountSession({
  vendorId
}, {
  prismaClient = prisma,
  stripeClient = getStripeClient()
} = {}) {
  const vendor = await prismaClient.vendor.findUnique({
    where: {
      id: vendorId
    },
    include: {
      seller: {
        include: {
          stripeAccount: true
        }
      }
    }
  });
  if (!vendor?.seller?.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing"
    };
  }
  const accountSession = await stripeClient.accountSessions.create({
    account: vendor.seller.stripeAccount.stripeAccountId,
    components: buildAccountSessionComponents()
  });
  return {
    ok: true,
    clientSecret: accountSession.client_secret,
    expiresAt: accountSession.expires_at
  };
}
