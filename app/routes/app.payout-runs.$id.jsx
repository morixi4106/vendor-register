import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const { getPayoutRunDetail } = await import("../services/sellerPayments.server.js");

  const payoutRun = await getPayoutRunDetail(params.id);

  if (!payoutRun) {
    throw new Response("出金予定が見つかりません。", { status: 404 });
  }

  return json({ payoutRun });
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);
  const { approvePayoutRun, markPayoutRunManuallyPaid } = await import(
    "../services/sellerPayments.server.js"
  );

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const result =
    intent === "approve"
      ? await approvePayoutRun({ payoutRunId: params.id, approvedBy: "admin" })
      : intent === "markPaid"
        ? await markPayoutRunManuallyPaid({
            payoutRunId: params.id,
            executedBy: "admin",
            externalTransferId: formData.get("externalTransferId"),
            transferMemo: formData.get("transferMemo"),
          })
        : {
            ok: false,
            reason: "invalid_intent",
          };

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: createPayoutRunErrorMessage(result.reason),
      },
      { status: 400 },
    );
  }

  return json({
    ok: true,
    message:
      intent === "approve"
        ? "出金予定を承認しました。"
        : "手動送金済みとして記録しました。",
  });
};

export default function AdminPayoutRunDetailPage() {
  const { payoutRun } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isApproving =
    navigation.formData?.get("intent") === "approve" &&
    navigation.state !== "idle";
  const isMarkingPaid =
    navigation.formData?.get("intent") === "markPaid" &&
    navigation.state !== "idle";

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .payout-detail__page{
          display:grid;
          gap:24px;
        }
        .payout-detail__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
        }
        .payout-detail__title{
          margin:0 0 8px;
          font-size:24px;
          font-weight:700;
          color:#111827;
        }
        .payout-detail__subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .payout-detail__button{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:42px;
          padding:0 16px;
          border-radius:999px;
          border:1px solid #111827;
          background:#111827;
          color:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
          text-decoration:none;
        }
        .payout-detail__button--secondary{
          border-color:#d1d5db;
          background:#fff;
          color:#111827;
        }
        .payout-detail__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .payout-detail__form{
          display:grid;
          gap:12px;
          max-width:720px;
        }
        .payout-detail__input{
          min-height:44px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:0 12px;
          font-size:14px;
          box-sizing:border-box;
        }
        .payout-detail__textarea{
          min-height:96px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:12px;
          font-size:14px;
          box-sizing:border-box;
          resize:vertical;
        }
        .payout-detail__notice{
          margin:16px 0 0;
          color:#047857;
          font-weight:700;
        }
        .payout-detail__error{
          margin:16px 0 0;
          color:#b91c1c;
          font-weight:700;
        }
      `}</style>

      <div className="payout-detail__page">
        <section className="payout-detail__card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h1 className="payout-detail__title">{payoutRun.id}</h1>
              <p className="payout-detail__subtitle">
                {payoutRun.sellerStoreName} / {formatMoney(payoutRun.amount, payoutRun.currencyCode)} /{" "}
                {payoutRun.statusLabel}
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <Link className="payout-detail__button payout-detail__button--secondary" to="/app/payout-runs">
                一覧へ戻る
              </Link>
              {payoutRun.status === "draft" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="approve" />
                  <button type="submit" className="payout-detail__button" disabled={isApproving}>
                    {isApproving ? "承認中..." : "承認する"}
                  </button>
                </Form>
              ) : null}
            </div>
          </div>
          {actionData?.message ? (
            <p className={actionData.ok ? "payout-detail__notice" : "payout-detail__error"}>
              {actionData.message}
            </p>
          ) : null}
        </section>

        {payoutRun.status === "approved" ? (
          <section className="payout-detail__card">
            <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
              手動送金の記録
            </h2>
            <p className="payout-detail__subtitle">
              銀行振込やWiseなどで実際の送金を完了してから、この出金予定を送金済みにしてください。
              Stripe Connect payoutはこの本番導線では実行しません。
            </p>
            <Form method="post" className="payout-detail__form">
              <input type="hidden" name="intent" value="markPaid" />
              <label>
                送金ID / 振込受付番号
                <input
                  className="payout-detail__input"
                  name="externalTransferId"
                  placeholder="例: bank_20260516_001"
                />
              </label>
              <label>
                メモ
                <textarea
                  className="payout-detail__textarea"
                  name="transferMemo"
                  placeholder="例: 2026年5月分の手動振込"
                />
              </label>
              <button type="submit" className="payout-detail__button" disabled={isMarkingPaid}>
                {isMarkingPaid ? "記録中..." : "手動送金済みにする"}
              </button>
            </Form>
          </section>
        ) : null}

        <section className="payout-detail__card">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <Row label="出店者" value={payoutRun.sellerStoreName} />
                <Row label="状態" value={payoutRun.statusLabel} />
                <Row label="金額" value={formatMoney(payoutRun.amount, payoutRun.currencyCode)} />
                <Row label="送金方法" value={payoutRun.transferMethodLabel} />
                <Row label="外部送金ID" value={payoutRun.externalTransferId || "-"} />
                <Row label="送金メモ" value={payoutRun.transferMemo || "-"} />
                <Row label="Stripe連携アカウント" value={payoutRun.stripeAccountId} />
                <Row label="Stripe出金ID" value={payoutRun.stripePayoutId || "-"} />
                <Row label="失敗コード" value={payoutRun.failureCode || "-"} />
                <Row label="失敗理由" value={payoutRun.failureMessage || "-"} />
                <Row label="承認日時" value={formatDateTime(payoutRun.approvedAt)} />
                <Row label="送金記録日時" value={formatDateTime(payoutRun.executedAt)} />
                <Row label="更新日時" value={formatDateTime(payoutRun.updatedAt)} />
              </tbody>
            </table>
          </div>
        </section>

        <section className="payout-detail__card">
          <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
            売上台帳
          </h2>
          {payoutRun.ledgerEntries.length === 0 ? (
            <p style={{ margin: 0 }}>台帳記録はまだありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>日時</th>
                    <th style={thStyle}>種別</th>
                    <th style={thStyle}>金額</th>
                    <th style={thStyle}>方向</th>
                    <th style={thStyle}>対象ID</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRun.ledgerEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td style={tdStyle}>{formatDateTime(entry.occurredAt)}</td>
                      <td style={tdStyle}>{entry.entryType}</td>
                      <td style={tdStyle}>{formatMoney(entry.amount, entry.currencyCode)}</td>
                      <td style={tdStyle}>{entry.direction}</td>
                      <td style={tdStyle}>{entry.stripeObjectId || "-"}</td>
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

function Row({ label, value }) {
  return (
    <tr>
      <th style={thStyle}>{label}</th>
      <td style={tdStyle}>{value}</td>
    </tr>
  );
}

function formatMoney(amount, currencyCode) {
  return `${amount} ${String(currencyCode || "jpy").toUpperCase()}`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("ja-JP") : "-";
}

function createPayoutRunErrorMessage(reason) {
  switch (reason) {
    case "payout_run_not_found":
      return "出金予定が見つかりません。";
    case "payout_run_not_approvable":
      return "この出金予定は承認できない状態です。";
    case "payout_run_not_executable":
      return "この出金予定は送金済みにできない状態です。";
    case "seller_payout_restricted":
      return "この出店者は制限中または禁止中のため、出金対象外です。";
    default:
      return "出金予定の更新に失敗しました。";
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
