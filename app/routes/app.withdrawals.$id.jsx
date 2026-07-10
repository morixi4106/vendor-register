import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

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
        ? "受付確認メールを再送しました。"
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
        ? "状況通知メールを送信しました。"
        : `状況通知メールを送信できませんでした: ${result.error || "unknown"}`,
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
        ? "返送証明の提出リンクをメールで送信しました。"
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

    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "返金判断を保存しました。Shopifyへの返金は自動実行していません。"
          : `返金判断を保存できませんでした: ${result.error || "unknown"}`,
      },
      { status: result.status || 200 },
    );
  }

  if (intent === "update_completion_record") {
    const result = await updateWithdrawalCompletionRecord({
      id: params.id,
      formData,
      changedBy: "admin",
    });

    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "完了記録を保存しました。Shopifyへの返金やキャンセルは自動実行していません。"
          : `完了記録を保存できませんでした: ${result.error || "unknown"}`,
      },
      { status: result.status || 200 },
    );
  }

  if (intent === "send_completion_email") {
    const result = await sendWithdrawalCompletionEmail({
      withdrawalRequestId: params.id,
    });

    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "完了通知メールを送信しました。"
          : `完了通知メールを送信できませんでした: ${result.error || "unknown"}`,
      },
      { status: result.status || 200 },
    );
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
        "Shopifyキャンセル/返金の自動実行はまだ保護中です。手動処理後にステータスと完了記録を更新してください。",
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
            actionData.ok
              ? "withdrawal-detail__notice--ok"
              : "withdrawal-detail__notice--error"
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
              [
                "国",
                withdrawalRequest.countryLabel ||
                  withdrawalRequest.countryCode ||
                  "-",
              ],
              ["受取日", withdrawalRequest.receivedDateLabel],
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
          <h2>注文の要約</h2>
          <DescriptionList rows={withdrawalRequest.orderSummaryRows} />
        </div>

        <ReturnInfoCard
          withdrawalRequest={withdrawalRequest}
          isSubmitting={isSubmitting}
        />

        <RefundDecisionCard
          withdrawalRequest={withdrawalRequest}
          isSubmitting={isSubmitting}
        />
      </section>

      <section className="withdrawal-detail__grid">
        <AdminStatusCard
          withdrawalRequest={withdrawalRequest}
          isSubmitting={isSubmitting}
        />
        <CompletionCard
          withdrawalRequest={withdrawalRequest}
          isSubmitting={isSubmitting}
          shopifyWriteActionsEnabled={shopifyWriteActionsEnabled}
        />
      </section>

      <section className="withdrawal-detail__grid">
        <JsonCard title="対象商品" value={withdrawalRequest.selectedLineItemsJson} />
        <JsonCard title="判定情報" value={withdrawalRequest.eligibilityJson} />
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
        <TimelineCard
          title="ステータス履歴"
          rows={withdrawalRequest.statusHistory}
        />
        <EmailLogCard rows={withdrawalRequest.emailLogs} />
      </section>
    </main>
  );
}

function ReturnInfoCard({ withdrawalRequest, isSubmitting }) {
  return (
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
            <option value="RECEIVED">返送品到着済み</option>
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
            <span>返送品到着日</span>
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
            <option value="OPENED_OK">開封・確認程度</option>
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
          返送証明、到着日、商品状態を記録します。ここで保存してもShopifyへの返金は実行されません。
        </p>
        <button type="submit" disabled={isSubmitting}>
          返送情報を保存
        </button>
      </Form>
    </div>
  );
}

function RefundDecisionCard({ withdrawalRequest, isSubmitting }) {
  return (
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
  );
}

function AdminStatusCard({ withdrawalRequest, isSubmitting }) {
  return (
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
        <Form method="post">
          <input type="hidden" name="intent" value="send_return_instructions" />
          <button type="submit" disabled={isSubmitting}>
            返送証明リンク送信
          </button>
        </Form>
      </div>
    </div>
  );
}

function CompletionCard({
  withdrawalRequest,
  isSubmitting,
  shopifyWriteActionsEnabled,
}) {
  return (
    <div className="withdrawal-detail__card">
      <h2>完了記録</h2>
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

      <div className="withdrawal-detail__guard">
        <strong>Shopify自動処理</strong>
        <p>
          {shopifyWriteActionsEnabled
            ? "書き込みフラグはONですが、自動キャンセル/返金はまだ保護中です。"
            : "書き込みフラグがOFFのため、Shopifyキャンセル/返金 mutation は呼びません。"}
        </p>
        <div className="withdrawal-detail__button-row">
          <Form method="post">
            <input type="hidden" name="intent" value="execute_shopify_cancel" />
            <button type="submit" disabled={isSubmitting}>
              キャンセル実行候補
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="execute_shopify_refund" />
            <button type="submit" disabled={isSubmitting}>
              返金実行候補
            </button>
          </Form>
        </div>
      </div>
    </div>
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
              <strong>
                {row.emailType} / {row.status}
              </strong>
              <span>{row.createdAtLabel}</span>
              <p>{row.subject}</p>
              {row.errorMessage ? (
                <p className="withdrawal-detail__error">{row.errorMessage}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function JsonCard({ title, value }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      <pre className="withdrawal-detail__pre">
        {JSON.stringify(value || {}, null, 2)}
      </pre>
    </section>
  );
}

function Badge({ tone, children }) {
  return (
    <span className={`withdrawal-detail__badge withdrawal-detail__badge--${tone}`}>
      {children}
    </span>
  );
}

function serializeWithdrawalRequest(request) {
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
    orderSummaryRows: buildOrderSummaryRows(request),
    returnInfoRows: buildReturnInfoRows(request),
    returnWarnings: buildWithdrawalReturnWarnings(request),
    returnRequirementStatus: request.returnRequirementStatus || "UNDECIDED",
    returnTrackingCompany: request.returnTrackingCompany || "",
    returnTrackingNumber: request.returnTrackingNumber || "",
    returnTrackingUrl: request.returnTrackingUrl || "",
    returnReceivedAtInput: formatDateInput(request.returnReceivedAt),
    returnReceivedAtLabel: formatDate(request.returnReceivedAt),
    returnConditionStatus: request.returnConditionStatus || "UNDECIDED",
    returnConditionNotes: request.returnConditionNotes || "",
    refundDecisionRows: buildRefundDecisionRows(request, refundCurrencyCode),
    refundWarnings: buildWithdrawalRefundWarnings(request),
    refundDecisionStatus: request.refundDecisionStatus || "UNDECIDED",
    refundItemAmountInput: formatInputAmount(request.refundItemAmount),
    refundInitialShippingAmountInput: formatInputAmount(
      request.refundInitialShippingAmount,
    ),
    refundDeductionAmountInput: formatInputAmount(request.refundDeductionAmount),
    refundCurrencyCode,
    returnShippingPayer: request.returnShippingPayer || "UNDECIDED",
    refundDecisionReason: request.refundDecisionReason || "",
    refundDecisionNotes: request.refundDecisionNotes || "",
    completionRows: buildCompletionRows(request, completionCurrencyCode),
    completionStatus: request.completionStatus || "UNDECIDED",
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
    nextAction: buildNextAction(request),
    quickActions: buildQuickActions(request.status),
    adminNotes: request.adminNotes || "",
    statusHistory: request.statusHistory.map((row) => ({
      id: row.id,
      toStatusLabel: getWithdrawalStatusLabel(row.toStatus),
      reason: row.reason,
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

function buildOrderSummaryRows(request) {
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : {};
  const currencyCode = getOrderCurrencyCode(request);

  return [
    ["ストア", request.shopDomain || "-"],
    ["注文名", request.shopifyOrderName || "-"],
    ["注文番号", request.shopifyOrderNumber || "-"],
    ["決済状態", snapshot.financialStatus || snapshot.displayFinancialStatus || "-"],
    ["配送状態", snapshot.fulfillmentStatus || snapshot.displayFulfillmentStatus || "-"],
    ["合計", formatAmount(snapshot.totalAmount, currencyCode)],
    ["送料", formatAmount(snapshot.shippingAmount, currencyCode)],
    ["注文日時", formatDate(snapshot.processedAt || snapshot.createdAt)],
  ];
}

function buildReturnInfoRows(request) {
  return [
    ["返送状況", getReturnRequirementLabel(request.returnRequirementStatus)],
    ["配送会社", request.returnTrackingCompany || "-"],
    ["追跡番号", request.returnTrackingNumber || "-"],
    ["追跡URL", request.returnTrackingUrl || "-"],
    ["返送品到着日", formatDate(request.returnReceivedAt)],
    ["商品状態", getReturnConditionLabel(request.returnConditionStatus)],
    ["商品状態メモ", request.returnConditionNotes || "-"],
    ["返送証明提出日", formatDate(request.returnProofSubmittedAt)],
    ["更新者", request.returnInfoUpdatedBy || "-"],
    ["更新日時", formatDate(request.returnInfoUpdatedAt)],
  ];
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
    ["完了メモ", request.completionNotes || "-"],
    ["記録者", request.completionRecordedBy || "-"],
    ["記録日時", formatDate(request.completionRecordedAt)],
    ["完了通知日時", formatDate(request.completionNotifiedAt)],
  ];
}

function buildWithdrawalReturnWarnings(request) {
  const warnings = [];
  if (request.returnRequirementStatus === "UNDECIDED") {
    warnings.push("返送が必要かどうかを判断してください。");
  }
  if (
    request.returnRequirementStatus === "REQUIRED" &&
    !request.returnTrackingNumber &&
    !request.returnTrackingUrl
  ) {
    warnings.push("返送が必要な場合は、追跡番号または追跡URLの確認が必要です。");
  }
  if (
    ["USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"].includes(
      request.returnConditionStatus,
    )
  ) {
    warnings.push("商品の状態により、減額または対象外判断が必要です。");
  }
  return warnings;
}

function buildWithdrawalRefundWarnings(request) {
  const warnings = [];
  if (request.refundDecisionStatus === "UNDECIDED") {
    warnings.push("返金可否と返金額を判断してください。");
  }
  if (request.refundInitialShippingAmount === null) {
    warnings.push("通常配送分の初回送料を返金対象として確認してください。");
  }
  if (request.returnShippingPayer === "UNDECIDED") {
    warnings.push("返送送料の負担者を記録してください。");
  }
  if (
    request.refundDecisionStatus === "PARTIAL_REFUND" &&
    !request.refundDecisionReason
  ) {
    warnings.push("一部返金の場合は減額理由を残してください。");
  }
  return warnings;
}

function buildNextAction(request) {
  if (request.status === WITHDRAWAL_STATUSES.REQUESTED) {
    return {
      title: "申請内容を確認",
      description: "注文、受取日、対象商品、EU対象かどうかを確認します。",
      items: [
        "注文番号とメールアドレスの一致を確認",
        "14日以内か確認",
        "例外商品や使用状態がないか確認",
      ],
    };
  }

  if (request.status === WITHDRAWAL_STATUSES.UNDER_REVIEW) {
    return {
      title: "返送と返金判断を記録",
      description: "返送が必要か、返金額をどうするかを判断してください。",
      items: [
        "返送が必要なら返送証明リンクを送る",
        "通常配送分の初回送料を確認",
        "減額がある場合は理由を記録",
      ],
    };
  }

  if (request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED) {
    return {
      title: "返送証明または到着を待つ",
      description: "購入者の返送証明、または返送品の到着を確認します。",
      items: ["追跡番号を確認", "商品状態を確認", "返金判断へ進む"],
    };
  }

  if (
    request.status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    request.status === WITHDRAWAL_STATUSES.REFUND_PENDING
  ) {
    return {
      title: "Shopify側で手動処理",
      description:
        "返金またはキャンセルをShopify管理画面で実行し、この画面に完了記録を残します。",
      items: ["Shopifyで処理", "処理IDと金額を記録", "完了通知メールを送信"],
    };
  }

  if (
    [WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED].includes(
      request.status,
    )
  ) {
    return {
      title: "完了記録を確認",
      description: "完了記録と購入者への通知履歴を確認してください。",
      items: [],
    };
  }

  return {
    title: "管理者確認",
    description: "申請の状態に応じて必要な操作を行ってください。",
    items: [],
  };
}

function buildQuickActions(status) {
  const actions = [];

  if (status === WITHDRAWAL_STATUSES.REQUESTED) {
    actions.push({
      status: WITHDRAWAL_STATUSES.UNDER_REVIEW,
      label: "確認中にする",
      reason: "管理者確認を開始しました。",
    });
  }

  if (status === WITHDRAWAL_STATUSES.UNDER_REVIEW) {
    actions.push({
      status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
      label: "返送待ちにする",
      reason: "返送または返送証明の確認が必要です。",
    });
    actions.push({
      status: WITHDRAWAL_STATUSES.REFUND_PENDING,
      label: "返金準備中にする",
      reason: "返金処理の準備に進みます。",
    });
  }

  if (status === WITHDRAWAL_STATUSES.RETURN_REQUESTED) {
    actions.push({
      status: WITHDRAWAL_STATUSES.RETURN_RECEIVED,
      label: "返送確認済みにする",
      reason: "返送品または返送証明を確認しました。",
    });
  }

  return actions;
}

function getReturnRequirementLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    NOT_REQUIRED: "返送不要",
    REQUIRED: "返送が必要",
    WAITING: "返送待ち",
    IN_TRANSIT: "返送中",
    RECEIVED: "返送品到着済み",
    CONDITION_CHECKED: "商品状態確認済み",
  };
  return labels[String(status || "UNDECIDED").toUpperCase()] || status || "-";
}

function getReturnConditionLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    NOT_APPLICABLE: "確認不要",
    UNUSED_OK: "未使用・問題なし",
    OPENED_OK: "開封・確認程度",
    USED_REVIEW: "使用感あり",
    DIRTY_REVIEW: "汚れあり",
    DAMAGED_REVIEW: "破損あり",
    EXEMPT_REVIEW: "対象外の可能性あり",
  };
  return labels[String(status || "UNDECIDED").toUpperCase()] || status || "-";
}

function getRefundDecisionLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    FULL_REFUND: "全額返金",
    PARTIAL_REFUND: "一部返金",
    NO_REFUND: "返金なし",
    RETURN_PENDING: "返送待ち",
  };
  return labels[String(status || "UNDECIDED").toUpperCase()] || status || "-";
}

function getReturnShippingPayerLabel(status) {
  const labels = {
    UNDECIDED: "未判断",
    CUSTOMER: "お客様負担",
    STORE: "当店負担",
    LEGAL_STORE: "法令または案内により当店負担",
  };
  return labels[String(status || "UNDECIDED").toUpperCase()] || status || "-";
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
  return labels[String(status || "UNDECIDED").toUpperCase()] || status || "-";
}

function getOrderCurrencyCode(request) {
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : {};
  return snapshot.currencyCode || snapshot.currency || request.refundCurrencyCode || "JPY";
}

function formatInputAmount(amount) {
  if (amount === null || amount === undefined || amount === "") {
    return "";
  }
  return String(amount);
}

function formatAmount(amount, currencyCode = "JPY") {
  if (amount === null || amount === undefined || amount === "") {
    return "-";
  }
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return `${amount} ${currencyCode}`;
  }
  return `${numeric.toLocaleString("ja-JP")} ${currencyCode}`;
}

function formatDateInput(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

const detailStyles = `
  .withdrawal-detail {
    background: #f4f6f8;
    color: #071428;
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-height: 100vh;
    padding: 24px;
  }

  .withdrawal-detail__card {
    background: #fff;
    border: 1px solid #dce3ea;
    border-radius: 8px;
    padding: 24px;
  }

  .withdrawal-detail__header {
    display: flex;
    justify-content: space-between;
  }

  .withdrawal-detail__back {
    color: #42526b;
    display: inline-block;
    font-weight: 700;
    margin-bottom: 12px;
    text-decoration: none;
  }

  .withdrawal-detail h1,
  .withdrawal-detail h2,
  .withdrawal-detail h3 {
    margin: 0 0 12px;
  }

  .withdrawal-detail p {
    color: #42526b;
    line-height: 1.8;
    margin: 0 0 12px;
  }

  .withdrawal-detail__badges,
  .withdrawal-detail__button-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .withdrawal-detail__badge {
    border-radius: 999px;
    border: 1px solid #dce3ea;
    display: inline-flex;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
  }

  .withdrawal-detail__badge--success { background: #e8fff1; border-color: #8de8b8; color: #047a3f; }
  .withdrawal-detail__badge--warning { background: #fff7e6; border-color: #ffd27a; color: #965500; }
  .withdrawal-detail__badge--danger { background: #fff0f0; border-color: #ffb4b4; color: #b50000; }
  .withdrawal-detail__badge--info { background: #eaf3ff; border-color: #b7d5ff; color: #0b5cab; }

  .withdrawal-detail__notice {
    border-radius: 8px;
    font-weight: 700;
    padding: 14px 18px;
  }

  .withdrawal-detail__notice--ok {
    background: #e8fff1;
    border: 1px solid #8de8b8;
    color: #047a3f;
  }

  .withdrawal-detail__notice--error {
    background: #fff0f0;
    border: 1px solid #ffb4b4;
    color: #b50000;
  }

  .withdrawal-detail__next strong {
    display: block;
    font-size: 20px;
    margin-bottom: 8px;
  }

  .withdrawal-detail__next ol {
    margin: 12px 0 0;
    padding-left: 22px;
  }

  .withdrawal-detail__grid {
    display: grid;
    gap: 24px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .withdrawal-detail__dl {
    display: grid;
    gap: 0;
    margin: 0;
  }

  .withdrawal-detail__dl div {
    border-bottom: 1px solid #edf1f5;
    display: grid;
    gap: 16px;
    grid-template-columns: 180px minmax(0, 1fr);
    padding: 12px 0;
  }

  .withdrawal-detail__dl dt {
    color: #5f6b7a;
    font-weight: 700;
  }

  .withdrawal-detail__dl dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .withdrawal-detail__form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .withdrawal-detail__form--spaced {
    margin-top: 20px;
  }

  .withdrawal-detail__form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .withdrawal-detail__form label span {
    color: #42526b;
    font-size: 13px;
    font-weight: 700;
  }

  .withdrawal-detail__form input,
  .withdrawal-detail__form select,
  .withdrawal-detail__form textarea {
    border: 1px solid #cdd6e0;
    border-radius: 8px;
    font: inherit;
    padding: 10px 12px;
  }

  .withdrawal-detail__form textarea {
    min-height: 84px;
  }

  .withdrawal-detail__checkbox {
    align-items: center;
    flex-direction: row !important;
  }

  .withdrawal-detail__checkbox input {
    width: auto;
  }

  .withdrawal-detail button {
    background: #101828;
    border: 0;
    border-radius: 8px;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 10px 16px;
  }

  .withdrawal-detail button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .withdrawal-detail__amount-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .withdrawal-detail__hint {
    background: #f8fafc;
    border: 1px solid #e3e9f0;
    border-radius: 8px;
    padding: 12px;
  }

  .withdrawal-detail__warnings {
    background: #fff7e6;
    border: 1px solid #ffd27a;
    border-radius: 8px;
    color: #704000;
    margin-top: 16px;
    padding: 14px 16px;
  }

  .withdrawal-detail__warnings ul {
    margin: 8px 0 0;
    padding-left: 20px;
  }

  .withdrawal-detail__quick-actions,
  .withdrawal-detail__completion,
  .withdrawal-detail__guard {
    border-top: 1px solid #edf1f5;
    margin-top: 20px;
    padding-top: 20px;
  }

  .withdrawal-detail__inline-form {
    margin-top: 12px;
  }

  .withdrawal-detail__pre {
    background: #0b1220;
    border-radius: 8px;
    color: #e2e8f0;
    max-height: 360px;
    overflow: auto;
    padding: 16px;
  }

  .withdrawal-detail__timeline {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .withdrawal-detail__timeline > div {
    border: 1px solid #edf1f5;
    border-radius: 8px;
    padding: 12px;
  }

  .withdrawal-detail__timeline span {
    color: #7a8699;
    display: block;
    font-size: 13px;
    margin-top: 4px;
  }

  .withdrawal-detail__empty {
    border: 1px dashed #cdd6e0;
    border-radius: 8px;
    color: #5f6b7a;
    padding: 18px;
  }

  .withdrawal-detail__error {
    color: #b50000;
  }

  @media (max-width: 900px) {
    .withdrawal-detail {
      padding: 16px;
    }

    .withdrawal-detail__grid,
    .withdrawal-detail__amount-grid {
      grid-template-columns: 1fr;
    }

    .withdrawal-detail__dl div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
`;
