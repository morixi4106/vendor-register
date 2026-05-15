import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  Outlet,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
} from "@remix-run/react";

import { authenticate } from "../shopify.server";

const DEFAULT_CURRENCY = "jpy";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const {
    getSellerPayoutableLedgerBalance,
    listAdminSellerRows,
    listPayoutRuns,
  } = await import("../services/sellerPayments.server.js");

  const [sellerRows, payoutRuns] = await Promise.all([
    listAdminSellerRows(),
    listPayoutRuns(),
  ]);

  const sellers = await Promise.all(
    sellerRows
      .filter((seller) => seller.sellerId)
      .map(async (seller) => ({
        ...seller,
        payoutableLedgerBalance: await getSellerPayoutableLedgerBalance({
          sellerId: seller.sellerId,
          currencyCode: DEFAULT_CURRENCY,
        }),
        payoutableLedgerCurrencyCode: DEFAULT_CURRENCY,
      })),
  );

  return json({
    sellers,
    payoutRuns,
  });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const { createPayoutRun } = await import("../services/sellerPayments.server.js");

  const formData = await request.formData();
  const result = await createPayoutRun({
    sellerId: String(formData.get("sellerId") || ""),
    amount: formData.get("amount"),
    currencyCode: String(formData.get("currencyCode") || DEFAULT_CURRENCY),
    createdBy: "admin",
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: createPayoutRunErrorMessage(result),
      },
      { status: 400 },
    );
  }

  return redirect(`/app/payout-runs/${result.payoutRun.id}`);
};

export default function AdminPayoutRunsPage() {
  const { sellers, payoutRuns } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const isCreating =
    navigation.formData?.has("sellerId") &&
    navigation.state !== "idle";
  const isDetailRoute = location.pathname.startsWith("/app/payout-runs/");

  if (isDetailRoute) {
    return <Outlet />;
  }

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .payout-admin__page{
          display:grid;
          gap:24px;
        }
        .payout-admin__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
        }
        .payout-admin__title{
          margin:0 0 8px;
          font-size:24px;
          font-weight:700;
          color:#111827;
        }
        .payout-admin__subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .payout-admin__form{
          display:grid;
          gap:12px;
          grid-template-columns:repeat(4, minmax(0, 1fr));
        }
        .payout-admin__field{
          display:grid;
          gap:8px;
        }
        .payout-admin__input,
        .payout-admin__select{
          min-height:44px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:0 12px;
          font-size:14px;
          box-sizing:border-box;
        }
        .payout-admin__button{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:44px;
          padding:0 16px;
          border-radius:999px;
          border:1px solid #111827;
          background:#111827;
          color:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
        }
        .payout-admin__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .payout-admin__notice{
          margin:0 0 16px;
          padding:12px 14px;
          border-radius:10px;
          background:#fef2f2;
          color:#b91c1c;
          font-weight:700;
        }
        .payout-admin__balance-grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
          gap:12px;
          margin-top:18px;
        }
        .payout-admin__balance-card{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:14px;
          display:grid;
          gap:6px;
        }
        .payout-admin__balance-label{
          margin:0;
          color:#6b7280;
          font-size:13px;
        }
        .payout-admin__balance-amount{
          margin:0;
          color:#111827;
          font-size:22px;
          font-weight:800;
        }
        .payout-admin__balance-status{
          margin:0;
          color:#6b7280;
          font-size:13px;
        }
        @media (max-width: 900px){
          .payout-admin__form{
            grid-template-columns:1fr;
          }
        }
      `}</style>

      <div className="payout-admin__page">
        <section className="payout-admin__card">
          <h1 className="payout-admin__title">出金管理</h1>
          <p className="payout-admin__subtitle">
            出金は自動実行しません。台帳上の出金可能残高を確認し、承認後に管理者が実行します。
          </p>

          {actionData?.message ? (
            <p className="payout-admin__notice">{actionData.message}</p>
          ) : null}

          <Form method="post" className="payout-admin__form">
            <div className="payout-admin__field">
              <label htmlFor="sellerId">出店者</label>
              <select id="sellerId" name="sellerId" className="payout-admin__select" required>
                <option value="">出店者を選択</option>
                {sellers.map((seller) => (
                  <option key={seller.sellerId} value={seller.sellerId}>
                    {seller.vendorStoreName} / 台帳残高:{" "}
                    {formatMoney(
                      seller.payoutableLedgerBalance,
                      seller.payoutableLedgerCurrencyCode,
                    )}
                  </option>
                ))}
              </select>
            </div>
            <div className="payout-admin__field">
              <label htmlFor="amount">金額</label>
              <input
                id="amount"
                name="amount"
                className="payout-admin__input"
                type="number"
                min="1"
                step="1"
                required
              />
            </div>
            <div className="payout-admin__field">
              <label htmlFor="currencyCode">通貨</label>
              <input
                id="currencyCode"
                name="currencyCode"
                className="payout-admin__input"
                defaultValue={DEFAULT_CURRENCY}
                required
              />
            </div>
            <div className="payout-admin__field" style={{ alignSelf: "end" }}>
              <button type="submit" className="payout-admin__button" disabled={isCreating}>
                {isCreating ? "作成中..." : "出金予定を作成"}
              </button>
            </div>
          </Form>

          {sellers.length > 0 ? (
            <div className="payout-admin__balance-grid">
              {sellers.map((seller) => (
                <div className="payout-admin__balance-card" key={seller.sellerId}>
                  <p className="payout-admin__balance-label">{seller.vendorStoreName}</p>
                  <p className="payout-admin__balance-amount">
                    {formatMoney(
                      seller.payoutableLedgerBalance,
                      seller.payoutableLedgerCurrencyCode,
                    )}
                  </p>
                  <p className="payout-admin__balance-status">
                    状態: {seller.sellerStatusLabel || seller.sellerStatus || "-"}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="payout-admin__card">
          <h2 className="payout-admin__title">出金予定一覧</h2>
          {payoutRuns.length === 0 ? (
            <p style={{ margin: 0 }}>出金予定はまだありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>出金ID</th>
                    <th style={thStyle}>出店者</th>
                    <th style={thStyle}>金額</th>
                    <th style={thStyle}>状態</th>
                    <th style={thStyle}>Stripe出金ID</th>
                    <th style={thStyle}>更新日時</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRuns.map((run) => (
                    <tr key={run.id}>
                      <td style={tdStyle}>
                        <Link to={`/app/payout-runs/${run.id}`}>{run.id}</Link>
                      </td>
                      <td style={tdStyle}>{run.sellerStoreName}</td>
                      <td style={tdStyle}>{formatMoney(run.amount, run.currencyCode)}</td>
                      <td style={tdStyle}>{run.statusLabel}</td>
                      <td style={tdStyle}>{run.stripePayoutId || "-"}</td>
                      <td style={tdStyle}>
                        {new Date(run.updatedAt).toLocaleString("ja-JP")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatMoney(amount, currencyCode) {
  const normalizedAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `${normalizedAmount} ${String(currencyCode || DEFAULT_CURRENCY).toUpperCase()}`;
}

function createPayoutRunErrorMessage(result) {
  switch (result.reason) {
    case "insufficient_ledger_balance":
      return `台帳上の出金可能残高が不足しています。出金可能: ${formatMoney(
        result.availableLedgerBalance,
        result.currencyCode,
      )} / 作成額: ${formatMoney(result.requestedAmount, result.currencyCode)}`;
    case "invalid_amount":
      return "出金額が不正です。1以上の整数で入力してください。";
    case "seller_not_active":
      return "出店者の決済状態が有効ではないため、出金予定を作成できません。";
    case "seller_payout_restricted":
      return "この出店者は制限中または禁止中のため、出金対象外です。";
    case "stripe_account_missing":
      return "Stripe連携アカウントが未作成のため、出金予定を作成できません。";
    default:
      return "出金予定の作成に失敗しました。";
  }
}

const thStyle = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #e5e7eb",
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "14px 12px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};
