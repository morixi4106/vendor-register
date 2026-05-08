import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const { getPayoutRunDetail } = await import("../services/sellerPayments.server.js");

  const payoutRun = await getPayoutRunDetail(params.id);

  if (!payoutRun) {
    throw new Response("Not Found", { status: 404 });
  }

  return json({ payoutRun });
};

export default function AdminPayoutRunDetailPage() {
  const { payoutRun } = useLoaderData();
  const navigation = useNavigation();
  const isApproving =
    navigation.formAction?.endsWith(`/internal/payout-runs/${payoutRun.id}/approve`) &&
    navigation.state !== "idle";
  const isExecuting =
    navigation.formAction?.endsWith(`/internal/payout-runs/${payoutRun.id}/execute`) &&
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
                Back
              </Link>
              {payoutRun.status === "draft" ? (
                <Form method="post" action={`/internal/payout-runs/${payoutRun.id}/approve`}>
                  <button type="submit" className="payout-detail__button" disabled={isApproving}>
                    {isApproving ? "Approving..." : "Approve"}
                  </button>
                </Form>
              ) : null}
              {payoutRun.status === "approved" ? (
                <Form method="post" action={`/internal/payout-runs/${payoutRun.id}/execute`}>
                  <button type="submit" className="payout-detail__button" disabled={isExecuting}>
                    {isExecuting ? "Executing..." : "Execute"}
                  </button>
                </Form>
              ) : null}
            </div>
          </div>
        </section>

        <section className="payout-detail__card">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <Row label="Seller" value={payoutRun.sellerStoreName} />
                <Row label="Status" value={payoutRun.statusLabel} />
                <Row label="Amount" value={`${payoutRun.amount} ${payoutRun.currencyCode.toUpperCase()}`} />
                <Row label="Stripe account" value={payoutRun.stripeAccountId} />
                <Row label="Stripe payout" value={payoutRun.stripePayoutId || "-"} />
                <Row label="Failure code" value={payoutRun.failureCode || "-"} />
                <Row label="Failure message" value={payoutRun.failureMessage || "-"} />
                <Row label="Approved at" value={payoutRun.approvedAt ? new Date(payoutRun.approvedAt).toLocaleString("ja-JP") : "-"} />
                <Row label="Executed at" value={payoutRun.executedAt ? new Date(payoutRun.executedAt).toLocaleString("ja-JP") : "-"} />
                <Row label="Updated at" value={new Date(payoutRun.updatedAt).toLocaleString("ja-JP")} />
              </tbody>
            </table>
          </div>
        </section>

        <section className="payout-detail__card">
          <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>Ledger entries</h2>
          {payoutRun.ledgerEntries.length === 0 ? (
            <p style={{ margin: 0 }}>No ledger entries yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>When</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Amount</th>
                    <th style={thStyle}>Direction</th>
                    <th style={thStyle}>Object</th>
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
