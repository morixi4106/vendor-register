import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import {
  backfillPaymentAttemptsFromPaidLedger,
  confirmManualPaymentRefundOperation,
  getPaymentOperationsDashboard,
  previewPaymentAttemptsFromPaidLedger,
  recordPaymentSettlementBatch,
  reviewPaymentAttempt,
} from "../services/paymentOperations.server.js";
import { reconcileWithdrawalRefundWebhook } from "../services/withdrawalDirectReturns.server.js";
import {
  completeDirectCustomerRefund,
  prepareDirectCustomerRefund,
} from "../services/directCustomerRefund.server.js";
import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

const ACCESS_ROLES = [
  MARKETPLACE_OPERATOR_ROLES.ADMIN,
  MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
  MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
];

const ACTION_ROLES = Object.freeze({
  review_attempt: [
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  ],
  confirm_manual_refund: [
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  ],
  record_settlement_batch: [
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  ],
  preview_paid_ledger: [MARKETPLACE_OPERATOR_ROLES.ADMIN],
  backfill_paid_ledger: [MARKETPLACE_OPERATOR_ROLES.ADMIN],
  prepare_direct_customer_refund: [
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  ],
  complete_direct_customer_refund: [
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  ],
});

function actorFromOperator(operator) {
  return (
    operator?.actorKey || operator?.email || operator?.userId || "operator"
  );
}

export const loader = async ({ request }) => {
  await requireMarketplaceOperator(request, { roles: ACCESS_ROLES });
  return json(await getPaymentOperationsDashboard());
};

export const action = async ({ request }) => {
  const formData = await request.clone().formData();
  const intent = String(formData.get("intent") || "");
  const { operator, session } = await requireMarketplaceOperator(request, {
    roles: ACTION_ROLES[intent] || [MARKETPLACE_OPERATOR_ROLES.ADMIN],
  });
  const actor = actorFromOperator(operator);
  let result;

  if (intent === "review_attempt") {
    result = await reviewPaymentAttempt({
      attemptId: String(formData.get("attemptId") || ""),
      actor,
      note: formData.get("note"),
    });
  } else if (intent === "confirm_manual_refund") {
    result = await confirmManualPaymentRefundOperation({
      operationId: String(formData.get("operationId") || ""),
      providerReference: formData.get("providerReference"),
      evidenceReference: formData.get("evidenceReference"),
      evidenceHash: formData.get("evidenceHash"),
      refundFeeAmount: formData.get("refundFeeAmount"),
      confirm: formData.get("confirm"),
      actor,
    });
    if (result.ok && result.payload) {
      result.withdrawalReconciliation = await reconcileWithdrawalRefundWebhook({
        payload: result.payload,
        shop: result.operation?.shopDomain,
      });
    }
  } else if (intent === "record_settlement_batch") {
    result = await recordPaymentSettlementBatch({
      ...Object.fromEntries(formData),
      paymentAttemptIds: formData.getAll("paymentAttemptIds"),
      refundOperationIds: formData.getAll("refundOperationIds"),
      actor,
    });
  } else if (intent === "preview_paid_ledger") {
    result = await previewPaymentAttemptsFromPaidLedger({
      limit: formData.get("limit"),
    });
  } else if (intent === "backfill_paid_ledger") {
    result =
      formData.get("confirm") === "backfill_payment_attempts"
        ? await backfillPaymentAttemptsFromPaidLedger({
            actor,
            limit: formData.get("limit"),
          })
        : { ok: false, reason: "confirmation_required" };
  } else if (intent === "prepare_direct_customer_refund") {
    result = await prepareDirectCustomerRefund({
      shopDomain: session.shop,
      orderReference: formData.get("orderReference"),
      amount: formData.get("amount"),
      currencyCode: formData.get("currencyCode"),
      recipientConsentReference: formData.get("recipientConsentReference"),
      recipientConsentHash: formData.get("recipientConsentHash"),
      confirm: formData.get("confirm"),
      actor,
    });
  } else if (intent === "complete_direct_customer_refund") {
    result = await completeDirectCustomerRefund({
      shopDomain: session.shop,
      orderReference: formData.get("orderReference"),
      amount: formData.get("amount"),
      currencyCode: formData.get("currencyCode"),
      recipientConsentReference: formData.get("recipientConsentReference"),
      recipientConsentHash: formData.get("recipientConsentHash"),
      transferEvidenceReference: formData.get("transferEvidenceReference"),
      transferEvidenceHash: formData.get("transferEvidenceHash"),
      transferReferenceMasked: formData.get("transferReferenceMasked"),
      confirm: formData.get("confirm"),
      actor,
    });
  } else {
    result = { ok: false, reason: "unsupported_action" };
  }

  return json(
    {
      ok: Boolean(result?.ok),
      message: result?.ok
        ? "処理を完了しました。"
        : `処理できませんでした: ${result?.reason || "unknown"}`,
      result,
    },
    { status: result?.ok ? 200 : 400 },
  );
};

function formatMoney(amount, currencyCode = "jpy") {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: String(currencyCode || "jpy").toUpperCase(),
  }).format(Number(amount || 0));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function Status({ children, tone = "neutral" }) {
  return (
    <span className={`payment-status payment-status--${tone}`}>{children}</span>
  );
}

function Metric({ label, value }) {
  return (
    <div className="payment-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function PaymentOperationsPage() {
  const {
    inspection,
    attempts,
    refunds,
    settlementBatches,
    directCustomerRefunds,
    directRefundReservations,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const backfillPreview = actionData?.result?.dryRun ? actionData.result : null;
  const backfillHasNoEligibleOrders = Boolean(
    backfillPreview && backfillPreview.uniqueOrders === 0,
  );
  const settlementAttemptCandidates = attempts.filter(
    (attempt) =>
      attempt.provider === "KOMOJU" &&
      attempt.status === "CAPTURED" &&
      attempt.test !== true &&
      attempt.requiresReview !== true &&
      !attempt.settlementLine,
  );
  const settlementRefundCandidates = refunds.filter(
    (refund) =>
      refund.provider === "KOMOJU" &&
      refund.status === "LEDGER_APPLIED" &&
      !refund.settlementLine,
  );

  return (
    <main className="payment-page">
      <style>{STYLES}</style>
      <header className="payment-header">
        <div>
          <h1>決済運用</h1>
          <p>Shopify PaymentsとKOMOJUの支払い・返金・入金照合を管理します。</p>
        </div>
        <Status tone={inspection.criticalCount > 0 ? "critical" : "success"}>
          {inspection.criticalCount > 0
            ? `要対応 ${inspection.criticalCount}件`
            : "重大な不整合なし"}
        </Status>
      </header>

      {actionData?.message ? (
        <div
          className={`payment-notice ${actionData.ok ? "is-success" : "is-error"}`}
        >
          {actionData.message}
        </div>
      ) : null}

      <section className="payment-metrics" aria-label="決済運用サマリー">
        <Metric label="期限超過" value={inspection.pendingExpiredCount} />
        <Metric label="決済要確認" value={inspection.attemptReviewCount} />
        <Metric label="返金要確認" value={inspection.refundReviewCount} />
        <Metric label="返金失敗" value={inspection.refundFailedCount} />
        <Metric
          label="入金未照合"
          value={inspection.unmatchedSettlementCount}
        />
        <Metric
          label="入金要確認"
          value={inspection.settlementBatchReviewCount}
        />
      </section>

      <section className="payment-section">
        <h2>会社からの直接返金</h2>
        <p>
          KOMOJUで返金できない場合だけ使用します。最初に購入者の同意と注文全額を確認して
          返金経路を予約し、実際の送金後に証拠を記録して台帳へ反映します。
        </p>
        <Form method="post" className="payment-form payment-form--direct-refund">
          <input
            type="hidden"
            name="intent"
            value="prepare_direct_customer_refund"
          />
          <input name="orderReference" placeholder="注文番号（例: #1001）" required />
          <input name="amount" type="number" min="1" placeholder="全額返金額（円）" required />
          <input type="hidden" name="currencyCode" value="jpy" />
          <input
            name="recipientConsentReference"
            placeholder="購入者同意の保存先またはチケット番号"
            required
          />
          <input
            name="recipientConsentHash"
            pattern="[A-Fa-f0-9]{64}"
            placeholder="購入者同意証跡のSHA-256（64桁）"
            required
          />
          <label className="payment-confirm payment-confirm--wide">
            <input
              type="checkbox"
              name="confirm"
              value="direct_customer_refund_prepare"
              required
            />
            購入者の同意と注文全額を確認しました。この予約後は同じ注文をShopify/KOMOJUから返金しません。
          </label>
          <button type="submit" disabled={busy}>
            直接返金を予約
          </button>
        </Form>
        <div className="payment-list">
          {directRefundReservations.length === 0 ? (
            <p className="payment-empty">送金待ちの直接返金予約はありません。</p>
          ) : null}
          {directRefundReservations.map((guard) => (
            <article className="payment-item" key={guard.id}>
              <div className="payment-item__summary">
                <div>
                  <strong>{guard.shopifyOrderId}</strong>
                  <p>
                    {formatMoney(guard.amount, guard.currencyCode)} / 予約日時 {formatDate(guard.reservedAt)}
                  </p>
                </div>
                <Status tone="warning">送金待ち</Status>
              </div>
            </article>
          ))}
        </div>
        <h3>送金完了を記録</h3>
        <Form method="post" className="payment-form payment-form--direct-refund">
          <input type="hidden" name="intent" value="complete_direct_customer_refund" />
          <input name="orderReference" placeholder="予約済みの注文番号（例: #1001）" required />
          <input name="amount" type="number" min="1" placeholder="全額返金額（円）" required />
          <input type="hidden" name="currencyCode" value="jpy" />
          <input name="recipientConsentReference" placeholder="準備時と同じ購入者同意の保存先" required />
          <input name="recipientConsentHash" pattern="[A-Fa-f0-9]{64}" placeholder="準備時と同じ同意証跡SHA-256" required />
          <input name="transferEvidenceReference" placeholder="送金証跡の保存先" required />
          <input name="transferEvidenceHash" pattern="[A-Fa-f0-9]{64}" placeholder="送金証跡のSHA-256（64桁）" required />
          <input name="transferReferenceMasked" placeholder="送金参照番号（末尾4桁など）" required />
          <label className="payment-confirm payment-confirm--wide">
            <input type="checkbox" name="confirm" value="direct_customer_refund_completed" required />
            予約済みの注文全額を購入者へ送金しました。送金証拠を確認し、台帳へ一度だけ反映します。
          </label>
          <button type="submit" disabled={busy}>送金完了を確定して台帳へ反映</button>
        </Form>
        <div className="payment-list">
          {directCustomerRefunds.length === 0 ? (
            <p className="payment-empty">直接返金の記録はありません。</p>
          ) : null}
          {directCustomerRefunds.map((refund) => (
            <article className="payment-item" key={refund.id}>
              <div className="payment-item__summary">
                <div>
                  <strong>{refund.shopifyOrderId}</strong>
                  <p>
                    {refund.transferReferenceMasked} / {formatDate(refund.completedAt)}
                  </p>
                </div>
                <div className="payment-item__amount">
                  {formatMoney(refund.amount, refund.currencyCode)}
                  <Status tone="success">{refund.status}</Status>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="payment-section">
        <h2>返金確認待ち</h2>
        <p>
          コンビニ・Pay-easy等は、KOMOJUで返金が成功してから台帳へ反映します。
        </p>
        <div className="payment-list">
          {refunds.length === 0 ? (
            <p className="payment-empty">返金操作はありません。</p>
          ) : null}
          {refunds.map((refund) => (
            <article className="payment-item" key={refund.id}>
              <div className="payment-item__summary">
                <div>
                  <strong>{refund.shopifyRefundId || refund.id}</strong>
                  <p>
                    {refund.provider} / {refund.paymentMethod} /{" "}
                    {refund.refundMode}
                  </p>
                </div>
                <div className="payment-item__amount">
                  {formatMoney(refund.amount, refund.currencyCode)}
                  <Status
                    tone={
                      refund.status === "FAILED"
                        ? "critical"
                        : refund.status === "LEDGER_APPLIED"
                          ? "success"
                          : "warning"
                    }
                  >
                    {refund.status}
                  </Status>
                </div>
              </div>
              {refund.refundMode === "KOMOJU_MANUAL" &&
              refund.status !== "LEDGER_APPLIED" ? (
                <Form
                  method="post"
                  className="payment-form payment-form--refund"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="confirm_manual_refund"
                  />
                  <input type="hidden" name="operationId" value={refund.id} />
                  <input
                    name="providerReference"
                    placeholder="KOMOJU返金参照番号"
                    required
                  />
                  <input
                    name="evidenceReference"
                    placeholder="証跡URLまたは保存先"
                    required
                  />
                  <input name="evidenceHash" placeholder="SHA-256（任意）" />
                  <input
                    name="refundFeeAmount"
                    type="number"
                    min="0"
                    defaultValue="0"
                    placeholder="実際の返金手数料"
                    aria-label="返金手数料"
                  />
                  <label className="payment-confirm">
                    <input
                      type="checkbox"
                      name="confirm"
                      value="provider_refund_confirmed"
                      required
                    />
                    KOMOJU側で返金成功を確認しました
                  </label>
                  <button type="submit" disabled={busy}>
                    確認して台帳へ反映
                  </button>
                </Form>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="payment-section">
        <h2>支払い試行</h2>
        <p>支払い待ち、期限切れ、同一注文の複数決済を確認します。</p>
        <div className="payment-table-wrap">
          <table className="payment-table">
            <thead>
              <tr>
                <th>注文</th>
                <th>決済</th>
                <th>状態</th>
                <th>金額</th>
                <th>更新</th>
                <th>確認</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>{attempt.shopifyOrderName || attempt.shopifyOrderId}</td>
                  <td>
                    {attempt.provider}
                    <small>{attempt.paymentMethod}</small>
                  </td>
                  <td>
                    <Status
                      tone={
                        attempt.requiresReview
                          ? "critical"
                          : attempt.status === "CAPTURED"
                            ? "success"
                            : "warning"
                      }
                    >
                      {attempt.status}
                    </Status>
                    {attempt.reviewReason ? (
                      <small>{attempt.reviewReason}</small>
                    ) : null}
                  </td>
                  <td>{formatMoney(attempt.amount, attempt.currencyCode)}</td>
                  <td>{formatDate(attempt.updatedAt)}</td>
                  <td>
                    {attempt.requiresReview ? (
                      <Form method="post" className="payment-inline-form">
                        <input
                          type="hidden"
                          name="intent"
                          value="review_attempt"
                        />
                        <input
                          type="hidden"
                          name="attemptId"
                          value={attempt.id}
                        />
                        <input name="note" placeholder="確認メモ" required />
                        <button type="submit" disabled={busy}>
                          確認済みにする
                        </button>
                      </Form>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="payment-section payment-section--split">
        <div>
          <h2>KOMOJU入金証跡</h2>
          <p>振込通知と銀行着金を照合し、控除内訳を記録します。</p>
          <Form method="post" className="payment-form">
            <input
              type="hidden"
              name="intent"
              value="record_settlement_batch"
            />
            <input type="hidden" name="provider" value="KOMOJU" />
            <input name="externalBatchId" placeholder="KOMOJU振込ID" required />
            <fieldset className="payment-settlement-lines">
              <legend>この振込に含まれる売上</legend>
              {settlementAttemptCandidates.length === 0 ? (
                <p className="payment-empty">
                  未登録のKOMOJU売上はありません。
                </p>
              ) : null}
              {settlementAttemptCandidates.map((attempt) => (
                <label key={attempt.id} className="payment-confirm">
                  <input
                    type="checkbox"
                    name="paymentAttemptIds"
                    value={attempt.id}
                  />
                  {attempt.shopifyOrderName || attempt.shopifyOrderId} /{" "}
                  {attempt.shopifyTransactionId || "Transaction未記録"} /{" "}
                  {formatMoney(attempt.amount, attempt.currencyCode)}
                </label>
              ))}
            </fieldset>
            {settlementRefundCandidates.length > 0 ? (
              <fieldset className="payment-settlement-lines">
                <legend>この振込で控除された返金</legend>
                {settlementRefundCandidates.map((refund) => (
                  <label key={refund.id} className="payment-confirm">
                    <input
                      type="checkbox"
                      name="refundOperationIds"
                      value={refund.id}
                    />
                    {refund.shopifyRefundId || refund.id} /{" "}
                    {formatMoney(refund.amount, refund.currencyCode)}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="payment-form__grid">
              <input
                name="grossAmount"
                type="number"
                min="0"
                placeholder="売上総額"
                required
              />
              <input
                name="refundAmount"
                type="number"
                min="0"
                placeholder="返金額"
                defaultValue="0"
              />
              <input
                name="feeAmount"
                type="number"
                min="0"
                placeholder="手数料"
                defaultValue="0"
              />
              <input
                name="netAmount"
                type="number"
                placeholder="振込額"
                required
              />
            </div>
            <input type="hidden" name="currencyCode" value="jpy" />
            <label>
              送金日
              <input name="payoutDate" type="date" required />
            </label>
            <label>
              銀行着金日
              <input name="bankDepositedAt" type="date" required />
            </label>
            <input
              name="evidenceReference"
              placeholder="証跡URLまたは保存先"
              required
            />
            <input
              name="evidenceHash"
              pattern="[A-Fa-f0-9]{64}"
              placeholder="証跡ファイルのSHA-256（64桁）"
              required
            />
            <label className="payment-confirm">
              <input
                type="checkbox"
                name="confirm"
                value="settlement_evidence_recorded"
                required
              />
              振込額と証跡を確認しました
            </label>
            <button
              type="submit"
              disabled={busy || settlementAttemptCandidates.length === 0}
            >
              入金証跡を記録
            </button>
          </Form>
        </div>
        <div>
          <h2>記録済み入金</h2>
          {settlementBatches.length === 0 ? (
            <p className="payment-empty">まだありません。</p>
          ) : null}
          {settlementBatches.map((batch) => (
            <div className="payment-batch" key={batch.id}>
              <strong>{batch.externalBatchId}</strong>
              <span>{formatMoney(batch.netAmount, batch.currencyCode)}</span>
              <Status
                tone={batch.status === "RECONCILED" ? "success" : "warning"}
              >
                {batch.status}
              </Status>
              <small>直接照合 {batch._count.lines}行</small>
            </div>
          ))}
        </div>
      </section>

      <section className="payment-section">
        <h2>既存注文の補完</h2>
        <p>
          Shopifyの実トランザクションを注文単位で確認してから決済試行を補完します。台帳のgateway名や金額は転記しません。
        </p>
        <Form
          method="post"
          className="payment-form payment-form--backfill-preview"
        >
          <input type="hidden" name="intent" value="preview_paid_ledger" />
          <label>
            対象台帳件数
            <input
              name="limit"
              type="number"
              min="1"
              max="500"
              defaultValue="200"
            />
          </label>
          <button type="submit" disabled={busy}>
            安全性を確認
          </button>
        </Form>
        {actionData?.result?.dryRun ? (
          <div
            className={`payment-backfill-summary ${actionData.result.canApply ? "is-safe" : backfillHasNoEligibleOrders ? "is-empty" : "is-blocked"}`}
          >
            <strong>
              {actionData.result.canApply
                ? "補完可能"
                : backfillHasNoEligibleOrders
                  ? "補完対象はありません"
                  : "補完を停止しました"}
            </strong>
            <span>
              台帳 {actionData.result.processedLedgerRows}件 / 注文{" "}
              {actionData.result.uniqueOrders}件
            </span>
            <span>
              テスト店舗の台帳を除外{" "}
              {actionData.result.excludedTestLedgerRows || 0}件
            </span>
            <span>
              作成予定 {actionData.result.projectedCreates}件 / 更新予定{" "}
              {actionData.result.projectedUpdates}件
            </span>
            <span>
              既存試行あり {actionData.result.existingAttemptOrders}注文
            </span>
            <span>重複台帳 {actionData.result.duplicateLedgerRows}件</span>
            <span>
              gateway未記録 {actionData.result.metadataGatewayMissingRows}件
            </span>
            <span>
              gateway複数表記 {actionData.result.metadataGatewayAnomalyRows}件
            </span>
            <span>UNKNOWN {actionData.result.unknownAttemptCount}件</span>
            <span>複数決済 {actionData.result.multipleAttemptOrders}注文</span>
            <span>要確認注文 {actionData.result.reviewRequiredOrders}件</span>
            {Object.keys(actionData.result.blockerReasons || {}).length > 0 ? (
              <span>
                停止理由:{" "}
                {Object.entries(actionData.result.blockerReasons)
                  .map(([reason, count]) => `${reason} (${count})`)
                  .join(" / ")}
              </span>
            ) : null}
          </div>
        ) : null}
        <Form method="post" className="payment-form payment-form--backfill">
          <input type="hidden" name="intent" value="backfill_paid_ledger" />
          <label>
            対象件数
            <input
              name="limit"
              type="number"
              min="1"
              max="500"
              defaultValue="200"
            />
          </label>
          <label className="payment-confirm">
            <input
              type="checkbox"
              name="confirm"
              value="backfill_payment_attempts"
              required
            />
            事前確認を再実行し、安全な注文だけを補完します
          </label>
          <button type="submit" disabled={busy || backfillHasNoEligibleOrders}>
            補完を実行
          </button>
        </Form>
      </section>
    </main>
  );
}

const STYLES = `
  .payment-page{padding:24px;max-width:1500px;margin:0 auto;color:#101828;letter-spacing:0}.payment-header,.payment-section{background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:24px;margin-bottom:20px}.payment-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.payment-header h1,.payment-section h2{margin:0 0 8px}.payment-header p,.payment-section p,.payment-item p{margin:0;color:#475467}.payment-notice{padding:14px 16px;border-radius:6px;margin-bottom:20px}.payment-notice.is-success{background:#ecfdf3;color:#027a48}.payment-notice.is-error{background:#fef3f2;color:#b42318}.payment-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:20px}.payment-metric{background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:18px}.payment-metric span{display:block;color:#667085;font-size:14px}.payment-metric strong{font-size:28px}.payment-list{display:grid;gap:12px;margin-top:18px}.payment-item{border-top:1px solid #eaecf0;padding-top:16px}.payment-item__summary{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.payment-item__amount{display:flex;align-items:center;gap:12px;font-weight:700}.payment-status{display:inline-flex;padding:4px 8px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:12px;font-weight:700}.payment-status--success{background:#ecfdf3;color:#027a48}.payment-status--warning{background:#fffaeb;color:#b54708}.payment-status--critical{background:#fef3f2;color:#b42318}.payment-form{display:grid;gap:12px;margin-top:16px}.payment-form--refund{grid-template-columns:repeat(4,minmax(140px,1fr));align-items:end}.payment-form--refund .payment-confirm{grid-column:1/-2}.payment-form--direct-refund{grid-template-columns:repeat(2,minmax(0,1fr));}.payment-form--direct-refund .payment-confirm--wide,.payment-form--direct-refund button{grid-column:1/-1}.payment-form input,.payment-inline-form input{border:1px solid #d0d5dd;border-radius:6px;padding:10px 12px;min-width:0}.payment-form button,.payment-inline-form button{border:0;border-radius:6px;padding:10px 14px;background:#101828;color:#fff;font-weight:700;cursor:pointer}.payment-form button:disabled,.payment-inline-form button:disabled{opacity:.5}.payment-confirm{display:flex;gap:8px;align-items:center}.payment-confirm input{width:16px;height:16px}.payment-settlement-lines{display:grid;gap:10px;border:1px solid #d0d5dd;border-radius:6px;padding:14px}.payment-settlement-lines legend{padding:0 6px;font-weight:700}.payment-table-wrap{overflow:auto;margin-top:18px}.payment-table{width:100%;border-collapse:collapse;min-width:980px}.payment-table th,.payment-table td{border-top:1px solid #eaecf0;padding:12px;text-align:left;vertical-align:top}.payment-table small{display:block;color:#667085;margin-top:4px}.payment-inline-form{display:flex;gap:8px}.payment-section--split{display:grid;grid-template-columns:1fr 1fr;gap:32px}.payment-form__grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.payment-form label{display:grid;gap:6px}.payment-batch{display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;border-top:1px solid #eaecf0;padding:12px 0}.payment-empty{padding:18px 0}.payment-form--backfill-preview{grid-template-columns:220px auto;align-items:end}.payment-backfill-summary{display:flex;flex-wrap:wrap;gap:10px 20px;margin-top:14px;padding:14px 16px;border-radius:6px}.payment-backfill-summary.is-safe{background:#ecfdf3;color:#027a48}.payment-backfill-summary.is-empty{background:#f2f4f7;color:#344054}.payment-backfill-summary.is-blocked{background:#fef3f2;color:#b42318}.payment-form--backfill{grid-template-columns:220px 1fr auto;align-items:end}.payment-form--backfill .payment-confirm{padding-bottom:10px}@media(max-width:1100px){.payment-metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.payment-page{padding:16px}.payment-header,.payment-section{padding:18px}.payment-metrics{grid-template-columns:repeat(2,1fr)}.payment-section--split{grid-template-columns:1fr}.payment-form--refund,.payment-form--direct-refund,.payment-form--backfill,.payment-form--backfill-preview{grid-template-columns:1fr}.payment-form--refund .payment-confirm,.payment-form--direct-refund .payment-confirm--wide,.payment-form--direct-refund button{grid-column:auto}}
`;
