import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function badgeClass(label) {
  const dangerLabels = ["要確認", "差し戻し", "停止中", "制限あり"];
  const warningLabels = ["申請中", "審査中", "公開準備中", "確認中"];
  const successLabels = ["承認済み", "稼働中", "Shopify連携済み"];
  let tone = "neutral";

  if (dangerLabels.includes(label)) tone = "danger";
  if (warningLabels.includes(label)) tone = "warning";
  if (successLabels.includes(label)) tone = "success";

  return `vendor-shell__badge vendor-shell__badge--${tone}`;
}

function normalizeMonth(value) {
  const normalizedValue = String(value || "").trim();
  const match = MONTH_PATTERN.exec(normalizedValue);

  if (!match) {
    return null;
  }

  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    return null;
  }

  return normalizedValue;
}

function currentMonthValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatMonthLabel(value) {
  const normalizedValue = normalizeMonth(value);
  if (!normalizedValue) return "未指定";

  const [year, month] = normalizedValue.split("-");
  return `${year}年${month}月`;
}

function emptyReport() {
  return {
    summary: {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      linked: 0,
    },
    products: [],
  };
}

export const loader = async ({ request }) => {
  const {
    formatDateTime,
    getVendorMonthlyReport,
    getVendorPublicContext,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const url = new URL(request.url);
  const requestedMonth = url.searchParams.get("month");
  const normalizedMonth = normalizeMonth(requestedMonth);
  const month = normalizedMonth || currentMonthValue();
  const monthNotice =
    requestedMonth && !normalizedMonth
      ? "対象月の形式が正しくないため、現在の月を表示しています。"
      : null;

  try {
    const report = await getVendorMonthlyReport({
      storeId: store.id,
      month,
    });

    return json({
      ...getVendorPublicContext(vendor, store),
      month,
      monthLabel: formatMonthLabel(month),
      generatedAtLabel: formatDateTime(new Date()),
      monthNotice,
      loadError: null,
      report,
    });
  } catch (error) {
    console.error("vendor monthly report loader error:", error);

    return json(
      {
        ...getVendorPublicContext(vendor, store),
        month,
        monthLabel: formatMonthLabel(month),
        generatedAtLabel: formatDateTime(new Date()),
        monthNotice,
        loadError:
          "月次レポートの読み込みに失敗しました。時間を置いて再度お試しください。",
        report: emptyReport(),
      },
      { status: 500 }
    );
  }
};

export default function VendorMonthlyReportPage() {
  const { vendor, store, month, monthLabel, generatedAtLabel, monthNotice, loadError, report } =
    useLoaderData();

  return (
    <VendorManagementShell
      activeItem="dashboard"
      storeName={store.storeName}
      title="月次レポート"
    >
      <style>{`
        .vendor-report__toolbar{
          display:flex;
          align-items:flex-end;
          justify-content:space-between;
          gap:16px;
          flex-wrap:wrap;
        }
        .vendor-report__summary-grid{
          display:grid;
          grid-template-columns:repeat(5, minmax(0, 1fr));
          gap:16px;
        }
        .vendor-report__table-head{
          display:flex;
          align-items:flex-end;
          justify-content:space-between;
          gap:16px;
          flex-wrap:wrap;
        }
        .vendor-report__table{
          min-width:1120px;
        }
        .vendor-report__table td{
          vertical-align:top;
        }
        .vendor-report__url{
          display:inline-block;
          max-width:320px;
          white-space:normal;
          word-break:break-all;
        }
        .vendor-report__empty{
          color:#6b7280;
        }
        @media print{
          .vendor-report__controls{
            display:none !important;
          }
          .vendor-card{
            box-shadow:none;
            break-inside:avoid;
          }
          .vendor-report__summary-grid{
            grid-template-columns:repeat(3, minmax(0, 1fr));
          }
          .vendor-report__table{
            min-width:0;
          }
          .vendor-report__table th,
          .vendor-report__table td{
            font-size:12px;
          }
          .vendor-report__url{
            max-width:none;
          }
        }
        @media (max-width: 1200px){
          .vendor-report__summary-grid{
            grid-template-columns:repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 760px){
          .vendor-report__summary-grid{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>

      {monthNotice ? (
        <section className="vendor-card">
          <div className="vendor-note">{monthNotice}</div>
        </section>
      ) : null}

      {loadError ? (
        <section className="vendor-card">
          <div className="vendor-note vendor-note--danger">{loadError}</div>
        </section>
      ) : null}

      <section className="vendor-card">
        <div className="vendor-report__toolbar">
          <div>
            <h2 className="vendor-section-title">月次レポート</h2>
            <p className="vendor-section-subtitle">
              このレポートでは、対象月に登録された商品を集計しています。ブラウザ印刷しやすい帳票形式で確認できます。
            </p>
          </div>

          <Form method="get" className="vendor-shell__search-form vendor-report__controls">
            <input
              className="vendor-shell__month-input"
              type="month"
              name="month"
              defaultValue={month}
            />
            <button className="vendor-shell__button" type="submit">
              対象月を更新
            </button>
            <button
              className="vendor-shell__button vendor-shell__button--primary"
              type="button"
              onClick={() => window.print()}
            >
              印刷する
            </button>
          </Form>
        </div>

        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">店舗名</div>
            <div className="vendor-description-value">{store.storeName}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">handle</div>
            <div className="vendor-description-value">{vendor.handle}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">管理メール</div>
            <div className="vendor-description-value">{vendor.managementEmail}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">ステータス</div>
            <div className="vendor-description-value">
              <span className={badgeClass(vendor.statusLabel)}>{vendor.statusLabel}</span>
            </div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">対象月</div>
            <div className="vendor-description-value">{monthLabel}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">レポート作成日</div>
            <div className="vendor-description-value">{generatedAtLabel}</div>
          </div>
        </div>

        <p className="vendor-helper-text">
          このレポートでは、{monthLabel} に登録された商品を集計しています。承認待ち商品数は「申請中」と「確認中」を合算しています。
        </p>
      </section>

      <section className="vendor-report__summary-grid">
        <div className="vendor-card">
          <p className="vendor-stat-title">対象月に登録された商品数</p>
          <p className="vendor-stat-value">{report.summary.total}</p>
          <p className="vendor-stat-sub">対象月に登録された商品の合計</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">対象月の承認待ち商品数</p>
          <p className="vendor-stat-value">{report.summary.pending}</p>
          <p className="vendor-stat-sub">申請中・確認中の合計</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">対象月の承認済み商品数</p>
          <p className="vendor-stat-value">{report.summary.approved}</p>
          <p className="vendor-stat-sub">approvalStatus が approved の商品</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">対象月の差し戻し商品数</p>
          <p className="vendor-stat-value">{report.summary.rejected}</p>
          <p className="vendor-stat-sub">approvalStatus が rejected の商品</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">対象月のShopify連携済み商品数</p>
          <p className="vendor-stat-value">{report.summary.linked}</p>
          <p className="vendor-stat-sub">shopifyProductId を持つ商品</p>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文・売上</h2>
        <div className="vendor-placeholder">
          注文・売上情報は注文連携後に追加予定です。現在の月次レポートでは、商品登録・審査・Shopify連携状況のみ表示しています。
        </div>
      </section>

      <section className="vendor-card">
        <div className="vendor-report__table-head">
          <div>
            <h2 className="vendor-section-title">対象月に登録された商品一覧</h2>
            <p className="vendor-section-subtitle">
              対象月に登録された商品だけを一覧表示しています。
            </p>
          </div>
          <div className="vendor-helper-text">件数: {report.summary.total} 件</div>
        </div>

        <div className="vendor-table-wrap">
          <table className="vendor-table vendor-report__table">
            <thead>
              <tr>
                <th>商品名</th>
                <th>価格</th>
                <th>通貨</th>
                <th>承認状態</th>
                <th>Shopify連携状態</th>
                <th>商品URL</th>
                <th>Shopify商品ID</th>
              </tr>
            </thead>
            <tbody>
              {report.products.length === 0 ? (
                <tr>
                  <td className="vendor-report__empty" colSpan="7">
                    対象月に登録された商品はありません。
                  </td>
                </tr>
              ) : (
                report.products.map((product) => (
                  <tr key={product.id}>
                    <td className="vendor-table__name">{product.name}</td>
                    <td>{product.priceLabel}</td>
                    <td>{product.currencyCode}</td>
                    <td>
                      <span className={badgeClass(product.approvalLabel)}>
                        {product.approvalLabel}
                      </span>
                    </td>
                    <td>
                      <span className={badgeClass(product.shopifyStatusLabel)}>
                        {product.shopifyStatusLabel}
                      </span>
                    </td>
                    <td>
                      {product.url ? (
                        <a
                          className="vendor-report__url"
                          href={product.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {product.url}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{product.shopifyProductId || "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </VendorManagementShell>
  );
}
