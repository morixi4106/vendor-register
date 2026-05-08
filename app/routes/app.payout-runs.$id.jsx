import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const { getPayoutRunDetail } = await import("../services/sellerPayments.server.js");

  const payoutRun = await getPayoutRunDetail(params.id);

  if (!payoutRun) {
    throw new Response("見つかりません", { status: 404 });
  }

  return json({ payoutRun });
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);
  const { approvePayoutRun, executePayoutRun } = await import(
    "../services/sellerPayments.server.js"
  );

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const result =
    intent === "approve"
      ? await approvePayoutRun({ payoutRunId: params.id, approvedBy: "admin" })
      : intent === "execute"
        ? await executePayoutRun({ payoutRunId: params.id, executedBy: "admin" })
        : {
            ok: false,
            reason: "invalid_intent",
          };

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: "出金予定の更新に失敗しました。",
      },
      { status: 400 },
    );
  }

  return json({
    ok: true,
    message: intent === "approve" ? "出金予定を承認しました。" : "出金を実行しました。",
  });
};

export default function AdminPayoutRunDetailPage() {
  const { payoutRun } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isApproving =
    navigation.formData?.get("intent") === "approve" &&
    navigation.state !== "idle";
  const isExecuting =
    navigation.formData?.get("intent") === "execute" &&
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
      `}</style>

      <div className="payout-detail__page">
        <section className="payout-detail__card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h1 className="payout-detail__title">{payoutRun.id}</h1>
              <p className="payout-detail__subtitle">
                {payoutRun.sellerStoreName} / {payoutRun.amount}{" "}
                {payoutRun.currencyCode.toUpperCase()} / {payoutRun.statusLabel}
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
              {payoutRun.status === "approved" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="execute" />
                  <button type="submit" className="payout-detail__button" disabled={isExecuting}>
                    {isExecuting ? "実行中..." : "出金を実行"}
                  </button>
                </Form>
              ) : null}
            </div>
          </div>
          {actionData?.message ? (
            <div style={{ marginTop: "16px", color: actionData.ok ? "#047857" : "#b91c1c" }}>
              {actionData.message}
            </div>
          ) : null}
        </section>

        <section className="payout-detail__card">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <Row label="出店者" value={payoutRun.sellerStoreName} />
                <Row label="状態" value={payoutRun.statusLabel} />
                <Row label="金額" value={`${payoutRun.amount} ${payoutRun.currencyCode.toUpperCase()}`} />
                <Row label="Stripe連携アカウント" value={payoutRun.stripeAccountId} />
                <Row label="Stripe出金ID" value={payoutRun.stripePayoutId || "-"} />
                <Row label="失敗コード" value={payoutRun.failureCode || "-"} />
                <Row label="失敗理由" value={payoutRun.failureMessage || "-"} />
                <Row label="承認日時" value={payoutRun.approvedAt ? new Date(payoutRun.approvedAt).toLocaleString("ja-JP") : "-"} />
                <Row label="実行日時" value={payoutRun.executedAt ? new Date(payoutRun.executedAt).toLocaleString("ja-JP") : "-"} />
                <Row label="更新日時" value={new Date(payoutRun.updatedAt).toLocaleString("ja-JP")} />
              </tbody>
            </table>
          </div>
        </section>

        <section className="payout-detail__card">
          <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>売上台帳</h2>
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
                      <td style={tdStyle}>{new Date(entry.occurredAt).toLocaleString("ja-JP")}</td>
                      <td style={tdStyle}>{entry.entryType}</td>
                      <td style={tdStyle}>{entry.amount} {entry.currencyCode.toUpperCase()}</td>
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
