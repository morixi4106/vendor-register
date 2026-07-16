import {
  formatWithdrawalCountry,
  formatWithdrawalDateTime,
  getWithdrawalDictionary,
  normalizeWithdrawalLocale,
} from "../utils/withdrawalLocale.js";

export function buildWithdrawalAcknowledgementSnapshot(withdrawalRequest) {
  const locale = normalizeWithdrawalLocale(withdrawalRequest?.correspondenceLocale) || "en-GB";
  const dictionary = getWithdrawalDictionary(locale);
  const copy = dictionary.email;
  const publicCopy = dictionary.public;
  const submittedAt = withdrawalRequest?.submittedAt || withdrawalRequest?.createdAt || new Date();
  const rows = [
    [publicCopy.reference, withdrawalRequest?.id || "-"],
    [publicCopy.submittedAt, formatWithdrawalDateTime(submittedAt, locale)],
    [publicCopy.order, withdrawalRequest?.shopifyOrderName || withdrawalRequest?.shopifyOrderNumber || "-"],
    [
      publicCopy.scope,
      String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() === "PARTIAL"
        ? publicCopy.partialOrder
        : publicCopy.wholeOrder,
    ],
    [
      publicCopy.country,
      formatWithdrawalCountry(
        withdrawalRequest?.consumerLawCountry || withdrawalRequest?.countryCode,
        locale,
      ),
    ],
  ];
  const text = [
    copy.acknowledgementHeading,
    "",
    copy.acknowledgementBody,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">${escapeHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h1 style="font-size:24px">${escapeHtml(copy.acknowledgementHeading)}</h1><p>${escapeHtml(copy.acknowledgementBody)}</p><table style="border-collapse:collapse;width:100%;max-width:640px">${htmlRows}</table></div>`;
  return {
    locale,
    subject: copy.acknowledgementSubject,
    text,
    html,
  };
}

export function buildWithdrawalStatusSnapshot(withdrawalRequest) {
  const locale = resolveLocale(withdrawalRequest);
  const isJapanese = locale === "ja-JP";
  const status = String(withdrawalRequest?.status || "UNDER_REVIEW").toUpperCase();
  const label = getStatusLabel(status, isJapanese);
  const message = getStatusMessage(status, isJapanese);
  const reference = withdrawalRequest?.id || "-";
  const order =
    withdrawalRequest?.shopifyOrderName ||
    withdrawalRequest?.shopifyOrderNumber ||
    "-";
  const subject = isJapanese
    ? `撤回通知の状況: ${label}`
    : `Withdrawal notice status: ${label}`;
  return buildSimpleSnapshot({
    locale,
    subject,
    heading: subject,
    body: message,
    rows: isJapanese
      ? [["受付番号", reference], ["注文番号", order]]
      : [["Reference", reference], ["Order number", order]],
  });
}

export function buildWithdrawalCompletionSnapshot(withdrawalRequest) {
  const locale = resolveLocale(withdrawalRequest);
  const isJapanese = locale === "ja-JP";
  const status = String(withdrawalRequest?.completionStatus || "UNDECIDED").toUpperCase();
  const currency =
    withdrawalRequest?.completionCurrencyCode ||
    withdrawalRequest?.refundCurrencyCode ||
    "JPY";
  const amount = formatMoney(
    withdrawalRequest?.completionRefundedAmount,
    currency,
    locale,
  );
  const shipping = formatMoney(
    withdrawalRequest?.completionRefundedShipping,
    currency,
    locale,
  );
  const reference = withdrawalRequest?.id || "-";
  const order =
    withdrawalRequest?.shopifyOrderName ||
    withdrawalRequest?.shopifyOrderNumber ||
    "-";
  const subject = isJapanese ? "撤回通知の処理結果" : "Withdrawal notice outcome";
  return buildSimpleSnapshot({
    locale,
    subject,
    heading: subject,
    body: isJapanese
      ? "撤回通知の確認が完了しました。以下の処理結果をご確認ください。"
      : "Review of your withdrawal notice is complete. The outcome is shown below.",
    rows: isJapanese
      ? [
          ["受付番号", reference],
          ["注文番号", order],
          ["処理結果", getCompletionLabel(status, true)],
          ["商品代金等の返金額", amount],
          ["通常配送分の初回送料の返金額", shipping],
        ]
      : [
          ["Reference", reference],
          ["Order number", order],
          ["Outcome", getCompletionLabel(status, false)],
          ["Refund for goods", amount],
          ["Refund of standard outbound delivery", shipping],
        ],
  });
}

function resolveLocale(withdrawalRequest) {
  return normalizeWithdrawalLocale(withdrawalRequest?.correspondenceLocale) || "en-GB";
}

function buildSimpleSnapshot({ locale, subject, heading, body, rows }) {
  const text = [
    heading,
    "",
    body,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">${escapeHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return {
    locale,
    subject,
    text,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h1 style="font-size:24px">${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p><table style="border-collapse:collapse;width:100%;max-width:640px">${htmlRows}</table></div>`,
  };
}

function getStatusLabel(status, isJapanese) {
  const labels = isJapanese
    ? {
        REQUESTED: "受付済み",
        ACKNOWLEDGED: "受付確認済み",
        UNDER_REVIEW: "確認中",
        APPROVED: "撤回確認済み",
        RETURN_REQUESTED: "返送待ち",
        RETURN_RECEIVED: "返送品確認中",
        REFUND_PENDING: "返金準備中",
        REFUNDED: "返金済み",
        CANCELLED: "キャンセル済み",
        REJECTED: "対象外",
        EXPIRED: "受付終了",
        ERROR: "要確認",
      }
    : {
        REQUESTED: "received",
        ACKNOWLEDGED: "acknowledged",
        UNDER_REVIEW: "under review",
        APPROVED: "confirmed",
        RETURN_REQUESTED: "awaiting return",
        RETURN_RECEIVED: "returned goods under review",
        REFUND_PENDING: "refund pending",
        REFUNDED: "refunded",
        CANCELLED: "cancelled",
        REJECTED: "not eligible",
        EXPIRED: "closed",
        ERROR: "review required",
      };
  return labels[status] || status;
}

function getStatusMessage(status, isJapanese) {
  if (isJapanese) {
    const messages = {
      UNDER_REVIEW: "注文内容、返送状況および商品状態を確認しています。",
      APPROVED: "撤回通知を確認しました。必要な返送または返金手続きを別途ご案内します。",
      RETURN_REQUESTED: "メールで案内した店舗別の返送先へ商品を返送し、返送証明を提出してください。",
      RETURN_RECEIVED: "店舗が返送品の到着を記録しました。商品状態を確認しています。",
      REFUND_PENDING: "返金内容を確認し、処理を準備しています。",
      REFUNDED: "返金処理が完了しました。決済方法への反映時期は決済会社により異なります。",
      CANCELLED: "対象注文のキャンセル処理が完了しました。",
      REJECTED: "確認の結果、今回の申請は撤回対象外として処理されました。",
      EXPIRED: "確認の結果、受付を終了しました。",
      ERROR: "追加確認が必要です。運営からの案内をお待ちください。",
    };
    return messages[status] || "申請内容を確認しています。";
  }
  const messages = {
    UNDER_REVIEW: "We are checking the order, return status and condition of the goods.",
    APPROVED: "Your withdrawal notice has been confirmed. We will send any required return or refund steps separately.",
    RETURN_REQUESTED: "Return the goods to each store address in the email and submit proof of return for each parcel.",
    RETURN_RECEIVED: "The store recorded receipt of the returned goods. Their condition is being checked.",
    REFUND_PENDING: "The refund details are being checked and prepared.",
    REFUNDED: "The refund has been processed. The time to appear depends on the payment provider.",
    CANCELLED: "The relevant order has been cancelled.",
    REJECTED: "After review, this request was treated as not eligible for the right of withdrawal.",
    EXPIRED: "After review, this request has been closed.",
    ERROR: "Additional review is required. Please wait for further information from the operator.",
  };
  return messages[status] || "Your submission is being reviewed.";
}

function getCompletionLabel(status, isJapanese) {
  const labels = isJapanese
    ? {
        UNDECIDED: "未決定",
        REFUNDED: "返金済み",
        PARTIALLY_REFUNDED: "一部返金済み",
        CANCELLED: "キャンセル済み",
        NO_REFUND_CLOSED: "返金なしで完了",
        REJECTED_CLOSED: "対象外として完了",
        MANUAL_CLOSED: "手動で完了",
      }
    : {
        UNDECIDED: "not decided",
        REFUNDED: "refunded",
        PARTIALLY_REFUNDED: "partially refunded",
        CANCELLED: "cancelled",
        NO_REFUND_CLOSED: "closed without a refund",
        REJECTED_CLOSED: "closed as not eligible",
        MANUAL_CLOSED: "closed manually",
      };
  return labels[status] || status;
}

function formatMoney(value, currency, locale) {
  const amount = Number(value || 0);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: String(currency || "JPY").toUpperCase(),
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${Number.isFinite(amount) ? amount : 0} ${currency || "JPY"}`;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
