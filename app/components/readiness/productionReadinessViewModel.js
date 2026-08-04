export function statusLabel(status) {
  switch (status) {
    case "pass":
      return "OK";
    case "fail":
      return "要対応";
    case "warning":
      return "注意";
    case "manual":
      return "外部確認";
    case "optional":
      return "任意";
    default:
      return status;
  }
}

export function categoryLabel(category) {
  switch (category) {
    case "stripe":
      return "Stripe";
    case "shopify":
      return "Shopify";
    case "seller":
      return "出店者";
    case "payout":
      return "出金";
    case "app":
      return "アプリ";
    default:
      return category;
  }
}

export function statusSortOrder(status) {
  switch (status) {
    case "fail":
      return 0;
    case "warning":
      return 1;
    case "manual":
      return 2;
    case "optional":
      return 3;
    case "pass":
      return 4;
    default:
      return 5;
  }
}

export function paymentFlowLabel(operation) {
  if (operation?.stripeConnectProductionEnabled) {
    return "Stripe Connect";
  }

  return "Shopify Checkout";
}

export function sellerPayoutFlowLabel(operation) {
  if (operation?.sellerPayoutProvider === "wise") {
    return "Wise API精算";
  }

  if (operation?.sellerPayoutProvider === "manual") {
    return "月次手動精算";
  }

  return operation?.sellerPayoutProviderLabel || "未設定";
}

export function heartbeatStatusLabel(heartbeat) {
  if (!heartbeat?.available) return "未確認";
  if (heartbeat.failureUnresolved || heartbeat.stale) return "要確認";
  if (!heartbeat.row?.lastSucceededAt) return "未実行";
  return "稼働中";
}

const CHECK_TITLE_LABELS = {
  payment_provider: "決済方式",
  seller_payout_provider: "出店者精算方式",
  production_payment_flow: "本番フロー",
  stripe_secret_key_live: "Stripe secret key",
  stripe_publishable_key_live: "Stripe publishable key",
  stripe_key_modes_match: "Stripeキー整合",
  stripe_platform_webhook_secret: "Stripe webhook",
  stripe_connect_webhook_secret: "Stripe Connect webhook",
  stripe_platform_fee_bps: "Stripe手数料設定",
  production_runtime: "実行環境",
  shopify_configured_scopes: "Shopify設定権限",
  shopify_granted_scopes: "Shopify承認済み権限",
  shopify_product_store_mapping: "Shopify商品と店舗の紐付け",
  shopify_payments_bank_account: "決済入金口座",
  active_sellers_have_stripe_accounts: "出店者の受取先",
  connected_accounts_match_current_stripe_key: "Stripe接続アカウント確認",
  connected_accounts_ready: "Stripe接続アカウント状態",
  seller_payout_transfer_mode: "精算実行方法",
  wise_api_environment: "Wise API設定",
  wise_webhook_secret: "Wise webhook",
  wise_execution_safety: "Wise実行安全性",
  wise_api_connection: "Wise API接続",
};

export function decorateCheckForDisplay(check, data) {
  const stripeConnectEnabled = Boolean(
    data.operation?.stripeConnectProductionEnabled,
  );
  const isOptionalStripe =
    check.category === "stripe" &&
    !stripeConnectEnabled &&
    check.status === "warning";
  const isScopeExcluded =
    check.releaseDisposition === "scope_excluded" &&
    check.releaseBlocking === false;
  const displayStatus =
    isOptionalStripe || isScopeExcluded ? "optional" : check.status;

  return {
    ...check,
    displayStatus,
    displayTitle: CHECK_TITLE_LABELS[check.id] || check.title,
    displayDetail: isScopeExcluded
      ? check.releaseDispositionReason || check.detail
      : checkDetailForDisplay(check, data, { isOptionalStripe }),
    displayAction: isScopeExcluded
      ? ""
      : checkActionForDisplay(check, data, { isOptionalStripe }),
    actionLink: checkActionLinkForDisplay(check),
  };
}

function checkDetailForDisplay(check, data, { isOptionalStripe }) {
  if (isOptionalStripe) {
    return "現在の本番導線では使いません。Stripe Connectを再開する場合だけ確認します。";
  }

  switch (check.id) {
    case "payment_provider":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connect が決済方式として有効です。"
        : "購入者の決済は Shopify Checkout で処理します。";
    case "seller_payout_provider":
      return `出店者への支払いは ${sellerPayoutFlowLabel(
        data.operation,
      )} として扱います。`;
    case "production_payment_flow":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connect の本番確認が有効です。"
        : `決済は ${paymentFlowLabel(data.operation)}、精算は ${sellerPayoutFlowLabel(
            data.operation,
          )} です。`;
    case "shopify_configured_scopes":
      return formatMissingScopeDetail(
        check.detail,
        "本番設定のSCOPESに不足があります",
      );
    case "shopify_granted_scopes":
      return formatMissingScopeDetail(
        check.detail,
        "インストール済みアプリに未承認の権限があります",
      );
    case "shopify_payments_bank_account":
      return "入金口座や決済サービス側の有効状態は、アプリから完全には確認できません。";
    case "active_sellers_have_stripe_accounts":
      if (data.operation?.sellerPayoutProvider === "wise") {
        return (
          check.detail || "Wise精算では、出店者ごとの受取先登録が必要です。"
        );
      }
      return "月次手動精算では、出店者のStripe登録は不要です。";
    case "connected_accounts_match_current_stripe_key":
    case "connected_accounts_ready":
      return data.operation?.stripeConnectProductionEnabled
        ? check.detail
        : "Stripe Connect未使用のため対象外です。";
    case "seller_payout_transfer_mode":
      return data.operation?.sellerPayoutProvider === "wise"
        ? "承認済みの精算予定からWise送金を実行します。"
        : "実送金後に外部送金IDを記録する運用です。";
    case "wise_api_connection":
      return data.operation?.sellerPayoutProvider === "wise"
        ? check.detail
        : "現在は手動精算のため、Wise API接続は任意です。";
    default:
      return check.detail;
  }
}

function checkActionForDisplay(check, data, { isOptionalStripe }) {
  if (isOptionalStripe) {
    return "今は対応不要です。Stripe Connectを使う方針に戻す時だけ設定します。";
  }

  switch (check.id) {
    case "payment_provider":
      return check.status === "pass"
        ? ""
        : "Renderの環境変数で PAYMENT_PROVIDER=shopify_payments を明示します。";
    case "seller_payout_provider":
      return check.status === "pass"
        ? ""
        : "Renderの環境変数で SELLER_PAYOUT_PROVIDER=manual または wise を明示します。";
    case "production_payment_flow":
      return data.operation?.stripeConnectProductionEnabled
        ? "Stripe Connectを使う場合だけ、live key、webhook、接続アカウントを確認します。"
        : "Stripe Connect direct charge と Connect payout は無効のままにします。";
    case "shopify_configured_scopes":
      return check.status === "pass"
        ? ""
        : "Shopify設定とRenderのSCOPESを更新し、再デプロイ後に再認可します。";
    case "shopify_granted_scopes":
      return check.status === "pass"
        ? ""
        : "Shopify管理画面でアプリを開き、追加権限を承認してください。出ない場合は再インストールで再認可します。";
    case "shopify_payments_bank_account":
      return "Shopify管理画面とKOMOJU側で、決済受付と入金口座の状態を確認します。";
    case "active_sellers_have_stripe_accounts":
      return check.status === "pass"
        ? ""
        : "受取先未登録の出店者は精算対象外にするか、受取先確認を完了します。";
    case "connected_accounts_match_current_stripe_key":
    case "connected_accounts_ready":
      return data.operation?.stripeConnectProductionEnabled
        ? check.action
        : "今は対応不要です。";
    case "seller_payout_transfer_mode":
      return data.operation?.sellerPayoutProvider === "wise"
        ? "承認、残高再計算、冪等性キーを通してから送金します。"
        : "銀行/Wiseなどで送金後、出金管理に外部送金IDを記録します。";
    case "wise_api_connection":
      return data.operation?.sellerPayoutProvider === "wise"
        ? check.action
        : "Wise API精算に切り替える時だけ設定します。";
    default:
      return check.action;
  }
}

function formatMissingScopeDetail(detail, prefix) {
  const missingScopes = String(detail || "").match(/:\s*(.+)$/)?.[1];

  if (missingScopes) {
    return `${prefix}: ${missingScopes}`;
  }

  return detail;
}

function checkActionLinkForDisplay(check) {
  switch (check.id) {
    case "shopify_product_store_mapping":
      return {
        label: "商品同期を開く",
        to: "/app/shopify-product-sync",
      };
    case "product_shipping_profiles_available":
    case "approved_product_shipping_weight":
    case "air_packet_product_profiles":
    case "air_packet_single_variant_products":
    case "air_packet_weight_sync":
    case "eu_product_international_shipping_profiles":
      return {
        label: "商品配送設定を開く",
        to: "/app/product-shipping",
      };
    case "air_packet_country_availability":
      return {
        label: "国際配送状況を開く",
        to: "/app/international-shipping",
      };
    case "withdrawal_open_requests":
      return {
        label: "未完了を見る",
        to: "/app/withdrawals?queue=open",
      };
    case "withdrawal_deadlines":
      return {
        label: "期限超過を見る",
        to: "/app/withdrawals?queue=deadline_expired",
      };
    case "withdrawal_email_failures":
      return {
        label: "メール失敗を見る",
        to: "/app/withdrawals?queue=email_failed",
      };
    case "withdrawal_processing_integrity":
      return {
        label: "処理不整合を見る",
        to: "/app/withdrawals?queue=processing_issue",
      };
    case "withdrawal_email_worker_heartbeat":
      return {
        label: "送信キューを見る",
        to: "/app/withdrawals?queue=email_failed",
      };
    case "seller_order_unresolved_shadow_checks":
      return {
        label: "注文差分を見る",
        to: "/app/seller-order-shadow",
      };
    case "seller_ledger_repair_candidates":
    case "test_store_pending_payout_runs":
      return {
        label: "出金管理を見る",
        to: "/app/payout-runs",
      };
    default:
      return null;
  }
}
