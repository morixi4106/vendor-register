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

import {
  MARKETPLACE_OPERATOR_ROLES,
  operatorAuditSnapshot,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

const DEFAULT_CURRENCY = "jpy";

export const loader = async ({ request }) => {
  await requireMarketplaceOperator(request, {
    roles: [
      MARKETPLACE_OPERATOR_ROLES.ADMIN,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_EXECUTOR,
    ],
  });
  const {
    getSellerPayoutableLedgerBalance,
    listAdminSellerRows,
    listPayoutRuns,
    listSellerLedgerRepairCandidates,
  } = await import("../services/sellerPayments.server.js");

  const [sellerRows, payoutRuns, repairCandidates] = await Promise.all([
    listAdminSellerRows(),
    listPayoutRuns(),
    listSellerLedgerRepairCandidates({ currencyCode: DEFAULT_CURRENCY }),
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
    repairCandidates,
  });
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "create_payout");
  const { operator } = await requireMarketplaceOperator(request, {
    role:
      intent === "repair_negative_balance"
        ? MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER
        : MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
  });

  if (intent === "repair_negative_balance") {
    const confirm = String(formData.get("confirm") || "");
    if (confirm !== "repair_negative_balance") {
      return json(
        {
          ok: false,
          intent,
          reason: "confirmation_required",
          message: "台帳補正の確認値が不足しています。画面を更新してもう一度実行してください。",
        },
        { status: 400 },
      );
    }

    const { repairSellerNegativeLedgerBalance } = await import(
      "../services/sellerPayments.server.js"
    );
    const result = await repairSellerNegativeLedgerBalance({
      sellerId: String(formData.get("sellerId") || ""),
      currencyCode: String(formData.get("currencyCode") || DEFAULT_CURRENCY),
      repairedBy: operator.actorKey,
      repairedByJson: operatorAuditSnapshot(operator),
      repairScope: String(formData.get("repairScope") || ""),
      shopifyOrderId: String(formData.get("shopifyOrderId") || ""),
      reason: String(formData.get("repairReason") || ""),
    });

    if (!result.ok) {
      return json(
        {
          ok: false,
          intent,
          reason: result.reason,
          message: repairLedgerErrorMessage(result),
        },
        { status: 400 },
      );
    }

    return json({
      ok: true,
      intent,
      repaired: result.repaired,
      message: result.repaired
        ? `${formatMoney(result.amount, result.currencyCode)} の補正台帳を追加しました。`
        : "補正対象のマイナス残高はありません。",
    });
  }

  const { createPayoutRun } = await import(
    "../services/sellerPayments.server.js"
  );
  const result = await createPayoutRun({
    sellerId: String(formData.get("sellerId") || ""),
    amount: formData.get("amount"),
    currencyCode: String(formData.get("currencyCode") || DEFAULT_CURRENCY),
    createdBy: operator.actorKey,
    createdByJson: operatorAuditSnapshot(operator),
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        intent,
        reason: result.reason,
        message: createPayoutRunErrorMessage(result),
      },
      { status: 400 },
    );
  }

  return redirect(`/app/payout-runs/${result.payoutRun.id}`);
};

export default function AdminPayoutRunsPage() {
  const { sellers, payoutRuns, repairCandidates } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const currentIntent = String(navigation.formData?.get("intent") || "");
  const isCreating =
    currentIntent !== "repair_negative_balance" &&
    navigation.formData?.has("sellerId") &&
    navigation.state !== "idle";
  const repairingSellerId =
    currentIntent === "repair_negative_balance" && navigation.state !== "idle"
      ? String(navigation.formData?.get("sellerId") || "")
      : "";
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
          white-space:nowrap;
        }
        .payout-admin__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .payout-admin__button--secondary{
          border-color:#d1d5db;
          background:#fff;
          color:#111827;
        }
        .payout-admin__notice{
          margin:0 0 16px;
          padding:12px 14px;
          border-radius:10px;
          background:#eff6ff;
          color:#1d4ed8;
          font-weight:700;
        }
        .payout-admin__notice--error{
          background:#fef2f2;
          color:#b91c1c;
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
        .payout-admin__balance-amount--negative{
          color:#b91c1c;
        }
        .payout-admin__balance-status{
          margin:0;
          color:#6b7280;
          font-size:13px;
        }
        .payout-admin__repair-list{
          display:grid;
          gap:12px;
        }
        .payout-admin__repair-row{
          display:grid;
          grid-template-columns:1.3fr 1fr 1fr auto;
          gap:12px;
          align-items:center;
          border:1px solid #fee2e2;
          background:#fff7f7;
          border-radius:12px;
          padding:14px;
        }
        .payout-admin__repair-name{
          margin:0;
          color:#111827;
          font-weight:800;
        }
        .payout-admin__repair-meta{
          margin:4px 0 0;
          color:#6b7280;
          font-size:13px;
          word-break:break-all;
        }
        .payout-admin__test-badge{
          display:inline-flex;
          align-items:center;
          min-height:22px;
          padding:0 8px;
          border-radius:999px;
          border:1px solid #fbbf24;
          background:#fffbeb;
          color:#92400e;
          font-size:12px;
          font-weight:800;
          vertical-align:middle;
        }
        @media (max-width: 900px){
          .payout-admin__form,
          .payout-admin__repair-row{
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
            <p
              className={`payout-admin__notice ${
                actionData.ok ? "" : "payout-admin__notice--error"
              }`}
            >
              {actionData.message}
            </p>
          ) : null}

          <Form method="post" className="payout-admin__form">
            <input type="hidden" name="intent" value="create_payout" />
            <div className="payout-admin__field">
              <label htmlFor="sellerId">出店者</label>
              <select
                id="sellerId"
                name="sellerId"
                className="payout-admin__select"
                required
              >
                <option value="">出店者を選択</option>
                {sellers.map((seller) => (
                  <option key={seller.sellerId} value={seller.sellerId}>
                    {seller.isTestStore ? "[テスト] " : ""}
                    {seller.vendorStoreName} / 台帳残高{" "}
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
              <button
                type="submit"
                className="payout-admin__button"
                disabled={isCreating}
              >
                {isCreating ? "作成中..." : "出金予定を作成"}
              </button>
            </div>
          </Form>

          {sellers.length > 0 ? (
            <div className="payout-admin__balance-grid">
              {sellers.map((seller) => (
                <div
                  className="payout-admin__balance-card"
                  key={seller.sellerId}
                >
                  <p className="payout-admin__balance-label">
                    {seller.vendorStoreName}
                    {seller.isTestStore ? (
                      <>
                        {" "}
                        <span className="payout-admin__test-badge">テスト</span>
                      </>
                    ) : null}
                  </p>
                  <p
                    className={`payout-admin__balance-amount ${
                      seller.payoutableLedgerBalance < 0
                        ? "payout-admin__balance-amount--negative"
                        : ""
                    }`}
                  >
                    {formatMoney(
                      seller.payoutableLedgerBalance,
                      seller.payoutableLedgerCurrencyCode,
                    )}
                  </p>
                  <p className="payout-admin__balance-status">
                    状態: {seller.sellerStatusLabel || seller.sellerStatus || "-"}
                  </p>
                  <p className="payout-admin__balance-status">
                    初回精算確認:{" "}
                    {seller.payoutVerification?.complete
                      ? "通過"
                      : seller.sellerVerificationStatusLabel || "未確認"}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="payout-admin__card">
          <h2 className="payout-admin__title">台帳補正</h2>
          <p className="payout-admin__subtitle">
            注文単位の過剰な返金・取消、またはマイナス残高に補正台帳を追加します。既存の売上・返金履歴は削除しません。
          </p>
          {repairCandidates.length === 0 ? (
            <p style={{ margin: 0, color: "#6b7280" }}>
              補正が必要な台帳不整合はありません。
            </p>
          ) : (
            <div className="payout-admin__repair-list">
              {repairCandidates.map((candidate) => (
                <div
                  className="payout-admin__repair-row"
                  key={candidate.sellerId}
                >
                  <div>
                    <p className="payout-admin__repair-name">
                      {candidate.vendorStoreName}
                      {candidate.isTestStore ? (
                        <>
                          {" "}
                          <span className="payout-admin__test-badge">テスト</span>
                        </>
                      ) : null}
                    </p>
                    <p className="payout-admin__repair-meta">
                      理由: {repairReasonLabel(candidate.reason)}
                    </p>
                    {candidate.shopifyOrderName || candidate.shopifyOrderId ? (
                      <p className="payout-admin__repair-meta">
                        注文: {candidate.shopifyOrderName || candidate.shopifyOrderId}
                      </p>
                    ) : null}
                    {candidate.paidAmount != null ||
                    candidate.reversedAmount != null ? (
                      <p className="payout-admin__repair-meta">
                        売上 {formatMoney(candidate.paidAmount, candidate.currencyCode)}
                        {" / "}
                        返金・取消{" "}
                        {formatMoney(
                          candidate.reversedAmount,
                          candidate.currencyCode,
                        )}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <p className="payout-admin__balance-label">
                      {candidate.payoutableLedgerBalance == null
                        ? "過剰マイナス"
                        : "現在の残高"}
                    </p>
                    <p className="payout-admin__balance-amount payout-admin__balance-amount--negative">
                      {formatMoney(
                        candidate.payoutableLedgerBalance == null
                          ? -candidate.repairAmount
                          : candidate.payoutableLedgerBalance,
                        candidate.currencyCode,
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="payout-admin__balance-label">追加する補正</p>
                    <p className="payout-admin__balance-amount">
                      {formatMoney(candidate.repairAmount, candidate.currencyCode)}
                    </p>
                  </div>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="repair_negative_balance"
                    />
                    <input
                      type="hidden"
                      name="sellerId"
                      value={candidate.sellerId}
                    />
                    <input
                      type="hidden"
                      name="currencyCode"
                      value={candidate.currencyCode}
                    />
                    <input
                      type="hidden"
                      name="repairScope"
                      value={candidate.repairScope || ""}
                    />
                    <input
                      type="hidden"
                      name="repairReason"
                      value={candidate.reason || ""}
                    />
                    <input
                      type="hidden"
                      name="shopifyOrderId"
                      value={candidate.shopifyOrderId || ""}
                    />
                    <input
                      type="hidden"
                      name="confirm"
                      value="repair_negative_balance"
                    />
                    <button
                      type="submit"
                      className="payout-admin__button"
                      disabled={repairingSellerId === candidate.sellerId}
                    >
                      {repairingSellerId === candidate.sellerId
                        ? "補正中..."
                        : "補正する"}
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          )}
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
                    <th style={thStyle}>送金方法</th>
                    <th style={thStyle}>状態</th>
                    <th style={thStyle}>送金ID</th>
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
                      <td style={tdStyle}>
                        {formatMoney(run.amount, run.currencyCode)}
                      </td>
                      <td style={tdStyle}>{run.transferMethodLabel || "-"}</td>
                      <td style={tdStyle}>{run.statusLabel}</td>
                      <td style={tdStyle}>
                        {run.wiseTransferId ||
                          run.externalTransferId ||
                          run.stripePayoutId ||
                          "-"}
                      </td>
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
    case "insufficient_governed_balance":
      return `留保額または未精算の直接請求を差し引くと、出金可能残高が不足します。出金可能: ${formatMoney(
        result.governedAvailableAmount,
        result.currencyCode,
      )} / 作成額: ${formatMoney(result.requestedAmount, result.currencyCode)}`;
    case "seller_payout_hold":
      return "管理者判断により、この店舗の出金を保留しています。";
    case "seller_governance_required":
      return "事業者情報、契約、返品先などの出金前確認が完了していません。";
    case "invalid_amount":
      return "出金額が不正です。1以上の整数で入力してください。";
    case "seller_not_active":
      return "出店者の決済状態が有効ではないため、出金予定を作成できません。";
    case "seller_payout_restricted":
      return "この出店者は制限中または禁止中のため、出金対象外です。";
    case "seller_not_found":
      return "出店者が見つかりません。";
    case "test_store_payout_disabled":
      return "テスト店舗のため、出金予定は作成できません。本番店舗に切り替えてから作成してください。";
    case "wise_recipient_missing":
      return "Wise受取先が未登録または有効ではないため、出金予定を作成できません。";
    case "seller_verification_required":
      return `初回精算前確認が完了していないため、出金予定を作成できません。未完了: ${
        result.verification?.missing?.join(", ") || "-"
      }`;
    default:
      return "出金予定の作成に失敗しました。";
  }
}

function repairLedgerErrorMessage(result) {
  switch (result.reason) {
    case "seller_not_found":
      return "出店者が見つかりません。";
    case "shopify_order_id_missing":
      return "補正対象の注文IDが見つかりません。";
    default:
      return "台帳補正に失敗しました。";
  }
}

function repairReasonLabel(reason) {
  switch (reason) {
    case "shopify_order_reversal_overage":
      return "注文単位で返金・取消が売上を超えています";
    case "negative_payoutable_ledger_balance":
      return "出店者の出金可能残高がマイナスです";
    default:
      return reason || "台帳不整合";
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
