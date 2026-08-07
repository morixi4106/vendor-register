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
  previewKomojuZeroBalanceLimitedLaunch,
  recordKomojuZeroBalanceLimitedLaunch,
} from "../services/komojuLimitedLaunch.server.js";
import {
  inspectOperationalReadiness,
  KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
} from "../services/operationalReadiness.server.js";
import {
  attachOrderToProductionTransactionProbe,
  buildProductionTransactionProbePage,
  cancelProductionTransactionProbe,
  confirmProductionTransactionRefundReserve,
  createProductionTransactionProbe,
  getProductionTransactionProbePageData,
  inspectProductionTransactionProbePreflight,
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
  const preflight = await inspectProductionTransactionProbePreflight({
    shopDomain: session.shop,
    releaseExpectation,
    targetProvider: "KOMOJU",
    targetPaymentMethod: "CARD",
  });
  const operationalReadiness = await inspectOperationalReadiness();
  const limitedLaunch = operationalReadiness.rows.find(
    (row) =>
      row.definition.key === KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  );
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
        target: preflight.target,
      }),
      preflight,
      limitedLaunch: limitedLaunch || null,
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
      const preflight = await inspectProductionTransactionProbePreflight({
        shopDomain: session.shop,
        releaseExpectation,
        targetProvider: "KOMOJU",
        targetPaymentMethod: "CARD",
      });
      if (!preflight.canStart) {
        return json(
          {
            ok: false,
            reason: "production_transaction_preflight_failed",
            preflight,
          },
          { status: 409, headers: privateHeaders() },
        );
      }
      result = await createProductionTransactionProbe({
        shopDomain: session.shop,
        startedBy: operator.actorKey,
        releaseExpectation,
        targetProvider: "KOMOJU",
        targetPaymentMethod: "CARD",
        komojuCardOnlyConfirmed:
          formData.get("komojuCardOnlyConfirmed") === "yes",
        untestedAsyncMethodsDisabledConfirmed:
          formData.get("untestedAsyncMethodsDisabledConfirmed") === "yes",
        komojuLiveConfirmed: formData.get("komojuLiveConfirmed") === "yes",
        singleCardIntegrationConfirmed:
          formData.get("singleCardIntegrationConfirmed") === "yes",
        automaticCaptureConfirmed:
          formData.get("automaticCaptureConfirmed") === "yes",
        releaseFreezeConfirmed:
          formData.get("releaseFreezeConfirmed") === "yes",
        externalSettingsEvidenceReference: formData.get(
          "externalSettingsEvidenceReference",
        ),
        externalSettingsEvidenceHash: formData.get(
          "externalSettingsEvidenceHash",
        ),
        payoutEvidenceStrategy: formData.get("payoutEvidenceStrategy"),
        maximumPlannedChargeAmount: formData.get("maximumPlannedChargeAmount"),
        confirmedRefundReserveAmount: formData.get(
          "confirmedRefundReserveAmount",
        ),
        confirmedKomojuUnsettledBalanceAmount: formData.get(
          "confirmedKomojuUnsettledBalanceAmount",
        ),
        zeroUnsettledBalanceConfirmed:
          formData.get("zeroUnsettledBalanceConfirmed") === "yes",
        companyRefundReserveConfirmed:
          formData.get("companyRefundReserveConfirmed") === "yes",
        directRefundFallbackConfirmed:
          formData.get("directRefundFallbackConfirmed") === "yes",
        domesticPlatformDirectOnlyConfirmed:
          formData.get("domesticPlatformDirectOnlyConfirmed") === "yes",
        limitedLaunchMaxOrderCount: formData.get(
          "limitedLaunchMaxOrderCount",
        ),
        limitedLaunchMaxGrossAmount: formData.get(
          "limitedLaunchMaxGrossAmount",
        ),
        limitedLaunchMaxOutstandingLiability: formData.get(
          "limitedLaunchMaxOutstandingLiability",
        ),
        komojuPayoutCycle: formData.get("komojuPayoutCycle"),
        expectedBankDepositAt: formData.get("expectedBankDepositAt"),
        komojuMinimumPayoutAmount: formData.get("komojuMinimumPayoutAmount"),
        estimatedProcessingFeeAmount: formData.get(
          "estimatedProcessingFeeAmount",
        ),
        payoutNotOnHoldConfirmed:
          formData.get("payoutNotOnHoldConfirmed") === "yes",
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
    } else if (intent === "confirm_refund_reserve") {
      result = await confirmProductionTransactionRefundReserve({
        probeId: formData.get("probeId"),
        actorKey: operator.actorKey,
        releaseExpectation,
        confirmedRefundReserveAmount: formData.get(
          "confirmedRefundReserveAmount",
        ),
        evidenceReference: formData.get("evidenceReference"),
        evidenceHash: formData.get("evidenceHash"),
        confirm: formData.get("confirm"),
      });
      if (result.ok) {
        result = await refreshProductionTransactionProbe({
          probeId: formData.get("probeId"),
          actorKey: operator.actorKey,
          releaseExpectation,
        });
      }
    } else if (intent === "preview_limited_launch") {
      result = await previewKomojuZeroBalanceLimitedLaunch({
        probeId: formData.get("probeId"),
        releaseExpectation,
        evidenceReference: formData.get("evidenceReference"),
        evidenceHash: formData.get("evidenceHash"),
      });
    } else if (intent === "record_limited_launch") {
      result = await recordKomojuZeroBalanceLimitedLaunch({
        probeId: formData.get("probeId"),
        actorKey: operator.actorKey,
        releaseExpectation,
        evidenceReference: formData.get("evidenceReference"),
        evidenceHash: formData.get("evidenceHash"),
        previewToken: formData.get("previewToken"),
        confirm: formData.get("confirm"),
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
  const limitedLaunchPreview = actionData?.preview || null;
  const busy = navigation.state !== "idle" || refreshFetcher.state !== "idle";

  useEffect(() => {
    if (
      !probe?.id ||
      ![
        "AWAITING_SETTLEMENT",
        "AWAITING_PAYOUT_EVIDENCE",
        "AWAITING_REFUND",
      ].includes(probe.status)
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
            KOMOJUクレジットカード1件で、注文・売上台帳・元取引への全額返金をまとめて照合します。
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

      {data.limitedLaunch?.ready ? (
        <section style={styles.success} role="status">
          <strong>国内運営直販の期限付き公開証跡が有効です。</strong>
          <span>
            有効期限: {formatDate(data.limitedLaunch.attestation?.expiresAt)}。
            期限までに同じ注文の全額返金E2Eを完了してください。
          </span>
        </section>
      ) : null}

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

            <div style={styles.preflight}>
              <h3 style={styles.inspectionTitle}>決済前の自動確認</h3>
              <ul style={styles.checks}>
                {data.preflight.checks.map((item) => (
                  <li key={item.id} style={styles.check}>
                    <span
                      style={
                        item.passed ? styles.checkPassed : styles.checkPending
                      }
                      aria-hidden="true"
                    >
                      {item.passed ? "✓" : "•"}
                    </span>
                    <span>
                      <strong>{preflightLabel(item.id)}</strong>
                      <span style={styles.checkReason}>{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {!activeProbe && probe?.status !== "PASSED" ? (
              <Form method="post" style={styles.form}>
                <input type="hidden" name="intent" value="start_probe" />
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="komojuCardOnlyConfirmed"
                    value="yes"
                    required
                  />
                  今回はKOMOJUクレジットカードだけを本番確認します
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="untestedAsyncMethodsDisabledConfirmed"
                    value="yes"
                    required
                  />
                  未検証のコンビニ・Pay-easy等はShopifyで無効にしました
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="komojuLiveConfirmed"
                    value="yes"
                    required
                  />
                  KOMOJUが本番モードであることを確認しました
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="singleCardIntegrationConfirmed"
                    value="yes"
                    required
                  />
                  KOMOJUカード連携は1種類だけ有効です
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="automaticCaptureConfirmed"
                    value="yes"
                    required
                  />
                  支払い確定は自動で、注文直後に売上確定されます
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="releaseFreezeConfirmed"
                    value="yes"
                    required
                  />
                  完了までRender・Shopify App・Functionのリリースを変更しません
                </label>
                <label style={styles.label}>
                  入金証拠の使い方
                  <select
                    style={styles.input}
                    name="payoutEvidenceStrategy"
                    defaultValue={
                      data.preflight.payoutEvidence
                        ?.existingReconciledPayoutAvailable
                        ? "EXISTING_RECONCILED_PAYOUT"
                        : "CURRENT_PAYMENT_WITH_REFUND_RESERVE"
                    }
                    required
                  >
                    <option
                      value="EXISTING_RECONCILED_PAYOUT"
                      disabled={
                        !data.preflight.payoutEvidence
                          ?.existingReconciledPayoutAvailable
                      }
                    >
                      既存の直接照合済みPayoutを使う（推奨）
                    </option>
                    <option value="CURRENT_PAYMENT_WITH_REFUND_RESERVE">
                      今回の決済を銀行着金まで待つ
                    </option>
                    <option value="ZERO_BALANCE_LIMITED_LAUNCH">
                      新規KOMOJU（未精算残高0円）の7日間限定公開
                    </option>
                  </select>
                  <span style={styles.hint}>
                    期限付き公開では、KOMOJU残高ではなく会社資金として全額返金分を確保します。
                  </span>
                </label>
                <label style={styles.label}>
                  今回の支払上限（送料・税を含む円額）
                  <input
                    style={styles.input}
                    name="maximumPlannedChargeAmount"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="例: 3000"
                    required
                  />
                </label>
                <label style={styles.label}>
                  確認済みの返金原資（円）
                  <input
                    style={styles.input}
                    name="confirmedRefundReserveAmount"
                    type="number"
                    min="1"
                    step="1"
                    required
                  />
                  <span style={styles.hint}>
                    通常方式はKOMOJU未精算残高、期限付き公開は会社資金を入力します。支払上限以上が必要です。
                  </span>
                </label>
                <fieldset style={styles.preflight}>
                  <legend style={styles.inspectionTitle}>
                    未精算残高0円の期限付き公開を選ぶ場合のみ
                  </legend>
                  <label style={styles.label}>
                    確認したKOMOJU未精算残高（円）
                    <input
                      style={styles.input}
                      name="confirmedKomojuUnsettledBalanceAmount"
                      type="number"
                      min="0"
                      max="0"
                      step="1"
                      placeholder="0"
                    />
                  </label>
                  <label style={styles.confirmationLabel}>
                    <input
                      type="checkbox"
                      name="zeroUnsettledBalanceConfirmed"
                      value="yes"
                    />
                    KOMOJU本番画面で未精算残高0円を確認しました
                  </label>
                  <label style={styles.confirmationLabel}>
                    <input
                      type="checkbox"
                      name="companyRefundReserveConfirmed"
                      value="yes"
                    />
                    注文全額以上の返金原資を会社資金として確保しました
                  </label>
                  <label style={styles.confirmationLabel}>
                    <input
                      type="checkbox"
                      name="directRefundFallbackConfirmed"
                      value="yes"
                    />
                    KOMOJU返金不能時は、購入者の同意を得た代替返金手順で対応できます
                  </label>
                  <label style={styles.confirmationLabel}>
                    <input
                      type="checkbox"
                      name="domesticPlatformDirectOnlyConfirmed"
                      value="yes"
                    />
                    7日間は国内の運営直販だけを扱い、第三者販売とEU販売を開始しません
                  </label>
                  <label style={styles.label}>
                    限定公開中の最大注文件数（テスト注文を含む）
                    <input
                      style={styles.input}
                      name="limitedLaunchMaxOrderCount"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="例: 3"
                    />
                  </label>
                  <label style={styles.label}>
                    限定公開中の累計売上上限（円）
                    <input
                      style={styles.input}
                      name="limitedLaunchMaxGrossAmount"
                      type="number"
                      min="1"
                      step="1"
                    />
                  </label>
                  <label style={styles.label}>
                    未返金債務の上限（円）
                    <input
                      style={styles.input}
                      name="limitedLaunchMaxOutstandingLiability"
                      type="number"
                      min="1"
                      step="1"
                    />
                  </label>
                  <label style={styles.label}>
                    KOMOJUの振込サイクル
                    <select style={styles.input} name="komojuPayoutCycle">
                      <option value="">選択してください</option>
                      <option value="WEEKLY">週次</option>
                      <option value="MONTHLY">月次</option>
                    </select>
                  </label>
                  <label style={styles.label}>
                    次回の銀行着金見込み
                    <input
                      style={styles.input}
                      name="expectedBankDepositAt"
                      type="datetime-local"
                    />
                  </label>
                  <label style={styles.label}>
                    KOMOJUの最低振込額（円）
                    <input
                      style={styles.input}
                      name="komojuMinimumPayoutAmount"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="例: 1000"
                    />
                  </label>
                  <label style={styles.label}>
                    今回の決済手数料見込（円）
                    <input
                      style={styles.input}
                      name="estimatedProcessingFeeAmount"
                      type="number"
                      min="0"
                      step="1"
                    />
                  </label>
                  <label style={styles.confirmationLabel}>
                    <input
                      type="checkbox"
                      name="payoutNotOnHoldConfirmed"
                      value="yes"
                    />
                    KOMOJUの振込が保留されていないことを確認しました
                  </label>
                </fieldset>
                <label style={styles.label}>
                  外部設定の確認証跡
                  <input
                    style={styles.input}
                    name="externalSettingsEvidenceReference"
                    placeholder="KOMOJU/Shopify画面の保存先またはチケット番号"
                    required
                  />
                </label>
                <label style={styles.label}>
                  証跡SHA-256
                  <input
                    style={styles.input}
                    name="externalSettingsEvidenceHash"
                    pattern="[A-Fa-f0-9]{64}"
                    placeholder="64桁のSHA-256"
                    required
                  />
                </label>
                <button
                  style={styles.primaryButton}
                  disabled={busy || !data.preflight.canStart}
                >
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
                    CheckoutからKOMOJUクレジットカードで購入し、#1234またはOrder
                    GIDを入力します。
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

            {activeProbe?.status === "AWAITING_REFUND_RESERVE_CONFIRMATION" ? (
              <Form method="post" style={styles.form}>
                <input
                  type="hidden"
                  name="intent"
                  value="confirm_refund_reserve"
                />
                <input type="hidden" name="probeId" value={activeProbe.id} />
                <label style={styles.label}>
                  現在確認できるKOMOJU未精算残高（円）
                  <input
                    style={styles.input}
                    name="confirmedRefundReserveAmount"
                    type="number"
                    min="1"
                    step="1"
                    required
                  />
                  <span style={styles.hint}>
                    今回の全額返金額以上であることを、返金直前にもう一度確認します。
                  </span>
                </label>
                <label style={styles.label}>
                  再確認した証跡の保存先
                  <input
                    style={styles.input}
                    name="evidenceReference"
                    placeholder="KOMOJU残高画面の保存先またはチケット番号"
                    required
                  />
                </label>
                <label style={styles.label}>
                  証跡SHA-256
                  <input
                    style={styles.input}
                    name="evidenceHash"
                    pattern="[A-Fa-f0-9]{64}"
                    placeholder="64桁のSHA-256"
                    required
                  />
                </label>
                <label style={styles.confirmationLabel}>
                  <input
                    type="checkbox"
                    name="confirm"
                    value="refund_reserve_reconfirmed"
                    required
                  />
                  現在の未精算残高で今回の全額返金が可能であることを確認しました
                </label>
                <button style={styles.primaryButton} disabled={busy}>
                  返金原資を再確認して次へ
                </button>
              </Form>
            ) : null}

            {activeProbe?.status === "AWAITING_PAYOUT_EVIDENCE" &&
            activeProbe.orderEvidence?.externalReadiness?.strategy ===
              "ZERO_BALANCE_LIMITED_LAUNCH" &&
            !data.limitedLaunch?.ready ? (
              <div style={styles.form}>
                <h3 style={styles.inspectionTitle}>
                  7日間の国内直販限定公開を記録
                </h3>
                <p style={styles.text}>
                  売上・SellerOrder・台帳・Shadow・KOMOJUカード取引の一致確認後だけ利用できます。
                  厳格な全額返金E2Eは免除されず、7日以内の完了が必要です。
                </p>
                {!limitedLaunchPreview ? (
                  <Form method="post" style={styles.form}>
                    <input
                      type="hidden"
                      name="intent"
                      value="preview_limited_launch"
                    />
                    <input
                      type="hidden"
                      name="probeId"
                      value={activeProbe.id}
                    />
                    <label style={styles.label}>
                      証跡一式の保存先
                      <input
                        style={styles.input}
                        name="evidenceReference"
                        placeholder="KOMOJU残高・会社返金原資・代替返金手順の保存先"
                        required
                      />
                    </label>
                    <label style={styles.label}>
                      証跡一式のSHA-256
                      <input
                        style={styles.input}
                        name="evidenceHash"
                        pattern="[A-Fa-f0-9]{64}"
                        placeholder="64桁のSHA-256"
                        required
                      />
                    </label>
                    <button style={styles.primaryButton} disabled={busy}>
                      確定内容をプレビュー
                    </button>
                  </Form>
                ) : (
                  <Form method="post" style={styles.form}>
                    <input
                      type="hidden"
                      name="intent"
                      value="record_limited_launch"
                    />
                    <input
                      type="hidden"
                      name="probeId"
                      value={activeProbe.id}
                    />
                    <input
                      type="hidden"
                      name="previewToken"
                      value={limitedLaunchPreview.previewToken}
                    />
                    <input
                      type="hidden"
                      name="evidenceReference"
                      value={limitedLaunchPreview.evidenceReference}
                    />
                    <input
                      type="hidden"
                      name="evidenceHash"
                      value={limitedLaunchPreview.evidenceHash}
                    />
                    <div style={styles.previewPanel}>
                      <strong>一度だけ使える最終確認</strong>
                      <span>
                        Release: {limitedLaunchPreview.releaseId}
                      </span>
                      <span>
                        注文: {limitedLaunchPreview.shopifyOrderId} / 売上: {limitedLaunchPreview.actualPaidAmount.toLocaleString()} {limitedLaunchPreview.currencyCode}
                      </span>
                      <span>
                        期限: {formatDate(limitedLaunchPreview.completionDeadline)}
                      </span>
                      <span>
                        上限: {limitedLaunchPreview.maxOrderCount}件 / 累計 {limitedLaunchPreview.maxGrossAmount.toLocaleString()}円 / 未返金債務 {limitedLaunchPreview.maxOutstandingLiability.toLocaleString()}円
                      </span>
                      <span>
                        会社返金予備資金: {limitedLaunchPreview.companyRefundReserveAmount.toLocaleString()}円
                      </span>
                      <span>
                        対象商品: {limitedLaunchPreview.allowedProducts.map((product) => product.name).join("、")}
                      </span>
                      <span>
                        証跡: {limitedLaunchPreview.evidenceReference}
                      </span>
                      <code style={styles.previewHash}>
                        SHA-256: {limitedLaunchPreview.evidenceHash}
                      </code>
                      <span>
                        このプレビューは{formatDate(limitedLaunchPreview.expiresAt)}まで有効です。
                      </span>
                    </div>
                    <label style={styles.confirmationLabel}>
                      <input
                        type="checkbox"
                        name="confirm"
                        value="activate_zero_balance_limited_launch"
                        required
                      />
                      内容を確認しました。確定後は延長・別注文への付け替え・証跡変更ができないことを了承します
                    </label>
                    <button style={styles.primaryButton} disabled={busy}>
                      一度限りの期限付き公開証跡を確定
                    </button>
                  </Form>
                )}
              </div>
            ) : null}

            {activeProbe &&
            [
              "AWAITING_SETTLEMENT",
              "AWAITING_PAYOUT_EVIDENCE",
              "AWAITING_REFUND_RESERVE_CONFIRMATION",
              "AWAITING_REFUND",
            ].includes(activeProbe.status) ? (
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
                  label="決済対象"
                  value={paymentTargetLabel(probe.paymentTarget)}
                />
                <Summary
                  label="Shopify注文"
                  value={probe.orderEvidence.shopifyOrderName || "未登録"}
                />
                <Summary label="開始日時" value={formatDate(probe.startedAt)} />
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
                <span style={styles.checkReason}>{reasonLabel(item.code)}</span>
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
      AWAITING_PAYOUT_EVIDENCE: "KOMOJU入金証跡待ち",
      AWAITING_REFUND_RESERVE_CONFIRMATION: "返金原資の再確認待ち",
      AWAITING_REFUND: "全額返金待ち",
      PASSED: "完了",
      INVALIDATED: "リリース変更で無効",
      CANCELLED: "中止",
    }[status] || status
  );
}

function paymentTargetLabel(target) {
  if (target?.provider === "KOMOJU" && target?.paymentMethod === "CARD") {
    return "KOMOJUクレジットカード";
  }
  if (target?.provider === "SHOPIFY_PAYMENTS") {
    return "Shopify Payments";
  }
  return "未設定";
}

function preflightLabel(id) {
  return (
    {
      release_configured: "現在のリリースを特定",
      purchase_control_release_ready: "購入制御Functionを確認",
      payment_provider_configured: "KOMOJUのサーバー設定",
      komoju_operations_enabled: "KOMOJU決済運用の記録",
      refund_confirmation_enforced: "返金確認の安全制御",
      payment_operations_clean: "未解決の決済運用",
      checkout_available: "購入緊急停止の状態",
      publication_boundary_ready: "第三者商品の公開境界",
      eligible_platform_product_available: "運営直販の購入対象",
      payment_target_supported: "決済対象",
    }[id] || id
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
      production_transaction_preflight_failed:
        "決済前の自動確認に未合格の項目があります。実決済の前に解消してください。",
      komoju_scope_confirmation_required:
        "KOMOJUカードだけを確認することと、未検証の決済方法を無効にしたことを確認してください。",
      komoju_external_readiness_missing:
        "KOMOJUの本番設定証跡、入金証跡の方針、決済予定上限を入力してください。",
      existing_reconciled_payout_required:
        "決済済み注文へ直接紐づいた既存のKOMOJU入金証跡がありません。現在の決済を待つ方式を選ぶ場合は返金原資も確認してください。",
      komoju_refund_reserve_insufficient:
        "確認済みのKOMOJU未精算残高が決済予定上限を下回っています。銀行着金後も全額返金できる原資を確保してください。",
      komoju_limited_launch_confirmation_required:
        "期限付き公開には、KOMOJU残高0円・会社返金原資・代替返金手順・国内直販限定の確認が必要です。",
      limited_launch_exception_required:
        "売上照合は完了しました。入金を待つか、期限付き国内直販の証跡を記録してください。",
      limited_launch_confirmation_invalid:
        "期限付き公開の確認内容と64桁の証跡SHA-256を確認してください。",
      limited_launch_probe_not_eligible:
        "現在の注文またはリリースは期限付き公開の対象状態ではありません。",
      limited_launch_paid_evidence_incomplete:
        "売上・台帳・KOMOJUカード取引の照合、または会社返金原資の確認が完了していません。",
      limited_launch_scope_not_restricted:
        "第三者販売またはEU販売が有効なため、国内運営直販限定の例外を利用できません。",
      limited_launch_exception_already_used:
        "この期限付き公開枠はすでに使用済みです。延長や別注文への付け替えはできません。",
      limited_launch_preview_unavailable:
        "安全な最終プレビューを作成できません。Shopify API Secretの本番設定を確認してください。",
      limited_launch_preview_changed:
        "プレビュー後にリリース、注文、商品、上限または証跡が変わったか、15分を経過しました。もう一度プレビューしてください。",
      komoju_refund_reserve_reconfirmation_required:
        "入金証拠の確認後に、現在のKOMOJU未精算残高を証跡付きで再確認してください。",
      komoju_refund_reserve_reconfirmation_invalid:
        "返金原資の金額または証跡が不十分です。支払上限以上の残高と64桁のSHA-256を入力してください。",
      refund_reserve_confirmation_not_available:
        "返金原資を再確認できる状態ではありません。画面を更新してください。",
      order_exceeds_confirmed_charge_plan:
        "注文合計が決済前に確認した上限を超えています。この注文は証跡に利用できません。",
      active_probe_payment_target_mismatch:
        "進行中の確認と決済対象が異なります。古い確認を中止してから開始してください。",
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
      order_predates_probe: "確認開始前に作成された注文は利用できません。",
      order_not_paid: "支払い済みで未返金の注文を指定してください。",
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
      paid_ledger_count_mismatch: "売上台帳の反映待ち、または件数不一致です。",
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
      payment_transaction_missing: "対象決済の売上取引がまだ確認できません。",
      payment_transaction_not_captured:
        "対象決済の売上取引が成功状態ではありません。",
      payment_transaction_provider_mismatch:
        "選択した決済プロバイダー以外の注文です。",
      payment_transaction_method_mismatch:
        "KOMOJUクレジットカード以外の決済方法です。",
      payment_transaction_count_mismatch:
        "成功した売上取引が1件ではありません。追加決済や分割決済がないか確認してください。",
      payment_attempt_direct_match_missing:
        "Shopifyの売上取引と同じKOMOJU決済試行を1件に特定できません。返金や入金登録へ進まないでください。",
      payment_transaction_is_test:
        "テスト決済の取引は本番証跡に利用できません。",
      payment_transaction_amount_mismatch: "決済額と注文合計が一致しません。",
      payment_transaction_currency_mismatch:
        "決済通貨と注文通貨が一致しません。",
      refund_transaction_missing:
        "対象決済の成功した返金取引がまだ確認できません。",
      refund_transaction_not_successful:
        "返金取引がすべて成功状態になるまで待ってください。",
      refund_transaction_provider_mismatch:
        "元の決済プロバイダー以外で処理された返金です。",
      refund_transaction_method_mismatch:
        "元のKOMOJUカード決済に対応する返金ではありません。",
      refund_transaction_is_test:
        "テスト返金の取引は本番証跡に利用できません。",
      refund_transaction_parent_mismatch:
        "返金取引が元の決済取引に紐づいていません。",
      refund_transaction_amount_mismatch: "返金額と注文合計が一致しません。",
      refund_transaction_currency_mismatch:
        "返金通貨と注文通貨が一致しません。",
      refund_ledger_count_mismatch:
        "返金Webhookと返金台帳の反映待ち、または件数不一致です。",
      existing_reconciled_payout_missing:
        "選択した既存のKOMOJU入金証跡が無効または削除されています。返金前に証跡を確認してください。",
      current_payment_payout_evidence_missing:
        "今回のKOMOJU決済へ直接紐づく銀行着金証跡がまだありません。決済運用画面で入金明細と決済試行を照合してください。",
      payout_evidence_strategy_missing:
        "KOMOJU入金証跡の確認方針を特定できません。新しい確認を開始してください。",
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
      shopify_payment_transaction_present: "Shopify Paymentsの売上取引を確認",
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
      shopify_refund_transaction_present: "Shopify Paymentsの返金取引を確認",
      shopify_refund_transaction_status: "返金取引が成功済み",
      shopify_refund_transaction_gateway: "返金元がShopify Payments",
      shopify_refund_transaction_live: "本番返金であることを確認",
      shopify_refund_transaction_parent: "元の決済取引への返金",
      shopify_refund_transaction_amount: "返金額が注文合計と一致",
      shopify_refund_transaction_currency: "返金通貨が注文通貨と一致",
      payment_transaction_present: "対象決済の売上取引を確認",
      payment_transaction_single: "成功した売上取引が1件だけ",
      payment_transaction_status: "売上取引が成功済み",
      payment_transaction_provider: "決済プロバイダーが一致",
      payment_transaction_method: "KOMOJUカード決済であることを確認",
      payment_transaction_live: "本番取引であることを確認",
      payment_transaction_amount: "決済額が注文合計と一致",
      payment_transaction_currency: "決済通貨が注文通貨と一致",
      payment_attempt_direct_match: "Shopify売上取引とKOMOJU決済試行が直接一致",
      refund_transaction_present: "対象決済の返金取引を確認",
      refund_transaction_status: "返金取引が成功済み",
      refund_transaction_provider: "返金元のプロバイダーが一致",
      refund_transaction_method: "KOMOJUカード返金であることを確認",
      refund_transaction_live: "本番返金であることを確認",
      refund_transaction_parent: "元の決済取引への返金",
      refund_transaction_amount: "返金額が注文合計と一致",
      refund_transaction_currency: "返金通貨が注文通貨と一致",
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
  preflight: {
    display: "grid",
    gap: 12,
    padding: 16,
    border: "1px solid #d0d5dd",
    borderRadius: 6,
    background: "#f9fafb",
  },
  form: { display: "grid", gap: 14, maxWidth: 620 },
  previewPanel: {
    display: "grid",
    gap: 8,
    padding: 16,
    border: "1px solid #f79009",
    borderRadius: 6,
    background: "#fffaeb",
    lineHeight: 1.6,
  },
  previewHash: {
    padding: 10,
    overflowWrap: "anywhere",
    background: "#fff",
    border: "1px solid #fedf89",
  },
  label: { display: "grid", gap: 7, fontWeight: 700 },
  confirmationLabel: {
    display: "grid",
    gridTemplateColumns: "20px 1fr",
    alignItems: "start",
    gap: 9,
    lineHeight: 1.6,
  },
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
