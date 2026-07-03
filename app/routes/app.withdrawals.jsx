import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import {
  WITHDRAWAL_ELIGIBILITY_STATUSES,
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "all");
  const eligibilityStatus = String(
    url.searchParams.get("eligibilityStatus") || "all",
  );
  const search = String(url.searchParams.get("search") || "").trim();
  const limit = clampLimit(url.searchParams.get("limit"));

  const where = {};

  if (status !== "all") where.status = status;
  if (eligibilityStatus !== "all") where.eligibilityStatus = eligibilityStatus;
  if (search) {
    where.OR = [
      { shopifyOrderName: { contains: search, mode: "insensitive" } },
      { shopifyOrderNumber: { contains: search, mode: "insensitive" } },
      { customerEmail: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
      { id: { contains: search, mode: "insensitive" } },
    ];
  }

  try {
    const [requests, summary] = await Promise.all([
      prisma.withdrawalRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          emailLogs: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
      prisma.withdrawalRequest.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);

    return json({
      available: true,
      status,
      eligibilityStatus,
      search,
      limit,
      summary: summary.map((row) => ({
        status: row.status,
        label: getWithdrawalStatusLabel(row.status),
        count: row._count?._all || 0,
      })),
      requests: requests.map(serializeWithdrawalRequest),
    });
  } catch (error) {
    console.error("withdrawals list load error:", error);
    return json({
      available: false,
      status,
      eligibilityStatus,
      search,
      limit,
      summary: [],
      requests: [],
      errorMessage:
        error?.code === "P2021"
          ? "撤回申請テーブルがまだ作成されていません。migration を適用してください。"
          : "撤回申請を読み込めませんでした。",
    });
  }
};

export default function WithdrawalsPage() {
  const {
    available,
    status,
    eligibilityStatus,
    search,
    limit,
    summary,
    requests,
    errorMessage,
  } = useLoaderData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  return (
    <main className="withdrawals-admin">
      <style>{adminStyles}</style>
      <section className="withdrawals-admin__card">
        <div className="withdrawals-admin__header">
          <div>
            <h1>撤回申請</h1>
            <p>
              EU撤回権フォームから届いた申請を確認します。申請受付は自動、返金やキャンセルは管理者確認後に行います。
            </p>
          </div>
          <Form method="get" className="withdrawals-admin__filters">
            <label>
              <span>状態</span>
              <select name="status" defaultValue={status}>
                <option value="all">すべて</option>
                {Object.values(WITHDRAWAL_STATUSES).map((value) => (
                  <option key={value} value={value}>
                    {getWithdrawalStatusLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>判定</span>
              <select name="eligibilityStatus" defaultValue={eligibilityStatus}>
                <option value="all">すべて</option>
                {Object.values(WITHDRAWAL_ELIGIBILITY_STATUSES).map((value) => (
                  <option key={value} value={value}>
                    {getWithdrawalEligibilityLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>検索</span>
              <input name="search" defaultValue={search} placeholder="注文番号 / メール" />
            </label>
            <label>
              <span>件数</span>
              <input name="limit" type="number" min="1" max={MAX_LIMIT} defaultValue={limit} />
            </label>
            <button type="submit" disabled={isLoading}>
              更新
            </button>
          </Form>
        </div>
      </section>

      {!available ? (
        <section className="withdrawals-admin__card">
          <div className="withdrawals-admin__empty">{errorMessage}</div>
        </section>
      ) : (
        <>
          <section className="withdrawals-admin__card withdrawals-admin__summary">
            {summary.length === 0 ? (
              <div className="withdrawals-admin__empty">まだ申請はありません。</div>
            ) : (
              summary.map((item) => (
                <div className="withdrawals-admin__summary-item" key={item.status}>
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>
              ))
            )}
          </section>

          <section className="withdrawals-admin__card">
            <div className="withdrawals-admin__table-wrap">
              <table className="withdrawals-admin__table">
                <thead>
                  <tr>
                    <th>受付日</th>
                    <th>注文</th>
                    <th>購入者</th>
                    <th>国</th>
                    <th>状態</th>
                    <th>判定</th>
                    <th>受付メール</th>
                    <th>詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.length === 0 ? (
                    <tr>
                      <td colSpan="8">
                        <div className="withdrawals-admin__empty">
                          条件に合う申請はありません。
                        </div>
                      </td>
                    </tr>
                  ) : (
                    requests.map((request) => (
                      <tr key={request.id}>
                        <td>{request.createdAtLabel}</td>
                        <td>
                          <div className="withdrawals-admin__strong">
                            {request.shopifyOrderName || request.shopifyOrderNumber || "-"}
                          </div>
                          <div className="withdrawals-admin__muted">{request.id}</div>
                        </td>
                        <td>
                          <div>{request.customerName}</div>
                          <div className="withdrawals-admin__muted">{request.customerEmail}</div>
                        </td>
                        <td>{request.countryLabel || request.countryCode || "-"}</td>
                        <td>
                          <Badge tone={request.statusTone}>{request.statusLabel}</Badge>
                        </td>
                        <td>
                          <Badge tone={request.eligibilityTone}>
                            {request.eligibilityLabel}
                          </Badge>
                        </td>
                        <td>{request.latestEmailStatusLabel}</td>
                        <td>
                          <Link className="withdrawals-admin__link" to={`/app/withdrawals/${request.id}`}>
                            開く
                          </Link>
                        </td>
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

function serializeWithdrawalRequest(request) {
  const latestEmail = request.emailLogs?.[0] || null;

  return {
    id: request.id,
    shopifyOrderName: request.shopifyOrderName,
    shopifyOrderNumber: request.shopifyOrderNumber,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    countryCode: request.countryCode,
    countryLabel: request.countryLabel,
    status: request.status,
    statusLabel: getWithdrawalStatusLabel(request.status),
    statusTone: getWithdrawalStatusTone(request.status),
    eligibilityStatus: request.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(request.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    latestEmailStatusLabel: latestEmail
      ? latestEmail.status === "sent"
        ? "送信済み"
        : "失敗"
      : "未送信",
    createdAtLabel: formatDate(request.createdAt),
  };
}

function Badge({ tone, children }) {
  return <span className={`withdrawals-admin__badge withdrawals-admin__badge--${tone}`}>{children}</span>;
}

function clampLimit(rawValue) {
  const parsed = Number(rawValue || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
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
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
}

const adminStyles = `
  .withdrawals-admin{
    display:grid;
    gap:24px;
    padding:24px;
    min-height:100%;
    background:#f3f4f6;
    color:#111827;
  }
  .withdrawals-admin__card{
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:22px;
  }
  .withdrawals-admin__header{
    display:flex;
    justify-content:space-between;
    gap:20px;
    align-items:flex-start;
    flex-wrap:wrap;
  }
  .withdrawals-admin h1{
    margin:0 0 8px;
    font-size:30px;
  }
  .withdrawals-admin p{
    margin:0;
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawals-admin__filters{
    display:flex;
    align-items:flex-end;
    gap:10px;
    flex-wrap:wrap;
  }
  .withdrawals-admin__filters label{
    display:grid;
    gap:6px;
    color:#4b5563;
    font-size:12px;
    font-weight:800;
  }
  .withdrawals-admin__filters input,
  .withdrawals-admin__filters select{
    min-height:40px;
    border:1px solid #d1d5db;
    border-radius:10px;
    padding:0 12px;
    background:#fff;
    color:#111827;
  }
  .withdrawals-admin__filters button,
  .withdrawals-admin__link{
    min-height:40px;
    display:inline-flex;
    align-items:center;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 16px;
    background:#111827;
    color:#fff;
    font-weight:800;
    text-decoration:none;
  }
  .withdrawals-admin__summary{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));
    gap:12px;
  }
  .withdrawals-admin__summary-item{
    display:grid;
    gap:8px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    padding:15px;
    background:#f9fafb;
  }
  .withdrawals-admin__summary-item span{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawals-admin__summary-item strong{
    font-size:28px;
  }
  .withdrawals-admin__table-wrap{
    overflow:auto;
  }
  .withdrawals-admin__table{
    width:100%;
    border-collapse:collapse;
    min-width:980px;
  }
  .withdrawals-admin__table th,
  .withdrawals-admin__table td{
    padding:13px 10px;
    border-bottom:1px solid #e5e7eb;
    text-align:left;
    vertical-align:top;
  }
  .withdrawals-admin__table th{
    color:#4b5563;
    font-size:12px;
    white-space:nowrap;
  }
  .withdrawals-admin__strong{
    font-weight:800;
  }
  .withdrawals-admin__muted{
    color:#6b7280;
    font-size:12px;
    overflow-wrap:anywhere;
  }
  .withdrawals-admin__badge{
    display:inline-flex;
    border:1px solid #d1d5db;
    border-radius:999px;
    padding:5px 10px;
    font-size:12px;
    font-weight:800;
    white-space:nowrap;
  }
  .withdrawals-admin__badge--success{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawals-admin__badge--warning{
    border-color:#fde68a;
    background:#fffbeb;
    color:#92400e;
  }
  .withdrawals-admin__badge--danger{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawals-admin__badge--info,
  .withdrawals-admin__badge--neutral{
    border-color:#bfdbfe;
    background:#eff6ff;
    color:#1d4ed8;
  }
  .withdrawals-admin__empty{
    border:1px dashed #cbd5e1;
    border-radius:14px;
    padding:18px;
    color:#64748b;
  }
`;
