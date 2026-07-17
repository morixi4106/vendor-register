import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { getProductionReadiness } =
    await import("../services/productionReadiness.server.js");

  return json(await getProductionReadiness());
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { getCarrierCallbackUrl, upsertShippingV2CarrierService } =
    await import("../services/carrierShippingRates.server.js");
  const appUrl = process.env.APP_URL;

  if (!appUrl) {
    return json(
      {
        carrierService: {
          ok: false,
          message: "APP_URL is not configured.",
        },
      },
      { status: 400 },
    );
  }

  const result = await upsertShippingV2CarrierService({
    shopDomain: session.shop,
    appUrl,
  });

  return json({
    carrierService: {
      ok: true,
      shopDomain: session.shop,
      callbackUrl: getCarrierCallbackUrl(appUrl),
      result,
    },
  });
};

export default function ProductionReadinessPage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isCarrierSubmitting = navigation.state === "submitting";
  const displayChecks = data.checks.map((check) =>
    decorateCheckForDisplay(check, data),
  );
  const blockingChecks = displayChecks.filter(
    (check) => check.displayStatus === "fail",
  );
  const nonBlockingChecks = displayChecks.filter(
    (check) => check.displayStatus !== "fail",
  );
  const displaySummary = {
    blockingCount: blockingChecks.length,
    warningCount: displayChecks.filter(
      (check) => check.displayStatus === "warning",
    ).length,
    manualCount: displayChecks.filter(
      (check) => check.displayStatus === "manual",
    ).length,
    optionalCount: displayChecks.filter(
      (check) => check.displayStatus === "optional",
    ).length,
  };
  const orderedChecks = [...blockingChecks, ...nonBlockingChecks].sort(
    (a, b) =>
      statusSortOrder(a.displayStatus) - statusSortOrder(b.displayStatus),
  );

  return (
    <div className="readiness-page">
      <style>{`
        .readiness-page{
          display:grid;
          gap:24px;
          padding:24px;
          background:#f3f4f6;
          min-height:100%;
          color:#111827;
        }
        .readiness-card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:22px;
        }
        .readiness-header{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:flex-start;
          flex-wrap:wrap;
        }
        .readiness-title{
          margin:0 0 8px;
          font-size:28px;
          line-height:1.25;
        }
        .readiness-subtitle{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-badge{
          display:inline-flex;
          align-items:center;
          min-height:36px;
          padding:0 14px;
          border-radius:999px;
          font-weight:800;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-badge--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-badge--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
          gap:14px;
        }
        .readiness-metric{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:16px;
          display:grid;
          gap:6px;
          min-width:0;
        }
        .readiness-metric__label{
          margin:0;
          color:#6b7280;
          font-size:13px;
          font-weight:700;
        }
        .readiness-metric__value{
          margin:0;
          font-size:22px;
          line-height:1.2;
          font-weight:900;
          overflow-wrap:anywhere;
        }
        .readiness-metric__value--compact{
          font-size:20px;
        }
        .readiness-section-title{
          margin:0 0 14px;
          font-size:20px;
        }
        .readiness-table{
          width:100%;
          border-collapse:collapse;
        }
        .readiness-table th,
        .readiness-table td{
          padding:14px 12px;
          border-bottom:1px solid #eef2f7;
          text-align:left;
          vertical-align:top;
        }
        .readiness-table th{
          color:#6b7280;
          font-size:13px;
          white-space:nowrap;
        }
        .readiness-status{
          display:inline-flex;
          align-items:center;
          min-height:28px;
          padding:0 10px;
          border-radius:999px;
          font-weight:800;
          font-size:12px;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-status--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-status--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-status--warning{
          color:#92400e;
          background:#fffbeb;
          border-color:#fde68a;
        }
        .readiness-status--manual{
          color:#374151;
          background:#f9fafb;
          border-color:#d1d5db;
        }
        .readiness-status--optional{
          color:#1f2937;
          background:#f3f4f6;
          border-color:#d1d5db;
        }
        .readiness-actions{
          margin:0;
          padding-left:18px;
          color:#374151;
          line-height:1.7;
        }
        .readiness-action-stack{
          display:grid;
          gap:8px;
          align-items:start;
        }
        .readiness-action-link{
          display:inline-flex;
          width:max-content;
          min-height:32px;
          align-items:center;
          border:1px solid #d1d5db;
          border-radius:999px;
          padding:0 12px;
          color:#111827;
          background:#fff;
          font-weight:900;
          text-decoration:none;
        }
        .readiness-link{
          color:#111827;
          font-weight:800;
        }
        .readiness-tool{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:center;
          flex-wrap:wrap;
        }
        .readiness-tool__body{
          display:grid;
          gap:6px;
          min-width:260px;
        }
        .readiness-tool__title{
          margin:0;
          font-size:18px;
          font-weight:900;
        }
        .readiness-tool__text{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-button{
          border:0;
          border-radius:999px;
          min-height:44px;
          padding:0 18px;
          background:#111827;
          color:#fff;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        }
        .readiness-button:disabled{
          cursor:wait;
          opacity:.65;
        }
        .readiness-result{
          margin:14px 0 0;
          border:1px solid #d1fae5;
          background:#ecfdf5;
          color:#065f46;
          border-radius:12px;
          padding:12px 14px;
          line-height:1.7;
        }
        .readiness-result--error{
          border-color:#fecaca;
          background:#fef2f2;
          color:#991b1b;
        }
        @media (max-width: 720px){
          .readiness-page{
            padding:16px;
          }
          .readiness-table{
            min-width:760px;
          }
          .readiness-table-wrap{
            overflow-x:auto;
          }
        }
      `}</style>

      <section className="readiness-card">
        <div className="readiness-header">
          <div>
            <h1 className="readiness-title">本番前チェック</h1>
            <p className="readiness-subtitle">
              決済、精算、Shopify権限、出店者まわりの切り替え漏れを確認します。
              秘密鍵の値は表示しません。
            </p>
          </div>
          <span
            className={`readiness-badge ${
              data.canGoLive ? "readiness-badge--pass" : "readiness-badge--fail"
            }`}
          >
            {data.canGoLive ? "コード上のブロッカーなし" : "要対応あり"}
          </span>
        </div>
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">配送サービス再登録</h2>
            <p className="readiness-tool__text">
              アプリを再インストールした後は、Shopify側の配送サービス登録が外れることがあります。
              配送方法にShipping V2が出ない場合はここから再登録します。
            </p>
          </div>
          <Form method="post">
            <button
              className="readiness-button"
              type="submit"
              disabled={isCarrierSubmitting}
            >
              {isCarrierSubmitting ? "再登録中" : "Shipping V2を再登録"}
            </button>
          </Form>
        </div>
        {actionData?.carrierService ? (
          <div
            className={`readiness-result ${
              actionData.carrierService.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.carrierService.ok
              ? `登録しました。Callback: ${actionData.carrierService.callbackUrl}`
              : actionData.carrierService.message || "再登録に失敗しました。"}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-grid">
          <Metric
            label="決済"
            value={paymentFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="出店者精算"
            value={sellerPayoutFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="Stripe Connect"
            value={
              data.operation?.stripeConnectProductionEnabled
                ? "使用中"
                : "使わない"
            }
            compact
          />
          <Metric label="要対応" value={displaySummary.blockingCount} />
          <Metric label="注意" value={displaySummary.warningCount} />
          <Metric label="外部確認" value={displaySummary.manualCount} />
          <Metric label="任意" value={displaySummary.optionalCount} />
          <Metric
            label="出店者"
            value={`${data.sellers.activeCount}/${data.sellers.totalCount}`}
          />
          <Metric label="撤回申請" value={data.withdrawals?.openCount ?? 0} />
          <Metric
            label="撤回期限"
            value={`${data.withdrawals?.deadlineExpiredCount ?? 0}/${data.withdrawals?.deadlineSoonCount ?? 0}`}
            compact
          />
          <Metric
            label="撤回メール失敗"
            value={data.withdrawals?.emailFailedCount ?? 0}
          />
          <Metric
            label="撤回要確認"
            value={data.withdrawals?.processingIssueCount ?? 0}
          />
          <Metric
            label="定期メール"
            value={heartbeatStatusLabel(data.integrity?.heartbeat)}
            compact
          />
          <Metric
            label="注文差分"
            value={data.integrity?.sellerOrderShadow?.unresolvedCount ?? 0}
          />
          <Metric
            label="台帳補正待ち"
            value={`${data.integrity?.ledgerRepairs?.productionCount ?? 0}/${data.integrity?.ledgerRepairs?.testCount ?? 0}`}
            compact
          />
          <Metric
            label="テスト出金予定"
            value={data.integrity?.testStores?.pendingPayoutRunCount ?? 0}
          />
        </div>
      </section>

      {blockingChecks.length > 0 ? (
        <section className="readiness-card">
          <h2 className="readiness-section-title">先に直すこと</h2>
          <ul className="readiness-actions">
            {blockingChecks.map((check) => (
              <li key={check.id}>
                <strong>{check.displayTitle}</strong>:{" "}
                {check.displayAction || check.displayDetail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="readiness-card">
        <h2 className="readiness-section-title">チェック結果</h2>
        <div className="readiness-table-wrap">
          <table className="readiness-table">
            <thead>
              <tr>
                <th>状態</th>
                <th>区分</th>
                <th>項目</th>
                <th>現在</th>
                <th>対応</th>
              </tr>
            </thead>
            <tbody>
              {orderedChecks.map((check) => (
                <tr key={check.id}>
                  <td>
                    <Status status={check.displayStatus} />
                  </td>
                  <td>{categoryLabel(check.category)}</td>
                  <td>{check.displayTitle}</td>
                  <td>{check.displayDetail || "-"}</td>
                  <td>
                    <div className="readiness-action-stack">
                      <span>{check.displayAction || "-"}</span>
                      {check.actionLink ? (
                        <Link
                          className="readiness-action-link"
                          to={check.actionLink.to}
                        >
                          {check.actionLink.label}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="readiness-card">
        <h2 className="readiness-section-title">補足</h2>
        <p className="readiness-subtitle">
          Shopify
          Payments、KOMOJU、Wise、銀行口座などの外部側ステータスは、アプリから完全には確認できません。
          Shopify管理画面と各決済サービス側で有効状態を確認し、少額注文、返金、キャンセル、精算記録まで通してください。
          出金管理は{" "}
          <Link className="readiness-link" to="/app/payout-runs">
            出金管理
          </Link>{" "}
          から確認できます。
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value, compact = false }) {
  return (
    <div className="readiness-metric">
      <p className="readiness-metric__label">{label}</p>
      <p
        className={`readiness-metric__value ${
          compact ? "readiness-metric__value--compact" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Status({ status }) {
  return (
    <span className={`readiness-status readiness-status--${status}`}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status) {
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

function categoryLabel(category) {
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

function statusSortOrder(status) {
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

function paymentFlowLabel(operation) {
  if (operation?.stripeConnectProductionEnabled) {
    return "Stripe Connect";
  }

  return "Shopify Checkout";
}

function sellerPayoutFlowLabel(operation) {
  if (operation?.sellerPayoutProvider === "wise") {
    return "Wise API精算";
  }

  if (operation?.sellerPayoutProvider === "manual") {
    return "月次手動精算";
  }

  return operation?.sellerPayoutProviderLabel || "未設定";
}

function heartbeatStatusLabel(heartbeat) {
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

function decorateCheckForDisplay(check, data) {
  const stripeConnectEnabled = Boolean(
    data.operation?.stripeConnectProductionEnabled,
  );
  const isOptionalStripe =
    check.category === "stripe" &&
    !stripeConnectEnabled &&
    check.status === "warning";
  const displayStatus = isOptionalStripe ? "optional" : check.status;

  return {
    ...check,
    displayStatus,
    displayTitle: CHECK_TITLE_LABELS[check.id] || check.title,
    displayDetail: checkDetailForDisplay(check, data, { isOptionalStripe }),
    displayAction: checkActionForDisplay(check, data, { isOptionalStripe }),
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
