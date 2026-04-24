import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function normalizeMonth(value) {
  return /^\d{4}-\d{2}$/.test(String(value || "")) ? String(value) : null;
}

function currentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

function formatMonthLabel(value) {
  const normalized = normalizeMonth(value);
  if (!normalized) return "未選択";

  const [year, month] = normalized.split("-");
  return `${year}年${month}月`;
}

export const loader = async ({ request }) => {
  const { getVendorPublicContext, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const url = new URL(request.url);
  const month = normalizeMonth(url.searchParams.get("month")) || currentMonthValue();

  return json({
    ...getVendorPublicContext(vendor, store),
    month,
  });
};

export default function VendorMonthlyReportPage() {
  const { store, month } = useLoaderData();

  return (
    <VendorManagementShell activeItem="dashboard" storeName={store.storeName} title="月次PDF出力">
      <section className="vendor-card">
        <h2 className="vendor-section-title">月次PDF出力</h2>
        <p className="vendor-section-subtitle">
          実際の PDF 生成 service は Phase 2 で追加します。Phase 1 では対象月の選択と、ブラウザ印刷ベースの出力導線を用意しています。
        </p>

        <Form method="get" className="vendor-shell__search-form">
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
            ブラウザ印刷で出力
          </button>
        </Form>

        <div className="vendor-helper-text">
          現在の対象月: {formatMonthLabel(month)}
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">出力内容</h2>
        <ul className="vendor-list">
          <li>登録商品一覧</li>
          <li>画面表示中のダッシュボード</li>
          <li>注文・売上情報は注文連携後に追加</li>
        </ul>
      </section>
    </VendorManagementShell>
  );
}
