import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { listAdminSellerRows, listPayoutRuns } = await import(
    "../services/sellerPayments.server.js"
  );

  const sellers = await listAdminSellerRows();
  const payoutRuns = await listPayoutRuns();

  return json({
    sellers: sellers.filter((seller) => seller.sellerId),
    payoutRuns,
  });
};

export default function AdminPayoutRunsPage() {
  const { sellers, payoutRuns } = useLoaderData();
  const navigation = useNavigation();
  const isCreating =
    navigation.formAction?.endsWith("/internal/payout-runs") &&
    navigation.state !== "idle";

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
      `}</style>

      <div className="payout-admin__page">
        <section className="payout-admin__card">
          <h1 className="payout-admin__title">Payout Runs</h1>
          <p className="payout-admin__subtitle">
            Sellers stay on manual payout. A payout is only sent when an approved run is
            explicitly executed by an admin.
          </p>

          <Form method="post" action="/internal/payout-runs" className="payout-admin__form">
            <div className="payout-admin__field">
              <label htmlFor="sellerId">Seller</label>
              <select id="sellerId" name="sellerId" className="payout-admin__select" required>
                <option value="">Select a seller</option>
                {sellers.map((seller) => (
                  <option key={seller.sellerId} value={seller.sellerId}>
                    {seller.vendorStoreName} ({seller.sellerStatus || "unknown"})
                  </option>
                ))}
              </select>
            </div>
            <div className="payout-admin__field">
              <label htmlFor="amount">Amount</label>
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
              <label htmlFor="currencyCode">Currency</label>
              <input
                id="currencyCode"
                name="currencyCode"
                className="payout-admin__input"
                defaultValue="jpy"
                required
              />
            </div>
            <div className="payout-admin__field" style={{ alignSelf: "end" }}>
              <button type="submit" className="payout-admin__button" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create payout run"}
              </button>
            </div>
          </Form>
        </section>

        <section className="payout-admin__card">
          {payoutRuns.length === 0 ? (
            <p style={{ margin: 0 }}>No payout runs yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Run</th>
                    <th style={thStyle}>Seller</th>
                    <th style={thStyle}>Amount</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Stripe payout</th>
                    <th style={thStyle}>Updated</th>
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
                        {run.amount} {run.currencyCode.toUpperCase()}
                      </td>
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
