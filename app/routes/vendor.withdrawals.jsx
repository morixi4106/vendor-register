import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import {
  appendVendorIdToPath,
  useVendorIdFromMatches,
} from "../components/vendor/vendorNavigation";

export const loader = async ({ request }) => {
  const {
    getVendorPublicContext,
    listVendorWithdrawalRequests,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const withdrawalRequests = await listVendorWithdrawalRequests({
    storeId: store.id,
    first: 100,
  });

  return json({
    ...getVendorPublicContext(vendor, store),
    withdrawalRequests,
    summary: {
      totalCount: withdrawalRequests.length,
      openCount: withdrawalRequests.filter(
        (item) =>
          !["REFUNDED", "CANCELLED", "REJECTED", "EXPIRED", "COMPLETED"].includes(
            item.status,
          ),
      ).length,
      actionCount: withdrawalRequests.filter((item) => item.needsVendorAction)
        .length,
    },
  });
};

export default function VendorWithdrawalsPage() {
  const { store, withdrawalRequests, summary } = useLoaderData();
  const vendorId = useVendorIdFromMatches();

  return (
    <VendorManagementShell
      activeItem="withdrawals"
      storeName={store.storeName}
      title="撤回・返品対応"
    >
      <style>{pageStyles}</style>

      <section className="vendor-card">
        <h2 className="vendor-section-title">撤回申請</h2>
        <p className="vendor-section-subtitle">
          この店舗が販売した商品の返送状況を確認します。複数店舗の注文でも、この画面には自店舗への返送分だけが表示されます。
        </p>
        <div className="withdrawal-summary">
          <SummaryItem label="対応中" value={summary.openCount} />
          <SummaryItem label="店舗の確認待ち" value={summary.actionCount} />
          <SummaryItem label="合計" value={summary.totalCount} />
        </div>
      </section>

      <section className="vendor-card">
        {withdrawalRequests.length === 0 ? (
          <div className="vendor-placeholder">
            現在、この店舗に関係する撤回申請はありません。
          </div>
        ) : (
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>受付日</th>
                  <th>注文</th>
                  <th>対象</th>
                  <th>状況</th>
                  <th>返送</th>
                  <th>次の対応</th>
                  <th aria-label="詳細" />
                </tr>
              </thead>
              <tbody>
                {withdrawalRequests.map((item) => (
                  <tr key={`${item.id}:${item.returnGroupId || "v1"}`}>
                    <td>{item.createdAtLabel}</td>
                    <td className="vendor-table__name">
                      {item.shopifyOrderName}
                      <span className="vendor-table__meta">{item.customerName}</span>
                    </td>
                    <td>{item.withdrawalScopeLabel}</td>
                    <td>
                      <span
                        className={`vendor-shell__badge vendor-shell__badge--${item.statusTone}`}
                      >
                        {item.statusLabel}
                      </span>
                    </td>
                    <td>{formatReturnLabel(item)}</td>
                    <td>
                      <strong>{item.vendorActionLabel}</strong>
                    </td>
                    <td>
                      <Link
                        className="vendor-shell__button"
                        to={appendVendorIdToPath(
                          `/vendor/withdrawals/${item.id}`,
                          vendorId,
                        )}
                      >
                        開く
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </VendorManagementShell>
  );
}

function SummaryItem({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}件</strong>
    </div>
  );
}

function formatReturnLabel(item) {
  if (item.returnTrackingNumber) {
    return `${item.returnTrackingCompany || "追跡"}: ${item.returnTrackingNumber}`;
  }
  if (item.returnReceivedAt) return `到着 ${item.returnReceivedAtLabel}`;
  return item.workflowVersion === 2 ? item.statusLabel : "未確認";
}

const pageStyles = `
  .withdrawal-summary{
    display:grid;
    grid-template-columns:repeat(3, minmax(0, 1fr));
    gap:12px;
    margin-top:18px;
  }
  .withdrawal-summary > div{
    border:1px solid #e5e7eb;
    border-radius:8px;
    padding:14px;
    background:#f9fafb;
  }
  .withdrawal-summary span{
    display:block;
    color:#6b7280;
    font-size:13px;
  }
  .withdrawal-summary strong{
    display:block;
    margin-top:6px;
    font-size:24px;
  }
  @media (max-width:760px){
    .withdrawal-summary{grid-template-columns:1fr;}
  }
`;
