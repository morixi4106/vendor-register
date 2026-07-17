import {
  formatWithdrawalCountry,
  formatWithdrawalDateTime,
  getWithdrawalDictionary,
  normalizeWithdrawalLocale,
} from "../utils/withdrawalLocale.js";

export function buildWithdrawalAcknowledgementSnapshot(withdrawalRequest) {
  const locale = resolveLocale(withdrawalRequest);
  const isJapanese = locale === "ja-JP";
  const dictionary = getWithdrawalDictionary(locale);
  const copy = dictionary.email;
  const publicCopy = dictionary.public;
  const payload = asObject(withdrawalRequest?.submittedPayloadJson);
  const submittedAt =
    withdrawalRequest?.submittedAt || payload.submittedAt || withdrawalRequest?.createdAt || new Date();
  const scope = String(payload.withdrawalScope || withdrawalRequest?.withdrawalScope || "FULL")
    .toUpperCase();
  const rows = [
    [publicCopy.reference, withdrawalRequest?.id || "-"],
    [publicCopy.submittedAt, formatWithdrawalDateTime(submittedAt, locale)],
    [isJapanese ? "サーバー受付日時 (UTC)" : "Server receipt time (UTC)", toIsoString(submittedAt)],
    [isJapanese ? "氏名" : "Name", payload.customerName || withdrawalRequest?.customerName || "-"],
    [
      isJapanese ? "確認メール送信先" : "Confirmation email",
      payload.customerEmail || withdrawalRequest?.customerEmail || "-",
    ],
    [
      publicCopy.order,
      payload.orderNumber || withdrawalRequest?.shopifyOrderName ||
        withdrawalRequest?.shopifyOrderNumber || "-",
    ],
    [
      publicCopy.scope,
      scope === "PARTIAL" ? publicCopy.partialOrder : publicCopy.wholeOrder,
    ],
    [
      isJapanese ? "撤回対象の商品・数量" : "Items and quantities",
      formatSelectedItems(payload, isJapanese),
    ],
    [
      isJapanese ? "商品受取日" : "Date goods were received",
      formatOptionalDate(payload.receivedDate, locale),
    ],
    [
      isJapanese ? "商品状態" : "Condition of goods",
      payload.itemCondition || "-",
    ],
    [isJapanese ? "補足" : "Additional information", payload.reason || "-"],
    [
      publicCopy.country,
      formatWithdrawalCountry(
        withdrawalRequest?.consumerLawCountry || payload.countryCode ||
          withdrawalRequest?.countryCode,
        locale,
      ),
    ],
    [
      isJapanese ? "適用した法務文面版" : "Legal notice version",
      withdrawalRequest?.submissionLegalBundleVersion || "-",
    ],
  ];
  const text = [
    copy.acknowledgementHeading,
    "",
    copy.acknowledgementBody,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");

  return {
    locale,
    subject: copy.acknowledgementSubject,
    text,
    html: buildEmailHtml({
      heading: copy.acknowledgementHeading,
      body: copy.acknowledgementBody,
      rows,
    }),
  };
}

export function buildWithdrawalStatusSnapshot(withdrawalRequest) {
  const locale = resolveLocale(withdrawalRequest);
  const isJapanese = locale === "ja-JP";
  const status = String(withdrawalRequest?.status || "UNDER_REVIEW").toUpperCase();
  const label = getStatusLabel(status, isJapanese);
  const subject = isJapanese
    ? `撤回申請の状況: ${label}`
    : `Withdrawal notice status: ${label}`;

  return buildSimpleSnapshot({
    locale,
    subject,
    heading: subject,
    body: getStatusMessage(status, isJapanese),
    rows: isJapanese
      ? [
          ["受付番号", withdrawalRequest?.id || "-"],
          ["注文番号", displayOrder(withdrawalRequest)],
        ]
      : [
          ["Reference", withdrawalRequest?.id || "-"],
          ["Order number", displayOrder(withdrawalRequest)],
        ],
  });
}

export function buildWithdrawalCompletionSnapshot(withdrawalRequest) {
  const locale = resolveLocale(withdrawalRequest);
  const isJapanese = locale === "ja-JP";
  const status = String(withdrawalRequest?.completionStatus || "UNDECIDED").toUpperCase();
  const currency =
    withdrawalRequest?.completionCurrencyCode || withdrawalRequest?.refundCurrencyCode || "JPY";
  const subject = isJapanese ? "撤回申請の処理結果" : "Withdrawal notice outcome";

  return buildSimpleSnapshot({
    locale,
    subject,
    heading: subject,
    body: isJapanese
      ? "撤回申請の確認が完了しました。処理結果は以下のとおりです。"
      : "Review of your withdrawal notice is complete. The outcome is shown below.",
    rows: isJapanese
      ? [
          ["受付番号", withdrawalRequest?.id || "-"],
          ["注文番号", displayOrder(withdrawalRequest)],
          ["処理結果", getCompletionLabel(status, true)],
          [
            "商品代金等の返金額",
            formatMoney(withdrawalRequest?.completionRefundedAmount, currency, locale),
          ],
          [
            "通常配送分の初回送料の返金額",
            formatMoney(withdrawalRequest?.completionRefundedShipping, currency, locale),
          ],
        ]
      : [
          ["Reference", withdrawalRequest?.id || "-"],
          ["Order number", displayOrder(withdrawalRequest)],
          ["Outcome", getCompletionLabel(status, false)],
          [
            "Refund for goods",
            formatMoney(withdrawalRequest?.completionRefundedAmount, currency, locale),
          ],
          [
            "Refund of standard outbound delivery",
            formatMoney(withdrawalRequest?.completionRefundedShipping, currency, locale),
          ],
        ],
  });
}

function resolveLocale(withdrawalRequest) {
  return normalizeWithdrawalLocale(withdrawalRequest?.correspondenceLocale) || "en-GB";
}

function buildSimpleSnapshot({ locale, subject, heading, body, rows }) {
  return {
    locale,
    subject,
    text: [heading, "", body, "", ...rows.map(([label, value]) => `${label}: ${value}`)].join(
      "\n",
    ),
    html: buildEmailHtml({ heading, body, rows }),
  };
}

function buildEmailHtml({ heading, body, rows }) {
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ddd">${escapeHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #ddd;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h1 style="font-size:24px">${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p><table style="border-collapse:collapse;width:100%;max-width:720px">${htmlRows}</table></div>`;
}

function formatSelectedItems(payload, isJapanese) {
  const selected = Array.isArray(payload.selectedLineItems) ? payload.selectedLineItems : [];
  if (selected.length) {
    return selected
      .map((line) => {
        const entry = asObject(line);
        const title = entry.title || entry.name || entry.label || entry.lineItemId || entry.id || "-";
        const quantity = Number(entry.quantity || entry.selectedQuantity || 0);
        return quantity > 0 ? `${title} x ${quantity}` : String(title);
      })
      .join("\n");
  }
  if (payload.itemText) return String(payload.itemText);
  return isJapanese ? "注文全体" : "Entire order";
}

function formatOptionalDate(value, locale) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function displayOrder(withdrawalRequest) {
  return withdrawalRequest?.shopifyOrderName || withdrawalRequest?.shopifyOrderNumber || "-";
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  const messages = isJapanese
    ? {
        UNDER_REVIEW: "注文内容、返送状況および商品状態を確認しています。",
        APPROVED: "撤回申請を確認しました。必要な返送または返金手順は別途ご案内します。",
        RETURN_REQUESTED: "メールに記載された店舗別の返送先へ商品を返送し、荷物ごとに返送証明を提出してください。",
        RETURN_RECEIVED: "店舗が返送品の到着を記録しました。商品の状態を確認しています。",
        REFUND_PENDING: "返金内容を確認し、処理を準備しています。",
        REFUNDED: "返金処理が完了しました。反映時期は決済会社により異なります。",
        CANCELLED: "対象の注文はキャンセルされました。",
        REJECTED: "確認の結果、今回の申請は撤回権の対象外として処理されました。",
        EXPIRED: "確認の結果、受付を終了しました。",
        ERROR: "追加確認が必要です。運営からの案内をお待ちください。",
      }
    : {
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
  return messages[status] || (isJapanese ? "申請内容を確認しています。" : "Your submission is being reviewed.");
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
