import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import {
  sendWithdrawalAcknowledgementEmail,
  sendWithdrawalCompletionEmail,
  sendWithdrawalReturnInstructionsEmail,
  sendWithdrawalStatusEmail,
  updateWithdrawalCompletionRecord,
  updateWithdrawalRefundDecision,
  updateWithdrawalReturnInfo,
  updateWithdrawalStatus,
} from "../services/withdrawals.server.js";
import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const withdrawalRequest = await prisma.withdrawalRequest.findUnique({
    where: { id: params.id },
    include: {
      statusHistory: { orderBy: { createdAt: "desc" } },
      emailLogs: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!withdrawalRequest) {
    throw new Response("Not Found", { status: 404 });
  }

  return json({
    withdrawalRequest: serializeWithdrawalRequest(withdrawalRequest),
    shopifyWriteActionsEnabled:
      String(process.env.WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS || "")
        .toLowerCase()
        .trim() === "true",
  });
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "resend_acknowledgement") {
    const result = await sendWithdrawalAcknowledgementEmail({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "受付確認メールを送信しました。"
        : `受付確認メールを送信できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "send_status_email") {
    const result = await sendWithdrawalStatusEmail({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "ステータス通知メールを送信しました。"
        : `ステータス通知メールを送信できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "send_return_instructions") {
    const result = await sendWithdrawalReturnInstructionsEmail({
      withdrawalRequestId: params.id,
      request,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "返送証明提出リンクをメールで送信しました。"
        : `返送案内メールを送信できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "add_admin_note") {
    const adminNotes = String(formData.get("adminNotes") || "").trim();
    await prisma.withdrawalRequest.update({
      where: { id: params.id },
      data: { adminNotes },
    });

    return redirect(`/app/withdrawals/${params.id}`);
  }

  if (intent === "update_return_info") {
    const result = await updateWithdrawalReturnInfo({
      id: params.id,
      formData,
      changedBy: "admin",
    });

    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "返送情報を保存しました。"
          : `返送情報を保存できませんでした: ${result.error || "unknown"}`,
      },
      { status: result.status || 200 },
    );
  }

  if (intent === "update_refund_decision") {
    const result = await updateWithdrawalRefundDecision({
      id: params.id,
      formData,
      changedBy: "admin",
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "返金判断を保存しました。Shopifyへの返金は自動実行していません。"
        : `返金判断を保存できませんでした: ${result.error || "unknown"}`,
    }, { status: result.status || 200 });
  }

  if (intent === "update_completion_record") {
    const result = await updateWithdrawalCompletionRecord({
      id: params.id,
      formData,
      changedBy: "admin",
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "完了記録を保存しました。Shopifyへの返金やキャンセルは自動実行していません。"
        : `完了記録を保存できませんでした: ${result.error || "unknown"}`,
    }, { status: result.status || 200 });
  }

  if (intent === "send_completion_email") {
    const result = await sendWithdrawalCompletionEmail({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "完了通知メールを送信しました。"
        : `完了通知メールを送信できませんでした: ${result.error || "unknown"}`,
    }, { status: result.status || 200 });
  }

  if (intent === "update_status") {
    const toStatus = String(formData.get("toStatus") || "");
    const reason = String(formData.get("reason") || "").trim() || null;
    const rejectionReason =
      String(formData.get("rejectionReason") || "").trim() || null;
    const shouldSendStatusEmail = formData.get("sendStatusEmail") === "1";

    const result = await updateWithdrawalStatus({
      id: params.id,
      toStatus,
      changedBy: "admin",
      reason,
      rejectionReason,
      metadataJson: {
        source: "admin_detail",
      },
    });

    if (result.ok && shouldSendStatusEmail) {
      const emailResult = await sendWithdrawalStatusEmail({
        withdrawalRequestId: params.id,
      });

      return json({
        ok: emailResult.ok,
        message: emailResult.ok
          ? "ステータスを更新し、状況メールを送信しました。"
          : `ステータスは更新しましたが、状況メールを送信できませんでした: ${
              emailResult.error || "unknown"
            }`,
      });
    }

    return json({
      ok: result.ok,
      message: result.ok
        ? "ステータスを更新しました。"
        : `ステータスを更新できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "execute_shopify_cancel" || intent === "execute_shopify_refund") {
    if (
      String(process.env.WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS || "")
        .toLowerCase()
        .trim() !== "true"
    ) {
      return json({
        ok: false,
        message:
          "Shopify書き込み処理は無効です。必要な確認後に WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS=true を設定してください。",
      });
    }

    return json({
      ok: false,
      message:
        "Shopifyキャンセル/返金の自動実行口は保護中です。まずは手動処理後にステータスを更新してください。",
    });
  }

  return json({ ok: false, message: "不明な操作です。" }, { status: 400 });
};

export default function WithdrawalDetailPage() {
  const { withdrawalRequest, shopifyWriteActionsEnabled } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <main className="withdrawal-detail">
      <style>{detailStyles}</style>
      <section className="withdrawal-detail__card withdrawal-detail__header">
        <div>
          <Link to="/app/withdrawals" className="withdrawal-detail__back">
            一覧へ戻る
          </Link>
          <h1>{withdrawalRequest.shopifyOrderName || withdrawalRequest.id}</h1>
          <p>
            {withdrawalRequest.customerName} / {withdrawalRequest.customerEmail}
          </p>
          <div className="withdrawal-detail__badges">
            <Badge tone={withdrawalRequest.statusTone}>
              {withdrawalRequest.statusLabel}
            </Badge>
            <Badge tone={withdrawalRequest.eligibilityTone}>
              {withdrawalRequest.eligibilityLabel}
            </Badge>
          </div>
        </div>
      </section>

      {actionData?.message ? (
        <div
          className={`withdrawal-detail__notice ${
            actionData.ok ? "withdrawal-detail__notice--ok" : "withdrawal-detail__notice--error"
          }`}
        >
          {actionData.message}
        </div>
      ) : null}

      <section className="withdrawal-detail__card withdrawal-detail__next">
        <h2>次にやること</h2>
        <strong>{withdrawalRequest.nextAction.title}</strong>
        <p>{withdrawalRequest.nextAction.description}</p>
        {withdrawalRequest.nextAction.items.length > 0 ? (
          <ol>
            {withdrawalRequest.nextAction.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="withdrawal-detail__grid">
        <div className="withdrawal-detail__card">
          <h2>申請内容</h2>
          <DescriptionList
            rows={[
              ["受付番号", withdrawalRequest.id],
              ["注文番号", withdrawalRequest.shopifyOrderName || "-"],
              ["注文ID", withdrawalRequest.shopifyOrderId || "-"],
              ["氏名", withdrawalRequest.customerName],
              ["メール", withdrawalRequest.customerEmail],
              ["電話", withdrawalRequest.customerPhone || "-"],
              ["国", withdrawalRequest.countryLabel || withdrawalRequest.countryCode || "-"],
              ["受領日", withdrawalRequest.receivedDateLabel],
              ["期限", withdrawalRequest.deadlineAtLabel],
              [
                "撤回対象",
                withdrawalRequest.withdrawalScope === "PARTIAL"
                  ? "一部の商品"
                  : "注文全体",
              ],
              ["商品状態", withdrawalRequest.itemCondition || "-"],
              ["理由", withdrawalRequest.reason || "-"],
            ]}
          />
        </div>

        <div className="withdrawal-detail__card">
          <h2>注文照合</h2>
          <DescriptionList rows={withdrawalRequest.orderSummaryRows} />
        </div>

        <div className="withdrawal-detail__card">
          <h2>返送確認</h2>
          <DescriptionList rows={withdrawalRequest.returnInfoRows} />
          {withdrawalRequest.returnWarnings.length > 0 ? (
            <WarningList items={withdrawalRequest.returnWarnings} />
          ) : null}
          <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
            <input type="hidden" name="intent" value="update_return_info" />
            <label>
              <span>返送状況</span>
              <select
                name="returnRequirementStatus"
                defaultValue={withdrawalRequest.returnRequirementStatus}
              >
                <option value="UNDECIDED">未判断</option>
                <option value="NOT_REQUIRED">返送不要</option>
                <option value="REQUIRED">返送が必要</option>
                <option value="WAITING">返送待ち</option>
                <option value="IN_TRANSIT">返送中</option>
                <option value="RECEIVED">返送到着済み</option>
                <option value="CONDITION_CHECKED">商品状態確認済み</option>
              </select>
            </label>
            <div className="withdrawal-detail__amount-grid">
              <label>
                <span>配送会社</span>
                <input
                  name="returnTrackingCompany"
                  defaultValue={withdrawalRequest.returnTrackingCompany}
                />
              </label>
              <label>
                <span>追跡番号</span>
                <input
                  name="returnTrackingNumber"
                  defaultValue={withdrawalRequest.returnTrackingNumber}
                />
              </label>
              <label>
                <span>追跡URL</span>
                <input
                  name="returnTrackingUrl"
                  defaultValue={withdrawalRequest.returnTrackingUrl}
                />
              </label>
              <label>
                <span>返送到着日</span>
                <input
                  type="date"
                  name="returnReceivedAt"
                  defaultValue={withdrawalRequest.returnReceivedAtInput}
                />
              </label>
            </div>
            <label>
              <span>商品状態</span>
              <select
                name="returnConditionStatus"
                defaultValue={withdrawalRequest.returnConditionStatus}
              >
                <option value="UNDECIDED">未判断</option>
                <option value="NOT_APPLICABLE">確認不要</option>
                <option value="UNUSED_OK">未使用・問題なし</option>
                <option value="OPENED_OK">開封/確認程度</option>
                <option value="USED_REVIEW">使用感あり</option>
                <option value="DIRTY_REVIEW">汚れあり</option>
                <option value="DAMAGED_REVIEW">破損あり</option>
                <option value="EXEMPT_REVIEW">対象外の可能性あり</option>
              </select>
            </label>
            <label>
              <span>商品状態メモ</span>
              <textarea
                name="returnConditionNotes"
                rows="3"
                defaultValue={withdrawalRequest.returnConditionNotes}
              />
            </label>
            <p className="withdrawal-detail__hint">
              返送証明・到着日・商品状態を記録します。ここで保存してもShopifyへの返金は実行されません。
            </p>
            <button type="submit" disabled={isSubmitting}>
              返送情報を保存
            </button>
          </Form>
        </div>

        <div className="withdrawal-detail__card">
          <h2>返金判断</h2>
          <DescriptionList rows={withdrawalRequest.refundDecisionRows} />
          {withdrawalRequest.refundWarnings.length > 0 ? (
            <WarningList items={withdrawalRequest.refundWarnings} />
          ) : null}
          <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
            <input type="hidden" name="intent" value="update_refund_decision" />
            <label>
              <span>判断</span>
              <select
                name="refundDecisionStatus"
                defaultValue={withdrawalRequest.refundDecisionStatus}
              >
                <option value="UNDECIDED">未判断</option>
                <option value="FULL_REFUND">全額返金</option>
                <option value="PARTIAL_REFUND">一部返金</option>
                <option value="NO_REFUND">返金なし</option>
                <option value="RETURN_PENDING">返送待ち</option>
              </select>
            </label>
            <div className="withdrawal-detail__amount-grid">
              <label>
                <span>商品代金</span>
                <input
                  name="refundItemAmount"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  defaultValue={withdrawalRequest.refundItemAmountInput}
                />
              </label>
              <label>
                <span>通常配送分の初回送料</span>
                <input
                  name="refundInitialShippingAmount"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  defaultValue={withdrawalRequest.refundInitialShippingAmountInput}
                />
              </label>
              <label>
                <span>減額</span>
                <input
                  name="refundDeductionAmount"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  defaultValue={withdrawalRequest.refundDeductionAmountInput}
                />
              </label>
              <label>
                <span>通貨</span>
                <input
                  name="refundCurrencyCode"
                  defaultValue={withdrawalRequest.refundCurrencyCode}
                />
              </label>
            </div>
            <label>
              <span>返送送料</span>
              <select
                name="returnShippingPayer"
                defaultValue={withdrawalRequest.returnShippingPayer}
              >
                <option value="UNDECIDED">未判断</option>
                <option value="CUSTOMER">お客様負担</option>
                <option value="STORE">当店負担</option>
                <option value="LEGAL_STORE">法令または案内により当店負担</option>
              </select>
            </label>
            <label>
              <span>判断理由</span>
              <textarea
                name="refundDecisionReason"
                rows="2"
                defaultValue={withdrawalRequest.refundDecisionReason}
              />
            </label>
            <label>
              <span>社内メモ</span>
              <textarea
                name="refundDecisionNotes"
                rows="3"
                defaultValue={withdrawalRequest.refundDecisionNotes}
              />
            </label>
            <p className="withdrawal-detail__hint">
              保存してもShopifyへの返金は実行されません。実返金前の判断メモとして使います。
            </p>
            <button type="submit" disabled={isSubmitting}>
              返金判断を保存
            </button>
          </Form>
        </div>

        <div className="withdrawal-detail__card">
          <h2>管理操作</h2>
          <Form method="post" className="withdrawal-detail__form">
            <input type="hidden" name="intent" value="update_status" />
            <label>
              <span>次の状態</span>
              <select name="toStatus" defaultValue={withdrawalRequest.status}>
                {Object.values(WITHDRAWAL_STATUSES).map((status) => (
                  <option key={status} value={status}>
                    {getWithdrawalStatusLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>理由 / メモ</span>
              <textarea name="reason" rows="3" />
            </label>
            <label>
              <span>却下理由 任意</span>
              <textarea name="rejectionReason" rows="2" />
            </label>
            <label className="withdrawal-detail__checkbox">
              <input type="checkbox" name="sendStatusEmail" value="1" />
              <span>更新後に購入者へ状況メールを送る</span>
            </label>
            <button type="submit" disabled={isSubmitting}>
              ステータスを更新
            </button>
          </Form>

          {withdrawalRequest.quickActions.length > 0 ? (
            <div className="withdrawal-detail__quick-actions">
              <strong>よく使う更新</strong>
              <div className="withdrawal-detail__button-row">
                {withdrawalRequest.quickActions.map((action) => (
                  <Form method="post" key={action.status}>
                    <input type="hidden" name="intent" value="update_status" />
                    <input type="hidden" name="toStatus" value={action.status} />
                    <input type="hidden" name="reason" value={action.reason} />
                    <button type="submit" disabled={isSubmitting}>
                      {action.label}
                    </button>
                  </Form>
                ))}
              </div>
            </div>
          ) : null}

          <div className="withdrawal-detail__button-row">
            <Form method="post">
              <input type="hidden" name="intent" value="resend_acknowledgement" />
              <button type="submit" disabled={isSubmitting}>
                受付メール再送
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="send_status_email" />
              <button type="submit" disabled={isSubmitting}>
                状況メール送信
              </button>
            </Form>
          </div>

          <div className="withdrawal-detail__button-row">
            <Form method="post">
              <input type="hidden" name="intent" value="send_return_instructions" />
              <button type="submit" disabled={isSubmitting}>
                返送証明リンク送信
              </button>
            </Form>
          </div>

          <div className="withdrawal-detail__completion">
            <h3>完了記録</h3>
            <DescriptionList rows={withdrawalRequest.completionRows} />
            <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
              <input type="hidden" name="intent" value="update_completion_record" />
              <label>
                <span>処理結果</span>
                <select
                  name="completionStatus"
                  defaultValue={withdrawalRequest.completionStatus}
                >
                  <option value="UNDECIDED">未記録</option>
                  <option value="REFUNDED">返金済み</option>
                  <option value="PARTIALLY_REFUNDED">一部返金済み</option>
                  <option value="CANCELLED">キャンセル済み</option>
                  <option value="NO_REFUND_CLOSED">返金なしで完了</option>
                  <option value="REJECTED_CLOSED">対象外として完了</option>
                  <option value="MANUAL_CLOSED">手動完了</option>
                </select>
              </label>
              <label>
                <span>処理内容</span>
                <input
                  name="completionAction"
                  defaultValue={withdrawalRequest.completionAction}
                  placeholder="例: Shopify管理画面で返金済み"
                />
              </label>
              <div className="withdrawal-detail__amount-grid">
                <label>
                  <span>返金処理額</span>
                  <input
                    name="completionRefundedAmount"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    defaultValue={withdrawalRequest.completionRefundedAmountInput}
                  />
                </label>
                <label>
                  <span>初回送料の返金額</span>
                  <input
                    name="completionRefundedShipping"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    defaultValue={withdrawalRequest.completionRefundedShippingInput}
                  />
                </label>
                <label>
                  <span>通貨</span>
                  <input
                    name="completionCurrencyCode"
                    defaultValue={withdrawalRequest.completionCurrencyCode}
                  />
                </label>
              </div>
              <label>
                <span>Shopify返金ID</span>
                <input
                  name="completionShopifyRefundId"
                  defaultValue={withdrawalRequest.completionShopifyRefundId}
                />
              </label>
              <label>
                <span>ShopifyキャンセルID</span>
                <input
                  name="completionShopifyCancelId"
                  defaultValue={withdrawalRequest.completionShopifyCancelId}
                />
              </label>
              <label>
                <span>完了メモ</span>
                <textarea
                  name="completionNotes"
                  rows="3"
                  defaultValue={withdrawalRequest.completionNotes}
                />
              </label>
              <p className="withdrawal-detail__hint">
                ここで保存してもShopifyへの返金・キャンセルは自動実行されません。実処理後の記録として使います。
              </p>
              <button type="submit" disabled={isSubmitting}>
                完了記録を保存
              </button>
            </Form>
            <Form method="post" className="withdrawal-detail__inline-form">
              <input type="hidden" name="intent" value="send_completion_email" />
              <button type="submit" disabled={isSubmitting}>
                完了通知メール送信
              </button>
            </Form>
          </div>

          <div className="withdrawal-detail__guard">
            <strong>Shopify自動処理</strong>
            <p>
              {shopifyWriteActionsEnabled
                ? "書き込みフラグはONですが、自動キャンセル/返金はまだ保護中です。"
                : "書き込みフラグがOFFのため、Shopifyキャンセル/返金mutationは呼びません。"}
            </p>
            <div className="withdrawal-detail__button-row">
              <Form method="post">
                <input type="hidden" name="intent" value="execute_shopify_cancel" />
                <button type="submit" disabled={isSubmitting}>
                  キャンセル実行口
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="execute_shopify_refund" />
                <button type="submit" disabled={isSubmitting}>
                  返金実行口
                </button>
              </Form>
            </div>
          </div>
        </div>
      </section>

      <section className="withdrawal-detail__grid">
        <div className="withdrawal-detail__card">
          <h2>対象商品</h2>
          <pre className="withdrawal-detail__pre">
            {JSON.stringify(withdrawalRequest.selectedLineItemsJson, null, 2)}
          </pre>
        </div>
        <div className="withdrawal-detail__card">
          <h2>判定情報</h2>
          <pre className="withdrawal-detail__pre">
            {JSON.stringify(withdrawalRequest.eligibilityJson, null, 2)}
          </pre>
        </div>
      </section>

      <section className="withdrawal-detail__card">
        <h2>管理メモ</h2>
        <Form method="post" className="withdrawal-detail__form">
          <input type="hidden" name="intent" value="add_admin_note" />
          <textarea
            name="adminNotes"
            rows="5"
            defaultValue={withdrawalRequest.adminNotes || ""}
          />
          <button type="submit" disabled={isSubmitting}>
            メモを保存
          </button>
        </Form>
      </section>

      <section className="withdrawal-detail__grid">
        <TimelineCard title="ステータス履歴" rows={withdrawalRequest.statusHistory} />
        <EmailLogCard rows={withdrawalRequest.emailLogs} />
      </section>
    </main>
  );
}

function DescriptionList({ rows }) {
  return (
    <dl className="withdrawal-detail__dl">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WarningList({ items }) {
  return (
    <div className="withdrawal-detail__warnings">
      <strong>確認が必要です</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function TimelineCard({ title, rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <div className="withdrawal-detail__empty">履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {rows.map((row) => (
            <div key={row.id}>
              <strong>{row.toStatusLabel}</strong>
              <span>{row.createdAtLabel}</span>
              <p>{row.reason || "-"}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmailLogCard({ rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>メールログ</h2>
      {rows.length === 0 ? (
        <div className="withdrawal-detail__empty">メールログはありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {rows.map((row) => (
            <div key={row.id}>
              <strong>{row.emailType} / {row.status}</strong>
              <span>{row.createdAtLabel}</span>
              <p>{row.subject}</p>
              {row.errorMessage ? <p className="withdrawal-detail__error">{row.errorMessage}</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Badge({ tone, children }) {
  return <span className={`withdrawal-detail__badge withdrawal-detail__badge--${tone}`}>{children}</span>;
}

function serializeWithdrawalRequest(request) {
  const orderSummaryRows = buildOrderSummaryRows(request);
  const refundCurrencyCode =
    request.refundCurrencyCode || getOrderCurrencyCode(request) || "JPY";
  const completionCurrencyCode =
    request.completionCurrencyCode || refundCurrencyCode || "JPY";

  return {
    id: request.id,
    shopDomain: request.shopDomain,
    shopifyOrderId: request.shopifyOrderId,
    shopifyOrderName: request.shopifyOrderName,
    shopifyOrderNumber: request.shopifyOrderNumber,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    customerPhone: request.customerPhone,
    countryCode: request.countryCode,
    countryLabel: request.countryLabel,
    receivedDateLabel: formatDate(request.receivedDate),
    withdrawalScope: request.withdrawalScope,
    itemCondition: request.itemCondition,
    reason: request.reason,
    status: request.status,
    statusLabel: getWithdrawalStatusLabel(request.status),
    statusTone: getWithdrawalStatusTone(request.status),
    eligibilityStatus: request.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(request.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    deadlineAtLabel: formatDate(request.deadlineAt),
    selectedLineItemsJson: request.selectedLineItemsJson || {},
    eligibilityJson: request.eligibilityJson || {},
    submittedPayloadJson: request.submittedPayloadJson || {},
    orderSnapshotJson: request.orderSnapshotJson || {},
    orderSummaryRows,
    returnInfoRows: buildReturnInfoRows(request),
    returnWarnings: buildWithdrawalReturnWarnings(request),
    returnRequirementStatus: request.returnRequirementStatus || "UNDECIDED",
    returnRequirementLabel: getReturnRequirementLabel(
      request.returnRequirementStatus,
    ),
    returnTrackingCompany: request.returnTrackingCompany || "",
    returnTrackingNumber: request.returnTrackingNumber || "",
    returnTrackingUrl: request.returnTrackingUrl || "",
    returnReceivedAtInput: formatDateInput(request.returnReceivedAt),
    returnReceivedAtLabel: formatDate(request.returnReceivedAt),
    returnConditionStatus: request.returnConditionStatus || "UNDECIDED",
    returnConditionLabel: getReturnConditionLabel(request.returnConditionStatus),
    returnConditionNotes: request.returnConditionNotes || "",
    returnInfoUpdatedAtLabel: formatDate(request.returnInfoUpdatedAt),
    returnInfoUpdatedBy: request.returnInfoUpdatedBy || "-",
    returnProofSubmittedAtLabel: formatDate(request.returnProofSubmittedAt),
    returnProofTokenExpiresAtLabel: formatDate(request.returnProofTokenExpiresAt),
    refundDecisionRows: buildRefundDecisionRows(request, refundCurrencyCode),
    refundWarnings: buildWithdrawalRefundWarnings(request),
    refundDecisionStatus: request.refundDecisionStatus || "UNDECIDED",
    refundDecisionLabel: getRefundDecisionLabel(request.refundDecisionStatus),
    refundItemAmountInput: formatInputAmount(request.refundItemAmount),
    refundInitialShippingAmountInput: formatInputAmount(
      request.refundInitialShippingAmount,
    ),
    refundDeductionAmountInput: formatInputAmount(request.refundDeductionAmount),
    refundTotalAmountLabel: formatAmount(
      request.refundTotalAmount,
      refundCurrencyCode,
    ),
    refundCurrencyCode,
    returnShippingPayer: request.returnShippingPayer || "UNDECIDED",
    returnShippingPayerLabel: getReturnShippingPayerLabel(
      request.returnShippingPayer,
    ),
    refundDecisionReason: request.refundDecisionReason || "",
    refundDecisionNotes: request.refundDecisionNotes || "",
    refundDecisionUpdatedAtLabel: formatDate(request.refundDecisionUpdatedAt),
    refundDecisionUpdatedBy: request.refundDecisionUpdatedBy || "-",
    completionRows: buildCompletionRows(request, completionCurrencyCode),
    completionStatus: request.completionStatus || "UNDECIDED",
    completionStatusLabel: getCompletionStatusLabel(request.completionStatus),
    completionAction: request.completionAction || "",
    completionShopifyRefundId: request.completionShopifyRefundId || "",
    completionShopifyCancelId: request.completionShopifyCancelId || "",
    completionRefundedAmountInput: formatInputAmount(
      request.completionRefundedAmount,
    ),
    completionRefundedShippingInput: formatInputAmount(
      request.completionRefundedShipping,
    ),
    completionCurrencyCode,
    completionNotes: request.completionNotes || "",
    completionRecordedAtLabel: formatDate(request.completionRecordedAt),
    completionRecordedBy: request.completionRecordedBy || "-",
    completionNotifiedAtLabel: formatDate(request.completionNotifiedAt),
    completionEmailMessageId: request.completionEmailMessageId || "-",
    nextAction: buildNextAction(request),
    quickActions: buildQuickActions(request.status),
    adminNotes: request.adminNotes || "",
    statusHistory: request.statusHistory.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      toStatusLabel: getWithdrawalStatusLabel(row.toStatus),
      reason: row.reason,
      changedBy: row.changedBy,
      metadataJson: row.metadataJson,
      createdAtLabel: formatDate(row.createdAt),
    })),
    emailLogs: request.emailLogs.map((row) => ({
      id: row.id,
      emailType: row.emailType,
      status: row.status,
      subject: row.subject,
      errorMessage: row.errorMessage,
      createdAtLabel: formatDate(row.createdAt),
    })),
  };
}

function buildNextAction(request) {
  if (request.eligibilityStatus === "ORDER_NOT_FOUND_REVIEW") {
    return {
      title: "注文番号とメールを確認",
      description: "注文を自動照合できていません。Shopify注文管理で注文番号と購入者メールを確認してください。",
      items: [
        "注文が見つかれば申請内容を管理メモに残す",
        "対象外や入力ミスなら購入者へ確認連絡する",
      ],
    };
  }

  if (request.eligibilityStatus === "EMAIL_MISMATCH_REVIEW") {
    return {
      title: "購入者メールの照合",
      description: "入力メールと注文メールが一致していません。本人確認が取れるまで返金判断を保留してください。",
      items: ["注文者本人か確認する", "確認後に確認中または却下へ進める"],
    };
  }

  if (request.eligibilityStatus === "DEADLINE_EXPIRED") {
    return {
      title: "期限超過の確認",
      description: "14日を超えている可能性があります。配送完了日や購入者申告日を確認してください。",
      items: ["期限内なら確認中へ進める", "期限外なら却下理由を残して却下する"],
    };
  }

  switch (request.status) {
    case WITHDRAWAL_STATUSES.REQUESTED:
    case WITHDRAWAL_STATUSES.ACKNOWLEDGED:
      return {
        title: "申請内容を確認",
        description: "注文内容、配送状況、撤回対象、商品状態を確認してください。",
        items: [
          "未発送ならキャンセル可否を確認",
          "発送済みなら返送案内へ進める",
          "例外商品や減額要素があれば管理メモに残す",
        ],
      };
    case WITHDRAWAL_STATUSES.UNDER_REVIEW:
      return {
        title: "承認または返送待ちへ進める",
        description: "撤回対象として扱えるかを判断し、次の状態に更新します。",
        items: ["未発送なら承認済みまたはキャンセル済みにする", "発送済みなら返送待ちにする"],
      };
    case WITHDRAWAL_STATUSES.APPROVED:
      return {
        title: "返送または返金準備",
        description: "承認済みの申請です。発送状況に応じて返送待ちまたは返金準備へ進めます。",
        items: ["返送が必要なら返送待ち", "返送不要または未発送なら返金準備中"],
      };
    case WITHDRAWAL_STATUSES.RETURN_REQUESTED:
      return {
        title: "返送到着を待つ",
        description: "返送または返送証明を確認したら、返送確認済みに更新してください。",
        items: ["追跡番号や返送証明を管理メモに残す", "商品状態に減額要素がないか確認する"],
      };
    case WITHDRAWAL_STATUSES.RETURN_RECEIVED:
      return {
        title: "返金額を確定",
        description: "商品状態を確認し、返金対象額を確定してください。",
        items: ["通常配送分の初回送料を返金対象として確認", "減額がある場合は理由を管理メモに残す"],
      };
    case WITHDRAWAL_STATUSES.REFUND_PENDING:
      return {
        title: "Shopifyで返金処理",
        description: "管理者がShopify側で返金を実行し、完了後に返金済みに更新します。",
        items: ["返金実行後、返金IDや金額を管理メモに残す", "購入者へ状況メールを送る"],
      };
    case WITHDRAWAL_STATUSES.REFUNDED:
    case WITHDRAWAL_STATUSES.CANCELLED:
      return {
        title: "処理完了",
        description: "この申請は完了状態です。必要に応じて履歴とメールログを確認してください。",
        items: [],
      };
    case WITHDRAWAL_STATUSES.REJECTED:
    case WITHDRAWAL_STATUSES.EXPIRED:
      return {
        title: "対象外処理済み",
        description: "却下または期限切れとして処理されています。理由が残っているか確認してください。",
        items: [],
      };
    default:
      return {
        title: "内容を確認",
        description: "申請内容とステータス履歴を確認してください。",
        items: [],
      };
  }
}

function buildQuickActions(status) {
  const actionsByStatus = {
    [WITHDRAWAL_STATUSES.REQUESTED]: [
      {
        status: WITHDRAWAL_STATUSES.UNDER_REVIEW,
        label: "確認中にする",
        reason: "admin_started_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.ACKNOWLEDGED]: [
      {
        status: WITHDRAWAL_STATUSES.UNDER_REVIEW,
        label: "確認中にする",
        reason: "admin_started_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.UNDER_REVIEW]: [
      {
        status: WITHDRAWAL_STATUSES.APPROVED,
        label: "承認済みにする",
        reason: "approved_after_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.APPROVED]: [
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
      {
        status: WITHDRAWAL_STATUSES.REFUND_PENDING,
        label: "返金準備中にする",
        reason: "ready_for_refund",
      },
    ],
    [WITHDRAWAL_STATUSES.RETURN_REQUESTED]: [
      {
        status: WITHDRAWAL_STATUSES.RETURN_RECEIVED,
        label: "返送確認済みにする",
        reason: "return_received",
      },
    ],
    [WITHDRAWAL_STATUSES.RETURN_RECEIVED]: [
      {
        status: WITHDRAWAL_STATUSES.REFUND_PENDING,
        label: "返金準備中にする",
        reason: "ready_for_refund",
      },
    ],
    [WITHDRAWAL_STATUSES.REFUND_PENDING]: [
      {
        status: WITHDRAWAL_STATUSES.REFUNDED,
        label: "返金済みにする",
        reason: "refund_completed_manually",
      },
    ],
  };

  return actionsByStatus[status] || [];
}

function buildOrderSummaryRows(request) {
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : null;

  if (!snapshot) {
    return [
      ["照合状態", "注文を自動照合できていません"],
      ["注文番号", request.shopifyOrderName || request.shopifyOrderNumber || "-"],
    ];
  }

  return [
    ["照合状態", "照合済み"],
    ["注文番号", snapshot.shopifyOrderName || request.shopifyOrderName || "-"],
    ["購入者メール", snapshot.buyerEmail || "-"],
    ["支払い状態", snapshot.financialStatus || "-"],
    ["配送状態", snapshot.fulfillmentStatus || "-"],
    ["商品小計", formatAmount(snapshot.subtotalAmount, snapshot.currencyCode)],
    ["初回送料", formatAmount(snapshot.shippingAmount, snapshot.currencyCode)],
    ["税", formatAmount(snapshot.taxAmount, snapshot.currencyCode)],
    ["合計", formatAmount(snapshot.totalAmount, snapshot.currencyCode)],
    ["配送先国", snapshot.shippingCountryCode || "-"],
    ["注文日時", formatDate(snapshot.processedAt || snapshot.createdAt)],
  ];
}

function buildReturnInfoRows(request) {
  return [
    ["返送状況", getReturnRequirementLabel(request.returnRequirementStatus)],
    ["配送会社", request.returnTrackingCompany || "-"],
    ["追跡番号", request.returnTrackingNumber || "-"],
    ["追跡URL", request.returnTrackingUrl || "-"],
    ["返送到着日", formatDate(request.returnReceivedAt)],
    ["商品状態", getReturnConditionLabel(request.returnConditionStatus)],
    ["商品状態メモ", request.returnConditionNotes || "-"],
    ["更新者", request.returnInfoUpdatedBy || "-"],
    ["更新日時", formatDate(request.returnInfoUpdatedAt)],
  ];
}

function buildWithdrawalReturnWarnings(request) {
  const warnings = [];
  const returnRequirementStatus = String(
    request.returnRequirementStatus || "UNDECIDED",
  ).toUpperCase();
  const returnConditionStatus = String(
    request.returnConditionStatus || "UNDECIDED",
  ).toUpperCase();

  if (
    [
      WITHDRAWAL_STATUSES.RETURN_REQUESTED,
      WITHDRAWAL_STATUSES.RETURN_RECEIVED,
      WITHDRAWAL_STATUSES.REFUND_PENDING,
    ].includes(request.status) &&
    returnRequirementStatus === "UNDECIDED"
  ) {
    warnings.push("返送が必要か未判断です。返金判断の前に返送要否を確認してください。");
  }

  if (
    ["RECEIVED", "CONDITION_CHECKED"].includes(returnRequirementStatus) &&
    !request.returnReceivedAt
  ) {
    warnings.push("返送到着済みですが、到着日が未入力です。");
  }

  if (
    returnRequirementStatus === "CONDITION_CHECKED" &&
    returnConditionStatus === "UNDECIDED"
  ) {
    warnings.push("商品状態確認済みですが、商品状態が未判断です。");
  }

  if (
    ["USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"].includes(
      returnConditionStatus,
    ) &&
    !request.returnConditionNotes
  ) {
    warnings.push("減額や対象外判断につながる状態です。商品状態メモに理由を残してください。");
  }

  return warnings;
}

function buildWithdrawalRefundWarnings(request) {
  const warnings = [];
  const refundDecisionStatus = String(
    request.refundDecisionStatus || "UNDECIDED",
  ).toUpperCase();
  const returnRequirementStatus = String(
    request.returnRequirementStatus || "UNDECIDED",
  ).toUpperCase();
  const returnConditionStatus = String(
    request.returnConditionStatus || "UNDECIDED",
  ).toUpperCase();
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : null;
  const orderTotal = Number(snapshot?.totalAmount);

  if (
    ["FULL_REFUND", "PARTIAL_REFUND"].includes(refundDecisionStatus) &&
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(returnRequirementStatus)
  ) {
    warnings.push("返送確認前に返金判断が入っています。返送証明または到着確認を確認してください。");
  }

  if (
    refundDecisionStatus === "FULL_REFUND" &&
    ["USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"].includes(
      returnConditionStatus,
    )
  ) {
    warnings.push("商品状態が要確認なのに全額返金になっています。減額要否を確認してください。");
  }

  if (Number(request.refundDeductionAmount || 0) > 0 && !request.refundDecisionReason) {
    warnings.push("減額があるため、返金判断理由を残してください。");
  }

  if (
    request.refundInitialShippingAmount === null ||
    request.refundInitialShippingAmount === undefined
  ) {
    warnings.push("通常配送分の初回送料を返金対象として確認してください。");
  }

  if (
    Number.isFinite(orderTotal) &&
    Number(request.refundTotalAmount || 0) > orderTotal
  ) {
    warnings.push("返金予定額が注文合計を超えています。");
  }

  return warnings;
}

function buildRefundDecisionRows(request, currencyCode) {
  return [
    ["判断", getRefundDecisionLabel(request.refundDecisionStatus)],
    ["商品代金", formatAmount(request.refundItemAmount, currencyCode)],
    [
      "通常配送分の初回送料",
      formatAmount(request.refundInitialShippingAmount, currencyCode),
    ],
    ["減額", formatAmount(request.refundDeductionAmount, currencyCode)],
    ["返金予定額", formatAmount(request.refundTotalAmount, currencyCode)],
    ["返送送料", getReturnShippingPayerLabel(request.returnShippingPayer)],
    ["判断理由", request.refundDecisionReason || "-"],
    ["更新者", request.refundDecisionUpdatedBy || "-"],
    ["更新日時", formatDate(request.refundDecisionUpdatedAt)],
  ];
}

function buildCompletionRows(request, currencyCode) {
  return [
    ["処理結果", getCompletionStatusLabel(request.completionStatus)],
    ["処理内容", request.completionAction || "-"],
    ["返金処理額", formatAmount(request.completionRefundedAmount, currencyCode)],
    [
      "初回送料の返金額",
      formatAmount(request.completionRefundedShipping, currencyCode),
    ],
    ["Shopify返金ID", request.completionShopifyRefundId || "-"],
    ["ShopifyキャンセルID", request.completionShopifyCancelId || "-"],
    ["記録者", request.completionRecordedBy || "-"],
    ["記録日時", formatDate(request.completionRecordedAt)],
    ["完了通知", formatDate(request.completionNotifiedAt)],
  ];
}

function getOrderCurrencyCode(request) {
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : null;

  return snapshot?.currencyCode || null;
}

function getReturnRequirementLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    NOT_REQUIRED: "返送不要",
    REQUIRED: "返送が必要",
    WAITING: "返送待ち",
    IN_TRANSIT: "返送中",
    RECEIVED: "返送到着済み",
    CONDITION_CHECKED: "商品状態確認済み",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function getReturnConditionLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    NOT_APPLICABLE: "確認不要",
    UNUSED_OK: "未使用・問題なし",
    OPENED_OK: "開封/確認程度",
    USED_REVIEW: "使用感あり",
    DIRTY_REVIEW: "汚れあり",
    DAMAGED_REVIEW: "破損あり",
    EXEMPT_REVIEW: "対象外の可能性あり",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function getRefundDecisionLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    FULL_REFUND: "全額返金",
    PARTIAL_REFUND: "一部返金",
    NO_REFUND: "返金なし",
    RETURN_PENDING: "返送待ち",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function getReturnShippingPayerLabel(value) {
  const labels = {
    UNDECIDED: "未判断",
    CUSTOMER: "お客様負担",
    STORE: "当店負担",
    LEGAL_STORE: "法令または案内により当店負担",
  };

  return labels[String(value || "UNDECIDED").toUpperCase()] || String(value || "-");
}

function getCompletionStatusLabel(status) {
  const labels = {
    UNDECIDED: "未記録",
    REFUNDED: "返金済み",
    PARTIALLY_REFUNDED: "一部返金済み",
    CANCELLED: "キャンセル済み",
    NO_REFUND_CLOSED: "返金なしで完了",
    REJECTED_CLOSED: "対象外として完了",
    MANUAL_CLOSED: "手動完了",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function formatInputAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return "";
  const numeric = Number(amount);
  return Number.isFinite(numeric) ? String(numeric) : "";
}

function formatAmount(amount, currencyCode) {
  if (amount === null || amount === undefined || amount === "") return "-";
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  const currency = String(currencyCode || "").toUpperCase();
  return currency
    ? `${numeric.toLocaleString("ja-JP")} ${currency}`
    : numeric.toLocaleString("ja-JP");
}

function formatDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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

const detailStyles = `
  .withdrawal-detail{
    display:grid;
    gap:24px;
    padding:24px;
    min-height:100%;
    background:#f3f4f6;
    color:#111827;
  }
  .withdrawal-detail__card{
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:22px;
  }
  .withdrawal-detail__next{
    border-color:#bfdbfe;
    background:#eff6ff;
  }
  .withdrawal-detail__next strong{
    display:block;
    margin-bottom:6px;
    font-size:18px;
  }
  .withdrawal-detail__next p{
    margin:0 0 10px;
    color:#1f2937;
    line-height:1.7;
  }
  .withdrawal-detail__next ol{
    margin:0;
    padding-left:22px;
    color:#374151;
    line-height:1.7;
  }
  .withdrawal-detail__header h1{
    margin:12px 0 8px;
    font-size:30px;
  }
  .withdrawal-detail__header p{
    margin:0;
    color:#4b5563;
  }
  .withdrawal-detail__back{
    color:#1d4ed8;
    font-weight:800;
    text-decoration:none;
  }
  .withdrawal-detail__badges,
  .withdrawal-detail__button-row{
    display:flex;
    flex-wrap:wrap;
    gap:10px;
    margin-top:16px;
  }
  .withdrawal-detail__grid{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));
    gap:24px;
  }
  .withdrawal-detail h2{
    margin:0 0 16px;
    font-size:22px;
  }
  .withdrawal-detail__dl{
    display:grid;
    gap:0;
    border:1px solid #e5e7eb;
    border-radius:14px;
    overflow:hidden;
  }
  .withdrawal-detail__dl div{
    display:grid;
    grid-template-columns:150px minmax(0, 1fr);
    border-top:1px solid #e5e7eb;
  }
  .withdrawal-detail__dl div:first-child{
    border-top:none;
  }
  .withdrawal-detail__dl dt,
  .withdrawal-detail__dl dd{
    margin:0;
    padding:12px 14px;
    line-height:1.6;
  }
  .withdrawal-detail__dl dt{
    background:#f9fafb;
    color:#4b5563;
    font-weight:800;
  }
  .withdrawal-detail__dl dd{
    overflow-wrap:anywhere;
  }
  .withdrawal-detail__badge{
    display:inline-flex;
    border:1px solid #d1d5db;
    border-radius:999px;
    padding:5px 10px;
    font-size:12px;
    font-weight:800;
  }
  .withdrawal-detail__badge--success{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawal-detail__badge--warning{
    border-color:#fde68a;
    background:#fffbeb;
    color:#92400e;
  }
  .withdrawal-detail__badge--danger{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawal-detail__badge--info,
  .withdrawal-detail__badge--neutral{
    border-color:#bfdbfe;
    background:#eff6ff;
    color:#1d4ed8;
  }
  .withdrawal-detail__form{
    display:grid;
    gap:12px;
  }
  .withdrawal-detail__form label{
    display:grid;
    gap:6px;
    color:#4b5563;
    font-size:13px;
    font-weight:800;
  }
  .withdrawal-detail__form input,
  .withdrawal-detail__form select,
  .withdrawal-detail__form textarea{
    width:100%;
    box-sizing:border-box;
    border:1px solid #d1d5db;
    border-radius:12px;
    padding:12px;
    font:inherit;
  }
  .withdrawal-detail__form--spaced{
    margin-top:16px;
  }
  .withdrawal-detail__amount-grid{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
    gap:12px;
  }
  .withdrawal-detail__hint{
    margin:0;
    color:#6b7280;
    font-size:13px;
    line-height:1.7;
  }
  .withdrawal-detail__checkbox{
    display:flex !important;
    grid-template-columns:none !important;
    align-items:center;
    gap:8px;
    color:#374151 !important;
    font-size:14px !important;
  }
  .withdrawal-detail__checkbox input{
    width:16px;
    height:16px;
  }
  .withdrawal-detail button{
    min-height:42px;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 16px;
    background:#111827;
    color:#fff;
    font-weight:800;
    cursor:pointer;
  }
  .withdrawal-detail__quick-actions{
    margin-top:18px;
    padding:16px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    background:#f9fafb;
  }
  .withdrawal-detail__quick-actions > strong{
    display:block;
    margin-bottom:10px;
  }
  .withdrawal-detail__guard{
    margin-top:18px;
    padding:16px;
    border:1px solid #fde68a;
    border-radius:14px;
    background:#fffbeb;
    color:#92400e;
    line-height:1.7;
  }
  .withdrawal-detail__warnings{
    margin:14px 0;
    padding:14px 16px;
    border:1px solid #fbbf24;
    border-radius:14px;
    background:#fffbeb;
    color:#92400e;
    line-height:1.7;
  }
  .withdrawal-detail__warnings strong{
    display:block;
    margin-bottom:6px;
  }
  .withdrawal-detail__warnings ul{
    margin:0;
    padding-left:20px;
  }
  .withdrawal-detail__pre{
    max-height:360px;
    overflow:auto;
    border:1px solid #e5e7eb;
    border-radius:14px;
    background:#f9fafb;
    padding:14px;
    white-space:pre-wrap;
    word-break:break-word;
  }
  .withdrawal-detail__timeline{
    display:grid;
    gap:12px;
  }
  .withdrawal-detail__timeline div{
    border:1px solid #e5e7eb;
    border-radius:14px;
    padding:14px;
    background:#f9fafb;
  }
  .withdrawal-detail__timeline strong{
    display:block;
    margin-bottom:4px;
  }
  .withdrawal-detail__timeline span{
    color:#6b7280;
    font-size:12px;
  }
  .withdrawal-detail__timeline p{
    margin:8px 0 0;
    color:#4b5563;
  }
  .withdrawal-detail__empty{
    border:1px dashed #cbd5e1;
    border-radius:14px;
    padding:16px;
    color:#64748b;
  }
  .withdrawal-detail__notice{
    border:1px solid #d1d5db;
    border-radius:14px;
    padding:14px 16px;
    background:#f9fafb;
    color:#374151;
    font-weight:700;
  }
  .withdrawal-detail__notice--ok{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawal-detail__notice--error{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawal-detail__error{
    color:#b91c1c !important;
  }
`;
