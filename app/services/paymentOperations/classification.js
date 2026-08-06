export const PAYMENT_PROVIDER = Object.freeze({
  SHOPIFY_PAYMENTS: "SHOPIFY_PAYMENTS",
  KOMOJU: "KOMOJU",
  UNKNOWN: "UNKNOWN",
});

export const PAYMENT_METHOD = Object.freeze({
  CARD: "CARD",
  CONVENIENCE_STORE: "CONVENIENCE_STORE",
  PAY_EASY: "PAY_EASY",
  BANK_TRANSFER: "BANK_TRANSFER",
  PAIDY: "PAIDY",
  SMARTPHONE_PAYMENT: "SMARTPHONE_PAYMENT",
  KOREAN_CARD: "KOREAN_CARD",
  OTHER: "OTHER",
});

export const PAYMENT_ATTEMPT_STATUS = Object.freeze({
  PENDING: "PENDING",
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  EXPIRED_SHOPIFY: "EXPIRED_SHOPIFY",
  REFUNDED: "REFUNDED",
  UNKNOWN: "UNKNOWN",
});

export const PAYMENT_REFUND_MODE = Object.freeze({
  SHOPIFY_LINKED: "SHOPIFY_LINKED",
  KOMOJU_MANUAL: "KOMOJU_MANUAL",
  DIRECT_BANK_TRANSFER: "DIRECT_BANK_TRANSFER",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

const MANUAL_KOMOJU_REFUND_METHODS = new Set([
  PAYMENT_METHOD.CONVENIENCE_STORE,
  PAYMENT_METHOD.PAY_EASY,
  PAYMENT_METHOD.BANK_TRANSFER,
]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function includesAny(value, candidates) {
  return candidates.some((candidate) => value.includes(candidate));
}

export function classifyPaymentGateway(gatewayName, formattedGateway = null) {
  const raw = [gatewayName, formattedGateway].filter(Boolean).join(" ");
  const normalized = normalize(raw);
  let provider = PAYMENT_PROVIDER.UNKNOWN;

  if (includesAny(normalized, ["shopify payments", "shopify_payments"])) {
    provider = PAYMENT_PROVIDER.SHOPIFY_PAYMENTS;
  } else if (normalized.includes("komoju")) {
    provider = PAYMENT_PROVIDER.KOMOJU;
  }

  let paymentMethod = PAYMENT_METHOD.OTHER;
  if (
    includesAny(normalized, [
      "convenience",
      "konbini",
      "コンビニ",
      "便利店",
    ])
  ) {
    paymentMethod = PAYMENT_METHOD.CONVENIENCE_STORE;
  } else if (includesAny(normalized, ["pay-easy", "payeasy", "ペイジー"])) {
    paymentMethod = PAYMENT_METHOD.PAY_EASY;
  } else if (
    includesAny(normalized, ["bank transfer", "銀行振込", "銀行轉帳"])
  ) {
    paymentMethod = PAYMENT_METHOD.BANK_TRANSFER;
  } else if (normalized.includes("paidy")) {
    paymentMethod = PAYMENT_METHOD.PAIDY;
  } else if (
    includesAny(normalized, [
      "paypay",
      "merpay",
      "au pay",
      "rakuten pay",
      "d barai",
      "d払い",
      "smartphone",
      "スマホ",
    ])
  ) {
    paymentMethod = PAYMENT_METHOD.SMARTPHONE_PAYMENT;
  } else if (includesAny(normalized, ["korean", "korea", "韓国", "한국"])) {
    paymentMethod = PAYMENT_METHOD.KOREAN_CARD;
  } else if (
    provider === PAYMENT_PROVIDER.SHOPIFY_PAYMENTS ||
    includesAny(normalized, [
      "credit card",
      "card",
      "visa",
      "mastercard",
      "jcb",
      "amex",
      "diners",
      "クレジット",
    ])
  ) {
    paymentMethod = PAYMENT_METHOD.CARD;
  }

  return {
    provider,
    paymentMethod,
    refundMode: getPaymentRefundMode({ provider, paymentMethod }),
    gatewayName: String(gatewayName || "").trim() || null,
    formattedGateway: String(formattedGateway || "").trim() || null,
  };
}

export function getPaymentRefundMode({ provider, paymentMethod }) {
  if (
    provider === PAYMENT_PROVIDER.KOMOJU &&
    MANUAL_KOMOJU_REFUND_METHODS.has(paymentMethod)
  ) {
    return PAYMENT_REFUND_MODE.KOMOJU_MANUAL;
  }
  if (
    provider === PAYMENT_PROVIDER.KOMOJU ||
    provider === PAYMENT_PROVIDER.SHOPIFY_PAYMENTS
  ) {
    return PAYMENT_REFUND_MODE.SHOPIFY_LINKED;
  }
  return PAYMENT_REFUND_MODE.REVIEW_REQUIRED;
}

export function isAsynchronousPaymentMethod(paymentMethod) {
  return MANUAL_KOMOJU_REFUND_METHODS.has(paymentMethod);
}

export function resolvePaymentAttemptStatus({
  transactionStatus,
  transactionKind,
  financialStatus,
  cancelledAt,
}) {
  const transaction = normalize(transactionStatus).toUpperCase();
  const kind = normalize(transactionKind).toUpperCase();
  const financial = normalize(financialStatus).toUpperCase();

  if (cancelledAt || kind === "VOID") return PAYMENT_ATTEMPT_STATUS.CANCELLED;
  if (transaction === "FAILURE" || transaction === "ERROR") {
    return PAYMENT_ATTEMPT_STATUS.FAILED;
  }
  if (transaction === "SUCCESS" && ["SALE", "CAPTURE"].includes(kind)) {
    return PAYMENT_ATTEMPT_STATUS.CAPTURED;
  }
  if (transaction === "SUCCESS" && kind === "AUTHORIZATION") {
    return PAYMENT_ATTEMPT_STATUS.AUTHORIZED;
  }
  if (financial === "REFUNDED") return PAYMENT_ATTEMPT_STATUS.REFUNDED;
  if (["PAID", "PARTIALLY_REFUNDED", "PARTIALLY_PAID"].includes(financial)) {
    return PAYMENT_ATTEMPT_STATUS.CAPTURED;
  }
  if (["VOIDED", "EXPIRED"].includes(financial)) {
    return PAYMENT_ATTEMPT_STATUS.EXPIRED_SHOPIFY;
  }
  if (["PENDING", "AUTHORIZED", "UNPAID"].includes(financial)) {
    return PAYMENT_ATTEMPT_STATUS.PENDING;
  }
  if (transaction === "PENDING") return PAYMENT_ATTEMPT_STATUS.PENDING;
  return PAYMENT_ATTEMPT_STATUS.UNKNOWN;
}

export function isSuccessfulRefundTransaction(transaction) {
  return (
    normalize(transaction?.kind).toUpperCase() === "REFUND" &&
    normalize(transaction?.status).toUpperCase() === "SUCCESS"
  );
}

export function normalizeProviderName(value) {
  const normalized = normalize(value).replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === "shopify_payments") return PAYMENT_PROVIDER.SHOPIFY_PAYMENTS;
  if (normalized === "komoju") return PAYMENT_PROVIDER.KOMOJU;
  return PAYMENT_PROVIDER.UNKNOWN;
}

export function providerConfigValue(provider) {
  if (provider === PAYMENT_PROVIDER.SHOPIFY_PAYMENTS) return "shopify_payments";
  if (provider === PAYMENT_PROVIDER.KOMOJU) return "komoju";
  return "unknown";
}
