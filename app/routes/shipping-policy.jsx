import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';

import { buildShippingRatePolicyData } from '../services/shippingRatePolicy.server.js';

const currencyFormatter = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0,
});

const pageStyles = {
  page: {
    margin: 0,
    minHeight: '100vh',
    background: '#f7f7f4',
    color: '#1f2933',
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  main: {
    maxWidth: '920px',
    margin: '0 auto',
    padding: '48px 20px 64px',
  },
  panel: {
    background: '#ffffff',
    border: '1px solid #deded8',
    borderRadius: '8px',
    padding: '32px',
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
  },
  eyebrow: {
    margin: '0 0 8px',
    color: '#5b6472',
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: 0,
  },
  h1: {
    margin: '0 0 16px',
    fontSize: '32px',
    lineHeight: 1.25,
  },
  lead: {
    margin: '0 0 24px',
    color: '#405060',
    fontSize: '16px',
    lineHeight: 1.8,
  },
  section: {
    marginTop: '32px',
  },
  h2: {
    margin: '0 0 12px',
    fontSize: '20px',
    lineHeight: 1.4,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '12px',
  },
  stat: {
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '16px',
    background: '#fbfbfa',
  },
  statLabel: {
    margin: '0 0 6px',
    color: '#5b6472',
    fontSize: '13px',
  },
  statValue: {
    margin: 0,
    fontSize: '24px',
    fontWeight: 800,
  },
  tableWrap: {
    overflowX: 'auto',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    minWidth: '640px',
  },
  th: {
    padding: '12px 14px',
    background: '#f3f4f1',
    borderBottom: '1px solid #e5e7eb',
    textAlign: 'left',
    fontSize: '13px',
  },
  td: {
    padding: '14px',
    borderBottom: '1px solid #eef0f2',
    verticalAlign: 'top',
    fontSize: '14px',
    lineHeight: 1.6,
  },
  amount: {
    whiteSpace: 'nowrap',
    fontWeight: 800,
  },
  note: {
    margin: '14px 0 0',
    color: '#5b6472',
    fontSize: '14px',
    lineHeight: 1.7,
  },
  error: {
    padding: '16px',
    border: '1px solid #f2b8b5',
    borderRadius: '8px',
    background: '#fff4f4',
    color: '#7f1d1d',
  },
};

function formatAmount(amount) {
  return Number.isFinite(amount) ? currencyFormatter.format(amount) : '配送不可';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));
}

export const meta = () => [
  { title: '送料について | Oja Immanuel Bacchus' },
  {
    name: 'description',
    content:
      'Oja Immanuel Bacchus の送料目安、最低送料、最高送料、平均送料、配送先別の例をご案内します。',
  },
];

export const loader = async () => {
  return json({
    policy: buildShippingRatePolicyData(),
  });
};

export default function ShippingPolicyPage() {
  const { policy } = useLoaderData();

  return (
    <div style={pageStyles.page}>
      <main style={pageStyles.main}>
        <article style={pageStyles.panel}>
          <p style={pageStyles.eyebrow}>Oja Immanuel Bacchus</p>
          <h1 style={pageStyles.h1}>送料について</h1>
          <p style={pageStyles.lead}>
            当ストアの送料は、配送先の国・地域、商品、数量などに応じて
            Shopify チェックアウト画面で自動計算されます。お客様が注文を確定する前に、
            実際にご負担いただく送料がチェックアウト画面に表示されます。
          </p>

          {!policy.ok ? (
            <div style={pageStyles.error}>
              送料設定を表示できませんでした。時間をおいて再度ご確認ください。
            </div>
          ) : (
            <>
              <section style={pageStyles.section}>
                <h2 style={pageStyles.h2}>送料の目安</h2>
                <div style={pageStyles.grid}>
                  <div style={pageStyles.stat}>
                    <p style={pageStyles.statLabel}>最低送料</p>
                    <p style={pageStyles.statValue}>
                      {formatAmount(policy.minimumAmount)}
                    </p>
                  </div>
                  <div style={pageStyles.stat}>
                    <p style={pageStyles.statLabel}>最高送料</p>
                    <p style={pageStyles.statValue}>
                      {formatAmount(policy.maximumAmount)}
                    </p>
                  </div>
                  <div style={pageStyles.stat}>
                    <p style={pageStyles.statLabel}>平均送料の目安</p>
                    <p style={pageStyles.statValue}>
                      {formatAmount(policy.averageAmount)}
                    </p>
                  </div>
                </div>
                <p style={pageStyles.note}>
                  配送不要の商品は送料 0 円です。表示金額は日本円基準です。
                  海外配送の場合、チェックアウト画面では表示通貨へ換算されることがあります。
                </p>
              </section>

              <section style={pageStyles.section}>
                <h2 style={pageStyles.h2}>配送先・条件別の送料</h2>
                <div style={pageStyles.tableWrap}>
                  <table style={pageStyles.table}>
                    <thead>
                      <tr>
                        <th style={pageStyles.th}>区分</th>
                        <th style={pageStyles.th}>条件</th>
                        <th style={pageStyles.th}>送料</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policy.rows.map((row) => (
                        <tr key={row.id}>
                          <td style={pageStyles.td}>{row.id}</td>
                          <td style={pageStyles.td}>{row.condition}</td>
                          <td style={{ ...pageStyles.td, ...pageStyles.amount }}>
                            {formatAmount(row.amount)}
                          </td>
                        </tr>
                      ))}
                      {!policy.undeliverableWhenNoRule ? (
                        <tr>
                          <td style={pageStyles.td}>default</td>
                          <td style={pageStyles.td}>
                            上記に該当しない配送先・条件
                          </td>
                          <td style={{ ...pageStyles.td, ...pageStyles.amount }}>
                            {formatAmount(policy.defaultAmount)}
                          </td>
                        </tr>
                      ) : (
                        <tr>
                          <td style={pageStyles.td}>その他</td>
                          <td style={pageStyles.td}>
                            上記に該当しない配送先・条件
                          </td>
                          <td style={{ ...pageStyles.td, ...pageStyles.amount }}>
                            配送不可
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section style={pageStyles.section}>
                <h2 style={pageStyles.h2}>送料の表示例</h2>
                <div style={pageStyles.tableWrap}>
                  <table style={pageStyles.table}>
                    <thead>
                      <tr>
                        <th style={pageStyles.th}>例</th>
                        <th style={pageStyles.th}>配送先</th>
                        <th style={pageStyles.th}>送料</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policy.examples.map((example) => (
                        <tr key={`${example.label}-${example.destination}`}>
                          <td style={pageStyles.td}>{example.label}</td>
                          <td style={pageStyles.td}>{example.destination}</td>
                          <td style={{ ...pageStyles.td, ...pageStyles.amount }}>
                            {example.isDeliverable
                              ? formatAmount(example.amount)
                              : '配送不可'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section style={pageStyles.section}>
                <h2 style={pageStyles.h2}>ご確認事項</h2>
                <p style={pageStyles.note}>
                  送料はチェックアウト画面で配送先住所を入力した後に確定します。
                  商品の組み合わせ、数量、配送先、配送会社の条件により表示例と異なる場合があります。
                  ご注文確定前に必ずチェックアウト画面の送料をご確認ください。
                </p>
                {policy.note ? <p style={pageStyles.note}>{policy.note}</p> : null}
                <p style={pageStyles.note}>
                  最終更新日: {formatDate(policy.generatedAt)}
                </p>
              </section>
            </>
          )}
        </article>
      </main>
    </div>
  );
}
