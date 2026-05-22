import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const { requireVendorContext } =
    await import("../services/vendorManagement.server.js");
  const { getSellerPaymentsPageData } =
    await import("../services/sellerPayments.server.js");
  const { vendor } = await requireVendorContext(request);
  const pageData = await getSellerPaymentsPageData({ vendorId: vendor.id });

  return json(pageData);
};

export default function SellerPaymentsSettingsPage() {
  const data = useLoaderData();
  const payoutRecipient = data.payoutRecipient;
  const payoutProviderLabel =
    data.payoutProvider === "wise" ? "Wise API送金" : "月次手動精算";

  return (
    <VendorManagementShell
      activeItem="payments"
      storeName={data.store.storeName}
      title="精算設定"
    >
      <style>{`
        .seller-payments__grid{
          display:grid;
          gap:24px;
        }
        .seller-payments__card{
          background:#ffffff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:20px;
        }
        .seller-payments__title{
          margin:0 0 8px;
          font-size:20px;
          font-weight:700;
        }
        .seller-payments__subtitle{
          margin:0 0 18px;
          font-size:13px;
          color:#6b7280;
          line-height:1.7;
        }
        .seller-payments__description{
          display:grid;
          gap:12px;
        }
        .seller-payments__row{
          display:grid;
          grid-template-columns:220px minmax(0, 1fr);
          gap:16px;
          padding-bottom:12px;
          border-bottom:1px solid #f1f5f9;
        }
        .seller-payments__term{
          font-size:13px;
          color:#6b7280;
          font-weight:700;
        }
        .seller-payments__value{
          font-size:14px;
          line-height:1.7;
          word-break:break-word;
        }
        .seller-payments__notice{
          border:1px solid #d1d5db;
          background:#f9fafb;
          color:#374151;
          border-radius:12px;
          padding:14px 16px;
          font-size:14px;
          line-height:1.7;
        }
      `}</style>

      <div className="seller-payments__grid">
        <section className="seller-payments__card">
          <h2 className="seller-payments__title">支払明細・精算方式</h2>
          <p className="seller-payments__subtitle">
            購入者の決済はストアのShopify
            Checkoutで処理されます。出店者への支払いは、管理者が月次精算額を確認してから実行します。
          </p>

          <div className="seller-payments__description">
            <Row
              label="精算状態"
              value={data.seller?.statusLabel || "未設定"}
            />
            <Row label="精算方式" value={payoutProviderLabel} />
            <Row label="支払タイミング" value="月次締め・管理者承認後" />
            <Row label="Stripe登録" value="不要" />
          </div>
        </section>

        <section className="seller-payments__card">
          <h2 className="seller-payments__title">受取先</h2>
          <p className="seller-payments__subtitle">
            受取先情報は管理者確認のうえ登録されます。Stripe
            Connectの登録フォームは現在の本番導線では使用しません。
          </p>

          {payoutRecipient ? (
            <div className="seller-payments__description">
              <Row
                label="方式"
                value={
                  payoutRecipient.provider === "wise"
                    ? "Wise"
                    : payoutRecipient.provider
                }
              />
              <Row label="状態" value={payoutRecipient.status} />
              <Row
                label="通貨"
                value={String(
                  payoutRecipient.currencyCode || "jpy",
                ).toUpperCase()}
              />
              <Row
                label="受取先ID"
                value={payoutRecipient.wiseRecipientId || "-"}
              />
              <Row
                label="口座名義"
                value={payoutRecipient.accountHolderName || "-"}
              />
              <Row label="概要" value={payoutRecipient.accountSummary || "-"} />
            </div>
          ) : (
            <div className="seller-payments__notice">
              受取先はまだ登録されていません。精算開始前に管理者が受取先を確認します。
            </div>
          )}
        </section>
      </div>
    </VendorManagementShell>
  );
}

function Row({ label, value }) {
  return (
    <div className="seller-payments__row">
      <div className="seller-payments__term">{label}</div>
      <div className="seller-payments__value">{value || "-"}</div>
    </div>
  );
}
