import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { authenticate } from "../shopify.server";

const SELLER_STATUSES = [
  "pending",
  "active",
  "review",
  "restricted",
  "banned",
];

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const { getAdminSellerDetail } = await import("../services/sellerPayments.server.js");

  const detail = await getAdminSellerDetail(params.id);

  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }

  return json(detail);
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);
  const { updateSellerStatus } = await import("../services/sellerPayments.server.js");

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "update_status") {
    return json(
      {
        ok: false,
        message: "Invalid request.",
      },
      { status: 400 },
    );
  }

  const status = String(formData.get("status") || "");
  const reason = String(formData.get("reason") || "");
  const result = await updateSellerStatus({
    sellerId: params.id,
    nextStatus: status,
    changedBy: "admin",
    reason,
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        message: "Failed to update seller status.",
      },
      { status: 400 },
    );
  }

  return json({
    ok: true,
    message: result.changed ? "Seller status updated." : "Seller status unchanged.",
  });
};

function badgeClassName(status) {
  switch (status) {
    case "active":
      return "seller-detail__badge seller-detail__badge--success";
    case "restricted":
    case "banned":
      return "seller-detail__badge seller-detail__badge--danger";
    case "pending":
    case "review":
      return "seller-detail__badge seller-detail__badge--warning";
    default:
      return "seller-detail__badge";
  }
}

export default function AdminSellerDetailPage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isStatusSubmitting =
    navigation.formData?.get("intent") === "update_status";
  const isStripeCreating =
    navigation.formAction?.endsWith(`/internal/sellers/${data.seller.id}/stripe-account`) &&
    navigation.state !== "idle";

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .seller-detail__page{
          display:grid;
          gap:24px;
        }
        .seller-detail__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
        }
        .seller-detail__title{
          margin:0 0 8px;
          font-size:24px;
          font-weight:700;
          color:#111827;
        }
        .seller-detail__subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .seller-detail__badge{
          display:inline-flex;
          align-items:center;
          padding:5px 10px;
          border-radius:999px;
          background:#f3f4f6;
          color:#374151;
          border:1px solid #d1d5db;
          font-size:12px;
          font-weight:700;
        }
        .seller-detail__badge--success{
          background:#ecfdf5;
          color:#047857;
          border-color:#a7f3d0;
        }
        .seller-detail__badge--warning{
          background:#fffbeb;
          color:#92400e;
          border-color:#fde68a;
        }
        .seller-detail__badge--danger{
          background:#fef2f2;
          color:#b91c1c;
          border-color:#fecaca;
        }
        .seller-detail__grid{
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:24px;
        }
        .seller-detail__description{
          display:grid;
          gap:12px;
        }
        .seller-detail__row{
          display:grid;
          grid-template-columns:180px minmax(0, 1fr);
          gap:12px;
          padding-bottom:12px;
          border-bottom:1px solid #f1f5f9;
        }
        .seller-detail__term{
          font-size:13px;
          font-weight:700;
          color:#6b7280;
        }
        .seller-detail__value{
          font-size:14px;
          line-height:1.7;
          word-break:break-word;
        }
        .seller-detail__button{
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
        .seller-detail__button--secondary{
          background:#fff;
          color:#111827;
          border-color:#d1d5db;
        }
        .seller-detail__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .seller-detail__form{
          display:grid;
          gap:12px;
        }
        .seller-detail__field{
          display:grid;
          gap:8px;
        }
        .seller-detail__input,
        .seller-detail__select{
          min-height:44px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:0 12px;
          font-size:14px;
          box-sizing:border-box;
        }
        .seller-detail__notice{
          border:1px solid #d1d5db;
          background:#f9fafb;
          color:#374151;
          border-radius:12px;
          padding:12px 14px;
          font-size:14px;
        }
      `}</style>

      <div className="seller-detail__page">
        <section className="seller-detail__card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <h1 className="seller-detail__title">{data.vendor.storeName}</h1>
              <p className="seller-detail__subtitle">
                Seller detail, Stripe account state, manual payout history, and recent
                webhook / ledger entries.
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <Link className="seller-detail__button seller-detail__button--secondary" to="/app/sellers">
                Back
              </Link>
              <a
                className="seller-detail__button seller-detail__button--secondary"
                href="/seller/settings/payments"
                target="_blank"
                rel="noreferrer"
              >
                Seller payments page
              </a>
            </div>
          </div>
          {actionData?.message ? (
            <div className="seller-detail__notice">{actionData.message}</div>
          ) : null}
        </section>

        <div className="seller-detail__grid">
          <section className="seller-detail__card">
            <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Seller</h2>
            <div className="seller-detail__description">
              <div className="seller-detail__row">
                <div className="seller-detail__term">Seller ID</div>
                <div className="seller-detail__value">{data.seller.id}</div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Status</div>
                <div className="seller-detail__value">
                  <span className={badgeClassName(data.seller.status)}>
                    {data.seller.statusLabel}
                  </span>
                </div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Vendor handle</div>
                <div className="seller-detail__value">{data.vendor.handle}</div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Management email</div>
                <div className="seller-detail__value">{data.vendor.managementEmail}</div>
              </div>
            </div>
          </section>

          <section className="seller-detail__card">
            <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Stripe account</h2>
            <div className="seller-detail__description">
              <div className="seller-detail__row">
                <div className="seller-detail__term">Connected account</div>
                <div className="seller-detail__value">
                  {data.stripeAccount?.stripeAccountId || "Not created"}
                </div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Details submitted</div>
                <div className="seller-detail__value">
                  {data.stripeAccount ? String(data.stripeAccount.detailsSubmitted) : "-"}
                </div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Charges enabled</div>
                <div className="seller-detail__value">
                  {data.stripeAccount ? String(data.stripeAccount.chargesEnabled) : "-"}
                </div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Payouts enabled</div>
                <div className="seller-detail__value">
                  {data.stripeAccount ? String(data.stripeAccount.payoutsEnabled) : "-"}
                </div>
              </div>
              <div className="seller-detail__row">
                <div className="seller-detail__term">Payout schedule</div>
                <div className="seller-detail__value">
                  {data.stripeAccount?.payoutSchedule || "-"}
                </div>
              </div>
            </div>
            {!data.stripeAccount ? (
              <Form method="post" action={`/internal/sellers/${data.seller.id}/stripe-account`}>
                <button
                  type="submit"
                  className="seller-detail__button"
                  disabled={isStripeCreating}
                >
                  {isStripeCreating ? "Creating..." : "Create connected account"}
                </button>
              </Form>
            ) : null}
          </section>
        </div>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Status change</h2>
          <Form method="post" className="seller-detail__form">
            <input type="hidden" name="intent" value="update_status" />
            <div className="seller-detail__field">
              <label htmlFor="status">Status</label>
              <select
                id="status"
                name="status"
                className="seller-detail__select"
                defaultValue={data.seller.status}
              >
                {SELLER_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="seller-detail__field">
              <label htmlFor="reason">Reason</label>
              <input
                id="reason"
                name="reason"
                className="seller-detail__input"
                defaultValue={data.seller.statusReason || ""}
                placeholder="Optional reason for status change"
              />
            </div>
            <div>
              <button
                type="submit"
                className="seller-detail__button"
                disabled={Boolean(isStatusSubmitting)}
              >
                {isStatusSubmitting ? "Updating..." : "Update status"}
              </button>
            </div>
          </Form>
        </section>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Status history</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>At</th>
                  <th style={thStyle}>From</th>
                  <th style={thStyle}>To</th>
                  <th style={thStyle}>Changed by</th>
                  <th style={thStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.statusHistory.map((item) => (
                  <tr key={item.id}>
                    <td style={tdStyle}>{new Date(item.createdAt).toLocaleString("ja-JP")}</td>
                    <td style={tdStyle}>{item.fromStatus || "-"}</td>
                    <td style={tdStyle}>{item.toStatus}</td>
                    <td style={tdStyle}>{item.changedBy || "-"}</td>
                    <td style={tdStyle}>{item.reason || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Recent orders</h2>
          <SimpleTable
            headers={["Order", "Status", "Amount", "PaymentIntent", "Charge"]}
            rows={data.orders.map((order) => [
              order.id,
              order.status,
              `${order.totalAmount} ${order.currencyCode.toUpperCase()}`,
              order.stripePaymentIntentId || "-",
              order.stripeChargeId || "-",
            ])}
          />
        </section>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Recent payout runs</h2>
          <SimpleTable
            headers={["Run", "Status", "Amount", "Stripe payout", "Updated"]}
            rows={data.payoutRuns.map((run) => [
              run.id,
              run.statusLabel,
              `${run.amount} ${run.currencyCode.toUpperCase()}`,
              run.stripePayoutId || "-",
              new Date(run.updatedAt).toLocaleString("ja-JP"),
            ])}
          />
        </section>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Recent ledger entries</h2>
          <SimpleTable
            headers={["When", "Type", "Amount", "Direction", "Object"]}
            rows={data.ledgerEntries.map((entry) => [
              new Date(entry.occurredAt).toLocaleString("ja-JP"),
              entry.entryType,
              `${entry.amount} ${entry.currencyCode.toUpperCase()}`,
              entry.direction,
              entry.stripeObjectId || "-",
            ])}
          />
        </section>

        <section className="seller-detail__card">
          <h2 className="seller-detail__title" style={{ fontSize: "18px" }}>Recent Stripe events</h2>
          <SimpleTable
            headers={["When", "Type", "Account", "Status"]}
            rows={data.stripeEvents.map((event) => [
              new Date(event.createdAt).toLocaleString("ja-JP"),
              event.type,
              event.stripeAccountId || "-",
              event.processingStatus,
            ])}
          />
        </section>
      </div>
    </div>
  );
}

function SimpleTable({ headers, rows }) {
  if (!rows.length) {
    return <p style={{ margin: 0 }}>No records yet.</p>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} style={thStyle}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${index}:${row[0]}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${index}:${cellIndex}`} style={tdStyle}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
