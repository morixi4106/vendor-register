import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { getProductionReadiness } =
    await import("../services/productionReadiness.server.js");

  return json(await getProductionReadiness());
};

export default function ProductionReadinessPage() {
  const data = useLoaderData();
  const blockingChecks = data.checks.filter((check) => check.status === "fail");
  const nonBlockingChecks = data.checks.filter(
    (check) => check.status !== "fail",
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
          grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
          gap:14px;
        }
        .readiness-metric{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:16px;
          display:grid;
          gap:6px;
        }
        .readiness-metric__label{
          margin:0;
          color:#6b7280;
          font-size:13px;
          font-weight:700;
        }
        .readiness-metric__value{
          margin:0;
          font-size:24px;
          font-weight:900;
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
        .readiness-actions{
          margin:0;
          padding-left:18px;
          color:#374151;
          line-height:1.7;
        }
        .readiness-link{
          color:#111827;
          font-weight:800;
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
            <h1 className="readiness-title">本番運用チェック</h1>
            <p className="readiness-subtitle">
              Stripe / Shopify /
              出金運用の切り替え漏れを確認します。秘密鍵の値は表示しません。
            </p>
          </div>
          <span
            className={`readiness-badge ${
              data.canGoLive ? "readiness-badge--pass" : "readiness-badge--fail"
            }`}
          >
            {data.canGoLive ? "コード上のブロッカーなし" : "本番ブロッカーあり"}
          </span>
        </div>
      </section>

      <section className="readiness-card">
        <div className="readiness-grid">
          <Metric
            label="決済方針"
            value={
              data.operation?.paymentFlowLabel ||
              "Shopify Payments + manual seller payouts"
            }
          />
          <Metric
            label="Stripe Connect"
            value={
              data.operation?.stripeConnectProductionEnabled
                ? "本番使用"
                : "未使用"
            }
          />
          <Metric label="Stripe key mode" value={data.stripe.mode} />
          <Metric label="ブロッカー" value={data.summary.blockingCount} />
          <Metric label="注意" value={data.summary.warningCount} />
          <Metric label="外部確認" value={data.summary.manualCount} />
          <Metric
            label="出店者"
            value={`${data.sellers.activeCount}/${data.sellers.totalCount}`}
          />
        </div>
      </section>

      {blockingChecks.length > 0 ? (
        <section className="readiness-card">
          <h2 className="readiness-section-title">先に直すこと</h2>
          <ul className="readiness-actions">
            {blockingChecks.map((check) => (
              <li key={check.id}>
                <strong>{check.title}</strong>: {check.action || check.detail}
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
              {[...blockingChecks, ...nonBlockingChecks].map((check) => (
                <tr key={check.id}>
                  <td>
                    <Status status={check.status} />
                  </td>
                  <td>{categoryLabel(check.category)}</td>
                  <td>{check.title}</td>
                  <td>{check.detail || "-"}</td>
                  <td>{check.action || "-"}</td>
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
          Paymentsの入金口座とWiseの受取口座は、アプリからは確認できません。
          Shopify管理画面の決済設定で実口座を確認し、テストでは少額注文から返金、キャンセル、出金記録まで通してください。
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

function Metric({ label, value }) {
  return (
    <div className="readiness-metric">
      <p className="readiness-metric__label">{label}</p>
      <p className="readiness-metric__value">{value}</p>
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
