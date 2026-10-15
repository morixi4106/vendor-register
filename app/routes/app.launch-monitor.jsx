import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { Icon } from "@shopify/polaris";
import { CheckIcon, EmailIcon, RefreshIcon } from "@shopify/polaris-icons";

import prisma from "../db.server.js";
import { buildLaunchMonitorGuide } from "../services/launchMonitorGuide.js";
import { inspectLaunchMonitorStatus } from "../services/launchMonitorStatus.server.js";
import { LAUNCH_MONITOR_HEARTBEAT_KEY } from "../services/launchMonitor.server.js";
import { requirePrivacyOperator } from "../utils/privacyOperator.server.js";
import { readBoundedFormData } from "../utils/requestBody.server.js";
import {
  acknowledgeMonitorIncident,
  confirmMonitorReceipt,
  getMonitorAcknowledgement,
  getMonitorReceiptStatus,
  refreshMonitorReceipt,
  sendMonitorReceiptTest,
} from "../services/monitorNotification.server.js";

export async function loader({ request }) {
  await requirePrivacyOperator(request);
  const heartbeat = await prisma.operationalHeartbeat.findUnique({
    where: { key: LAUNCH_MONITOR_HEARTBEAT_KEY },
  });
  const monitorEnabled = isEnabled(process.env.LAUNCH_MONITOR_ENABLED);
  const notification = await getMonitorReceiptStatus();
  const status = await inspectLaunchMonitorStatus({
    monitorHeartbeat: heartbeat,
    notification,
  });
  const guide = buildLaunchMonitorGuide({
    enabled: monitorEnabled,
    metadata: heartbeat?.metadataJson || {},
    status,
  });
  return Response.json(
    {
      heartbeat,
      guide,
      notification,
      status,
      acknowledgement: await getMonitorAcknowledgement({
        incidentKey: heartbeat?.metadataJson?.incidentKey,
      }),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function action({ request }) {
  const { operator } = await requirePrivacyOperator(request);
  const form = await readBoundedFormData(request, 8000);
  try {
    const intent = form.get("intent");
    if (intent === "send-receipt-test") await sendMonitorReceiptTest();
    else if (intent === "confirm-receipt")
      await confirmMonitorReceipt({
        code: form.get("code"),
        actor: operator.actorKey,
      });
    else if (intent === "refresh-delivery") await refreshMonitorReceipt();
    else if (intent === "ack-incident")
      await acknowledgeMonitorIncident({
        incidentKey: form.get("incidentKey"),
        actor: operator.actorKey,
      });
    else
      return Response.json(
        { ok: false, error: "invalid_action" },
        { status: 400 },
      );
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, error: "notification_check_failed" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export default function LaunchMonitorPage() {
  const { heartbeat, guide, notification, acknowledgement, status } =
    useLoaderData();
  const actionData = useActionData();
  const busy = useNavigation().state !== "idle";
  const metadata = heartbeat?.metadataJson || {};
  const report = metadata.lastReport || {};
  const checks = Array.isArray(report.checks) ? report.checks : [];
  return (
    <main style={styles.page}>
      <section style={styles.header}>
        <div>
          <h1 style={styles.title}>公開監視</h1>
        </div>
        <StatusBadge status={status.publication.status} />
      </section>

      <section style={styles.statusSection} aria-label="確認状況">
        <h2 style={styles.sectionTitle}>確認状況</h2>
        <div style={styles.statusGrid}>
          <section style={styles.statusGroup}>
            <h3 style={styles.statusTitle}>通知</h3>
            <StatusBadge status={status.notification.status} compact />
            <strong>{statusLabel(status.notification.code)}</strong>
            <StatusFacts
              rows={[
                [
                  "自動通知",
                  status.configuration.notificationMode === "live"
                    ? "本番通知"
                    : status.configuration.notificationMode === "prelaunch"
                      ? "公開前停止"
                      : "停止中",
                ],
                ["配信結果", eventLabel(status.notification.providerEvent)],
                ["本人確認", formatDate(status.notification.humanVerifiedAt)],
                ["テスト送信", formatDate(status.notification.sentAt)],
              ]}
            />
          </section>
          <section style={styles.statusGroup}>
            <h3 style={styles.statusTitle}>同期・監視</h3>
            <StatusBadge status={status.catalog.status} compact />
            <strong>{statusLabel(status.catalog.code)}</strong>
            <StatusFacts
              rows={[
                ["同期の最終成功", formatDate(status.catalog.lastSucceededAt)],
                [
                  "成功からの経過",
                  status.catalog.ageMinutes === null
                    ? "-"
                    : `${status.catalog.ageMinutes}分`,
                ],
                [
                  "同期の主担当設定",
                  status.configuration.scheduler === "render"
                    ? "Render"
                    : status.configuration.scheduler === "github"
                      ? "GitHub"
                      : "不明",
                ],
              ]}
            />
            <div style={styles.monitorRows}>
              {[
                ["通常監視", status.monitoring.current],
                ["整合性検査", status.monitoring.heavy],
                ["外部監視", status.monitoring.external],
              ].map(([label, check]) => (
                <div key={label} style={styles.monitorRow}>
                  <span>{label}</span>
                  <StatusBadge status={check.status} compact />
                  <span>
                    {statusLabel(check.code)} / {formatDate(check.checkedAt)}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section style={styles.statusGroup}>
            <h3 style={styles.statusTitle}>公開条件</h3>
            <StatusBadge status={status.publication.status} compact />
            <strong>{statusLabel(status.publication.code)}</strong>
            <StatusFacts
              rows={[
                ["重大な未解決項目", status.publication.criticalCount],
                ["注意項目", status.publication.warningCount],
                ["監視結果の日時", formatDate(status.publication.checkedAt)],
                [
                  "自動更新の許可設定",
                  status.configuration.maintenanceAuthorized ? "あり" : "なし",
                ],
              ]}
            />
            <Link to="/app/production-readiness" style={styles.guideLink}>
              本番確認
            </Link>
          </section>
        </div>
      </section>

      <section style={styles.grid}>
        <Metric label="監視開始" value={formatDate(metadata.startedAt)} />
        <Metric label="集中監視終了予定" value={formatDate(metadata.endsAt)} />
        <Metric label="最終確認" value={formatDate(metadata.lastCheckedAt)} />
        <Metric label="実行回数" value={String(metadata.runCount || 0)} />
      </section>

      <section style={styles.panel}>
        <div style={styles.guideHeader}>
          <div>
            <h2 style={styles.sectionTitle}>運用ガイド</h2>
            <p style={styles.muted}>
              現在の監視結果から、次に確認する項目を順番に表示します。
            </p>
          </div>
          <StatusBadge status={guide.tone} compact />
        </div>
        <div>
          <strong style={styles.guideTitle}>{guide.title}</strong>
          <p style={styles.detail}>{guide.description}</p>
        </div>
        {guide.steps.length > 0 ? (
          <ol style={styles.guideList}>
            {guide.steps.map((step) => (
              <li key={step.id} style={styles.guideRow}>
                <div style={styles.guideRowInner}>
                  <div>
                    <strong>{step.title}</strong>
                    <p style={styles.detail}>{step.detail}</p>
                  </div>
                  {step.href ? (
                    <Link to={step.href} style={styles.guideLink}>
                      確認する
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p style={styles.noAction}>
            作業は不要です。次回の自動確認を待ちます。
          </p>
        )}
      </section>

      <section style={styles.panel}>
        <h2 style={styles.sectionTitle}>通知の受信確認</h2>
        <strong>
          {notification.ready ? "受信確認済み" : "受信確認が必要"}
        </strong>
        <span>配信状態: {notification.providerEvent}</span>
        {actionData ? (
          <p role="status">
            {actionData.ok
              ? "処理を完了しました。"
              : "確認できませんでした。設定と確認コードを確認してください。"}
          </p>
        ) : null}
        <div style={styles.guideRowInner}>
          <Form method="post">
            <button
              style={styles.command}
              title="通知テストを送信"
              name="intent"
              value="send-receipt-test"
              disabled={busy}
            >
              <Icon source={EmailIcon} tone="inherit" />
              通知テストを送信
            </button>
          </Form>
          <Form method="post">
            <button
              style={styles.command}
              title="配信状態を確認"
              name="intent"
              value="refresh-delivery"
              disabled={busy}
            >
              <Icon source={RefreshIcon} tone="inherit" />
              配信状態を確認
            </button>
          </Form>
          <Form method="post" style={styles.guideRowInner}>
            <input
              style={styles.codeInput}
              name="code"
              aria-label="受信確認コード"
              placeholder="受信確認コード"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={busy}
            />
            <button
              style={styles.command}
              title="受信を確認"
              name="intent"
              value="confirm-receipt"
              disabled={busy}
            >
              <Icon source={CheckIcon} tone="inherit" />
              受信を確認
            </button>
          </Form>
        </div>
        {metadata.incidentKey ? (
          <Form method="post">
            <input
              type="hidden"
              name="incidentKey"
              value={metadata.incidentKey}
            />
            <button
              name="intent"
              value="ack-incident"
              disabled={busy || acknowledgement.acknowledged}
            >
              異常を確認しました
            </button>
            {acknowledgement.acknowledged ? (
              <p>
                対応期限: {formatDate(acknowledgement.responseDueAt)}
                {acknowledgement.overdue ? "（期限超過）" : ""}
              </p>
            ) : null}
          </Form>
        ) : null}
      </section>

      <section style={styles.panel}>
        <h2 style={styles.sectionTitle}>最新結果</h2>
        {checks.length === 0 ? (
          <p style={styles.muted}>監視エージェントの初回実行待ちです。</p>
        ) : (
          <div style={styles.list}>
            {checks.map((check) => (
              <div key={check.id} style={styles.row}>
                <StatusBadge status={check.severity} compact />
                <div>
                  <strong>{checkLabel(check.id)}</strong>
                  <p style={styles.detail}>{check.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function StatusFacts({ rows }) {
  return (
    <dl style={styles.statusFacts}>
      {rows.map(([label, value]) => (
        <div key={label} style={styles.factRow}>
          <dt>{label}</dt>
          <dd style={styles.factValue}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Metric({ label, value }) {
  return (
    <div style={styles.metric}>
      <span style={styles.muted}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status, compact = false }) {
  const normalized = String(status || "waiting");
  const labels = {
    healthy: "正常",
    ok: "正常",
    warning: "注意",
    critical: "異常",
    waiting: "待機中",
  };
  const colors = {
    healthy: ["#e8fff4", "#087a55"],
    ok: ["#e8fff4", "#087a55"],
    warning: ["#fff8dc", "#8a5a00"],
    critical: ["#fff0f0", "#b42318"],
    waiting: ["#f2f4f7", "#475467"],
  };
  const [background, color] = colors[normalized] || colors.waiting;
  return (
    <span
      style={{
        ...styles.badge,
        background,
        color,
        ...(compact ? styles.badgeCompact : {}),
      }}
    >
      {labels[normalized] || normalized}
    </span>
  );
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(code) {
  const labels = {
    verified: "受信・配信確認済み",
    unavailable: "状態を取得できません",
    unconfigured: "通知設定または受信確認が未完了",
    delivery_failed: "通知の送信・配信に失敗",
    human_confirmation_required: "本人の受信確認待ち",
    delivery_confirmation_required: "有効な配信証拠が必要",
    timing_invalid: "同期の時間設定が不正",
    success_missing_or_invalid: "同期の成功記録を確認できません",
    latest_run_failed: "同期の直近実行が失敗",
    critical_stale: "同期の成功記録が期限切れ",
    warning_stale: "同期の成功から時間が経過",
    fresh: "成功記録は有効",
    disabled: "設定上は無効",
    missing_or_invalid: "有効な実行記録がありません",
    stale: "実行記録が期限切れ",
    report_missing_or_invalid: "監視結果を確認できません",
    report_stale: "新しい監視結果が必要",
    issues_pending: "監視上の未解決項目あり",
    monitor_issues_clear: "監視上の未解決項目なし",
  };
  return labels[code] || "未確認";
}

function eventLabel(event) {
  const labels = {
    pending: "配信結果待ち",
    sent: "送信済み",
    delivered: "配信済み",
    opened: "開封通知あり",
    clicked: "クリック通知あり",
    bounced: "バウンス",
    complained: "苦情通知あり",
    failed: "失敗",
    suppressed: "配信抑止",
  };
  return labels[event] || "未確認";
}

function checkLabel(id) {
  const labels = {
    database_connection: "データベース",
    render_http_5xx: "HTTP 5xx",
    render_app_errors: "アプリログ",
    render_auth_rejections: "認証拒否",
    render_rate_limits: "アクセス制限",
    render_log_collection: "Renderログ取得",
    render_backup_recovery: "バックアップ復旧可能期間",
    launch_monitor_notification_delivery: "通知の受信・配信確認",
    withdrawal_operations_available: "撤回運用データ",
    withdrawal_email_failures: "撤回メール失敗",
    withdrawal_email_outbox: "撤回メールキュー",
    withdrawal_email_worker_heartbeat: "撤回メールワーカー",
    withdrawal_processing_integrity: "撤回処理の整合性",
    seller_order_unresolved_shadow_checks: "SellerOrder差分",
    seller_ledger_repair_candidates: "売上台帳の補正候補",
    test_store_pending_payout_runs: "テスト店舗の出金予定",
    contact_inquiry_spike: "問い合わせ件数",
    public_root_redirect: "公開ルート",
    official_storefront: "正式ストア",
    shopify_product_catalog_sync_freshness: "商品カタログ同期",
    operational_attestation_legal_disclosures_reviewed:
      "法定表示・利用規約の確認",
    operational_attestation_checkout_final_screen_reviewed:
      "購入直前画面の表示確認",
    operational_attestation_unsupported_sales_surfaces_disabled:
      "未対応販売経路の無効化",
    operational_attestation_emergency_stop_drill_completed:
      "販売緊急停止の実地訓練",
    operational_attestation_refund_liquidity_confirmed: "返金原資の確認",
    operational_attestation_admin_mfa_access_reviewed: "管理者権限・MFAの確認",
    operational_attestation_privacy_incident_runbook_confirmed:
      "個人情報事故対応手順",
    operational_attestation_email_delivery_confirmed: "業務メールの実受信確認",
    operational_attestation_platform_direct_payment_flow_verified:
      "KOMOJU決済・注文・台帳照合",
    heavy_checks_not_initialized: "重い整合性検査",
    launch_integrity: "業務データ整合性",
  };
  return labels[id] || id;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

const styles = {
  statusSection: { display: "grid", gap: 18, minWidth: 0 },
  statusGrid: {
    display: "grid",
    gap: 24,
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  },
  statusGroup: {
    display: "grid",
    gap: 12,
    alignContent: "start",
    justifyItems: "start",
    minWidth: 0,
    padding: "16px 0",
    borderTop: "1px solid #dfe3e8",
    overflowWrap: "anywhere",
  },
  statusTitle: { margin: 0, fontSize: 18 },
  statusFacts: { display: "grid", gap: 8, margin: 0, width: "100%" },
  factRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: 12,
  },
  factValue: { margin: 0, minWidth: 0 },
  monitorRows: { display: "grid", gap: 12 },
  monitorRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  command: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    padding: "8px 16px",
    border: "1px solid #101828",
    borderRadius: 6,
    background: "#101828",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  codeInput: {
    width: 180,
    maxWidth: "100%",
    minHeight: 40,
    boxSizing: "border-box",
    padding: "8px 12px",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    fontSize: 16,
  },
  page: {
    display: "grid",
    gap: 24,
    padding: "24px 16px",
    maxWidth: 1400,
    margin: "0 auto",
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    padding: 24,
    border: "1px solid #dfe3e8",
    background: "#fff",
    borderRadius: 8,
  },
  title: { margin: 0, fontSize: 30 },
  sectionTitle: { margin: 0, fontSize: 22 },
  muted: { margin: "8px 0 0", color: "#667085" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: 12,
  },
  metric: {
    display: "grid",
    gap: 8,
    padding: 18,
    border: "1px solid #dfe3e8",
    background: "#fff",
    borderRadius: 8,
  },
  panel: {
    display: "grid",
    gap: 18,
    padding: 24,
    border: "1px solid #dfe3e8",
    background: "#fff",
    borderRadius: 8,
    minWidth: 0,
  },
  guideHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  },
  guideTitle: { display: "block", fontSize: 18 },
  guideList: { margin: 0, paddingLeft: 24 },
  guideRow: {
    padding: "16px 0",
    borderBottom: "1px solid #eaecf0",
  },
  guideRowInner: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 18,
  },
  guideLink: {
    color: "#101828",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  noAction: {
    margin: 0,
    padding: "14px 0",
    color: "#087a55",
    fontWeight: 700,
  },
  list: { display: "grid" },
  row: {
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr)",
    gap: 14,
    padding: "16px 0",
    borderBottom: "1px solid #eaecf0",
  },
  detail: { margin: "6px 0 0", color: "#475467" },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
    padding: "0 14px",
    borderRadius: 999,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  badgeCompact: { minHeight: 28, padding: "0 10px", fontSize: 13 },
};
