import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import {
  approveShopifyPayoutEvidence,
  getSingleOperatorPayoutConfirmationText,
  listShopifyPayoutEvidence,
  rejectShopifyPayoutEvidence,
  submitShopifyPayoutEvidence,
} from "../services/shopifyPayoutEvidence.server.js";
import {
  buildProductionReleaseExpectation,
  buildProductionReleaseFingerprint,
} from "../services/productionRelease.server.js";
import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

const VIEW_ROLES = [
  MARKETPLACE_OPERATOR_ROLES.ADMIN,
  MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
  MARKETPLACE_OPERATOR_ROLES.COMPLIANCE_REVIEWER,
  MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
];

export async function loader({ request }) {
  const { session } = await requireMarketplaceOperator(request, {
    roles: VIEW_ROLES,
  });
  const release = buildProductionReleaseExpectation();
  const evidence = release.releaseId
    ? await listShopifyPayoutEvidence({
        shopDomain: session.shop,
        releaseId: release.releaseId,
      })
    : [];
  return json(
    {
      release: {
        configured: release.configured,
        releaseId: release.releaseId,
        releaseFingerprint: release.configured
          ? buildProductionReleaseFingerprint(release)
          : null,
      },
      shopDomain: session.shop,
      evidence: evidence.map(serializeEvidence),
      singleOperatorConfirmation: getSingleOperatorPayoutConfirmationText(),
    },
    { headers: privateHeaders() },
  );
}

export async function action({ request }) {
  const formData = await request.clone().formData();
  const intent = String(formData.get("intent") || "");
  const role =
    intent === "submit"
      ? MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER
      : intent === "approve_with_waiver"
        ? MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER
        : MARKETPLACE_OPERATOR_ROLES.COMPLIANCE_REVIEWER;
  const { session, operator } = await requireMarketplaceOperator(request, {
    role,
  });

  let result;
  if (intent === "submit") {
    result = await submitShopifyPayoutEvidence({
      shopDomain: session.shop,
      payoutId: formData.get("payoutId"),
      payoutStatus: "DEPOSITED",
      amount: formData.get("amount"),
      currencyCode: formData.get("currencyCode"),
      shopifyPayoutDate: formData.get("shopifyPayoutDate"),
      bankDepositedAt: formData.get("bankDepositedAt"),
      bankReferenceMasked: formData.get("bankReferenceMasked"),
      evidenceReference: formData.get("evidenceReference"),
      evidenceHash: formData.get("evidenceHash"),
      submittedBy: operator.actorKey,
    });
  } else if (intent === "approve") {
    result = await approveShopifyPayoutEvidence({
      evidenceId: formData.get("evidenceId"),
      reviewedBy: operator.actorKey,
    });
  } else if (intent === "approve_with_waiver") {
    result = await approveShopifyPayoutEvidence({
      evidenceId: formData.get("evidenceId"),
      reviewedBy: operator.actorKey,
      reviewerAccountOwner: operator.accountOwner,
      allowSingleOperatorWaiver: true,
      singleOperatorConfirmation: formData.get("singleOperatorConfirmation"),
      singleOperatorWaiverReason: formData.get("singleOperatorWaiverReason"),
    });
  } else if (intent === "reject") {
    result = await rejectShopifyPayoutEvidence({
      evidenceId: formData.get("evidenceId"),
      reviewedBy: operator.actorKey,
      rejectionReason: formData.get("rejectionReason"),
    });
  } else {
    result = { ok: false, reason: "unsupported_intent" };
  }

  return json(result, {
    status: result.ok ? 200 : 400,
    headers: privateHeaders(),
  });
}

export default function ShopifyPayoutEvidencePage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main className="payout-page">
      <style>{styles}</style>
      <header className="payout-header">
        <div>
          <p className="eyebrow">PRODUCTION EVIDENCE</p>
          <h1>Shopify Payments着金証拠</h1>
          <p>
            ShopifyのPayoutと銀行着金を照合した証拠を登録し、別の確認者が承認します。
            銀行明細全体や口座番号は保存しないでください。
          </p>
        </div>
        <Link className="secondary-button" to="/app/production-readiness">
          本番確認へ戻る
        </Link>
      </header>

      <section className="summary-band">
        <div>
          <span>Release ID</span>
          <strong>{data.release.releaseId || "未設定"}</strong>
        </div>
        <div>
          <span>対象ショップ</span>
          <strong>{data.shopDomain}</strong>
        </div>
        <div>
          <span>承認方式</span>
          <strong>原則として登録者と確認者を分離</strong>
        </div>
      </section>

      {actionData ? (
        <div
          className={actionData.ok ? "notice success" : "notice error"}
          role="status"
        >
          {actionData.ok
            ? "処理が完了しました。画面を再読み込みすると最新状態を確認できます。"
            : `処理できませんでした: ${reasonLabel(actionData.reason)}`}
        </div>
      ) : null}

      <section className="payout-section">
        <h2>証拠を登録</h2>
        <p className="section-copy">
          マスキング済みの証拠ファイルをアクセス制限された保存先へ置き、その参照先とSHA-256を登録します。
        </p>
        <Form method="post" className="evidence-form">
          <input type="hidden" name="intent" value="submit" />
          <label>
            <span>Shopify Payout ID</span>
            <input name="payoutId" required maxLength={160} />
          </label>
          <label>
            <span>金額（最小通貨単位。JPYは円）</span>
            <input name="amount" type="number" min="1" step="1" required />
          </label>
          <label>
            <span>通貨</span>
            <input
              name="currencyCode"
              defaultValue="JPY"
              pattern="[A-Za-z]{3}"
              maxLength={3}
              required
            />
          </label>
          <label>
            <span>Shopify送金日</span>
            <input name="shopifyPayoutDate" type="date" required />
          </label>
          <label>
            <span>銀行着金日</span>
            <input name="bankDepositedAt" type="date" required />
          </label>
          <label className="wide">
            <span>銀行明細の参照番号（マスキング済み）</span>
            <input
              name="bankReferenceMasked"
              maxLength={160}
              placeholder="例: 振込参照番号の末尾4桁のみ"
              required
            />
          </label>
          <label className="wide">
            <span>証拠ファイルの保存先</span>
            <input
              name="evidenceReference"
              maxLength={500}
              placeholder="アクセス制限された保存先URLまたは管理番号"
              required
            />
          </label>
          <label className="wide">
            <span>証拠ファイルのSHA-256</span>
            <input
              name="evidenceHash"
              pattern="[A-Fa-f0-9]{64}"
              minLength={64}
              maxLength={64}
              placeholder="64文字"
              required
            />
          </label>
          <button type="submit" disabled={busy || !data.release.configured}>
            証拠を登録
          </button>
        </Form>
      </section>

      <section className="payout-section">
        <h2>登録・承認履歴</h2>
        {data.evidence.length === 0 ? (
          <p className="empty">現在のReleaseに登録された証拠はありません。</p>
        ) : (
          <div className="evidence-list">
            {data.evidence.map((item) => (
              <article className="evidence-item" key={item.id}>
                <div className="evidence-title">
                  <div>
                    <span
                      className={`status status-${item.status.toLowerCase()}`}
                    >
                      {statusLabel(item.status)}
                    </span>
                    <h3>{item.payoutId}</h3>
                  </div>
                  <strong>
                    {item.amount.toLocaleString("ja-JP")} {item.currencyCode}
                  </strong>
                </div>
                <dl>
                  <div>
                    <dt>Shopify送金日</dt>
                    <dd>{formatDate(item.shopifyPayoutDate)}</dd>
                  </div>
                  <div>
                    <dt>銀行着金日</dt>
                    <dd>{formatDate(item.bankDepositedAt)}</dd>
                  </div>
                  <div>
                    <dt>参照番号</dt>
                    <dd>{item.bankReferenceMasked}</dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd className="hash">{item.evidenceHash}</dd>
                  </div>
                  <div>
                    <dt>登録者</dt>
                    <dd>{item.submittedBy}</dd>
                  </div>
                  <div>
                    <dt>確認者</dt>
                    <dd>{item.reviewedBy || "未確認"}</dd>
                  </div>
                </dl>

                {item.status === "SUBMITTED" ? (
                  <div className="review-grid">
                    <Form method="post" className="review-form">
                      <input type="hidden" name="intent" value="approve" />
                      <input type="hidden" name="evidenceId" value={item.id} />
                      <p>登録者とは別の担当者が証拠を確認します。</p>
                      <button type="submit" disabled={busy}>
                        独立確認して承認
                      </button>
                    </Form>

                    <Form method="post" className="review-form warning-form">
                      <input
                        type="hidden"
                        name="intent"
                        value="approve_with_waiver"
                      />
                      <input type="hidden" name="evidenceId" value={item.id} />
                      <p>
                        第二確認者を用意できない場合だけ、ストア所有者が残存リスクを明示して承認します。
                      </p>
                      <label>
                        <span>確認文</span>
                        <input
                          name="singleOperatorConfirmation"
                          placeholder={data.singleOperatorConfirmation}
                          required
                        />
                      </label>
                      <label>
                        <span>単独運用とする理由（30文字以上）</span>
                        <textarea
                          name="singleOperatorWaiverReason"
                          minLength={30}
                          required
                        />
                      </label>
                      <button type="submit" disabled={busy}>
                        単独運用例外として承認
                      </button>
                    </Form>

                    <Form method="post" className="review-form reject-form">
                      <input type="hidden" name="intent" value="reject" />
                      <input type="hidden" name="evidenceId" value={item.id} />
                      <label>
                        <span>差し戻し理由（10文字以上）</span>
                        <textarea
                          name="rejectionReason"
                          minLength={10}
                          required
                        />
                      </label>
                      <button type="submit" disabled={busy}>
                        差し戻す
                      </button>
                    </Form>
                  </div>
                ) : null}

                {item.singleOperatorWaiver ? (
                  <p className="waiver">
                    単独運用例外: {item.singleOperatorWaiverReason}
                  </p>
                ) : null}
                {item.rejectionReason ? (
                  <p className="rejection">
                    差し戻し理由: {item.rejectionReason}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function serializeEvidence(item) {
  return {
    id: item.id,
    payoutId: item.payoutId,
    amount: item.amount,
    currencyCode: item.currencyCode,
    bankReferenceMasked: item.bankReferenceMasked,
    evidenceHash: item.evidenceHash,
    status: item.status,
    submittedBy: item.submittedBy,
    reviewedBy: item.reviewedBy,
    rejectionReason: item.rejectionReason,
    singleOperatorWaiver: item.singleOperatorWaiver,
    singleOperatorWaiverReason: item.singleOperatorWaiverReason,
    shopifyPayoutDate: item.shopifyPayoutDate.toISOString(),
    bankDepositedAt: item.bankDepositedAt.toISOString(),
  };
}

function statusLabel(status) {
  return (
    {
      SUBMITTED: "確認待ち",
      APPROVED: "承認済み",
      REJECTED: "差し戻し",
    }[status] || status
  );
}

function reasonLabel(reason) {
  return (
    {
      release_unconfigured: "Release IDが設定されていません",
      shop_domain_mismatch: "対象ショップが現在のReleaseと一致しません",
      invalid_shop_domain: "ショップドメインが不正です",
      invalid_payout_id: "Payout IDを確認してください",
      payout_not_deposited: "銀行着金済みのPayoutだけ登録できます",
      invalid_payout_amount: "金額を確認してください",
      invalid_currency_code: "通貨コードを確認してください",
      invalid_payout_dates: "送金日と着金日を確認してください",
      invalid_bank_deposit_date: "着金日は送金日以降の日付にしてください",
      bank_reference_required: "マスキング済み参照番号が必要です",
      evidence_reference_required: "証拠ファイルの保存先が必要です",
      evidence_hash_required: "証拠ファイルのSHA-256が必要です",
      approved_evidence_is_immutable: "承認済み証拠は変更できません",
      payout_evidence_submitter_mismatch:
        "このPayoutの確認待ち証拠は、最初に登録した担当者だけが更新できます",
      independent_payout_approval_required:
        "登録者とは別の確認者による承認が必要です",
      payout_evidence_approval_conflict:
        "別の操作で状態が変わりました。再読み込みしてください",
      payout_evidence_not_pending: "この証拠は確認待ちではありません",
      rejection_reason_required: "差し戻し理由を10文字以上で入力してください",
    }[reason] ||
    reason ||
    "unknown_error"
  );
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("ja-JP");
}

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

const styles = `
  .payout-page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 64px; color: #111827; }
  .payout-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 24px; }
  .payout-header h1 { margin: 4px 0 8px; font-size: 30px; letter-spacing: 0; }
  .payout-header p { margin: 0; line-height: 1.7; }
  .eyebrow { font-size: 12px; font-weight: 700; color: #4b5563; }
  .secondary-button, button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 16px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #111827; font-weight: 700; text-decoration: none; cursor: pointer; }
  button { background: #111827; color: #fff; border-color: #111827; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .summary-band { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid #dbe2ea; margin-bottom: 24px; }
  .summary-band div { padding: 18px 20px; border-right: 1px solid #dbe2ea; }
  .summary-band div:last-child { border-right: 0; }
  .summary-band span, .summary-band strong { display: block; }
  .summary-band span { color: #64748b; font-size: 13px; margin-bottom: 5px; }
  .summary-band strong { overflow-wrap: anywhere; }
  .payout-section { background: #fff; border: 1px solid #dbe2ea; border-radius: 8px; padding: 24px; margin-bottom: 22px; }
  .payout-section h2 { margin: 0 0 6px; font-size: 21px; }
  .section-copy { margin: 0 0 20px; color: #475569; }
  .evidence-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .evidence-form label, .review-form label { display: grid; gap: 7px; font-weight: 700; }
  .evidence-form .wide { grid-column: 1 / -1; }
  input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #b8c2cf; border-radius: 6px; padding: 11px 12px; font: inherit; background: #fff; }
  textarea { min-height: 90px; resize: vertical; }
  .evidence-form button { justify-self: start; }
  .notice { padding: 14px 16px; border: 1px solid; border-radius: 6px; margin-bottom: 20px; }
  .notice.success { color: #166534; background: #f0fdf4; border-color: #86efac; }
  .notice.error { color: #991b1b; background: #fef2f2; border-color: #fca5a5; }
  .empty { color: #64748b; }
  .evidence-list { display: grid; gap: 16px; }
  .evidence-item { border-top: 1px solid #dbe2ea; padding-top: 20px; }
  .evidence-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .evidence-title h3 { margin: 7px 0 0; font-size: 18px; }
  .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; background: #f1f5f9; }
  .status-approved { background: #dcfce7; color: #166534; }
  .status-rejected { background: #fee2e2; color: #991b1b; }
  dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
  dl div { min-width: 0; }
  dt { color: #64748b; font-size: 12px; margin-bottom: 4px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .review-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .review-form { border: 1px solid #dbe2ea; border-radius: 6px; padding: 16px; }
  .review-form p { margin: 0 0 14px; color: #475569; }
  .warning-form { border-color: #fbbf24; background: #fffbeb; }
  .reject-form { border-color: #fecaca; background: #fff7f7; }
  .waiver, .rejection { padding: 12px 14px; border-left: 3px solid #f59e0b; background: #fffbeb; }
  .rejection { border-left-color: #dc2626; background: #fef2f2; }
  @media (max-width: 760px) {
    .payout-page { padding: 20px 14px 48px; }
    .payout-header { display: grid; }
    .summary-band, .evidence-form, dl, .review-grid { grid-template-columns: 1fr; }
    .summary-band div { border-right: 0; border-bottom: 1px solid #dbe2ea; }
    .summary-band div:last-child { border-bottom: 0; }
    .evidence-form .wide { grid-column: auto; }
  }
`;
