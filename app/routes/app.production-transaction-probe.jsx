import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEffect } from "react";

import {
  attachOrderToProductionTransactionProbe,
  buildProductionTransactionProbePage,
  cancelProductionTransactionProbe,
  createProductionTransactionProbe,
  getProductionTransactionProbePageData,
  refreshProductionTransactionProbe,
  serializeProductionTransactionProbe,
} from "../services/productionTransactionProbe.server.js";
import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

const OPERATOR_ROLES = [
  MARKETPLACE_OPERATOR_ROLES.ADMIN,
  MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
];

export async function loader({ request }) {
  const { session } = await requireMarketplaceOperator(request, {
    roles: OPERATOR_ROLES,
  });
  const releaseExpectation = await getReleaseExpectation(session.shop);
  const data = await getProductionTransactionProbePageData({
    shopDomain: session.shop,
    releaseExpectation,
  });
  const displayProbe =
    data.activeProbe ||
    data.recentProbes.find(
      (probe) =>
        probe.status === "PASSED" &&
        probe.releaseFingerprint === data.release.releaseFingerprint,
    ) ||
    null;

  return json(
    {
      ...data,
      activeProbe: serializeProductionTransactionProbe(data.activeProbe),
      displayProbe: serializeProductionTransactionProbe(displayProbe),
      recentProbes: data.recentProbes.map(serializeProductionTransactionProbe),
      page: buildProductionTransactionProbePage({
        activeProbe: displayProbe,
        release: data.release,
      }),
    },
    { headers: privateHeaders() },
  );
}

export async function action({ request }) {
  const { session, operator } = await requireMarketplaceOperator(request, {
    roles: OPERATOR_ROLES,
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const releaseExpectation = await getReleaseExpectation(session.shop);
  let result;

  try {
    if (intent === "start_probe") {
      result = await createProductionTransactionProbe({
        shopDomain: session.shop,
        startedBy: operator.actorKey,
        releaseExpectation,
      });
    } else if (intent === "attach_order") {
      result = await attachOrderToProductionTransactionProbe({
        probeId: formData.get("probeId"),
        orderReference: formData.get("orderReference"),
        actorKey: operator.actorKey,
        releaseExpectation,
      });
    } else if (intent === "refresh_probe") {
      result = await refreshProductionTransactionProbe({
        probeId: formData.get("probeId"),
        actorKey: operator.actorKey,
        releaseExpectation,
      });
    } else if (intent === "cancel_probe") {
      result = await cancelProductionTransactionProbe({
        probeId: formData.get("probeId"),
        actorKey: operator.actorKey,
      });
    } else {
      return json(
        { ok: false, reason: "unsupported_intent" },
        { status: 400, headers: privateHeaders() },
      );
    }
  } catch (error) {
    console.error("Production transaction probe action failed:", {
      intent,
      name: error instanceof Error ? error.name : "unknown",
    });
    return json(
      { ok: false, reason: "production_transaction_probe_failed" },
      { status: 500, headers: privateHeaders() },
    );
  }

  return json(result, {
    status: result.ok ? 200 : result.reason?.includes("conflict") ? 409 : 400,
    headers: privateHeaders(),
  });
}

export function headers() {
  return privateHeaders();
}

export default function ProductionTransactionProbePage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const refreshFetcher = useFetcher();
  const activeProbe = data.activeProbe;
  const probe = data.displayProbe;
  const page = data.page;
  const busy = navigation.state !== "idle" || refreshFetcher.state !== "idle";

  useEffect(() => {
    if (
      !probe?.id ||
      !["AWAITING_SETTLEMENT", "AWAITING_REFUND"].includes(probe.status)
    ) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (refreshFetcher.state === "idle") {
        refreshFetcher.submit(
          { intent: "refresh_probe", probeId: probe.id },
          { method: "post" },
        );
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [probe?.id, probe?.status, refreshFetcher]);

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>PRODUCTION E2E</p>
          <h1 style={styles.title}>本番注文・返金 E2E確認</h1>
          <p style={styles.lead}>
            Shopify Paymentsの実取引と、アプリの注文・売上台帳・元取引への全額返金を照合します。
          </p>
        </div>
        <StatusBadge tone={page.tone} label={page.statusLabel} />
      </header>

      <section style={styles.notice}>
        <strong>この画面から注文や返金は実行されません。</strong>
        <span>
          購入と全額返金はShopifyで行います。この画面は結果を読み取り、
          現在のリリースに紐づく検証証跡だけを記録します。
        </span>
      </section>

      {!data.available ? (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>準備が必要です</h2>
          <p style={styles.text}>
            データベースmigrationの適用後に利用できます。適用完了までは実行しないでください。
          </p>
        </section>
      ) : (
        <>
          <section style={styles.section}>
            <div style={styles.sectionHeading}>
              <div>
                <h2 style={styles.sectionTitle}>次に行うこと</h2>
                <p style={styles.text}>{page.instruction}</p>
              </div>
              <span style={styles.release}>
                Release: {data.release.releaseId || "未設定"}
              </span>
            </div>

            {!activeProbe && probe?.status !== "PASSED" ? (
              <Form method="post">
                <input type="hidden" name="intent" value="start_probe" />
                <button style={styles.primaryButton} disabled={busy}>
                  確認を開始
                </button>
              </Form>
            ) : null}

            {activeProbe?.status === "AWAITING_ORDER" ? (
              <Form method="post" style={styles.form}>
                <input type="hidden" name="intent" value="attach_order" />
                <input type="hidden" name="probeId" value={activeProbe.id} />
                <label style={styles.label}>
                  Shopify注文番号
                  <span style={styles.hint}>
                    確認開始後に運営直販商品をShopify
                    Paymentsの実カードで購入し、#1234またはOrder GIDを入力します。
                  </span>
                  <input
                    style={styles.input}
                    name="orderReference"
                    placeholder="#1234"
                    autoComplete="off"
                    required
                  />
                </label>
                <button style={styles.primaryButton} disabled={busy}>
                  注文を照合対象にする
                </button>
              </Form>
            ) : null}

            {activeProbe &&
            ["AWAITING_SETTLEMENT", "AWAITING_REFUND"].includes(
              activeProbe.status,
            ) ? (
              <div style={styles.actions}>
                <refreshFetcher.Form method="post">
                  <input type="hidden" name="intent" value="refresh_probe" />
                  <input type="hidden" name="probeId" value={activeProbe.id} />
                  <button style={styles.secondaryButton} disabled={busy}>
                    今すぐ再確認
                  </button>
                </refreshFetcher.Form>
                <span style={styles.hint}>
                  この画面を開いている間は15秒ごとに確認します。
                </span>
              </div>
            ) : null}

            {activeProbe ? (
              <Form method="post" style={styles.cancelForm}>
                <input type="hidden" name="intent" value="cancel_probe" />
                <input type="hidden" name="probeId" value={activeProbe.id} />
                <button style={styles.textButton} disabled={busy}>
                  この確認を中止
                </button>
              </Form>
            ) : null}

            <ResultMessage
              result={actionData || refreshFetcher.data}
              fallbackReason={probe?.lastErrorCode}
            />
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>進行状況</h2>
            <ol style={styles.steps}>
              {page.steps.map((step, index) => (
                <li key={step.id} style={styles.step}>
                  <span
                    style={{
                      ...styles.stepNumber,
                      ...(step.done ? styles.stepNumberDone : {}),
                    }}
                    aria-hidden="true"
                  >
                    {step.done ? "✓" : index + 1}
                  </span>
                  <span>
                    <strong>{step.label}</strong>
                    <span style={styles.stepDetail}>{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {probe ? (
            <section style={styles.section}>
              <div style={styles.sectionHeading}>
                <h2 style={styles.sectionTitle}>照合結果</h2>
                <span style={styles.hint}>
                  最終確認: {formatDate(probe.lastCheckedAt)}
                </span>
              </div>
              <dl style={styles.summary}>
                <Summary label="状態" value={statusLabel(probe.status)} />
                <Summary
                  label="Shopify注文"
                  value={probe.orderEvidence.shopifyOrderName || "未登録"}
                />
                <Summary
                  label="開始日時"
                  value={formatDate(probe.startedAt)}
                />
                <Summary
                  label="完了日時"
                  value={formatDate(probe.completedAt)}
                />
              </dl>
              <Inspection title="売上反映" inspection={probe.paidEvidence} />
              <Inspection title="全額返金" inspection={probe.refundEvidence} />
            </section>
          ) : null}

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>最近の確認</h2>
            {data.recentProbes.length === 0 ? (
              <p style={styles.text}>まだ確認履歴はありません。</p>
            ) : (
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>開始日時</th>
                      <th style={styles.th}>状態</th>
                      <th style={styles.th}>注文</th>
                      <th style={styles.th}>Release</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentProbes.map((item) => (
                      <tr key={item.id}>
                        <td style={styles.td}>{formatDate(item.startedAt)}</td>
                        <td style={styles.td}>{statusLabel(item.status)}</td>
                        <td style={styles.td}>
                          {item.orderEvidence.shopifyOrderName || "-"}
                        </td>
                        <td style={styles.td}>{item.releaseId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <footer style={styles.footer}>
        <Link to="/app/production-readiness">本番確認へ戻る</Link>
      </footer>
    </main>
  );
}

function Summary({ label, value }) {
  return (
    <div style={styles.summaryItem}>
      <dt style={styles.summaryLabel}>{label}</dt>
      <dd style={styles.summaryValue}>{value}</dd>
    </div>
  );
}

function Inspection({ title, inspection }) {
  if (!inspection || !Array.isArray(inspection.checks)) return null;
  return (
    <div style={styles.inspection}>
      <h3 style={styles.inspectionTitle}>{title}</h3>
      <ul style={styles.checks}>
        {inspection.checks.map((item) => (
          <li key={item.id} style={styles.check}>
            <span
              style={item.passed ? styles.checkPassed : styles.checkPending}
              aria-hidden="true"
            >
              {item.passed ? "✓" : "•"}
            </span>
            <span>
              <strong>{checkLabel(item.id)}</strong>
              {!item.passed ? (
                <span style={styles.checkReason}>
                  {reasonLabel(item.code)}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultMessage({ result, fallbackReason }) {
  if (result?.ok === false) {
    return (
      <p role="alert" style={styles.error}>
        {reasonLabel(result.reason)}
      </p>
    );
  }
  if (result?.ok === true && !result.pending) {
    return (
      <p role="status" style={styles.success}>
        更新しました。
      </p>
    );
  }
  if (fallbackReason) {
    return <p style={styles.pending}>{reasonLabel(fallbackReason)}</p>;
  }
  return null;
}

function StatusBadge({ tone, label }) {
  const toneStyle =
    tone === "success"
      ? styles.badgeSuccess
      : tone === "warning"
        ? styles.badgeWarning
        : styles.badgeNeutral;
  return <span style={{ ...styles.badge, ...toneStyle }}>{label}</span>;
}

async function getReleaseExpectation(shopDomain) {
  const { inspectMarketplaceCheckoutValidation } =
    await import("../services/shopifyCheckoutValidation.server.js");
  const { buildProductionReleaseExpectation } =
    await import("../services/productionRelease.server.js");
  let checkoutValidation = null;
  try {
    checkoutValidation = await inspectMarketplaceCheckoutValidation(shopDomain);
  } catch (error) {
    console.error("Production transaction probe release lookup failed:", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  return buildProductionReleaseExpectation({ checkoutValidation });
}

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(status) {
  return (
    {
      AWAITING_ORDER: "注文待ち",
      AWAITING_SETTLEMENT: "売上反映待ち",
      AWAITING_REFUND: "全額返金待ち",
      PASSED: "完了",
      INVALIDATED: "リリース変更で無効",
      CANCELLED: "中止",
    }[status] || status
  );
}

function reasonLabel(reason) {
  return (
    {
      production_transaction_probe_input_invalid:
        "現在のリリース情報を確認できません。RenderとShopify Appのバージョン設定を確認してください。",
      production_transaction_probe_unavailable:
        "migrationが未適用のため、この機能を利用できません。",
      production_transaction_probe_conflict:
        "別の更新と競合しました。画面を更新して状態を確認してください。",
      shopify_order_already_used:
        "この注文は別の確認ですでに使用されています。新しい実注文を指定してください。",
      order_reference_invalid:
        "注文番号は#1234またはShopify Order GIDで入力してください。",
      shopify_order_not_found: "Shopifyで注文を確認できませんでした。",
      shopify_order_transactions_incomplete:
        "注文の決済取引をすべて取得できませんでした。Shopifyの取引件数を確認してください。",
      shopify_refund_transactions_incomplete:
        "返金取引をすべて取得できませんでした。Shopifyの返金履歴を確認してください。",
      shopify_order_reference_ambiguous:
        "注文番号を一意に特定できません。Order GIDを入力してください。",
      shopify_test_order_not_allowed:
        "テスト注文は証跡に利用できません。本番モードの実注文を指定してください。",
      order_predates_probe:
        "確認開始前に作成された注文は利用できません。",
      order_not_paid:
        "支払い済みで未返金の注文を指定してください。",
      order_already_refunded:
        "すでに返金が始まっている注文は利用できません。新しい実注文で確認してください。",
      order_contains_non_platform_product:
        "運営直販以外の商品が含まれるため、この確認には利用できません。",
      local_product_mapping_missing:
        "Shopify商品とアプリの商品を照合できません。",
      release_changed:
        "確認中にリリースが変わりました。現在のリリースで新しく確認してください。",
      marketplace_order_missing:
        "注文Webhookの反映待ちです。少し待って再確認してください。",
      paid_ledger_count_mismatch:
        "売上台帳の反映待ち、または件数不一致です。",
      seller_order_shadow_not_matched:
        "SellerOrderの比較がまだ一致していません。",
      shopify_payment_transaction_missing:
        "Shopify Paymentsの売上取引がまだ確認できません。",
      shopify_payment_transaction_not_captured:
        "Shopify Paymentsの売上取引が成功状態ではありません。",
      shopify_payment_transaction_not_shopify_payments:
        "Shopify Payments以外の決済、または手動の支払い済み注文は利用できません。",
      shopify_payment_transaction_is_test:
        "テスト決済の取引は本番証跡に利用できません。",
      shopify_payment_transaction_amount_mismatch:
        "Shopify Paymentsの決済額と注文合計が一致しません。",
      shopify_payment_transaction_currency_mismatch:
        "Shopify Paymentsの決済通貨と注文通貨が一致しません。",
      shopify_order_not_fully_refunded:
        "Shopifyで同じ注文を全額返金してから再確認してください。",
      shopify_refund_transaction_missing:
        "Shopify Paymentsの成功した返金取引がまだ確認できません。",
      shopify_refund_transaction_not_successful:
        "Shopifyの返金取引がすべて成功状態になるまで待ってください。",
      shopify_refund_transaction_not_shopify_payments:
        "Shopify Payments以外の方法で処理された返金は利用できません。",
      shopify_refund_transaction_is_test:
        "テスト返金の取引は本番証跡に利用できません。",
      shopify_refund_transaction_parent_mismatch:
        "返金取引が元のShopify Payments取引に紐づいていません。",
      shopify_refund_transaction_amount_mismatch:
        "Shopify Paymentsの返金額と注文合計が一致しません。",
      shopify_refund_transaction_currency_mismatch:
        "Shopify Paymentsの返金通貨と注文通貨が一致しません。",
      refund_ledger_count_mismatch:
        "返金Webhookと返金台帳の反映待ち、または件数不一致です。",
      active_probe_not_found:
        "有効な確認がありません。画面を更新して新しく開始してください。",
      production_transaction_probe_failed:
        "確認処理に失敗しました。しばらく待って再度お試しください。",
    }[reason] || "まだ合格条件を満たしていません。"
  );
}

function checkLabel(id) {
  return (
    {
      shopify_payment_transaction_present:
        "Shopify Paymentsの売上取引を確認",
      shopify_payment_transaction_status: "売上取引が成功済み",
      shopify_payment_transaction_gateway: "決済元がShopify Payments",
      shopify_payment_transaction_live: "本番取引であることを確認",
      shopify_payment_transaction_amount: "決済額が注文合計と一致",
      shopify_payment_transaction_currency: "決済通貨が注文通貨と一致",
      commercial_fingerprint: "注文内容が途中で変わっていない",
      marketplace_order: "MarketplaceOrderが作成済み",
      marketplace_currency: "注文通貨が一致",
      marketplace_total: "注文合計が一致",
      seller_orders: "SellerOrderが1件",
      platform_store: "運営直販店舗の注文",
      seller_order_lines: "商品行と数量・金額が一致",
      paid_ledger_count: "売上台帳が1回だけ計上",
      paid_ledger_direction: "売上がcredit方向",
      paid_ledger_currency: "売上台帳の通貨が一致",
      paid_ledger_amount: "売上台帳の金額が一致",
      paid_ledger_seller: "売上台帳の販売者が一致",
      seller_order_shadow: "既存計算とSellerOrderが一致",
      shopify_refund_transaction_present:
        "Shopify Paymentsの返金取引を確認",
      shopify_refund_transaction_status: "返金取引が成功済み",
      shopify_refund_transaction_gateway: "返金元がShopify Payments",
      shopify_refund_transaction_live: "本番返金であることを確認",
      shopify_refund_transaction_parent: "元の決済取引への返金",
      shopify_refund_transaction_amount: "返金額が注文合計と一致",
      shopify_refund_transaction_currency: "返金通貨が注文通貨と一致",
      shopify_financial_status: "Shopifyが全額返金済み",
      shopify_refund_total: "Shopify返金総額が一致",
      shopify_refund_record: "返金レコードが1件",
      seller_order_refund_amount: "SellerOrder返金額が一致",
      seller_order_refund_quantity: "全商品数量が返金済み",
      refund_ledger_count: "返金台帳が1回だけ計上",
      refund_ledger_direction: "返金がdebit方向",
      refund_ledger_currency: "返金台帳の通貨が一致",
      refund_ledger_seller: "返金台帳の販売者が一致",
      refund_ledger_identifiers: "Shopify返金IDが一致",
      reversal_amount: "売上と差引金額が一致",
      cancellation_no_double_debit: "キャンセルとの二重差引がない",
    }[id] || id
  );
}

const styles = {
  page: {
    display: "grid",
    gap: 20,
    maxWidth: 1180,
    margin: "0 auto",
    padding: 24,
    color: "#101828",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    padding: "16px 0 20px",
    borderBottom: "1px solid #dfe3e8",
  },
  eyebrow: {
    margin: "0 0 6px",
    color: "#475467",
    fontSize: 12,
    fontWeight: 700,
  },
  title: { margin: 0, fontSize: 30, letterSpacing: 0 },
  lead: { margin: "10px 0 0", color: "#475467", lineHeight: 1.7 },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 32,
    padding: "4px 10px",
    borderRadius: 6,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  badgeSuccess: { background: "#ecfdf3", color: "#067647" },
  badgeWarning: { background: "#fffaeb", color: "#b54708" },
  badgeNeutral: { background: "#f2f4f7", color: "#344054" },
  notice: {
    display: "grid",
    gap: 6,
    padding: 16,
    borderLeft: "4px solid #475467",
    background: "#f7f8fa",
    lineHeight: 1.6,
  },
  section: {
    display: "grid",
    gap: 18,
    padding: "24px 0",
    borderBottom: "1px solid #dfe3e8",
  },
  sectionHeading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap",
  },
  sectionTitle: { margin: 0, fontSize: 21, letterSpacing: 0 },
  text: { margin: "6px 0 0", color: "#475467", lineHeight: 1.7 },
  release: { color: "#667085", fontSize: 13, overflowWrap: "anywhere" },
  form: { display: "grid", gap: 14, maxWidth: 620 },
  label: { display: "grid", gap: 7, fontWeight: 700 },
  hint: { color: "#667085", fontSize: 13, fontWeight: 400, lineHeight: 1.6 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 44,
    padding: "9px 12px",
    border: "1px solid #98a2b3",
    borderRadius: 6,
    font: "inherit",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  primaryButton: {
    minHeight: 42,
    padding: "8px 16px",
    border: 0,
    borderRadius: 6,
    background: "#101828",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    minHeight: 42,
    padding: "8px 16px",
    border: "1px solid #98a2b3",
    borderRadius: 6,
    background: "#fff",
    color: "#101828",
    fontWeight: 700,
    cursor: "pointer",
  },
  cancelForm: { marginTop: 4 },
  textButton: {
    padding: 0,
    border: 0,
    background: "transparent",
    color: "#b42318",
    textDecoration: "underline",
    cursor: "pointer",
  },
  error: {
    margin: 0,
    padding: 12,
    border: "1px solid #fda29b",
    borderRadius: 6,
    background: "#fef3f2",
    color: "#b42318",
  },
  success: {
    margin: 0,
    padding: 12,
    border: "1px solid #84e1bc",
    borderRadius: 6,
    background: "#ecfdf3",
    color: "#067647",
  },
  pending: {
    margin: 0,
    padding: 12,
    background: "#fffaeb",
    color: "#b54708",
  },
  steps: {
    display: "grid",
    gap: 14,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: { display: "grid", gridTemplateColumns: "34px 1fr", gap: 12 },
  stepNumber: {
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    border: "1px solid #98a2b3",
    borderRadius: "50%",
    color: "#475467",
    fontWeight: 700,
  },
  stepNumberDone: {
    borderColor: "#12b76a",
    background: "#ecfdf3",
    color: "#067647",
  },
  stepDetail: {
    display: "block",
    marginTop: 4,
    color: "#667085",
    lineHeight: 1.6,
  },
  summary: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 1,
    margin: 0,
    background: "#dfe3e8",
    border: "1px solid #dfe3e8",
  },
  summaryItem: { padding: 14, background: "#fff" },
  summaryLabel: { color: "#667085", fontSize: 12 },
  summaryValue: { margin: "5px 0 0", fontWeight: 700 },
  inspection: { display: "grid", gap: 10, paddingTop: 8 },
  inspectionTitle: { margin: 0, fontSize: 17 },
  checks: {
    display: "grid",
    gap: 8,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  check: { display: "grid", gridTemplateColumns: "22px 1fr", gap: 8 },
  checkPassed: { color: "#067647", fontWeight: 700 },
  checkPending: { color: "#b54708", fontWeight: 700 },
  checkReason: {
    display: "block",
    marginTop: 2,
    color: "#667085",
    fontWeight: 400,
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 680 },
  th: {
    padding: "10px 8px",
    borderBottom: "1px solid #dfe3e8",
    textAlign: "left",
    color: "#475467",
  },
  td: {
    padding: "12px 8px",
    borderBottom: "1px solid #eaecf0",
    verticalAlign: "top",
    overflowWrap: "anywhere",
  },
  footer: { padding: "4px 0 24px" },
};
