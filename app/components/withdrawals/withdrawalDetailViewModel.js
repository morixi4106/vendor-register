import {
  getCompletionRecordBlockers,
  getQuickTransitionConfig,
} from "../../services/withdrawalAdminDetail.js";
import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
} from "../../utils/withdrawalStatus.js";

export const RETURN_REQUIREMENT_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["NOT_REQUIRED", "返送不要"],
  ["REQUIRED", "返送が必要"],
  ["WAITING", "返送待ち"],
  ["IN_TRANSIT", "返送中"],
  ["RECEIVED", "返送品到着済み"],
  ["CONDITION_CHECKED", "商品状態確認済み"],
];

export const RETURN_CONDITION_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["NOT_APPLICABLE", "確認不要"],
  ["UNUSED_OK", "未使用・問題なし"],
  ["OPENED_OK", "開封・確認程度"],
  ["USED_REVIEW", "使用感あり"],
  ["DIRTY_REVIEW", "汚れあり"],
  ["DAMAGED_REVIEW", "破損あり"],
  ["EXEMPT_REVIEW", "対象外の可能性あり"],
];

export const REFUND_DECISION_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["FULL_REFUND", "全額返金"],
  ["PARTIAL_REFUND", "一部返金"],
  ["NO_REFUND", "返金なし"],
  ["RETURN_PENDING", "返送待ち"],
];

export const RETURN_SHIPPING_PAYER_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["CUSTOMER", "お客様負担"],
  ["STORE", "当店負担"],
  ["LEGAL_STORE", "法令または案内により当店負担"],
];

export const COMPLETION_OPTIONS = [
  ["UNDECIDED", "未記録"],
  ["REFUNDED", "返金済み"],
  ["PARTIALLY_REFUNDED", "一部返金済み"],
  ["CANCELLED", "キャンセル済み"],
  ["NO_REFUND_CLOSED", "返金なしで完了"],
  ["REJECTED_CLOSED", "対象外として完了"],
  ["MANUAL_CLOSED", "手動完了"],
];

export function buildRequestRows(request) {
  return [
    ["受付番号", request.id],
    ["注文番号", request.shopifyOrderName || request.shopifyOrderNumber || "-"],
    ["注文ID", request.shopifyOrderId || "-"],
    ["氏名", request.customerName],
    ["メール", request.customerEmail],
    ["電話", request.customerPhone || "-"],
    ["国", request.countryLabel || request.countryCode || "-"],
    ["受取日", formatDate(request.receivedDate)],
    ["撤回期限", formatDate(request.deadlineAt)],
    [
      "撤回対象",
      request.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体",
    ],
    ["商品状態", request.itemCondition || "-"],
    ["理由", request.reason || "-"],
    ["申請日時", formatDate(request.createdAt)],
  ];
}

export function buildOrderRows(request, currencyCode) {
  const order = request.orderSnapshotJson || {};
  return [
    ["shop", request.shopDomain || "-"],
    [
      "注文合計",
      formatMoney(order.totalAmount ?? order.total_price, currencyCode),
    ],
    [
      "商品小計",
      formatMoney(order.subtotalAmount ?? order.subtotal_price, currencyCode),
    ],
    [
      "送料",
      formatMoney(
        order.shippingAmount ?? order.total_shipping_price_set,
        currencyCode,
      ),
    ],
    ["支払い状態", order.financialStatus || order.financial_status || "-"],
    ["配送状態", order.fulfillmentStatus || order.fulfillment_status || "-"],
    ["注文日時", formatDate(order.processedAt || order.processed_at)],
  ];
}

export function buildShopifyReconciliation(
  request,
  currencyCode,
  liveShopifyOrderStatus = null,
) {
  const order = request.orderSnapshotJson || {};
  const liveOrder = liveShopifyOrderStatus?.ok
    ? liveShopifyOrderStatus.order || null
    : null;
  const orderCurrency = currencyCode || getOrderCurrencyCode(request);
  const financialStatus = normalizeStatus(
    liveOrder?.financialStatus ||
      order.financialStatus ||
      order.financial_status,
  );
  const fulfillmentStatus = normalizeStatus(
    liveOrder?.fulfillmentStatus ||
      order.fulfillmentStatus ||
      order.fulfillment_status,
  );
  const cancelledAt =
    liveOrder?.cancelledAt || order.cancelledAt || order.cancelled_at || null;
  const completionStatus = normalizeStatus(
    request.completionStatus || "UNDECIDED",
  );
  const refundDecisionStatus = normalizeStatus(
    request.refundDecisionStatus || "UNDECIDED",
  );
  const plannedRefundAmount =
    request.refundTotalAmount ?? calculateDisplayRefundTotal(request);
  const completedRefundAmount = request.completionRefundedAmount;
  const adminOrderUrl = getShopifyAdminOrderUrl(request);
  const issues = [];

  if (Object.keys(order).length === 0) {
    issues.push(
      "注文スナップショットが未記録です。Shopify注文画面で状態を確認してください。",
    );
  }

  if (liveShopifyOrderStatus && !liveShopifyOrderStatus.ok) {
    issues.push(
      "Shopifyの現在状態を取得できませんでした。保存済み情報と管理画面で確認してください。",
    );
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    !request.completionShopifyRefundId
  ) {
    issues.push("返金済みの完了記録ですが、Shopify返金IDが未記録です。");
  }

  if (completionStatus === "CANCELLED" && !request.completionShopifyCancelId) {
    issues.push(
      "キャンセル済みの完了記録ですが、ShopifyキャンセルIDが未記録です。",
    );
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    financialStatus &&
    !["REFUNDED", "PARTIALLY_REFUNDED"].includes(financialStatus)
  ) {
    issues.push(
      "アプリ側は返金完了ですが、注文スナップショットの支払い状態が返金済みではありません。",
    );
  }

  if (completionStatus === "CANCELLED" && !cancelledAt) {
    issues.push(
      "アプリ側はキャンセル完了ですが、注文スナップショットにキャンセル日時がありません。",
    );
  }

  if (
    completionStatus === "UNDECIDED" &&
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(financialStatus)
  ) {
    issues.push(
      "Shopify側は返金済みに見えますが、アプリ側の完了記録が未設定です。",
    );
  }

  if (completionStatus === "UNDECIDED" && cancelledAt) {
    issues.push(
      "Shopify側はキャンセル済みに見えますが、アプリ側の完了記録が未設定です。",
    );
  }

  if (
    liveOrder &&
    order.financialStatus &&
    normalizeStatus(order.financialStatus || order.financial_status) !==
      financialStatus
  ) {
    issues.push("保存済みの支払い状態とShopifyライブ状態が異なります。");
  }

  if (
    liveOrder &&
    order.fulfillmentStatus &&
    normalizeStatus(order.fulfillmentStatus || order.fulfillment_status) !==
      fulfillmentStatus
  ) {
    issues.push("保存済みの配送状態とShopifyライブ状態が異なります。");
  }

  if (
    refundDecisionStatus !== "UNDECIDED" &&
    completionStatus !== "UNDECIDED" &&
    isComparableMoney(plannedRefundAmount) &&
    isComparableMoney(completedRefundAmount) &&
    normalizeMoney(plannedRefundAmount) !==
      normalizeMoney(completedRefundAmount)
  ) {
    issues.push("返金判断額と完了記録の返金額が一致していません。");
  }

  if (
    liveOrder &&
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    isComparableMoney(liveOrder.totalRefundedAmount) &&
    isComparableMoney(completedRefundAmount) &&
    normalizeMoney(liveOrder.totalRefundedAmount) !==
      normalizeMoney(completedRefundAmount)
  ) {
    issues.push(
      "Shopifyライブ返金済み額とアプリの完了返金額が一致していません。",
    );
  }

  if (
    completionStatus === "UNDECIDED" &&
    ["UNFULFILLED", "OPEN"].includes(fulfillmentStatus) &&
    [WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.UNDER_REVIEW].includes(
      request.status,
    )
  ) {
    issues.push(
      "Shopify側では未発送に見えます。返送案内ではなく、注文キャンセルで処理できるか確認してください。",
    );
  }

  if (
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
      normalizeStatus(request.returnRequirementStatus || "UNDECIDED"),
    ) &&
    ["UNFULFILLED", "OPEN"].includes(fulfillmentStatus)
  ) {
    issues.push(
      "返送待ちになっていますが、Shopify側では未発送に見えます。発送状況を確認してください。",
    );
  }

  for (const blocker of getCompletionRecordBlockers(
    request,
    request.completionStatus || "UNDECIDED",
  )) {
    issues.push(blocker);
  }

  return {
    adminOrderUrl,
    issues,
    rows: [
      [
        "Shopify注文",
        request.shopifyOrderName || request.shopifyOrderNumber || "-",
      ],
      ["Shopify注文ID", request.shopifyOrderId || order.id || "-"],
      ["管理画面リンク", adminOrderUrl ? "あり" : "-"],
      ["支払い状態", order.financialStatus || order.financial_status || "-"],
      ["配送状態", order.fulfillmentStatus || order.fulfillment_status || "-"],
      [
        "ライブ支払い状態",
        liveOrder?.financialStatus ||
          (liveShopifyOrderStatus ? "取得不可" : "-"),
      ],
      [
        "ライブ配送状態",
        liveOrder?.fulfillmentStatus ||
          (liveShopifyOrderStatus ? "取得不可" : "-"),
      ],
      ["キャンセル日時", formatDate(cancelledAt)],
      [
        "ライブ返金済み額",
        liveOrder
          ? formatMoney(
              liveOrder.totalRefundedAmount,
              liveOrder.currencyCode || orderCurrency,
            )
          : "-",
      ],
      [
        "ライブ現在合計",
        liveOrder
          ? formatMoney(
              liveOrder.currentTotalAmount,
              liveOrder.currencyCode || orderCurrency,
            )
          : "-",
      ],
      [
        "アプリ完了状態",
        labelFromOptions(COMPLETION_OPTIONS, request.completionStatus),
      ],
      [
        "返金判断額",
        formatMoney(
          plannedRefundAmount,
          request.refundCurrencyCode || orderCurrency,
        ),
      ],
      [
        "完了記録の返金額",
        formatMoney(
          request.completionRefundedAmount,
          request.completionCurrencyCode || orderCurrency,
        ),
      ],
      ["Shopify返金ID", request.completionShopifyRefundId || "-"],
      ["ShopifyキャンセルID", request.completionShopifyCancelId || "-"],
    ],
  };
}

function getShopifyAdminOrderUrl(request) {
  const order = request.orderSnapshotJson || {};
  const shopDomain = request.shopDomain || order.shopDomain || order.shop;
  const orderId = extractShopifyNumericId(
    request.shopifyOrderId ||
      order.shopifyOrderId ||
      order.admin_graphql_api_id ||
      order.id,
  );

  if (!shopDomain || !orderId) return null;

  const normalizedShop = String(shopDomain).replace(/^https?:\/\//, "");
  if (normalizedShop.endsWith(".myshopify.com")) {
    const storeHandle = normalizedShop.replace(".myshopify.com", "");
    return `https://admin.shopify.com/store/${encodeURIComponent(
      storeHandle,
    )}/orders/${encodeURIComponent(orderId)}`;
  }

  return `https://${normalizedShop}/admin/orders/${encodeURIComponent(orderId)}`;
}

function extractShopifyNumericId(value) {
  const raw = String(value || "");
  const gidMatch = raw.match(/\/Order\/(\d+)/);
  if (gidMatch) return gidMatch[1];
  const numericMatch = raw.match(/\d{6,}/);
  return numericMatch ? numericMatch[0] : null;
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isComparableMoney(value) {
  return value != null && value !== "" && Number.isFinite(Number(value));
}

function normalizeMoney(value) {
  return Math.round(Number(value) * 100);
}

function hasSentEmailLog(request, emailType) {
  return Array.isArray(request.emailLogs)
    ? request.emailLogs.some(
        (log) =>
          log.emailType === emailType &&
          String(log.status || "").toLowerCase() === "sent",
      )
    : false;
}

function shouldNotifyVendors(request) {
  return ![WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED].includes(
    String(request.status || ""),
  );
}

export function buildCompletionReadiness(request, currencyCode) {
  const completionStatus = normalizeStatus(
    request.completionStatus || "UNDECIDED",
  );
  const plannedRefundAmount =
    request.refundTotalAmount ?? calculateDisplayRefundTotal(request);
  const items = [];

  if (completionStatus !== "UNDECIDED") {
    const blockers = getCompletionRecordBlockers(request, completionStatus);
    const items =
      blockers.length > 0
        ? blockers
        : [
            "Shopify側の処理結果をアプリ側に記録済みです。完了通知が未送信なら送信してください。",
          ];
    if (
      shouldNotifyVendors(request) &&
      !hasSentEmailLog(request, "vendor_notification")
    ) {
      items.push(
        "出店者通知が未送信です。発送停止や返品対応が必要な可能性があるため、必要に応じて通知してください。",
      );
    }
    return {
      label:
        blockers.length > 0 || items.length > 1
          ? "完了記録に確認点があります"
          : "完了記録済み",
      tone: blockers.length > 0 || items.length > 1 ? "warning" : "success",
      items,
    };
  }

  if (isReturnStillOpen(request)) {
    items.push(
      "返送が未完了です。返送不要にするか、返送品到着・商品状態を確認してから完了記録へ進んでください。",
    );
  }

  if (
    normalizeStatus(request.refundDecisionStatus || "UNDECIDED") === "UNDECIDED"
  ) {
    items.push(
      "返金判断が未記録です。商品代金・通常配送分の初回送料・減額・返送送料負担を先に記録してください。",
    );
  }

  if (!isComparableMoney(plannedRefundAmount)) {
    items.push(
      "返金予定額が未確定です。返金ありで完了する場合は、返金判断と返金額を先に保存してください。",
    );
  } else {
    items.push(
      `現在の返金予定額は ${formatMoney(plannedRefundAmount, request.refundCurrencyCode || currencyCode)} です。Shopify側の手動処理額と一致するか確認してください。`,
    );
  }

  if (
    shouldNotifyVendors(request) &&
    !hasSentEmailLog(request, "vendor_notification")
  ) {
    items.push(
      "出店者通知が未送信です。発送停止・返送受け取り・商品状態確認が必要な場合は先に通知してください。",
    );
  }

  items.push(
    "完了記録はShopify側で手動返金・キャンセル・対象外処理を終えた後に保存します。",
  );

  return {
    label: items.length > 1 ? "完了前チェック" : "完了記録の準備",
    tone:
      isReturnStillOpen(request) ||
      normalizeStatus(request.refundDecisionStatus || "UNDECIDED") ===
        "UNDECIDED"
        ? "warning"
        : "success",
    items,
  };
}

function isReturnStillOpen(request) {
  return ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
    normalizeStatus(request.returnRequirementStatus || "UNDECIDED"),
  );
}

export function getNextActionTitle(request) {
  if (request.status === WITHDRAWAL_STATUSES.REQUESTED) {
    return "受付メールと申請内容を確認";
  }
  if (
    request.returnRequirementStatus === "REQUIRED" ||
    request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED
  ) {
    return "返送状況を確認";
  }
  if (request.refundDecisionStatus === "UNDECIDED") {
    return "返金対象額を判断";
  }
  if (request.completionStatus === "UNDECIDED") {
    return "Shopify側の手動処理後に完了記録を残す";
  }
  return "必要に応じて購入者へ状況を通知";
}

export function getNextActionItems(request) {
  const items = [];

  if (!request.confirmationSentAt) {
    items.push("受付確認メールが未送信なら再送してください。");
  }
  if (
    shouldNotifyVendors(request) &&
    !hasSentEmailLog(request, "vendor_notification")
  ) {
    items.push(
      "出店者への通知が未送信です。発送停止・返品対応が必要な場合は通知してください。",
    );
  }
  if (request.eligibilityStatus !== "ELIGIBLE") {
    items.push(
      "注文番号、メール、EU対象、期限、例外商品に該当しないかを確認してください。",
    );
  }
  if (request.returnRequirementStatus === "UNDECIDED") {
    items.push("返送が必要か、返送不要で処理できるかを判断してください。");
  }
  if (request.refundDecisionStatus === "UNDECIDED") {
    items.push(
      "商品代金、通常配送分の初回送料、減額、返送送料の負担者を記録してください。",
    );
  }
  if (request.completionStatus === "UNDECIDED") {
    items.push(
      "Shopifyで返金またはキャンセルを手動処理した後、完了記録を保存してください。",
    );
  }

  return items.length > 0 ? items : ["現時点で必須の作業はありません。"];
}

export function buildProcessingDecision(request, currencyCode) {
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const latestEmail = Array.isArray(request.emailLogs)
    ? request.emailLogs[0]
    : null;
  const hasEmailFailure = Array.isArray(request.emailLogs)
    ? request.emailLogs.some((log) => log.status === "failed")
    : false;
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");
  const refundCurrency = request.refundCurrencyCode || currencyCode;
  const plannedRefundAmount =
    request.refundTotalAmount ?? calculateDisplayRefundTotal(request);

  let label = "手動確認";
  let tone = "warning";
  const items = [];

  if (completionStatus !== "UNDECIDED") {
    label = "完了済み";
    tone = "success";
    items.push(
      "完了通知が未送信の場合は、必要に応じて完了通知メールを送信してください。",
    );
  } else if (
    request.status === WITHDRAWAL_STATUSES.REQUESTED ||
    request.status === WITHDRAWAL_STATUSES.ACKNOWLEDGED ||
    request.status === WITHDRAWAL_STATUSES.UNDER_REVIEW
  ) {
    label = "申請内容の確認";
    tone = "warning";
    items.push(
      "注文番号、購入時メール、EU対象、期限、対象外商品の有無を確認してください。",
    );
  } else if (
    request.status === WITHDRAWAL_STATUSES.APPROVED &&
    returnStatus === "UNDECIDED"
  ) {
    label = "返送要否の判断";
    tone = "warning";
    items.push("返送が必要か、返送不要で返金判断へ進めるかを決めてください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED ||
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(returnStatus)
  ) {
    label = "返送待ち";
    tone = "info";
    items.push("追跡番号、返送証明、または返送品の到着を確認してください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    [
      "RECEIVED",
      "CONDITION_CHECKED",
      "NOT_REQUIRED",
      "NOT_APPLICABLE",
    ].includes(returnStatus)
  ) {
    label = refundStatus === "UNDECIDED" ? "返金判断待ち" : "手動処理待ち";
    tone = refundStatus === "UNDECIDED" ? "warning" : "info";
    items.push(
      refundStatus === "UNDECIDED"
        ? "商品代金、通常配送分の初回送料、減額、返送送料負担を記録してください。"
        : "Shopify側でキャンセルまたは返金を手動処理し、完了記録を残してください。",
    );
  } else if (request.status === WITHDRAWAL_STATUSES.REFUND_PENDING) {
    label = "手動返金待ち";
    tone = "info";
    items.push(
      "Shopify側で返金処理を行い、返金IDと返金額を完了記録に残してください。",
    );
  }

  if (!request.confirmationSentAt) {
    items.push("受付確認メールが未送信です。");
  }
  if (shouldNotifyVendors(request) && !hasVendorNotification) {
    items.push(
      "出店者通知が未送信です。発送や返送対応が必要な出店者へ通知してください。",
    );
  }
  if (hasEmailFailure) {
    items.push(
      "メール送信失敗があります。送信元設定と宛先を確認してください。",
    );
  }

  return {
    label,
    tone,
    items,
    rows: [
      ["推奨処理", label],
      ["現在の状態", request.statusLabel || request.status || "-"],
      [
        "返送状態",
        labelFromOptions(
          RETURN_REQUIREMENT_OPTIONS,
          request.returnRequirementStatus,
        ),
      ],
      [
        "商品状態",
        labelFromOptions(
          RETURN_CONDITION_OPTIONS,
          request.returnConditionStatus,
        ),
      ],
      [
        "返金判断",
        labelFromOptions(REFUND_DECISION_OPTIONS, request.refundDecisionStatus),
      ],
      ["返金予定額", formatMoney(plannedRefundAmount, refundCurrency)],
      [
        "出店者通知",
        hasVendorNotification
          ? "送信済み"
          : shouldNotifyVendors(request)
            ? "未送信"
            : "対象外",
      ],
      [
        "メール状態",
        latestEmail
          ? `${latestEmail.emailType} / ${
              latestEmail.status === "sent" ? "送信済み" : "失敗"
            }`
          : "履歴なし",
      ],
    ],
  };
}

export function buildProcessingSteps(request) {
  const status = String(request.status || "");
  const eligibilityStatus = String(request.eligibilityStatus || "");
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const hasReturnInstruction = hasSentEmailLog(request, "return_instructions");
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");
  const hasEmailFailure = Array.isArray(request.emailLogs)
    ? request.emailLogs.some((log) => log.status === "failed")
    : false;
  const isClosed = [
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
  ].includes(status);
  const returnResolved = [
    "NOT_REQUIRED",
    "NOT_APPLICABLE",
    "RECEIVED",
    "CONDITION_CHECKED",
  ].includes(returnStatus);
  const returnWaiting = ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
    returnStatus,
  );
  const refundDecided = refundStatus !== "UNDECIDED";
  const completed = completionStatus !== "UNDECIDED";

  return [
    {
      label: "受付",
      status: request.confirmationSentAt ? "済" : "未送信",
      tone: request.confirmationSentAt ? "success" : "warning",
      detail: request.confirmationSentAt
        ? "受付確認メールを送信済みです。"
        : "まず受付確認メールを送信してください。",
    },
    {
      label: "申請条件",
      status: eligibilityStatus === "ELIGIBLE" ? "確認済み" : "要確認",
      tone: eligibilityStatus === "ELIGIBLE" ? "success" : "warning",
      detail:
        eligibilityStatus === "ELIGIBLE"
          ? "EU対象・期限・注文照合は通過しています。"
          : getWithdrawalEligibilityLabel(eligibilityStatus),
    },
    {
      label: "出店者通知",
      status: hasVendorNotification
        ? "送信済み"
        : shouldNotifyVendors(request)
          ? "未送信"
          : "対象外",
      tone: hasVendorNotification
        ? "success"
        : shouldNotifyVendors(request)
          ? "warning"
          : "neutral",
      detail: hasVendorNotification
        ? "対象出店者へ撤回申請を通知済みです。"
        : shouldNotifyVendors(request)
          ? "発送停止、返送受け取り、商品状態確認が必要な場合は出店者へ通知してください。"
          : "却下または期限切れのため、通常は出店者通知不要です。",
    },
    {
      label: "返送案内",
      status:
        returnStatus === "UNDECIDED"
          ? "未判断"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "不要"
            : hasReturnInstruction
              ? "送信済み"
              : "未送信",
      tone:
        returnStatus === "UNDECIDED"
          ? "warning"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "success"
            : hasReturnInstruction
              ? "success"
              : "warning",
      detail:
        returnStatus === "UNDECIDED"
          ? "返送が必要か、返送不要で進めるかを判断してください。"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "返送なしで次の判断へ進めます。"
            : "返送が必要な場合は、返送案内メールの送信状況を確認してください。",
    },
    {
      label: "返送確認",
      status: returnResolved ? "済" : returnWaiting ? "待ち" : "未判断",
      tone: returnResolved ? "success" : returnWaiting ? "info" : "neutral",
      detail: returnResolved
        ? "返送不要、または返送品の確認が済んでいます。"
        : returnWaiting
          ? "追跡番号、返送証明、到着状況を確認してください。"
          : "返送要否が決まるまでは保留です。",
    },
    {
      label: "返金判断",
      status: refundDecided ? "済" : "未判断",
      tone: refundDecided ? "success" : returnResolved ? "warning" : "neutral",
      detail: refundDecided
        ? "返金予定額と減額理由が記録されています。"
        : returnResolved
          ? "商品状態を踏まえて、返金予定額を記録してください。"
          : "返送確認後に判断します。",
    },
    {
      label: "Shopify処理",
      status: completed ? "記録済み" : refundDecided ? "処理待ち" : "未到達",
      tone: completed ? "success" : refundDecided ? "warning" : "neutral",
      detail: completed
        ? "返金またはキャンセルの完了記録があります。"
        : refundDecided
          ? "Shopifyで手動返金またはキャンセルし、完了記録を残してください。"
          : "返金判断後に対応します。",
    },
    {
      label: "完了通知",
      status: request.completionNotifiedAt
        ? "送信済み"
        : completed
          ? "未送信"
          : "未到達",
      tone: request.completionNotifiedAt
        ? "success"
        : completed
          ? "warning"
          : "neutral",
      detail: request.completionNotifiedAt
        ? "購入者への完了通知を送信済みです。"
        : completed
          ? "完了通知メールを送信してください。"
          : "完了記録後に通知します。",
    },
    {
      label: "メール状態",
      status: hasEmailFailure ? "失敗あり" : "正常",
      tone: hasEmailFailure ? "danger" : "success",
      detail: hasEmailFailure
        ? "メール履歴から失敗した通知を確認してください。"
        : "記録上のメール失敗はありません。",
    },
  ].filter(
    (step) => !isClosed || step.label !== "返送案内" || step.tone !== "neutral",
  );
}

function calculateDisplayRefundTotal(request) {
  const item = toFiniteNumber(request.refundItemAmount);
  const shipping = toFiniteNumber(request.refundInitialShippingAmount);
  const deduction = toFiniteNumber(request.refundDeductionAmount);
  const total = item + shipping - deduction;
  return total > 0 ? total : null;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function buildQuickActions(request) {
  const status = request.status;
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");

  if (completionStatus !== "UNDECIDED") {
    return [];
  }

  const actions = [];

  if (status === WITHDRAWAL_STATUSES.REQUESTED) {
    actions.push(getQuickActionDefinition("acknowledge"));
    actions.push(getQuickActionDefinition("start_review"));
  }

  if (
    status === WITHDRAWAL_STATUSES.ACKNOWLEDGED ||
    status === WITHDRAWAL_STATUSES.UNDER_REVIEW
  ) {
    actions.push(getQuickActionDefinition("approve"));
  }

  if (status === WITHDRAWAL_STATUSES.APPROVED) {
    actions.push(getQuickActionDefinition("request_return"));
    actions.push(getQuickActionDefinition("no_return_refund_pending"));
  }

  if (
    status === WITHDRAWAL_STATUSES.RETURN_REQUESTED ||
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(returnStatus)
  ) {
    actions.push(getQuickActionDefinition("mark_return_received"));
  }

  if (
    status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    ["RECEIVED", "CONDITION_CHECKED"].includes(returnStatus)
  ) {
    actions.push(getQuickActionDefinition("move_refund_pending"));
  }

  return actions.filter(Boolean);
}

function getQuickActionDefinition(key) {
  const transition = getQuickTransitionConfig(key);
  if (!transition) return null;

  return {
    key,
    label: transition.label,
    description: transition.description,
    tone: transition.tone,
    hiddenInputs: transition.hiddenInputs || [],
  };
}

export function buildReviewChecks(request) {
  const eligibilityStatus = String(request.eligibilityStatus || "");
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const hasOrderOrEmailIssue = [
    "ORDER_NOT_FOUND_REVIEW",
    "EMAIL_MISMATCH_REVIEW",
  ].includes(eligibilityStatus);
  const hasDeadlineOrCountryIssue = [
    "DEADLINE_EXPIRED",
    "NON_EU_REVIEW",
  ].includes(eligibilityStatus);
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");

  return [
    {
      label: "受付メール",
      status: request.confirmationSentAt ? "送信済み" : "未送信",
      tone: request.confirmationSentAt ? "success" : "warning",
      detail: request.confirmationSentAt
        ? "購入者へ受付確認を送信済みです。"
        : "耐久性のある媒体として、まず受付メールを送ってください。",
    },
    {
      label: "注文・メール照合",
      status: hasOrderOrEmailIssue ? "要確認" : "確認候補",
      tone: hasOrderOrEmailIssue ? "warning" : "success",
      detail: "注文番号と購入時メールが一致するかを確認します。",
    },
    {
      label: "期限・対象国",
      status: hasDeadlineOrCountryIssue ? "要確認" : "確認候補",
      tone: hasDeadlineOrCountryIssue ? "warning" : "success",
      detail: "EU対象か、受領日から14日以内かを確認します。",
    },
    {
      label: "出店者通知",
      status: hasVendorNotification
        ? "送信済み"
        : shouldNotifyVendors(request)
          ? "未送信"
          : "対象外",
      tone: hasVendorNotification
        ? "success"
        : shouldNotifyVendors(request)
          ? "warning"
          : "neutral",
      detail:
        "発送停止、返送受け取り、商品状態確認が必要な出店者へ通知します。",
    },
    {
      label: "返送要否",
      status: returnStatus === "UNDECIDED" ? "未判断" : "記録済み",
      tone: returnStatus === "UNDECIDED" ? "warning" : "success",
      detail: "返送不要・返送待ち・到着済みなどを記録します。",
    },
    {
      label: "返金判断",
      status: refundStatus === "UNDECIDED" ? "未判断" : "記録済み",
      tone: refundStatus === "UNDECIDED" ? "warning" : "success",
      detail:
        "商品代金、通常配送分の初回送料、減額、返送送料負担を分けて判断します。",
    },
    {
      label: "完了記録",
      status: completionStatus === "UNDECIDED" ? "未記録" : "記録済み",
      tone: completionStatus === "UNDECIDED" ? "neutral" : "success",
      detail: "Shopify側の手動処理後、結果と外部IDを残します。",
    },
  ];
}

export function labelFromOptions(options, value) {
  return (
    options.find(([optionValue]) => optionValue === value)?.[1] || value || "-"
  );
}

export function getDeadlineSourceLabel(value) {
  const labels = {
    buyer_received_date: "購入者入力の受領日",
    order_processed_at: "注文処理日時",
    order_created_at: "注文作成日時",
  };

  return labels[value] || value || "-";
}

export function getLineTitle(line) {
  return (
    line?.title ||
    line?.name ||
    line?.productTitle ||
    line?.product_title ||
    line?.variantTitle ||
    "-"
  );
}

export function getLineIdentifier(line) {
  return (
    line?.sku ||
    line?.skuId ||
    line?.shopifyLineItemId ||
    line?.lineItemId ||
    line?.id ||
    line?.variantId ||
    line?.productId ||
    null
  );
}

export function getLineQuantity(line) {
  const quantity =
    line?.quantity ??
    line?.currentQuantity ??
    line?.current_quantity ??
    line?.fulfillableQuantity ??
    line?.fulfillable_quantity;

  return quantity == null || quantity === "" ? "-" : quantity;
}

export function formatLineAmount(line) {
  const amount =
    line?.lineSubtotalAmount ??
    line?.netAmount ??
    line?.totalAmount ??
    line?.price ??
    line?.amount ??
    line?.originalUnitPrice;
  const currencyCode =
    line?.currencyCode || line?.currency || line?.presentmentCurrency || "JPY";

  return formatMoney(amount, currencyCode);
}

export function formatMoney(value, currencyCode = "JPY") {
  if (value == null || value === "") return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  const digits = getCurrencyMinorUnitDigits(currencyCode);
  const majorAmount = numeric / 10 ** digits;
  return `${majorAmount.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currencyCode || ""}`.trim();
}

export function formatMoneyInputValue(value, currencyCode = "JPY") {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";

  const digits = getCurrencyMinorUnitDigits(currencyCode);
  return (numeric / 10 ** digits).toFixed(digits);
}

function getCurrencyMinorUnitDigits(currencyCode) {
  const normalized = String(currencyCode || "JPY")
    .trim()
    .toUpperCase();
  const zeroDecimalCurrencies = new Set([
    "BIF",
    "CLP",
    "DJF",
    "GNF",
    "JPY",
    "KMF",
    "KRW",
    "MGA",
    "PYG",
    "RWF",
    "UGX",
    "VND",
    "VUV",
    "XAF",
    "XOF",
    "XPF",
  ]);

  return zeroDecimalCurrencies.has(normalized) ? 0 : 2;
}

export function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
}

export function formatDateInput(value) {
  if (!value) return "";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch (_error) {
    return "";
  }
}

export function getOrderCurrencyCode(request) {
  const order = request.orderSnapshotJson || {};
  return (
    order.currencyCode ||
    order.currency ||
    order.presentment_currency ||
    order.total_price_set?.shop_money?.currency_code ||
    "JPY"
  );
}
