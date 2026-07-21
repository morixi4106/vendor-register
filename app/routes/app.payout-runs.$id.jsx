import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import {
  MARKETPLACE_OPERATOR_ROLES,
  operatorAuditSnapshot,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

export const loader = async ({ request, params }) => {
  await requireMarketplaceOperator(request, {
    roles: [
      MARKETPLACE_OPERATOR_ROLES.ADMIN,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
      MARKETPLACE_OPERATOR_ROLES.FINANCE_EXECUTOR,
    ],
  });
  const { getPayoutRunDetail } =
    await import("../services/sellerPayments.server.js");

  const payoutRun = await getPayoutRunDetail(params.id);

  if (!payoutRun) {
    throw new Response("出金予定が見つかりません。", { status: 404 });
  }

  return json({ payoutRun });
};

export const action = async ({ request, params }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const { operator } = await requireMarketplaceOperator(request, {
    role:
      intent === "approve"
        ? MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER
        : MARKETPLACE_OPERATOR_ROLES.FINANCE_EXECUTOR,
  });
  const {
    approvePayoutRun,
    executeWisePayoutRun,
    markPayoutRunManuallyPaid,
    syncWisePayoutRunStatus,
  } = await import("../services/sellerPayments.server.js");

  const result =
    intent === "approve"
      ? await approvePayoutRun({
          payoutRunId: params.id,
          approvedBy: operator.actorKey,
          approvedByJson: operatorAuditSnapshot(operator),
        })
      : intent === "executeWise"
        ? await executeWisePayoutRun({
            payoutRunId: params.id,
            executedBy: operator.actorKey,
            executedByJson: operatorAuditSnapshot(operator),
          })
        : intent === "syncWise"
          ? await syncWisePayoutRunStatus({
              payoutRunId: params.id,
              executedBy: operator.actorKey,
              executedByJson: operatorAuditSnapshot(operator),
            })
          : intent === "markPaid"
            ? await markPayoutRunManuallyPaid({
                payoutRunId: params.id,
                executedBy: operator.actorKey,
                executedByJson: operatorAuditSnapshot(operator),
                externalTransferId: formData.get("externalTransferId"),
                transferMemo: formData.get("transferMemo"),
              })
            : {
                ok: false,
                reason: "invalid_intent",
              };

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: createPayoutRunErrorMessage(result.reason),
      },
      { status: 400 },
    );
  }

  return json({
    ok: true,
    message:
      intent === "approve"
        ? "出金予定を承認しました。"
        : intent === "executeWise"
          ? result.pending
            ? "Wise送金を開始しました。完了確認後に台帳へ反映します。"
            : "Wise送金が完了し、台帳へ反映しました。"
          : intent === "syncWise"
            ? result.returned
              ? "Wiseからの資金返還を確認し、売上台帳へ戻しました。"
              : result.pending
                ? "Wise送金ステータスを更新しました。"
                : "Wise送金の完了を確認し、台帳へ反映しました。"
            : result.pending
              ? "手動送金を処理中にしました。実際の振込後、送金IDを記録して完了してください。"
              : "手動送金の完了を記録し、台帳へ反映しました。",
  });
};

export default function AdminPayoutRunDetailPage() {
  const { payoutRun } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isApproving =
    navigation.formData?.get("intent") === "approve" &&
    navigation.state !== "idle";
  const isMarkingPaid =
    navigation.formData?.get("intent") === "markPaid" &&
    navigation.state !== "idle";
  const isExecutingWise =
    navigation.formData?.get("intent") === "executeWise" &&
    navigation.state !== "idle";
  const isSyncingWise =
    navigation.formData?.get("intent") === "syncWise" &&
    navigation.state !== "idle";

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .payout-detail__page{
          display:grid;
          gap:24px;
        }
        .payout-detail__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
        }
        .payout-detail__title{
          margin:0 0 8px;
          font-size:24px;
          font-weight:700;
          color:#111827;
        }
        .payout-detail__subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .payout-detail__button{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:42px;
          padding:0 16px;
          border-radius:999px;
          border:1px solid #111827;
          background:#111827;
          color:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
          text-decoration:none;
        }
        .payout-detail__button--secondary{
          border-color:#d1d5db;
          background:#fff;
          color:#111827;
        }
        .payout-detail__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .payout-detail__form{
          display:grid;
          gap:12px;
          max-width:720px;
        }
        .payout-detail__input{
          min-height:44px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:0 12px;
          font-size:14px;
          box-sizing:border-box;
        }
        .payout-detail__textarea{
          min-height:96px;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:12px;
          font-size:14px;
          box-sizing:border-box;
          resize:vertical;
        }
        .payout-detail__notice{
          margin:16px 0 0;
          color:#047857;
          font-weight:700;
        }
        .payout-detail__error{
          margin:16px 0 0;
          color:#b91c1c;
          font-weight:700;
        }
        .payout-detail__test-badge{
          display:inline-flex;
          align-items:center;
          min-height:22px;
          padding:0 8px;
          border-radius:999px;
          border:1px solid #fbbf24;
          background:#fffbeb;
          color:#92400e;
          font-size:12px;
          font-weight:800;
          vertical-align:middle;
        }
      `}</style>

      <div className="payout-detail__page">
        <section className="payout-detail__card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 className="payout-detail__title">{payoutRun.id}</h1>
              <p className="payout-detail__subtitle">
                {payoutRun.sellerStoreName}
                {payoutRun.sellerIsTestStore ? (
                  <>
                    {" "}
                    <span className="payout-detail__test-badge">テスト</span>
                  </>
                ) : null}{" "}
                / {formatMoney(payoutRun.amount, payoutRun.currencyCode)} /{" "}
                {payoutRun.statusLabel}
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <Link
                className="payout-detail__button payout-detail__button--secondary"
                to="/app/payout-runs"
              >
                一覧へ戻る
              </Link>
              {payoutRun.status === "draft" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="approve" />
                  <button
                    type="submit"
                    className="payout-detail__button"
                    disabled={isApproving}
                  >
                    {isApproving ? "承認中..." : "承認する"}
                  </button>
                </Form>
              ) : null}
            </div>
          </div>
          {actionData?.message ? (
            <p
              className={
                actionData.ok ? "payout-detail__notice" : "payout-detail__error"
              }
            >
              {actionData.message}
            </p>
          ) : null}
        </section>

        {payoutRun.status === "approved" &&
        payoutRun.transferMethod === "wise_api" ? (
          <section className="payout-detail__card">
            <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
              Wise API送金
            </h2>
            <p className="payout-detail__subtitle">
              承認済みの精算額をWise
              APIで送金します。送金完了が確認できるまで、台帳の支払済みdebitは作成しません。
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="executeWise" />
              <button
                type="submit"
                className="payout-detail__button"
                disabled={isExecutingWise}
              >
                {isExecutingWise ? "Wise送金中..." : "Wise APIで送金実行"}
              </button>
            </Form>
          </section>
        ) : null}

        {["processing", "reconciliation_required"].includes(payoutRun.status) &&
        payoutRun.transferMethod === "wise_api" ? (
          <section className="payout-detail__card">
            <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
              Wiseステータス確認
            </h2>
            <p className="payout-detail__subtitle">
              {payoutRun.status === "reconciliation_required"
                ? "送金結果が確定していません。Wise側の同じtransfer IDを確認してください。新しい送金は作成せず、ステータス確認だけを実行します。"
                : "Wise送金は処理中です。ステータスを確認し、完了していれば台帳へ反映します。"}
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="syncWise" />
              <button
                type="submit"
                className="payout-detail__button"
                disabled={isSyncingWise}
              >
                {isSyncingWise ? "確認中..." : "Wiseステータスを確認"}
              </button>
            </Form>
          </section>
        ) : null}

        {payoutRun.status === "approved" &&
        payoutRun.transferMethod === "manual_bank_transfer" ? (
          <section className="payout-detail__card">
            <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
              手動送金を開始
            </h2>
            <p className="payout-detail__subtitle">
              最新残高を再確認してこの出金予定を確保します。この操作では台帳を支払済みにせず、実際の銀行振込も行いません。
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="markPaid" />
              <button
                type="submit"
                className="payout-detail__button"
                disabled={isMarkingPaid}
              >
                {isMarkingPaid ? "確保中..." : "手動送金の処理を開始"}
              </button>
            </Form>
          </section>
        ) : null}

        {payoutRun.status === "processing" &&
        payoutRun.transferMethod === "manual_bank_transfer" ? (
          <section className="payout-detail__card">
            <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
              手動送金を完了
            </h2>
            <p className="payout-detail__subtitle">
              銀行側で実際の振込が完了した後、その証跡となる送金IDを入力してください。完了時に初めて台帳へ反映します。
            </p>
            <Form method="post" className="payout-detail__form">
              <input type="hidden" name="intent" value="markPaid" />
              <label>
                送金ID / 振込受付番号
                <input
                  className="payout-detail__input"
                  name="externalTransferId"
                  required
                  placeholder="例: bank_20260516_001"
                />
              </label>
              <label>
                メモ
                <textarea
                  className="payout-detail__textarea"
                  name="transferMemo"
                  placeholder="例: 2026年5月分の手動振込"
                />
              </label>
              <button
                type="submit"
                className="payout-detail__button"
                disabled={isMarkingPaid}
              >
                {isMarkingPaid ? "完了処理中..." : "送金完了を記録"}
              </button>
            </Form>
          </section>
        ) : null}

        <section className="payout-detail__card">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <Row label="出店者" value={payoutRun.sellerStoreName} />
                <Row label="状態" value={payoutRun.statusLabel} />
                <Row
                  label="金額"
                  value={formatMoney(payoutRun.amount, payoutRun.currencyCode)}
                />
                <Row label="送金方法" value={payoutRun.transferMethodLabel} />
                <Row
                  label="外部送金ID"
                  value={payoutRun.externalTransferId || "-"}
                />
                <Row label="送金メモ" value={payoutRun.transferMemo || "-"} />
                <Row
                  label="Wise受取先ID"
                  value={payoutRun.payoutRecipient?.wiseRecipientId || "-"}
                />
                <Row
                  label="Wise quote ID"
                  value={payoutRun.wiseQuoteId || "-"}
                />
                <Row
                  label="Wise transfer ID"
                  value={payoutRun.wiseTransferId || "-"}
                />
                <Row
                  label="Wise status"
                  value={payoutRun.wiseTransferStatus || "-"}
                />
                <Row label="失敗コード" value={payoutRun.failureCode || "-"} />
                <Row label="失敗理由" value={payoutRun.failureMessage || "-"} />
                <Row
                  label="承認日時"
                  value={formatDateTime(payoutRun.approvedAt)}
                />
                <Row
                  label="送金記録日時"
                  value={formatDateTime(payoutRun.executedAt)}
                />
                <Row
                  label="更新日時"
                  value={formatDateTime(payoutRun.updatedAt)}
                />
              </tbody>
            </table>
          </div>
        </section>

        <section className="payout-detail__card">
          <h2 className="payout-detail__title" style={{ fontSize: "18px" }}>
            売上台帳
          </h2>
          {payoutRun.ledgerEntries.length === 0 ? (
            <p style={{ margin: 0 }}>台帳記録はまだありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>日時</th>
                    <th style={thStyle}>種別</th>
                    <th style={thStyle}>金額</th>
                    <th style={thStyle}>方向</th>
                    <th style={thStyle}>対象ID</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRun.ledgerEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td style={tdStyle}>
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td style={tdStyle}>{entry.entryType}</td>
                      <td style={tdStyle}>
                        {formatMoney(entry.amount, entry.currencyCode)}
                      </td>
                      <td style={tdStyle}>{entry.direction}</td>
                      <td style={tdStyle}>{entry.stripeObjectId || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <tr>
      <th style={thStyle}>{label}</th>
      <td style={tdStyle}>{value}</td>
    </tr>
  );
}

function formatMoney(amount, currencyCode) {
  return `${amount} ${String(currencyCode || "jpy").toUpperCase()}`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("ja-JP") : "-";
}

function createPayoutRunErrorMessage(reason) {
  switch (reason) {
    case "payout_run_not_found":
      return "出金予定が見つかりません。";
    case "payout_run_not_approvable":
      return "この出金予定は承認できない状態です。";
    case "payout_run_not_executable":
      return "この出金予定は送金済みにできない状態です。";
    case "payout_creator_missing":
    case "payout_audit_identity_missing":
      return "操作担当者の監査情報が不足しています。この出金予定は実行せず、作り直してください。";
    case "payout_maker_checker_required":
      return "作成者と承認者を分ける必要があります。別の担当者が操作してください。";
    case "payout_approval_snapshot_missing":
      return "承認時の送金方法・受取先記録がありません。この出金予定は実行せず、作り直してください。";
    case "payout_transfer_method_changed":
    case "payout_currency_changed":
    case "payout_recipient_changed":
      return "承認後に送金条件または受取先が変更されています。再実行せず、出金予定を作り直してください。";
    case "payout_processing_owner_mismatch":
      return "処理を開始した担当者と完了担当者が一致しません。処理状況を確認してください。";
    case "external_transfer_id_required":
      return "実際の振込後に、金融機関の送金IDを入力してください。";
    case "external_transfer_id_duplicate":
      return "この送金IDは別の出金記録ですでに使用されています。";
    case "wise_transfer_reconciliation_required":
      return "Wiseの結果を確定できません。資金状況をWise側で照合するまで再送金しないでください。";
    case "seller_payout_restricted":
      return "この出店者は制限中または禁止中のため、出金対象外です。";
    case "wise_payout_not_enabled":
      return "Wise API送金モードが有効ではありません。";
    case "wise_env_missing":
      return "Wise APIの環境変数が不足しています。";
    case "wise_live_transfers_disabled":
      return "Wise live送金は明示的に有効化されていません。";
    case "wise_recipient_missing":
      return "Wise受取先が未登録または有効ではありません。";
    case "insufficient_ledger_balance":
      return "台帳上の出金可能残高が不足しています。";
    case "insufficient_governed_balance":
      return "留保額または未精算の直接請求を差し引くと、出金可能残高が不足します。";
    case "seller_payout_hold":
      return "管理者判断により、この店舗の出金を保留しています。";
    case "seller_governance_required":
      return "事業者情報、契約、返品先などの出金前確認が完了していません。";
    case "wise_payout_execution_failed":
      return "Wise API送金に失敗しました。";
    case "wise_transfer_missing":
      return "Wise transfer IDが未作成です。";
    case "wise_transfer_failed":
      return "Wise送金が失敗ステータスになりました。";
    default:
      return "出金予定の更新に失敗しました。";
  }
}

const thStyle = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #e5e7eb",
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "14px 12px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};
