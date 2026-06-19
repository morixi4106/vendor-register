import { json } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

const STATUS_LABELS = {
  matched: "一致",
  amount_mismatch: "金額差分",
  seller_mismatch: "出店者差分",
  line_count_mismatch: "明細差分",
  unmatched_product: "商品未紐付け",
  inactive_seller: "出店者停止",
  multi_seller_detected: "複数出店者",
  failed: "失敗",
  skipped: "スキップ",
};

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "all");
  const limit = clampLimit(url.searchParams.get("limit"));

  if (!prisma.sellerOrderShadowCheck) {
    return json({
      available: false,
      status,
      limit,
      summary: [],
      checks: [],
    });
  }

  const where = status === "all" ? {} : { status };
  const [checks, groupedSummary] = await Promise.all([
    prisma.sellerOrderShadowCheck.findMany({
      where,
      orderBy: { checkedAt: "desc" },
      take: limit,
      include: {
        marketplaceOrder: {
          select: {
            shopifyOrderName: true,
          },
        },
      },
    }),
    prisma.sellerOrderShadowCheck.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  return json({
    available: true,
    status,
    limit,
    summary: groupedSummary
      .map((row) => ({
        status: row.status,
        label: getStatusLabel(row.status),
        count: row._count?._all || 0,
      }))
      .sort((a, b) => getStatusSort(a.status) - getStatusSort(b.status)),
    checks: checks.map(serializeShadowCheck),
  });
};

function clampLimit(rawValue) {
  const parsed = Number(rawValue || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status || "-";
}

function getStatusSort(status) {
  if (status === "matched") return 1;
  if (status === "multi_seller_detected") return 2;
  if (status === "skipped") return 3;
  if (status === "failed") return 90;
  return 50;
}

function serializeShadowCheck(check) {
  return {
    id: check.id,
    status: check.status,
    statusLabel: getStatusLabel(check.status),
    shopDomain: check.shopDomain,
    shopifyOrderId: check.shopifyOrderId,
    shopifyOrderName:
      check.shopifyOrderName || check.marketplaceOrder?.shopifyOrderName || "",
    legacyLedgerAmount: check.legacyLedgerAmount,
    sellerOrderCalculatedAmount: check.sellerOrderCalculatedAmount,
    currencyCode: check.currencyCode,
    legacySellerIds: safeJsonArray(check.legacySellerIdsJson),
    sellerOrderSellerIds: safeJsonArray(check.sellerOrderSellerIdsJson),
    differences: safeJsonObject(check.differencesJson),
    errorMessage: check.errorMessage || "",
    checkedAt: check.checkedAt,
  };
}

function safeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
}

function formatMoney(amount, currencyCode) {
  const number = Number(amount || 0);
  return `${number.toLocaleString("ja-JP")} ${String(currencyCode || "").toUpperCase()}`;
}

function StatusBadge({ status, children }) {
  return (
    <span className={`shadow-admin__badge shadow-admin__badge--${status}`}>
      {children}
    </span>
  );
}

export default function SellerOrderShadowPage() {
  const { available, status, limit, summary, checks } = useLoaderData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  return (
    <main className="shadow-admin">
      <style>{`
        .shadow-admin{
          display:grid;
          gap:24px;
          padding:24px;
          background:#f3f4f6;
          min-height:100%;
          color:#111827;
        }
        .shadow-admin__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:22px;
        }
        .shadow-admin__header{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:flex-start;
          flex-wrap:wrap;
        }
        .shadow-admin__title{
          margin:0 0 8px;
          font-size:28px;
          line-height:1.25;
        }
        .shadow-admin__subtitle{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .shadow-admin__filters{
          display:flex;
          gap:10px;
          align-items:flex-end;
          flex-wrap:wrap;
        }
        .shadow-admin__field{
          display:grid;
          gap:6px;
          color:#4b5563;
          font-size:12px;
          font-weight:700;
        }
        .shadow-admin__select,
        .shadow-admin__input{
          min-height:40px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:0 12px;
          background:#fff;
          color:#111827;
          font-size:14px;
        }
        .shadow-admin__button{
          min-height:40px;
          border:1px solid #111827;
          border-radius:999px;
          padding:0 16px;
          background:#111827;
          color:#fff;
          font-weight:700;
          cursor:pointer;
        }
        .shadow-admin__summary{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
          gap:12px;
        }
        .shadow-admin__summary-item{
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:14px;
          background:#f9fafb;
        }
        .shadow-admin__summary-label{
          margin:0 0 8px;
          color:#4b5563;
          font-size:13px;
          font-weight:700;
        }
        .shadow-admin__summary-count{
          margin:0;
          font-size:28px;
          font-weight:800;
        }
        .shadow-admin__table-wrap{
          overflow:auto;
        }
        .shadow-admin__table{
          width:100%;
          border-collapse:collapse;
          min-width:1100px;
        }
        .shadow-admin__table th,
        .shadow-admin__table td{
          padding:12px 10px;
          border-bottom:1px solid #e5e7eb;
          text-align:left;
          vertical-align:top;
          font-size:13px;
        }
        .shadow-admin__table th{
          color:#4b5563;
          font-size:12px;
          white-space:nowrap;
        }
        .shadow-admin__badge{
          display:inline-flex;
          align-items:center;
          border-radius:999px;
          border:1px solid #d1d5db;
          padding:4px 9px;
          font-size:12px;
          font-weight:800;
          background:#f9fafb;
          color:#374151;
          white-space:nowrap;
        }
        .shadow-admin__badge--matched{
          background:#ecfdf5;
          border-color:#a7f3d0;
          color:#047857;
        }
        .shadow-admin__badge--multi_seller_detected{
          background:#eff6ff;
          border-color:#bfdbfe;
          color:#1d4ed8;
        }
        .shadow-admin__badge--failed,
        .shadow-admin__badge--amount_mismatch,
        .shadow-admin__badge--seller_mismatch,
        .shadow-admin__badge--line_count_mismatch,
        .shadow-admin__badge--unmatched_product,
        .shadow-admin__badge--inactive_seller{
          background:#fef2f2;
          border-color:#fecaca;
          color:#b91c1c;
        }
        .shadow-admin__mono{
          font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size:12px;
          word-break:break-all;
        }
        .shadow-admin__pre{
          margin:0;
          max-width:380px;
          white-space:pre-wrap;
          word-break:break-word;
          font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size:12px;
          color:#374151;
        }
        .shadow-admin__empty{
          padding:18px;
          border:1px dashed #cbd5e1;
          border-radius:14px;
          color:#64748b;
        }
      `}</style>

      <section className="shadow-admin__card">
        <div className="shadow-admin__header">
          <div>
            <h1 className="shadow-admin__title">SellerOrder検証</h1>
            <p className="shadow-admin__subtitle">
              既存の売上台帳と、新しい出店者別注文の計算結果を比較します。現時点では本番導線の読み替えは行いません。
            </p>
          </div>
          <Form method="get" className="shadow-admin__filters">
            <label className="shadow-admin__field">
              状態
              <select name="status" defaultValue={status} className="shadow-admin__select">
                <option value="all">すべて</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="shadow-admin__field">
              件数
              <input
                name="limit"
                type="number"
                min="1"
                max={MAX_LIMIT}
                defaultValue={limit}
                className="shadow-admin__input"
              />
            </label>
            <button type="submit" className="shadow-admin__button" disabled={isLoading}>
              更新
            </button>
          </Form>
        </div>
      </section>

      {!available ? (
        <section className="shadow-admin__card">
          <div className="shadow-admin__empty">
            SellerOrder検証テーブルはまだ利用できません。migration適用後に表示されます。
          </div>
        </section>
      ) : (
        <>
          <section className="shadow-admin__card">
            <div className="shadow-admin__summary">
              {summary.length === 0 ? (
                <div className="shadow-admin__empty">まだ検証結果はありません。</div>
              ) : (
                summary.map((item) => (
                  <div className="shadow-admin__summary-item" key={item.status}>
                    <p className="shadow-admin__summary-label">{item.label}</p>
                    <p className="shadow-admin__summary-count">{item.count}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="shadow-admin__card">
            <div className="shadow-admin__table-wrap">
              <table className="shadow-admin__table">
                <thead>
                  <tr>
                    <th>日時</th>
                    <th>状態</th>
                    <th>注文</th>
                    <th>shop</th>
                    <th>既存台帳</th>
                    <th>新計算</th>
                    <th>既存seller</th>
                    <th>新seller</th>
                    <th>差分</th>
                    <th>エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.length === 0 ? (
                    <tr>
                      <td colSpan="10">
                        <div className="shadow-admin__empty">条件に合う検証結果はありません。</div>
                      </td>
                    </tr>
                  ) : (
                    checks.map((check) => (
                      <tr key={check.id}>
                        <td>{formatDate(check.checkedAt)}</td>
                        <td>
                          <StatusBadge status={check.status}>{check.statusLabel}</StatusBadge>
                        </td>
                        <td>
                          <div>{check.shopifyOrderName || "-"}</div>
                          <div className="shadow-admin__mono">{check.shopifyOrderId}</div>
                        </td>
                        <td>{check.shopDomain}</td>
                        <td>{formatMoney(check.legacyLedgerAmount, check.currencyCode)}</td>
                        <td>{formatMoney(check.sellerOrderCalculatedAmount, check.currencyCode)}</td>
                        <td>
                          <pre className="shadow-admin__pre">{JSON.stringify(check.legacySellerIds, null, 2)}</pre>
                        </td>
                        <td>
                          <pre className="shadow-admin__pre">{JSON.stringify(check.sellerOrderSellerIds, null, 2)}</pre>
                        </td>
                        <td>
                          <pre className="shadow-admin__pre">{JSON.stringify(check.differences, null, 2)}</pre>
                        </td>
                        <td>{check.errorMessage || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
