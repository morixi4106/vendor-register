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
  approveWithdrawalIdentityReview,
  getWithdrawalShopifyLiveOrderStatus,
  sendWithdrawalAcknowledgementEmail,
  sendWithdrawalCompletionEmail,
  sendWithdrawalReturnInstructionsEmail,
  sendWithdrawalStatusEmail,
  sendWithdrawalVendorNotificationEmails,
  sendWithdrawalEmail,
  updateWithdrawalCompletionRecord,
  updateWithdrawalRefundDecision,
  updateWithdrawalReturnInfo,
  updateWithdrawalStatus,
} from "../services/withdrawals.server.js";
import {
  confirmWithdrawalPartialLineMapping,
  createReturnInstruction,
  getWithdrawalV2Detail,
  updateWithdrawalContractShippingDecision,
  updateWithdrawalGroupReview,
} from "../services/withdrawalDirectReturns.server.js";
import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

const RETURN_REQUIREMENT_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["NOT_REQUIRED", "返送不要"],
  ["REQUIRED", "返送が必要"],
  ["WAITING", "返送待ち"],
  ["IN_TRANSIT", "返送中"],
  ["RECEIVED", "返送品到着済み"],
  ["CONDITION_CHECKED", "商品状態確認済み"],
];

const RETURN_CONDITION_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["NOT_APPLICABLE", "確認不要"],
  ["UNUSED_OK", "未使用・問題なし"],
  ["OPENED_OK", "開封・確認程度"],
  ["USED_REVIEW", "使用感あり"],
  ["DIRTY_REVIEW", "汚れあり"],
  ["DAMAGED_REVIEW", "破損あり"],
  ["EXEMPT_REVIEW", "対象外の可能性あり"],
];

const REFUND_DECISION_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["FULL_REFUND", "全額返金"],
  ["PARTIAL_REFUND", "一部返金"],
  ["NO_REFUND", "返金なし"],
  ["RETURN_PENDING", "返送待ち"],
];

const RETURN_SHIPPING_PAYER_OPTIONS = [
  ["UNDECIDED", "未判断"],
  ["CUSTOMER", "お客様負担"],
  ["STORE", "当店負担"],
  ["LEGAL_STORE", "法令または案内により当店負担"],
];

const COMPLETION_OPTIONS = [
  ["UNDECIDED", "未記録"],
  ["REFUNDED", "返金済み"],
  ["PARTIALLY_REFUNDED", "一部返金済み"],
  ["CANCELLED", "キャンセル済み"],
  ["NO_REFUND_CLOSED", "返金なしで完了"],
  ["REJECTED_CLOSED", "対象外として完了"],
  ["MANUAL_CLOSED", "手動完了"],
];

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

  const liveShopifyOrderStatus = await getWithdrawalShopifyLiveOrderStatus({
    withdrawalRequest,
  });
  const directReturnDetail =
    Number(withdrawalRequest.workflowVersion || 1) === 2
      ? await getWithdrawalV2Detail(withdrawalRequest.id)
      : null;

  return json({
    withdrawalRequest: serializeWithdrawalRequest(withdrawalRequest),
    directReturnDetail,
    liveShopifyOrderStatus,
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

  if (intent === "approve_identity_review") {
    const result = await approveWithdrawalIdentityReview({
      withdrawalRequestId: params.id,
      changedBy: "admin",
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "注文と申請者の照合を確認し、店舗別の撤回処理を開始しました。"
          : `本人確認待ちを解除できませんでした: ${result.error || "unknown"}`,
      },
      { status: result.status || (result.ok ? 200 : 400) },
    );
  }

  if (intent === "confirm_direct_return_line_mapping") {
    const lineSelections = String(formData.get("availableLineIds") || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((sellerOrderLineId) => ({
        sellerOrderLineId,
        quantity: formData.get(`selectedQuantity_${sellerOrderLineId}`),
      }))
      .filter((entry) => Number(entry.quantity) > 0);
    const result = await confirmWithdrawalPartialLineMapping({
      withdrawalRequestId: params.id,
      lineSelections,
      changedBy: "admin",
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "撤回対象の商品と数量を確定しました。"
          : directReturnErrorMessage(result.error),
      },
      { status: result.status || (result.ok ? 200 : 400) },
    );
  }

  if (intent === "send_direct_return_instruction") {
    const result = await createReturnInstruction({
      returnGroupId: formData.get("returnGroupId"),
      operationalReturnDeadlineAt: formData.get("operationalReturnDeadlineAt"),
      notes: formData.get("notes"),
      changedBy: "admin",
      send: true,
      request,
      sendEmailImpl: sendWithdrawalEmail,
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "店舗別の返送案内を送信しました。"
          : directReturnErrorMessage(result.error),
      },
      { status: result.status || (result.ok ? 200 : 400) },
    );
  }

  if (intent === "update_direct_return_group") {
    const lineReviews = String(formData.get("lineIds") || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({
        id,
        receivedQuantity: formData.get(`receivedQuantity_${id}`),
        conditionStatus: formData.get(`conditionStatus_${id}`),
        conditionNotes: formData.get(`conditionNotes_${id}`),
      }));
    const result = await updateWithdrawalGroupReview({
      returnGroupId: formData.get("returnGroupId"),
      changedBy: "admin",
      values: { ...Object.fromEntries(formData), lineReviews },
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "店舗別の返送・返金判断を保存しました。"
          : directReturnErrorMessage(result.error),
      },
      { status: result.status || (result.ok ? 200 : 400) },
    );
  }

  if (intent === "update_direct_return_shipping") {
    const result = await updateWithdrawalContractShippingDecision({
      withdrawalContractId: formData.get("withdrawalContractId"),
      status: formData.get("initialShippingRefundStatus"),
      amount: formData.get("initialShippingRefundAmount"),
      reason: formData.get("initialShippingRefundReason"),
      changedBy: "admin",
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "初回送料の返金判断を保存しました。"
          : directReturnErrorMessage(result.error),
      },
      { status: result.status || (result.ok ? 200 : 400) },
    );
  }

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

  if (intent === "send_vendor_notification") {
    const result = await sendWithdrawalVendorNotificationEmails({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? result.skipped
          ? "通知対象の出店者が見つかりませんでした。"
          : `出店者通知を送信しました。送信 ${result.sentCount || 0} 件 / 既送信 ${result.skippedCount || 0} 件`
        : `出店者通知を送信できませんでした: ${
            result.error || `${result.failedCount || 0} 件失敗`
          }`,
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
        ? "返送案内メールを送信しました。"
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
    const completionStatus = String(
      formData.get("completionStatus") || "UNDECIDED",
    ).toUpperCase();
    const current = await prisma.withdrawalRequest.findUnique({
      where: { id: params.id },
    });

    if (!current) {
      return json(
        { ok: false, message: "撤回申請が見つかりません。" },
        { status: 404 },
      );
    }

    if (
      completionStatus !== "UNDECIDED" &&
      formData.get("confirmManualCompletion") !== "1"
    ) {
      return json(
        {
          ok: false,
          message:
            "完了記録を保存するには、Shopify側の手動処理確認チェックを入れてください。",
        },
        { status: 400 },
      );
    }

    const blockers = getCompletionRecordBlockers(current, completionStatus);
    if (blockers.length > 0) {
      return json(
        {
          ok: false,
          message: `完了記録を保存できません。${blockers.join(" ")}`,
        },
        { status: 400 },
      );
    }

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

  if (intent === "quick_transition") {
    const actionKey = String(formData.get("quickAction") || "");
    const transition = getQuickTransitionConfig(actionKey);

    if (!transition) {
      return json(
        { ok: false, message: "実行できない操作です。" },
        { status: 400 },
      );
    }

    if (transition.returnInfo) {
      const returnResult = await updateWithdrawalReturnInfo({
        id: params.id,
        formData,
        changedBy: "admin",
      });

      if (!returnResult.ok) {
        return json(
          {
            ok: false,
            message: `返送情報を更新できませんでした: ${
              returnResult.error || "unknown"
            }`,
          },
          { status: returnResult.status || 400 },
        );
      }
    }

    const statusResult = await updateWithdrawalStatus({
      id: params.id,
      toStatus: transition.toStatus,
      changedBy: "admin",
      reason: transition.reason,
      metadataJson: {
        source: "admin_quick_transition",
        quickAction: actionKey,
      },
    });

    return json(
      {
        ok: statusResult.ok,
        message: statusResult.ok
          ? transition.successMessage
          : `操作を実行できませんでした: ${statusResult.error || "unknown"}`,
      },
      { status: statusResult.status || 200 },
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
  const {
    withdrawalRequest,
    directReturnDetail,
    liveShopifyOrderStatus,
    shopifyWriteActionsEnabled,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const currencyCode =
    withdrawalRequest.refundCurrencyCode ||
    withdrawalRequest.completionCurrencyCode ||
    getOrderCurrencyCode(withdrawalRequest) ||
    "JPY";
  const shopifyReconciliation = buildShopifyReconciliation(
    withdrawalRequest,
    currencyCode,
    liveShopifyOrderStatus,
  );
  const identityReviewRequired = [
    "ORDER_NOT_FOUND_REVIEW",
    "EMAIL_MISMATCH_REVIEW",
  ].includes(withdrawalRequest.eligibilityStatus);

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
        <div className="withdrawal-detail__guard">
          <strong>Shopify自動処理</strong>
          <span>{shopifyWriteActionsEnabled ? "有効" : "無効"}</span>
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

      {identityReviewRequired ? (
        <section className="withdrawal-detail__card withdrawal-detail__alert">
          <div>
            <h2>本人確認待ち</h2>
            <p>
              申請は受け付けていますが、店舗通知・返送先の作成・商品数量の予約は停止しています。
              注文と申請者の関係を確認してから解除してください。
            </p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="approve_identity_review" />
            <button type="submit" disabled={isSubmitting}>
              本人確認済みとして処理を開始
            </button>
          </Form>
        </section>
      ) : null}

      {shopifyReconciliation.issues.length > 0 ? (
        <section className="withdrawal-detail__card withdrawal-detail__alert">
          <div>
            <h2>先に確認すること</h2>
            <p>
              Shopify側の注文状態と、アプリ側の撤回処理記録に確認点があります。
            </p>
          </div>
          <ul>
            {shopifyReconciliation.issues.slice(0, 4).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="withdrawal-detail__card withdrawal-detail__next">
        <h2>次にやること</h2>
        <strong>{getNextActionTitle(withdrawalRequest)}</strong>
        <ol>
          {getNextActionItems(withdrawalRequest).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>

      <QuickActionPanel
        request={withdrawalRequest}
        isSubmitting={isSubmitting}
      />

      <ProcessingDecisionCard
        request={withdrawalRequest}
        currencyCode={currencyCode}
      />

      <ProcessingStepsCard request={withdrawalRequest} />

      {Number(withdrawalRequest.workflowVersion || 1) === 2 ? (
        <DirectReturnWorkflowPanel
          detail={directReturnDetail}
          isSubmitting={isSubmitting}
          currencyCode={currencyCode}
        />
      ) : null}

      <section className="withdrawal-detail__grid">
        <InfoCard
          title="申請内容"
          rows={buildRequestRows(withdrawalRequest)}
        />
        <InfoCard
          title="注文の概要"
          rows={buildOrderRows(withdrawalRequest, currencyCode)}
        />
        {Number(withdrawalRequest.workflowVersion || 1) === 1 ? (
          <ReturnInfoCard request={withdrawalRequest} isSubmitting={isSubmitting} />
        ) : null}
        {Number(withdrawalRequest.workflowVersion || 1) === 1 ? (
          <RefundDecisionCard
            request={withdrawalRequest}
            currencyCode={currencyCode}
            isSubmitting={isSubmitting}
          />
        ) : null}
        <AdminStatusCard request={withdrawalRequest} isSubmitting={isSubmitting} />
        <CompletionCard
          request={withdrawalRequest}
          currencyCode={currencyCode}
          isSubmitting={isSubmitting}
        />
        <ShopifyReconciliationCard
          request={withdrawalRequest}
          liveShopifyOrderStatus={liveShopifyOrderStatus}
          currencyCode={currencyCode}
          reconciliation={shopifyReconciliation}
        />
        <ReviewChecklistCard request={withdrawalRequest} />
        <SelectedItemsCard data={withdrawalRequest.selectedLineItemsJson} />
        <EligibilitySummaryCard
          data={withdrawalRequest.eligibilityJson}
          request={withdrawalRequest}
        />
        <AdminNoteCard request={withdrawalRequest} isSubmitting={isSubmitting} />
        <TimelineCard history={withdrawalRequest.statusHistory} />
        <EmailLogCard logs={withdrawalRequest.emailLogs} />
      </section>
    </main>
  );
}

/* Legacy V2 panel was corrupted by an earlier encoding conversion.
function DirectReturnWorkflowPanel({ detail, isSubmitting, currencyCode }) {
  if (!detail) {
    return (
      <section className="withdrawal-detail__card withdrawal-detail__alert">
        <h2>店舗別返送</h2>
        <p>V2データを読み込めません。migrationと初期化状態を確認してください。</p>
      </section>
    );
  }
  const groups = detail.withdrawalReturnGroups || [];
  return (
    <section className="withdrawal-detail__card">
      <h2>店舗別の返送管理</h2>
      <p className="withdrawal-detail__muted">
        返送先・返送商品・追跡・到着・検品・返金判断を店舗ごとに管理します。Shopifyへの返金はここから実行しません。
      </p>
      <div style={{ display: "grid", gap: 18, marginTop: 18 }}>
        {groups.length ? groups.map((group) => (
          <article key={group.id} style={{ borderTop: "1px solid #e5e7eb", paddingTop: 18 }}>
            <div className="withdrawal-detail__header">
              <div>
                <h3 style={{ margin: "0 0 8px" }}>{group.storeNameSnapshot || "店舗"}</h3>
                <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
                  {group.progressStatus} / {group.outcomeStatus}
                  {group.blockedReason ? ` / ${group.blockedReason}` : ""}
                </p>
              </div>
              <Badge tone={group.blockedReason ? "danger" : "neutral"}>
                {group.instructionStatus === "SENT" ? "案内済み" : group.returnAddress ? "案内準備可" : "返送先未設定"}
              </Badge>
            </div>

            <div className="withdrawal-detail__table-wrap" style={{ marginTop: 14 }}>
              <table className="withdrawal-detail__table">
                <thead><tr><th>商品</th><th>数量</th><th>返送証明</th><th>到着</th></tr></thead>
                <tbody>
                  {(group.lines || []).map((line) => (
                    <tr key={line.id}>
                      <td>{line.requestedLine.titleSnapshot}</td>
                      <td>{line.instructedQuantity}</td>
                      <td>{line.submittedQuantity}</td>
                      <td>{line.receivedQuantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(group.shipments || []).length ? (
              <div style={{ marginTop: 14 }}>
                <strong>返送荷物</strong>
                <ul>
                  {group.shipments.map((shipment) => (
                    <li key={shipment.id}>
                      荷物 {shipment.packageNumber}: {shipment.trackingCompany || "配送会社未入力"} {shipment.trackingNumber || shipment.trackingUrl || "-"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {group.instructionStatus !== "SENT" ? (
              <Form method="post" style={{ display: "grid", gap: 10, marginTop: 16 }}>
                <input type="hidden" name="intent" value="send_direct_return_instruction" />
                <input type="hidden" name="returnGroupId" value={group.id} />
                <label>
                  <span>返送期限</span>
                  <input name="operationalReturnDeadlineAt" type="date" />
                </label>
                <label>
                  <span>案内への追記</span>
                  <textarea name="notes" rows={3} />
                </label>
                <button className="withdrawal-detail__button" disabled={isSubmitting || !group.returnAddress} type="submit">
                  この店舗の返送案内を送る
                </button>
              </Form>
            ) : null}

            <Form method="post" style={{ display: "grid", gap: 12, marginTop: 18 }}>
              <input type="hidden" name="intent" value="update_direct_return_group" />
              <input type="hidden" name="returnGroupId" value={group.id} />
              <div className="withdrawal-detail__form-grid">
                <SelectField label="返送証明" name="evidenceStatus" value={group.evidenceStatus} options={["NOT_SUBMITTED", "SUBMITTED", "ACCEPTED", "REJECTED"]} />
                <SelectField label="到着" name="receiptStatus" value={group.receiptStatus} options={["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED"]} />
                <SelectField label="検品" name="inspectionStatus" value={group.inspectionStatus} options={["NOT_INSPECTED", "IN_PROGRESS", "INSPECTED", "VALUE_REDUCTION_REVIEW"]} />
                <SelectField label="返金判断" name="refundDecisionStatus" value={group.refundDecisionStatus} options={["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"]} />
                <SelectField label="結果" name="outcomeStatus" value={group.outcomeStatus} options={["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "CANCELLED"]} />
                <label><span>商品返金基準額</span><input name="itemRefundBaseAmount" type="number" min="0" defaultValue={group.itemRefundBaseAmount} /></label>
                <label><span>減額</span><input name="deductionAmount" type="number" min="0" defaultValue={group.deductionAmount} /></label>
              </div>
              <label><span>減額理由</span><input name="deductionReason" defaultValue={group.metadataJson?.deductionReason || ""} /></label>
              <label><span>確認メモ</span><textarea name="reviewNotes" rows={3} defaultValue={group.metadataJson?.reviewNotes || ""} /></label>
              <p className="withdrawal-detail__muted">
                予定返金: {formatMoney(group.plannedRefundAmount, group.currencyCode || currencyCode)}
              </p>
              <button className="withdrawal-detail__button" disabled={isSubmitting} type="submit">店舗別の確認結果を保存</button>
            </Form>
          </article>
        )) : <p>返送グループがありません。申請は管理者確認が必要です。</p>}
      </div>
    </section>
  );
}

function SelectField({ label, name, value, options }) {
  return (
    <label>
      <span>{label}</span>
      <select name={name} defaultValue={value}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function directReturnErrorMessage(error) {
  const messages = {
    active_return_address_required: "この店舗の有効な返品受取先が未設定です。",
    withdrawal_approval_required: "申請を承認してから返送案内を送ってください。",
    line_mapping_required: "注文商品と店舗の対応を確認してください。",
    instruction_already_sent: "この店舗には既に返送案内を送信済みです。",
    instruction_email_failed: "返送案内メールを送信できませんでした。送信設定を確認してください。",
    deduction_reason_required: "減額する場合は理由を入力してください。",
  };
  return messages[error] || `処理できませんでした: ${error || "unknown"}`;
}

*/

function DirectReturnWorkflowPanel({ detail, isSubmitting, currencyCode }) {
  if (!detail) {
    return (
      <section className="withdrawal-detail__card withdrawal-detail__alert">
        <h2>店舗別返送</h2>
        <p>V2データを読み込めません。migrationと初期化状態を確認してください。</p>
      </section>
    );
  }
  const groups = detail.withdrawalReturnGroups || [];
  const contracts = detail.contracts || [];
  const needsPartialLineMapping =
    String(detail.withdrawalScope || "").toUpperCase() === "PARTIAL" &&
    (detail.requestedLines || []).length === 0;
  const selectedQuantities = detail.selectedLineItemsJson?.selectedLineQuantities || {};

  return (
    <section className="withdrawal-detail__card">
      <h2>店舗別の返送管理</h2>
      <p className="withdrawal-detail__muted">
        返送先、返送商品、追跡、到着、検品、返金判断を店舗単位で管理します。Shopifyへの返金やキャンセルは、この画面から自動実行しません。
      </p>

      {needsPartialLineMapping ? (
        <Form method="post" className="withdrawal-detail__form" style={{ marginTop: 18 }}>
          <input
            type="hidden"
            name="intent"
            value="confirm_direct_return_line_mapping"
          />
          <input
            type="hidden"
            name="availableLineIds"
            value={(detail.availableOrderLines || []).map((line) => line.id).join(",")}
          />
          <div>
            <h3 style={{ margin: "0 0 8px" }}>撤回対象の商品を確定</h3>
            <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
              購入者の自由記述は申告内容として残し、実際の注文商品と数量をここで確認します。数量が0の商品は対象外です。
            </p>
          </div>
          {(detail.availableOrderLines || []).length ? (
            <div className="withdrawal-detail__table-wrap">
              <table className="withdrawal-detail__table">
                <thead>
                  <tr>
                    <th>店舗</th>
                    <th>商品</th>
                    <th>購入数 / 選択可能</th>
                    <th>撤回数</th>
                    <th>商品金額</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.availableOrderLines || []).map((line) => (
                    <tr key={line.id}>
                      <td>{line.storeName}</td>
                      <td>
                        {line.title}
                        {line.sku ? <small> / SKU: {line.sku}</small> : null}
                      </td>
                      <td>{line.quantity} / {line.availableQuantity}</td>
                      <td>
                        <input
                          aria-label={`${line.title}の撤回数量`}
                          name={`selectedQuantity_${line.id}`}
                          type="number"
                          min="0"
                          max={line.availableQuantity}
                          step="1"
                          defaultValue={selectedQuantities[line.id] || 0}
                          disabled={line.availableQuantity <= 0}
                        />
                      </td>
                      <td>{formatMoney(line.netAmount, line.currencyCode || currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="withdrawal-detail__alert">
              注文商品を取得できません。注文とSellerOrderの紐付けを確認してください。
            </p>
          )}
          <button
            className="withdrawal-detail__button"
            disabled={isSubmitting || !(detail.availableOrderLines || []).length}
            type="submit"
          >
            対象商品と数量を確定
          </button>
        </Form>
      ) : null}

      {contracts.length ? <div style={{ display: "grid", gap: 16, marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>初回送料</h3>
        <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
          通常配送分は注文全体で一度だけ配賦します。店舗数分を重複加算しないでください。
        </p>
        {contracts.map((contract) => (
          <Form key={contract.id} method="post" className="withdrawal-detail__form">
            <input type="hidden" name="intent" value="update_direct_return_shipping" />
            <input type="hidden" name="withdrawalContractId" value={contract.id} />
            <div className="withdrawal-detail__form-grid">
              <SelectField
                label={contract.contractPartyName || "契約"}
                name="initialShippingRefundStatus"
                value={contract.initialShippingRefundStatus}
                options={["UNDECIDED", "REFUND_STANDARD", "NOT_REFUNDABLE", "ALREADY_ALLOCATED"]}
              />
              <label><span>初回送料の返金額</span><input name="initialShippingRefundAmount" type="number" min="0" defaultValue={contract.initialShippingRefundAmount} /></label>
            </div>
            <label><span>判断理由</span><input name="initialShippingRefundReason" defaultValue={contract.initialShippingRefundReason || ""} /></label>
            <button className="withdrawal-detail__button" disabled={isSubmitting} type="submit">送料判断を保存</button>
          </Form>
        ))}
      </div> : null}

      <div style={{ display: "grid", gap: 20, marginTop: 24 }}>
        {groups.length ? groups.map((group) => (
          <article key={group.id} style={{ borderTop: "1px solid #e5e7eb", paddingTop: 18 }}>
            <div className="withdrawal-detail__header">
              <div>
                <h3 style={{ margin: "0 0 8px" }}>{group.storeNameSnapshot || "店舗"}</h3>
                <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
                  {group.progressStatus} / {group.outcomeStatus}
                  {group.blockedReason ? ` / ${group.blockedReason}` : ""}
                </p>
              </div>
              <Badge tone={group.blockedReason ? "danger" : group.instructionStatus === "SENT" ? "success" : "neutral"}>
                {group.instructionStatus === "SENT" ? "返送案内済み" : group.returnAddress ? "案内可能" : "返送先未設定"}
              </Badge>
            </div>

            {(group.shipments || []).length ? (
              <div style={{ marginTop: 14 }}>
                <strong>返送荷物</strong>
                <ul>
                  {group.shipments.map((shipment) => (
                    <li key={shipment.id}>荷物 {shipment.packageNumber}: {shipment.trackingCompany || "配送会社未入力"} {shipment.trackingNumber || shipment.trackingUrl || "-"}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {group.instructionStatus !== "SENT" ? (
              <Form method="post" style={{ display: "grid", gap: 10, marginTop: 16 }}>
                <input type="hidden" name="intent" value="send_direct_return_instruction" />
                <input type="hidden" name="returnGroupId" value={group.id} />
                <label><span>返送期限</span><input name="operationalReturnDeadlineAt" type="date" /></label>
                <label><span>店舗別の追記</span><textarea name="notes" rows={3} /></label>
                <button className="withdrawal-detail__button" disabled={isSubmitting || !group.returnAddress} type="submit">この店舗への返送案内を送る</button>
              </Form>
            ) : null}

            <Form method="post" style={{ display: "grid", gap: 12, marginTop: 18 }}>
              <input type="hidden" name="intent" value="update_direct_return_group" />
              <input type="hidden" name="returnGroupId" value={group.id} />
              <input type="hidden" name="lineIds" value={(group.lines || []).map((line) => line.id).join(",")} />
              <div className="withdrawal-detail__form-grid">
                <SelectField label="返送証明" name="evidenceStatus" value={group.evidenceStatus} options={["NOT_SUBMITTED", "SUBMITTED", "ACCEPTED", "REJECTED"]} />
                <SelectField label="到着状況" name="receiptStatus" value={group.receiptStatus} options={["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED"]} />
                <SelectField label="検品状況" name="inspectionStatus" value={group.inspectionStatus} options={["NOT_INSPECTED", "IN_PROGRESS", "INSPECTED", "VALUE_REDUCTION_REVIEW"]} />
                <SelectField label="返金判断" name="refundDecisionStatus" value={group.refundDecisionStatus} options={["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"]} />
                <SelectField label="最終結果" name="outcomeStatus" value={group.outcomeStatus} options={["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "CANCELLED"]} />
                <label><span>商品返金の基準額</span><input name="itemRefundBaseAmount" type="number" min="0" defaultValue={group.itemRefundBaseAmount} /></label>
                <label><span>減額</span><input name="deductionAmount" type="number" min="0" defaultValue={group.deductionAmount} /></label>
              </div>

              <div className="withdrawal-detail__table-wrap">
                <table className="withdrawal-detail__table">
                  <thead><tr><th>商品</th><th>案内数</th><th>提出数</th><th>到着数</th><th>状態</th><th>メモ</th></tr></thead>
                  <tbody>
                    {(group.lines || []).map((line) => (
                      <tr key={line.id}>
                        <td>{line.requestedLine.titleSnapshot}</td>
                        <td>{line.instructedQuantity}</td>
                        <td>{line.submittedQuantity}</td>
                        <td><input name={`receivedQuantity_${line.id}`} type="number" min="0" max={line.instructedQuantity} defaultValue={line.receivedQuantity} /></td>
                        <td>
                          <select name={`conditionStatus_${line.id}`} defaultValue={line.conditionStatus}>
                            {["UNDECIDED", "UNUSED_OK", "OPENED_OK", "USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"].map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </td>
                        <td><input name={`conditionNotes_${line.id}`} defaultValue={line.conditionNotes || ""} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label><span>減額理由</span><input name="deductionReason" defaultValue={group.metadataJson?.deductionReason || ""} /></label>
              <label><span>確認メモ</span><textarea name="reviewNotes" rows={3} defaultValue={group.metadataJson?.reviewNotes || ""} /></label>
              <p className="withdrawal-detail__muted">予定返金額: {formatMoney(group.plannedRefundAmount, group.currencyCode || currencyCode)}</p>
              <button className="withdrawal-detail__button" disabled={isSubmitting} type="submit">店舗別の確認結果を保存</button>
            </Form>
          </article>
        )) : (
          <p>
            {needsPartialLineMapping
              ? "対象商品と数量を確定すると、店舗別の返送グループが作成されます。"
              : `返送グループがありません。${detail.v2ReviewReason ? `確認理由: ${detail.v2ReviewReason}` : "注文との紐付けを確認してください。"}`}
          </p>
        )}
      </div>
    </section>
  );
}

function SelectField({ label, name, value, options }) {
  return (
    <label>
      <span>{label}</span>
      <select name={name} defaultValue={value}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function directReturnErrorMessage(error) {
  const messages = {
    active_return_address_required: "この店舗の有効な返送先が未設定です。",
    withdrawal_approval_required: "申請を承認してから返送案内を送ってください。",
    line_mapping_required: "注文商品と店舗の対応を確認してください。",
    instruction_already_sent: "この店舗にはすでに返送案内を送信しています。",
    instruction_email_failed: "返送案内メールを送信できませんでした。メール設定を確認してください。",
    deduction_reason_required: "減額する場合は理由を入力してください。",
    invalid_shipping_refund_status: "初回送料の判断が正しくありません。",
    withdrawal_contract_not_found: "対象の契約が見つかりません。",
    withdrawal_partial_line_mapping_required: "撤回する商品を1点以上選び、数量を入力してください。",
    withdrawal_line_not_in_order: "この注文に含まれない商品が指定されました。画面を更新してやり直してください。",
    withdrawal_line_quantity_exceeded: "購入数を超える撤回数量は指定できません。",
    withdrawal_quantity_unavailable: "既返金分または他の申請で確保済みのため、その数量は選択できません。",
    withdrawal_line_mapping_locked: "対象商品はすでに確定済みのため変更できません。",
    withdrawal_partial_mapping_not_applicable: "注文全体の撤回では商品選択を変更できません。",
    withdrawal_policy_not_found: "この申請に適用する店舗別返送ポリシーが見つかりません。",
  };
  return messages[error] || `処理できませんでした: ${error || "unknown"}`;
}

function QuickActionPanel({ request, isSubmitting }) {
  const actions = buildQuickActions(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__quick-panel">
      <div>
        <h2>主要操作</h2>
        <p>
          よく使う状態変更だけを並べています。却下や期限切れなどの重い判断は、下のステータス更新で理由を入力して実行してください。
        </p>
      </div>
      {actions.length === 0 ? (
        <div className="withdrawal-detail__empty">
          この状態で使うショートカット操作はありません。
        </div>
      ) : (
        <div className="withdrawal-detail__quick-grid">
          {actions.map((action) => (
            <Form
              method="post"
              className="withdrawal-detail__quick-action"
              key={action.key}
            >
              <input type="hidden" name="intent" value="quick_transition" />
              <input type="hidden" name="quickAction" value={action.key} />
              {action.hiddenInputs.map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <strong>{action.label}</strong>
              <span>{action.description}</span>
              <button
                className={`withdrawal-detail__button--${action.tone}`}
                type="submit"
                disabled={isSubmitting}
              >
                実行
              </button>
            </Form>
          ))}
        </div>
      )}
    </section>
  );
}

function ProcessingDecisionCard({ request, currencyCode }) {
  const decision = buildProcessingDecision(request, currencyCode);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide withdrawal-detail__decision">
      <div className="withdrawal-detail__decision-header">
        <div>
          <h2>処理判断</h2>
          <p>
            現在の状態から、管理者が次に確認するべき処理をまとめています。
          </p>
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>
      <DescriptionList rows={decision.rows} />
      {decision.items.length > 0 ? (
        <ul className="withdrawal-detail__decision-list">
          {decision.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProcessingStepsCard({ request }) {
  const steps = buildProcessingSteps(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>処理ステップ</h2>
      <p className="withdrawal-detail__subtext">
        申請受付から完了通知まで、運用上の抜け漏れを確認します。
      </p>
      <div className="withdrawal-detail__steps">
        {steps.map((step) => (
          <div className="withdrawal-detail__step" key={step.label}>
            <div>
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </div>
            <Badge tone={step.tone}>{step.status}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReturnInfoCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>返送確認</h2>
      <DescriptionList
        rows={[
          ["返送状態", labelFromOptions(RETURN_REQUIREMENT_OPTIONS, request.returnRequirementStatus)],
          ["追跡会社", request.returnTrackingCompany || "-"],
          ["追跡番号", request.returnTrackingNumber || "-"],
          ["追跡URL", request.returnTrackingUrl || "-"],
          ["返送品到着日", formatDate(request.returnReceivedAt)],
          ["商品状態", labelFromOptions(RETURN_CONDITION_OPTIONS, request.returnConditionStatus)],
          ["状態メモ", request.returnConditionNotes || "-"],
        ]}
      />
      <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
        <input type="hidden" name="intent" value="update_return_info" />
        <label>
          <span>返送状態</span>
          <select
            name="returnRequirementStatus"
            defaultValue={request.returnRequirementStatus || "UNDECIDED"}
          >
            {RETURN_REQUIREMENT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>商品状態</span>
          <select
            name="returnConditionStatus"
            defaultValue={request.returnConditionStatus || "UNDECIDED"}
          >
            {RETURN_CONDITION_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>追跡会社</span>
            <input
              name="returnTrackingCompany"
              defaultValue={request.returnTrackingCompany || ""}
            />
          </label>
          <label>
            <span>追跡番号</span>
            <input
              name="returnTrackingNumber"
              defaultValue={request.returnTrackingNumber || ""}
            />
          </label>
        </div>
        <label>
          <span>追跡URL</span>
          <input name="returnTrackingUrl" defaultValue={request.returnTrackingUrl || ""} />
        </label>
        <label>
          <span>返送品到着日</span>
          <input
            type="date"
            name="returnReceivedAt"
            defaultValue={formatDateInput(request.returnReceivedAt)}
          />
        </label>
        <label>
          <span>状態メモ</span>
          <textarea
            name="returnConditionNotes"
            defaultValue={request.returnConditionNotes || ""}
          />
        </label>
        <button type="submit" disabled={isSubmitting}>
          返送情報を保存
        </button>
      </Form>
      <Form method="post" className="withdrawal-detail__inline-form">
        <input type="hidden" name="intent" value="send_return_instructions" />
        <button type="submit" disabled={isSubmitting}>
          返送案内メールを送信
        </button>
      </Form>
    </section>
  );
}

function RefundDecisionCard({ request, currencyCode, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>返金判断</h2>
      <DescriptionList
        rows={[
          ["判断", labelFromOptions(REFUND_DECISION_OPTIONS, request.refundDecisionStatus)],
          ["商品代金", formatMoney(request.refundItemAmount, request.refundCurrencyCode || currencyCode)],
          [
            "通常配送分の初回送料",
            formatMoney(request.refundInitialShippingAmount, request.refundCurrencyCode || currencyCode),
          ],
          ["減額", formatMoney(request.refundDeductionAmount, request.refundCurrencyCode || currencyCode)],
          ["返金予定額", formatMoney(request.refundTotalAmount, request.refundCurrencyCode || currencyCode)],
          ["返送送料", labelFromOptions(RETURN_SHIPPING_PAYER_OPTIONS, request.returnShippingPayer)],
          ["理由", request.refundDecisionReason || "-"],
          ["メモ", request.refundDecisionNotes || "-"],
        ]}
      />
      <div className="withdrawal-detail__hint">
        撤回が認められる場合、商品代金と通常配送方法に相当する初回送料を返金対象として確認します。追加配送費用や返送送料は、案内内容や法令に応じて個別に判断します。
      </div>
      <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
        <input type="hidden" name="intent" value="update_refund_decision" />
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>判断</span>
            <select
              name="refundDecisionStatus"
              defaultValue={request.refundDecisionStatus || "UNDECIDED"}
            >
              {REFUND_DECISION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>返送送料</span>
            <select
              name="returnShippingPayer"
              defaultValue={request.returnShippingPayer || "UNDECIDED"}
            >
              {RETURN_SHIPPING_PAYER_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="withdrawal-detail__amount-grid">
          <AmountInput
            label="商品代金"
            name="refundItemAmount"
            value={request.refundItemAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <AmountInput
            label="通常配送分の初回送料"
            name="refundInitialShippingAmount"
            value={request.refundInitialShippingAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <AmountInput
            label="減額"
            name="refundDeductionAmount"
            value={request.refundDeductionAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <label>
            <span>通貨</span>
            <input name="refundCurrencyCode" defaultValue={request.refundCurrencyCode || currencyCode} />
          </label>
        </div>
        <label>
          <span>判断理由</span>
          <input
            name="refundDecisionReason"
            defaultValue={request.refundDecisionReason || ""}
          />
        </label>
        <label>
          <span>メモ</span>
          <textarea
            name="refundDecisionNotes"
            defaultValue={request.refundDecisionNotes || ""}
          />
        </label>
        <button type="submit" disabled={isSubmitting}>
          返金判断を保存
        </button>
      </Form>
    </section>
  );
}

function AdminStatusCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>ステータス更新</h2>
      <Form method="post" className="withdrawal-detail__form">
        <input type="hidden" name="intent" value="update_status" />
        <label>
          <span>次の状態</span>
          <select name="toStatus" defaultValue={request.status}>
            {Object.values(WITHDRAWAL_STATUSES).map((value) => (
              <option key={value} value={value}>
                {getWithdrawalStatusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>理由</span>
          <input name="reason" />
        </label>
        <label>
          <span>却下理由</span>
          <input name="rejectionReason" defaultValue={request.rejectionReason || ""} />
        </label>
        <label className="withdrawal-detail__checkbox">
          <input type="checkbox" name="sendStatusEmail" value="1" />
          <span>購入者へ状況メールを送信する</span>
        </label>
        <button type="submit" disabled={isSubmitting}>
          ステータスを更新
        </button>
      </Form>
      <div className="withdrawal-detail__button-row withdrawal-detail__quick-actions">
        <Form method="post">
          <input type="hidden" name="intent" value="resend_acknowledgement" />
          <button type="submit" disabled={isSubmitting}>
            受付メールを再送
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="send_status_email" />
          <button type="submit" disabled={isSubmitting}>
            状況メールを送信
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="send_vendor_notification" />
          <button type="submit" disabled={isSubmitting}>
            出店者へ通知
          </button>
        </Form>
      </div>
    </section>
  );
}

function CompletionCard({ request, currencyCode, isSubmitting }) {
  const readiness = buildCompletionReadiness(request, currencyCode);

  return (
    <section className="withdrawal-detail__card">
      <h2>完了記録</h2>
      <DescriptionList
        rows={[
          ["完了状態", labelFromOptions(COMPLETION_OPTIONS, request.completionStatus)],
          ["実施内容", request.completionAction || "-"],
          ["Shopify返金ID", request.completionShopifyRefundId || "-"],
          ["ShopifyキャンセルID", request.completionShopifyCancelId || "-"],
          [
            "返金額",
            formatMoney(request.completionRefundedAmount, request.completionCurrencyCode || currencyCode),
          ],
          [
            "返金した送料",
            formatMoney(request.completionRefundedShipping, request.completionCurrencyCode || currencyCode),
          ],
          ["完了メモ", request.completionNotes || "-"],
          ["完了記録日時", formatDate(request.completionRecordedAt)],
          ["完了通知", formatDate(request.completionNotifiedAt)],
        ]}
      />
      <div
        className={
          readiness.tone === "success"
            ? "withdrawal-detail__ok-note"
            : "withdrawal-detail__warning-list"
        }
      >
        <strong>{readiness.label}</strong>
        <ul>
          {readiness.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <Form method="post" className="withdrawal-detail__form withdrawal-detail__form--spaced">
        <input type="hidden" name="intent" value="update_completion_record" />
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>完了状態</span>
            <select
              name="completionStatus"
              defaultValue={request.completionStatus || "UNDECIDED"}
            >
              {COMPLETION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>実施内容</span>
            <input
              name="completionAction"
              defaultValue={request.completionAction || ""}
              placeholder="例: manual_refund"
            />
          </label>
        </div>
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>Shopify返金ID</span>
            <input
              name="completionShopifyRefundId"
              defaultValue={request.completionShopifyRefundId || ""}
            />
          </label>
          <label>
            <span>ShopifyキャンセルID</span>
            <input
              name="completionShopifyCancelId"
              defaultValue={request.completionShopifyCancelId || ""}
            />
          </label>
          <AmountInput
            label="返金額"
            name="completionRefundedAmount"
            value={request.completionRefundedAmount}
            currencyCode={request.completionCurrencyCode || currencyCode}
          />
          <AmountInput
            label="返金した送料"
            name="completionRefundedShipping"
            value={request.completionRefundedShipping}
            currencyCode={request.completionCurrencyCode || currencyCode}
          />
          <label>
            <span>通貨</span>
            <input
              name="completionCurrencyCode"
              defaultValue={request.completionCurrencyCode || currencyCode}
            />
          </label>
        </div>
        <label>
          <span>完了メモ</span>
          <textarea name="completionNotes" defaultValue={request.completionNotes || ""} />
        </label>
        <label className="withdrawal-detail__checkbox withdrawal-detail__checkbox--guard">
          <input type="checkbox" name="confirmManualCompletion" value="1" />
          <span>
            Shopify側で返金・キャンセル・対象外処理を確認済みです。自動実行ではなく、ここではアプリ側の完了記録だけを保存します。
          </span>
        </label>
        <button type="submit" disabled={isSubmitting}>
          完了記録を保存
        </button>
      </Form>
      <Form method="post" className="withdrawal-detail__inline-form">
        <input type="hidden" name="intent" value="send_completion_email" />
        <button type="submit" disabled={isSubmitting}>
          完了通知メールを送信
        </button>
      </Form>
    </section>
  );
}

function ShopifyReconciliationCard({
  request,
  liveShopifyOrderStatus,
  currencyCode,
  reconciliation,
}) {
  const displayReconciliation =
    reconciliation ||
    buildShopifyReconciliation(request, currencyCode, liveShopifyOrderStatus);

  return (
    <section className="withdrawal-detail__card">
      <div className="withdrawal-detail__section-header">
        <div>
          <h2>Shopify突合</h2>
          <p className="withdrawal-detail__subtext">
            Shopify側の注文記録と、アプリ側の返金・キャンセル完了記録を確認します。
          </p>
        </div>
        {displayReconciliation.adminOrderUrl ? (
          <a
            className="withdrawal-detail__link-button"
            href={displayReconciliation.adminOrderUrl}
            target="_blank"
            rel="noreferrer"
          >
            Shopify注文を開く
          </a>
        ) : null}
      </div>
      <DescriptionList rows={displayReconciliation.rows} />
      {liveShopifyOrderStatus?.checkedAt ? (
        <div
          className={
            liveShopifyOrderStatus.ok
              ? "withdrawal-detail__ok-note"
              : "withdrawal-detail__warning-list"
          }
        >
          <strong>
            {liveShopifyOrderStatus.ok
              ? "Shopifyライブ状態を取得しました"
              : "Shopifyライブ状態を取得できませんでした"}
          </strong>
          <p>
            {liveShopifyOrderStatus.ok
              ? `${formatDate(liveShopifyOrderStatus.checkedAt)} 時点の注文状態を併せて表示しています。`
              : `理由: ${liveShopifyOrderStatus.error || "unknown"}`}
          </p>
        </div>
      ) : null}
      {displayReconciliation.issues.length > 0 ? (
        <div className="withdrawal-detail__warning-list">
          <strong>確認が必要です</strong>
          <ul>
            {displayReconciliation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="withdrawal-detail__ok-note">
          現時点で大きな不整合は見つかっていません。
        </div>
      )}
    </section>
  );
}

function AdminNoteCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>管理者メモ</h2>
      <Form method="post" className="withdrawal-detail__form">
        <input type="hidden" name="intent" value="add_admin_note" />
        <label>
          <span>メモ</span>
          <textarea name="adminNotes" defaultValue={request.adminNotes || ""} />
        </label>
        <button type="submit" disabled={isSubmitting}>
          メモを保存
        </button>
      </Form>
    </section>
  );
}

function InfoCard({ title, rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      <DescriptionList rows={rows} />
    </section>
  );
}

function DescriptionList({ rows }) {
  return (
    <dl className="withdrawal-detail__dl">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewChecklistCard({ request }) {
  const checks = buildReviewChecks(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>確認チェック</h2>
      <p className="withdrawal-detail__subtext">
        申請を進める前に、最低限ここだけ確認します。自動返金や自動キャンセルはまだ実行しません。
      </p>
      <div className="withdrawal-detail__checklist">
        {checks.map((check) => (
          <div className="withdrawal-detail__check" key={check.label}>
            <div>
              <strong>{check.label}</strong>
              <span>{check.detail}</span>
            </div>
            <Badge tone={check.tone}>{check.status}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function SelectedItemsCard({ data }) {
  const scope = data?.scope === "PARTIAL" ? "一部の商品" : "注文全体";
  const selectedLineItems = Array.isArray(data?.selectedLineItems)
    ? data.selectedLineItems
    : [];
  const orderLineItems = Array.isArray(data?.orderLineItems)
    ? data.orderLineItems
    : [];

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>対象商品</h2>
      <DescriptionList
        rows={[
          ["撤回対象", scope],
          ["購入者の入力", data?.freeText || "-"],
          [
            "選択された商品",
            selectedLineItems.length > 0 ? selectedLineItems.join(" / ") : "-",
          ],
        ]}
      />

      {orderLineItems.length > 0 ? (
        <div className="withdrawal-detail__table-wrap">
          <table className="withdrawal-detail__table">
            <thead>
              <tr>
                <th>商品</th>
                <th>SKU / ID</th>
                <th>数量</th>
                <th>金額</th>
              </tr>
            </thead>
            <tbody>
              {orderLineItems.map((line, index) => (
                <tr key={getLineIdentifier(line) || index}>
                  <td>{getLineTitle(line)}</td>
                  <td>{getLineIdentifier(line) || "-"}</td>
                  <td>{getLineQuantity(line)}</td>
                  <td>{formatLineAmount(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="withdrawal-detail__empty">
          注文明細は記録されていません。購入者の入力内容とShopify注文を照合してください。
        </div>
      )}

      <RawJsonDetails data={data} />
    </section>
  );
}

function EligibilitySummaryCard({ data, request }) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

  return (
    <section className="withdrawal-detail__card">
      <h2>判定情報</h2>
      <DescriptionList
        rows={[
          ["判定", request.eligibilityLabel],
          ["EU対象", data?.isEuCountry ? "EU対象" : "要確認"],
          ["注文照合", data?.orderFound ? "照合済み" : "要確認"],
          ["メール照合", data?.orderEmailMatched ? "一致または未判定" : "不一致"],
          ["期限", formatDate(data?.deadlineAt || request.deadlineAt)],
          [
            "期限の根拠",
            getDeadlineSourceLabel(data?.deadlineSource || request.deadlineSource),
          ],
          ["判定日時", formatDate(data?.evaluatedAt)],
        ]}
      />

      {warnings.length > 0 ? (
        <div className="withdrawal-detail__warning-list">
          <strong>確認メモ</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="withdrawal-detail__ok-note">
          自動判定上の警告はありません。
        </div>
      )}

      <RawJsonDetails data={data} />
    </section>
  );
}

function RawJsonDetails({ data }) {
  if (!data) return null;

  return (
    <details className="withdrawal-detail__raw">
      <summary>詳細JSONを表示</summary>
      <pre className="withdrawal-detail__pre">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function JsonCard({ title, data }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      {data ? (
        <pre className="withdrawal-detail__pre">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : (
        <div className="withdrawal-detail__empty">記録はありません。</div>
      )}
    </section>
  );
}

function TimelineCard({ history }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>ステータス履歴</h2>
      {history.length === 0 ? (
        <div className="withdrawal-detail__empty">履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {history.map((item) => (
            <div key={item.id}>
              <strong>
                {item.fromStatus ? getWithdrawalStatusLabel(item.fromStatus) : "-"} →{" "}
                {getWithdrawalStatusLabel(item.toStatus)}
              </strong>
              <span>
                {formatDate(item.createdAt)} / {item.changedBy || "-"} /{" "}
                {item.reason || "-"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmailLogCard({ logs }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>メール履歴</h2>
      {logs.length === 0 ? (
        <div className="withdrawal-detail__empty">メール履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {logs.map((log) => (
            <div key={log.id}>
              <strong>
                {log.emailType} / {log.status === "sent" ? "送信済み" : "失敗"}
              </strong>
              <span>
                {formatDate(log.sentAt || log.createdAt)} / {log.toEmail}
              </span>
              {log.errorMessage ? (
                <p className="withdrawal-detail__error">{log.errorMessage}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AmountInput({ label, name, value, currencyCode = "JPY" }) {
  const digits = getCurrencyMinorUnitDigits(currencyCode);

  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step={digits === 0 ? "1" : "0.01"}
        name={name}
        defaultValue={formatMoneyInputValue(value, currencyCode)}
      />
    </label>
  );
}

function Badge({ tone, children }) {
  return (
    <span className={`withdrawal-detail__badge withdrawal-detail__badge--${tone}`}>
      {children}
    </span>
  );
}

function buildRequestRows(request) {
  return [
    ["受付番号", request.id],
    ["注文番号", request.shopifyOrderName || request.shopifyOrderNumber || "-"],
    ["注文ID", request.shopifyOrderId || "-"],
    ["氏名", request.customerName],
    ["メール", request.customerEmail],
    ["電話", request.customerPhone || "-"],
    ["国", request.countryLabel || request.countryCode || "-"],
    ["受取日", formatDate(request.receivedDate)],
    ["撤回期限", formatDate(request.deadlineAt)],
    ["撤回対象", request.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体"],
    ["商品状態", request.itemCondition || "-"],
    ["理由", request.reason || "-"],
    ["申請日時", formatDate(request.createdAt)],
  ];
}

function buildOrderRows(request, currencyCode) {
  const order = request.orderSnapshotJson || {};
  return [
    ["shop", request.shopDomain || "-"],
    ["注文合計", formatMoney(order.totalAmount ?? order.total_price, currencyCode)],
    ["商品小計", formatMoney(order.subtotalAmount ?? order.subtotal_price, currencyCode)],
    ["送料", formatMoney(order.shippingAmount ?? order.total_shipping_price_set, currencyCode)],
    ["支払い状態", order.financialStatus || order.financial_status || "-"],
    ["配送状態", order.fulfillmentStatus || order.fulfillment_status || "-"],
    ["注文日時", formatDate(order.processedAt || order.processed_at)],
  ];
}

function buildShopifyReconciliation(
  request,
  currencyCode,
  liveShopifyOrderStatus = null,
) {
  const order = request.orderSnapshotJson || {};
  const liveOrder = liveShopifyOrderStatus?.ok
    ? liveShopifyOrderStatus.order || null
    : null;
  const orderCurrency = currencyCode || getOrderCurrencyCode(request);
  const financialStatus = normalizeStatus(
    liveOrder?.financialStatus || order.financialStatus || order.financial_status,
  );
  const fulfillmentStatus = normalizeStatus(
    liveOrder?.fulfillmentStatus ||
      order.fulfillmentStatus ||
      order.fulfillment_status,
  );
  const cancelledAt =
    liveOrder?.cancelledAt || order.cancelledAt || order.cancelled_at || null;
  const completionStatus = normalizeStatus(request.completionStatus || "UNDECIDED");
  const refundDecisionStatus = normalizeStatus(
    request.refundDecisionStatus || "UNDECIDED",
  );
  const plannedRefundAmount =
    request.refundTotalAmount ?? calculateDisplayRefundTotal(request);
  const completedRefundAmount = request.completionRefundedAmount;
  const adminOrderUrl = getShopifyAdminOrderUrl(request);
  const issues = [];

  if (Object.keys(order).length === 0) {
    issues.push("注文スナップショットが未記録です。Shopify注文画面で状態を確認してください。");
  }

  if (liveShopifyOrderStatus && !liveShopifyOrderStatus.ok) {
    issues.push("Shopifyの現在状態を取得できませんでした。保存済み情報と管理画面で確認してください。");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    !request.completionShopifyRefundId
  ) {
    issues.push("返金済みの完了記録ですが、Shopify返金IDが未記録です。");
  }

  if (completionStatus === "CANCELLED" && !request.completionShopifyCancelId) {
    issues.push("キャンセル済みの完了記録ですが、ShopifyキャンセルIDが未記録です。");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    financialStatus &&
    !["REFUNDED", "PARTIALLY_REFUNDED"].includes(financialStatus)
  ) {
    issues.push("アプリ側は返金完了ですが、注文スナップショットの支払い状態が返金済みではありません。");
  }

  if (completionStatus === "CANCELLED" && !cancelledAt) {
    issues.push("アプリ側はキャンセル完了ですが、注文スナップショットにキャンセル日時がありません。");
  }

  if (
    completionStatus === "UNDECIDED" &&
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(financialStatus)
  ) {
    issues.push("Shopify側は返金済みに見えますが、アプリ側の完了記録が未設定です。");
  }

  if (completionStatus === "UNDECIDED" && cancelledAt) {
    issues.push("Shopify側はキャンセル済みに見えますが、アプリ側の完了記録が未設定です。");
  }

  if (
    liveOrder &&
    order.financialStatus &&
    normalizeStatus(order.financialStatus || order.financial_status) !==
      financialStatus
  ) {
    issues.push("保存済みの支払い状態とShopifyライブ状態が異なります。");
  }

  if (
    liveOrder &&
    order.fulfillmentStatus &&
    normalizeStatus(order.fulfillmentStatus || order.fulfillment_status) !==
      fulfillmentStatus
  ) {
    issues.push("保存済みの配送状態とShopifyライブ状態が異なります。");
  }

  if (
    refundDecisionStatus !== "UNDECIDED" &&
    completionStatus !== "UNDECIDED" &&
    isComparableMoney(plannedRefundAmount) &&
    isComparableMoney(completedRefundAmount) &&
    normalizeMoney(plannedRefundAmount) !== normalizeMoney(completedRefundAmount)
  ) {
    issues.push("返金判断額と完了記録の返金額が一致していません。");
  }

  if (
    liveOrder &&
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    isComparableMoney(liveOrder.totalRefundedAmount) &&
    isComparableMoney(completedRefundAmount) &&
    normalizeMoney(liveOrder.totalRefundedAmount) !==
      normalizeMoney(completedRefundAmount)
  ) {
    issues.push("Shopifyライブ返金済み額とアプリの完了返金額が一致していません。");
  }

  if (
    completionStatus === "UNDECIDED" &&
    ["UNFULFILLED", "OPEN"].includes(fulfillmentStatus) &&
    [WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.UNDER_REVIEW].includes(
      request.status,
    )
  ) {
    issues.push("Shopify側では未発送に見えます。返送案内ではなく、注文キャンセルで処理できるか確認してください。");
  }

  if (
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
      normalizeStatus(request.returnRequirementStatus || "UNDECIDED"),
    ) &&
    ["UNFULFILLED", "OPEN"].includes(fulfillmentStatus)
  ) {
    issues.push("返送待ちになっていますが、Shopify側では未発送に見えます。発送状況を確認してください。");
  }

  for (const blocker of getCompletionRecordBlockers(
    request,
    request.completionStatus || "UNDECIDED",
  )) {
    issues.push(blocker);
  }

  return {
    adminOrderUrl,
    issues,
    rows: [
      ["Shopify注文", request.shopifyOrderName || request.shopifyOrderNumber || "-"],
      ["Shopify注文ID", request.shopifyOrderId || order.id || "-"],
      ["管理画面リンク", adminOrderUrl ? "あり" : "-"],
      ["支払い状態", order.financialStatus || order.financial_status || "-"],
      ["配送状態", order.fulfillmentStatus || order.fulfillment_status || "-"],
      [
        "ライブ支払い状態",
        liveOrder?.financialStatus || (liveShopifyOrderStatus ? "取得不可" : "-"),
      ],
      [
        "ライブ配送状態",
        liveOrder?.fulfillmentStatus || (liveShopifyOrderStatus ? "取得不可" : "-"),
      ],
      ["キャンセル日時", formatDate(cancelledAt)],
      [
        "ライブ返金済み額",
        liveOrder
          ? formatMoney(
              liveOrder.totalRefundedAmount,
              liveOrder.currencyCode || orderCurrency,
            )
          : "-",
      ],
      [
        "ライブ現在合計",
        liveOrder
          ? formatMoney(
              liveOrder.currentTotalAmount,
              liveOrder.currencyCode || orderCurrency,
            )
          : "-",
      ],
      ["アプリ完了状態", labelFromOptions(COMPLETION_OPTIONS, request.completionStatus)],
      ["返金判断額", formatMoney(plannedRefundAmount, request.refundCurrencyCode || orderCurrency)],
      [
        "完了記録の返金額",
        formatMoney(
          request.completionRefundedAmount,
          request.completionCurrencyCode || orderCurrency,
        ),
      ],
      ["Shopify返金ID", request.completionShopifyRefundId || "-"],
      ["ShopifyキャンセルID", request.completionShopifyCancelId || "-"],
    ],
  };
}

function getShopifyAdminOrderUrl(request) {
  const order = request.orderSnapshotJson || {};
  const shopDomain = request.shopDomain || order.shopDomain || order.shop;
  const orderId = extractShopifyNumericId(
    request.shopifyOrderId ||
      order.shopifyOrderId ||
      order.admin_graphql_api_id ||
      order.id,
  );

  if (!shopDomain || !orderId) return null;

  const normalizedShop = String(shopDomain).replace(/^https?:\/\//, "");
  if (normalizedShop.endsWith(".myshopify.com")) {
    const storeHandle = normalizedShop.replace(".myshopify.com", "");
    return `https://admin.shopify.com/store/${encodeURIComponent(
      storeHandle,
    )}/orders/${encodeURIComponent(orderId)}`;
  }

  return `https://${normalizedShop}/admin/orders/${encodeURIComponent(orderId)}`;
}

function extractShopifyNumericId(value) {
  const raw = String(value || "");
  const gidMatch = raw.match(/\/Order\/(\d+)/);
  if (gidMatch) return gidMatch[1];
  const numericMatch = raw.match(/\d{6,}/);
  return numericMatch ? numericMatch[0] : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function isComparableMoney(value) {
  return value != null && value !== "" && Number.isFinite(Number(value));
}

function normalizeMoney(value) {
  return Math.round(Number(value) * 100);
}

function hasSentEmailLog(request, emailType) {
  return Array.isArray(request.emailLogs)
    ? request.emailLogs.some(
        (log) =>
          log.emailType === emailType &&
          String(log.status || "").toLowerCase() === "sent",
      )
    : false;
}

function shouldNotifyVendors(request) {
  return ![
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
  ].includes(String(request.status || ""));
}

function buildCompletionReadiness(request, currencyCode) {
  const completionStatus = normalizeStatus(
    request.completionStatus || "UNDECIDED",
  );
  const plannedRefundAmount =
    request.refundTotalAmount ?? calculateDisplayRefundTotal(request);
  const items = [];

  if (completionStatus !== "UNDECIDED") {
    const blockers = getCompletionRecordBlockers(request, completionStatus);
    const items =
      blockers.length > 0
        ? blockers
        : ["Shopify側の処理結果をアプリ側に記録済みです。完了通知が未送信なら送信してください。"];
    if (shouldNotifyVendors(request) && !hasSentEmailLog(request, "vendor_notification")) {
      items.push("出店者通知が未送信です。発送停止や返品対応が必要な可能性があるため、必要に応じて通知してください。");
    }
    return {
      label:
        blockers.length > 0 || items.length > 1
          ? "完了記録に確認点があります"
          : "完了記録済み",
      tone: blockers.length > 0 || items.length > 1 ? "warning" : "success",
      items,
    };
  }

  if (isReturnStillOpen(request)) {
    items.push("返送が未完了です。返送不要にするか、返送品到着・商品状態を確認してから完了記録へ進んでください。");
  }

  if (normalizeStatus(request.refundDecisionStatus || "UNDECIDED") === "UNDECIDED") {
    items.push("返金判断が未記録です。商品代金・通常配送分の初回送料・減額・返送送料負担を先に記録してください。");
  }

  if (!isComparableMoney(plannedRefundAmount)) {
    items.push("返金予定額が未確定です。返金ありで完了する場合は、返金判断と返金額を先に保存してください。");
  } else {
    items.push(`現在の返金予定額は ${formatMoney(plannedRefundAmount, request.refundCurrencyCode || currencyCode)} です。Shopify側の手動処理額と一致するか確認してください。`);
  }

  if (shouldNotifyVendors(request) && !hasSentEmailLog(request, "vendor_notification")) {
    items.push("出店者通知が未送信です。発送停止・返送受け取り・商品状態確認が必要な場合は先に通知してください。");
  }

  items.push("完了記録はShopify側で手動返金・キャンセル・対象外処理を終えた後に保存します。");

  return {
    label: items.length > 1 ? "完了前チェック" : "完了記録の準備",
    tone:
      isReturnStillOpen(request) ||
      normalizeStatus(request.refundDecisionStatus || "UNDECIDED") ===
        "UNDECIDED"
        ? "warning"
        : "success",
    items,
  };
}

function getCompletionRecordBlockers(request, completionStatusValue) {
  const completionStatus = normalizeStatus(completionStatusValue || "UNDECIDED");
  if (completionStatus === "UNDECIDED") return [];

  const refundDecisionStatus = normalizeStatus(
    request.refundDecisionStatus || "UNDECIDED",
  );
  const blockers = [];

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED", "NO_REFUND_CLOSED"].includes(
      completionStatus,
    ) &&
    refundDecisionStatus === "UNDECIDED"
  ) {
    blockers.push("返金判断が未記録です。完了前に返金判断を保存してください。");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED", "NO_REFUND_CLOSED", "MANUAL_CLOSED"].includes(
      completionStatus,
    ) &&
    isReturnStillOpen(request)
  ) {
    blockers.push("返送が未完了です。返送不要または返送確認済みにしてから完了記録を保存してください。");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    refundDecisionStatus === "NO_REFUND"
  ) {
    blockers.push("返金なし判断の申請を返金済みとして完了できません。返金判断を見直してください。");
  }

  return blockers;
}

function isReturnStillOpen(request) {
  return ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
    normalizeStatus(request.returnRequirementStatus || "UNDECIDED"),
  );
}

function getNextActionTitle(request) {
  if (request.status === WITHDRAWAL_STATUSES.REQUESTED) {
    return "受付メールと申請内容を確認";
  }
  if (request.returnRequirementStatus === "REQUIRED" || request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED) {
    return "返送状況を確認";
  }
  if (request.refundDecisionStatus === "UNDECIDED") {
    return "返金対象額を判断";
  }
  if (request.completionStatus === "UNDECIDED") {
    return "Shopify側の手動処理後に完了記録を残す";
  }
  return "必要に応じて購入者へ状況を通知";
}

function getNextActionItems(request) {
  const items = [];

  if (!request.confirmationSentAt) {
    items.push("受付確認メールが未送信なら再送してください。");
  }
  if (shouldNotifyVendors(request) && !hasSentEmailLog(request, "vendor_notification")) {
    items.push("出店者への通知が未送信です。発送停止・返品対応が必要な場合は通知してください。");
  }
  if (request.eligibilityStatus !== "ELIGIBLE") {
    items.push("注文番号、メール、EU対象、期限、例外商品に該当しないかを確認してください。");
  }
  if (request.returnRequirementStatus === "UNDECIDED") {
    items.push("返送が必要か、返送不要で処理できるかを判断してください。");
  }
  if (request.refundDecisionStatus === "UNDECIDED") {
    items.push("商品代金、通常配送分の初回送料、減額、返送送料の負担者を記録してください。");
  }
  if (request.completionStatus === "UNDECIDED") {
    items.push("Shopifyで返金またはキャンセルを手動処理した後、完了記録を保存してください。");
  }

  return items.length > 0 ? items : ["現時点で必須の作業はありません。"];
}

function buildProcessingDecision(request, currencyCode) {
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const latestEmail = Array.isArray(request.emailLogs)
    ? request.emailLogs[0]
    : null;
  const hasEmailFailure = Array.isArray(request.emailLogs)
    ? request.emailLogs.some((log) => log.status === "failed")
    : false;
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");
  const refundCurrency = request.refundCurrencyCode || currencyCode;
  const plannedRefundAmount =
    request.refundTotalAmount ??
    calculateDisplayRefundTotal(request);

  let label = "手動確認";
  let tone = "warning";
  const items = [];

  if (completionStatus !== "UNDECIDED") {
    label = "完了済み";
    tone = "success";
    items.push("完了通知が未送信の場合は、必要に応じて完了通知メールを送信してください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.REQUESTED ||
    request.status === WITHDRAWAL_STATUSES.ACKNOWLEDGED ||
    request.status === WITHDRAWAL_STATUSES.UNDER_REVIEW
  ) {
    label = "申請内容の確認";
    tone = "warning";
    items.push("注文番号、購入時メール、EU対象、期限、対象外商品の有無を確認してください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.APPROVED &&
    returnStatus === "UNDECIDED"
  ) {
    label = "返送要否の判断";
    tone = "warning";
    items.push("返送が必要か、返送不要で返金判断へ進めるかを決めてください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED ||
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(returnStatus)
  ) {
    label = "返送待ち";
    tone = "info";
    items.push("追跡番号、返送証明、または返送品の到着を確認してください。");
  } else if (
    request.status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    ["RECEIVED", "CONDITION_CHECKED", "NOT_REQUIRED", "NOT_APPLICABLE"].includes(
      returnStatus,
    )
  ) {
    label = refundStatus === "UNDECIDED" ? "返金判断待ち" : "手動処理待ち";
    tone = refundStatus === "UNDECIDED" ? "warning" : "info";
    items.push(
      refundStatus === "UNDECIDED"
        ? "商品代金、通常配送分の初回送料、減額、返送送料負担を記録してください。"
        : "Shopify側でキャンセルまたは返金を手動処理し、完了記録を残してください。",
    );
  } else if (request.status === WITHDRAWAL_STATUSES.REFUND_PENDING) {
    label = "手動返金待ち";
    tone = "info";
    items.push("Shopify側で返金処理を行い、返金IDと返金額を完了記録に残してください。");
  }

  if (!request.confirmationSentAt) {
    items.push("受付確認メールが未送信です。");
  }
  if (shouldNotifyVendors(request) && !hasVendorNotification) {
    items.push("出店者通知が未送信です。発送や返送対応が必要な出店者へ通知してください。");
  }
  if (hasEmailFailure) {
    items.push("メール送信失敗があります。送信元設定と宛先を確認してください。");
  }

  return {
    label,
    tone,
    items,
    rows: [
      ["推奨処理", label],
      ["現在の状態", request.statusLabel || request.status || "-"],
      [
        "返送状態",
        labelFromOptions(RETURN_REQUIREMENT_OPTIONS, request.returnRequirementStatus),
      ],
      [
        "商品状態",
        labelFromOptions(RETURN_CONDITION_OPTIONS, request.returnConditionStatus),
      ],
      [
        "返金判断",
        labelFromOptions(REFUND_DECISION_OPTIONS, request.refundDecisionStatus),
      ],
      ["返金予定額", formatMoney(plannedRefundAmount, refundCurrency)],
      [
        "出店者通知",
        hasVendorNotification
          ? "送信済み"
          : shouldNotifyVendors(request)
            ? "未送信"
            : "対象外",
      ],
      [
        "メール状態",
        latestEmail
          ? `${latestEmail.emailType} / ${
              latestEmail.status === "sent" ? "送信済み" : "失敗"
            }`
          : "履歴なし",
      ],
    ],
  };
}

function buildProcessingSteps(request) {
  const status = String(request.status || "");
  const eligibilityStatus = String(request.eligibilityStatus || "");
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const hasReturnInstruction = hasSentEmailLog(request, "return_instructions");
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");
  const hasEmailFailure = Array.isArray(request.emailLogs)
    ? request.emailLogs.some((log) => log.status === "failed")
    : false;
  const isClosed = [
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
  ].includes(status);
  const returnResolved = [
    "NOT_REQUIRED",
    "NOT_APPLICABLE",
    "RECEIVED",
    "CONDITION_CHECKED",
  ].includes(returnStatus);
  const returnWaiting = ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
    returnStatus,
  );
  const refundDecided = refundStatus !== "UNDECIDED";
  const completed = completionStatus !== "UNDECIDED";

  return [
    {
      label: "受付",
      status: request.confirmationSentAt ? "済" : "未送信",
      tone: request.confirmationSentAt ? "success" : "warning",
      detail: request.confirmationSentAt
        ? "受付確認メールを送信済みです。"
        : "まず受付確認メールを送信してください。",
    },
    {
      label: "申請条件",
      status: eligibilityStatus === "ELIGIBLE" ? "確認済み" : "要確認",
      tone: eligibilityStatus === "ELIGIBLE" ? "success" : "warning",
      detail:
        eligibilityStatus === "ELIGIBLE"
          ? "EU対象・期限・注文照合は通過しています。"
          : getWithdrawalEligibilityLabel(eligibilityStatus),
    },
    {
      label: "出店者通知",
      status: hasVendorNotification
        ? "送信済み"
        : shouldNotifyVendors(request)
          ? "未送信"
          : "対象外",
      tone: hasVendorNotification
        ? "success"
        : shouldNotifyVendors(request)
          ? "warning"
          : "neutral",
      detail: hasVendorNotification
        ? "対象出店者へ撤回申請を通知済みです。"
        : shouldNotifyVendors(request)
          ? "発送停止、返送受け取り、商品状態確認が必要な場合は出店者へ通知してください。"
          : "却下または期限切れのため、通常は出店者通知不要です。",
    },
    {
      label: "返送案内",
      status:
        returnStatus === "UNDECIDED"
          ? "未判断"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "不要"
            : hasReturnInstruction
              ? "送信済み"
              : "未送信",
      tone:
        returnStatus === "UNDECIDED"
          ? "warning"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "success"
            : hasReturnInstruction
              ? "success"
              : "warning",
      detail:
        returnStatus === "UNDECIDED"
          ? "返送が必要か、返送不要で進めるかを判断してください。"
          : returnStatus === "NOT_REQUIRED" || returnStatus === "NOT_APPLICABLE"
            ? "返送なしで次の判断へ進めます。"
            : "返送が必要な場合は、返送案内メールの送信状況を確認してください。",
    },
    {
      label: "返送確認",
      status: returnResolved ? "済" : returnWaiting ? "待ち" : "未判断",
      tone: returnResolved ? "success" : returnWaiting ? "info" : "neutral",
      detail: returnResolved
        ? "返送不要、または返送品の確認が済んでいます。"
        : returnWaiting
          ? "追跡番号、返送証明、到着状況を確認してください。"
          : "返送要否が決まるまでは保留です。",
    },
    {
      label: "返金判断",
      status: refundDecided ? "済" : "未判断",
      tone: refundDecided ? "success" : returnResolved ? "warning" : "neutral",
      detail: refundDecided
        ? "返金予定額と減額理由が記録されています。"
        : returnResolved
          ? "商品状態を踏まえて、返金予定額を記録してください。"
          : "返送確認後に判断します。",
    },
    {
      label: "Shopify処理",
      status: completed ? "記録済み" : refundDecided ? "処理待ち" : "未到達",
      tone: completed ? "success" : refundDecided ? "warning" : "neutral",
      detail: completed
        ? "返金またはキャンセルの完了記録があります。"
        : refundDecided
          ? "Shopifyで手動返金またはキャンセルし、完了記録を残してください。"
          : "返金判断後に対応します。",
    },
    {
      label: "完了通知",
      status: request.completionNotifiedAt ? "送信済み" : completed ? "未送信" : "未到達",
      tone: request.completionNotifiedAt
        ? "success"
        : completed
          ? "warning"
          : "neutral",
      detail: request.completionNotifiedAt
        ? "購入者への完了通知を送信済みです。"
        : completed
          ? "完了通知メールを送信してください。"
          : "完了記録後に通知します。",
    },
    {
      label: "メール状態",
      status: hasEmailFailure ? "失敗あり" : "正常",
      tone: hasEmailFailure ? "danger" : "success",
      detail: hasEmailFailure
        ? "メール履歴から失敗した通知を確認してください。"
        : "記録上のメール失敗はありません。",
    },
  ].filter((step) => !isClosed || step.label !== "返送案内" || step.tone !== "neutral");
}

function calculateDisplayRefundTotal(request) {
  const item = toFiniteNumber(request.refundItemAmount);
  const shipping = toFiniteNumber(request.refundInitialShippingAmount);
  const deduction = toFiniteNumber(request.refundDeductionAmount);
  const total = item + shipping - deduction;
  return total > 0 ? total : null;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildQuickActions(request) {
  const status = request.status;
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");

  if (completionStatus !== "UNDECIDED") {
    return [];
  }

  const actions = [];

  if (status === WITHDRAWAL_STATUSES.REQUESTED) {
    actions.push(getQuickActionDefinition("acknowledge"));
    actions.push(getQuickActionDefinition("start_review"));
  }

  if (
    status === WITHDRAWAL_STATUSES.ACKNOWLEDGED ||
    status === WITHDRAWAL_STATUSES.UNDER_REVIEW
  ) {
    actions.push(getQuickActionDefinition("approve"));
  }

  if (status === WITHDRAWAL_STATUSES.APPROVED) {
    actions.push(getQuickActionDefinition("request_return"));
    actions.push(getQuickActionDefinition("no_return_refund_pending"));
  }

  if (
    status === WITHDRAWAL_STATUSES.RETURN_REQUESTED ||
    ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(returnStatus)
  ) {
    actions.push(getQuickActionDefinition("mark_return_received"));
  }

  if (
    status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    ["RECEIVED", "CONDITION_CHECKED"].includes(returnStatus)
  ) {
    actions.push(getQuickActionDefinition("move_refund_pending"));
  }

  return actions.filter(Boolean);
}

function getQuickActionDefinition(key) {
  const transition = getQuickTransitionConfig(key);
  if (!transition) return null;

  return {
    key,
    label: transition.label,
    description: transition.description,
    tone: transition.tone,
    hiddenInputs: transition.hiddenInputs || [],
  };
}

function getQuickTransitionConfig(key) {
  const definitions = {
    acknowledge: {
      label: "受付済みにする",
      description: "申請を受け付けた状態にします。受付メールは別途送信できます。",
      tone: "neutral",
      toStatus: WITHDRAWAL_STATUSES.ACKNOWLEDGED,
      reason: "管理画面の主要操作で受付済みにしました。",
      successMessage: "受付済みにしました。",
    },
    start_review: {
      label: "確認中にする",
      description: "注文内容や対象条件を確認する状態にします。",
      tone: "neutral",
      toStatus: WITHDRAWAL_STATUSES.UNDER_REVIEW,
      reason: "管理画面の主要操作で確認中にしました。",
      successMessage: "確認中にしました。",
    },
    approve: {
      label: "撤回対象として承認",
      description: "撤回対象として承認し、次の返送・返金判断へ進めます。",
      tone: "success",
      toStatus: WITHDRAWAL_STATUSES.APPROVED,
      reason: "管理画面の主要操作で撤回対象として承認しました。",
      successMessage: "撤回対象として承認しました。",
    },
    request_return: {
      label: "返送待ちにする",
      description: "返送が必要な申請として、返送待ち状態にします。",
      tone: "warning",
      toStatus: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
      reason: "管理画面の主要操作で返送待ちにしました。",
      successMessage: "返送待ちにしました。",
    },
    no_return_refund_pending: {
      label: "返送不要で返金判断へ",
      description: "返送不要として記録し、返金判断に進めます。",
      tone: "warning",
      toStatus: WITHDRAWAL_STATUSES.REFUND_PENDING,
      reason: "管理画面の主要操作で返送不要として返金判断に進めました。",
      successMessage: "返送不要として返金判断に進めました。",
      returnInfo: true,
      hiddenInputs: [
        ["returnRequirementStatus", "NOT_REQUIRED"],
        ["returnConditionStatus", "NOT_APPLICABLE"],
      ],
    },
    mark_return_received: {
      label: "返送確認済みにする",
      description: "返送品または返送証明を確認した状態にします。",
      tone: "success",
      toStatus: WITHDRAWAL_STATUSES.RETURN_RECEIVED,
      reason: "管理画面の主要操作で返送確認済みにしました。",
      successMessage: "返送確認済みにしました。",
    },
    move_refund_pending: {
      label: "返金準備中にする",
      description: "返金額と減額有無を判断する段階へ進めます。",
      tone: "warning",
      toStatus: WITHDRAWAL_STATUSES.REFUND_PENDING,
      reason: "管理画面の主要操作で返金準備中にしました。",
      successMessage: "返金準備中にしました。",
    },
  };

  return definitions[key] || null;
}

function buildReviewChecks(request) {
  const eligibilityStatus = String(request.eligibilityStatus || "");
  const returnStatus = String(request.returnRequirementStatus || "UNDECIDED");
  const refundStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const hasOrderOrEmailIssue = [
    "ORDER_NOT_FOUND_REVIEW",
    "EMAIL_MISMATCH_REVIEW",
  ].includes(eligibilityStatus);
  const hasDeadlineOrCountryIssue = [
    "DEADLINE_EXPIRED",
    "NON_EU_REVIEW",
  ].includes(eligibilityStatus);
  const hasVendorNotification = hasSentEmailLog(request, "vendor_notification");

  return [
    {
      label: "受付メール",
      status: request.confirmationSentAt ? "送信済み" : "未送信",
      tone: request.confirmationSentAt ? "success" : "warning",
      detail: request.confirmationSentAt
        ? "購入者へ受付確認を送信済みです。"
        : "耐久性のある媒体として、まず受付メールを送ってください。",
    },
    {
      label: "注文・メール照合",
      status: hasOrderOrEmailIssue ? "要確認" : "確認候補",
      tone: hasOrderOrEmailIssue ? "warning" : "success",
      detail: "注文番号と購入時メールが一致するかを確認します。",
    },
    {
      label: "期限・対象国",
      status: hasDeadlineOrCountryIssue ? "要確認" : "確認候補",
      tone: hasDeadlineOrCountryIssue ? "warning" : "success",
      detail: "EU対象か、受領日から14日以内かを確認します。",
    },
    {
      label: "出店者通知",
      status: hasVendorNotification
        ? "送信済み"
        : shouldNotifyVendors(request)
          ? "未送信"
          : "対象外",
      tone: hasVendorNotification
        ? "success"
        : shouldNotifyVendors(request)
          ? "warning"
          : "neutral",
      detail: "発送停止、返送受け取り、商品状態確認が必要な出店者へ通知します。",
    },
    {
      label: "返送要否",
      status: returnStatus === "UNDECIDED" ? "未判断" : "記録済み",
      tone: returnStatus === "UNDECIDED" ? "warning" : "success",
      detail: "返送不要・返送待ち・到着済みなどを記録します。",
    },
    {
      label: "返金判断",
      status: refundStatus === "UNDECIDED" ? "未判断" : "記録済み",
      tone: refundStatus === "UNDECIDED" ? "warning" : "success",
      detail:
        "商品代金、通常配送分の初回送料、減額、返送送料負担を分けて判断します。",
    },
    {
      label: "完了記録",
      status: completionStatus === "UNDECIDED" ? "未記録" : "記録済み",
      tone: completionStatus === "UNDECIDED" ? "neutral" : "success",
      detail: "Shopify側の手動処理後、結果と外部IDを残します。",
    },
  ];
}

function labelFromOptions(options, value) {
  return options.find(([optionValue]) => optionValue === value)?.[1] || value || "-";
}

function getDeadlineSourceLabel(value) {
  const labels = {
    buyer_received_date: "購入者入力の受領日",
    order_processed_at: "注文処理日時",
    order_created_at: "注文作成日時",
  };

  return labels[value] || value || "-";
}

function getLineTitle(line) {
  return (
    line?.title ||
    line?.name ||
    line?.productTitle ||
    line?.product_title ||
    line?.variantTitle ||
    "-"
  );
}

function getLineIdentifier(line) {
  return (
    line?.sku ||
    line?.skuId ||
    line?.shopifyLineItemId ||
    line?.lineItemId ||
    line?.id ||
    line?.variantId ||
    line?.productId ||
    null
  );
}

function getLineQuantity(line) {
  const quantity =
    line?.quantity ??
    line?.currentQuantity ??
    line?.current_quantity ??
    line?.fulfillableQuantity ??
    line?.fulfillable_quantity;

  return quantity == null || quantity === "" ? "-" : quantity;
}

function formatLineAmount(line) {
  const amount =
    line?.lineSubtotalAmount ??
    line?.netAmount ??
    line?.totalAmount ??
    line?.price ??
    line?.amount ??
    line?.originalUnitPrice;
  const currencyCode =
    line?.currencyCode ||
    line?.currency ||
    line?.presentmentCurrency ||
    "JPY";

  return formatMoney(amount, currencyCode);
}

function formatMoney(value, currencyCode = "JPY") {
  if (value == null || value === "") return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  const digits = getCurrencyMinorUnitDigits(currencyCode);
  const majorAmount = numeric / 10 ** digits;
  return `${majorAmount.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currencyCode || ""}`.trim();
}

function formatMoneyInputValue(value, currencyCode = "JPY") {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";

  const digits = getCurrencyMinorUnitDigits(currencyCode);
  return (numeric / 10 ** digits).toFixed(digits);
}

function getCurrencyMinorUnitDigits(currencyCode) {
  const normalized = String(currencyCode || "JPY").trim().toUpperCase();
  const zeroDecimalCurrencies = new Set([
    "BIF",
    "CLP",
    "DJF",
    "GNF",
    "JPY",
    "KMF",
    "KRW",
    "MGA",
    "PYG",
    "RWF",
    "UGX",
    "VND",
    "VUV",
    "XAF",
    "XOF",
    "XPF",
  ]);

  return zeroDecimalCurrencies.has(normalized) ? 0 : 2;
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

function formatDateInput(value) {
  if (!value) return "";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch (_error) {
    return "";
  }
}

function getOrderCurrencyCode(request) {
  const order = request.orderSnapshotJson || {};
  return (
    order.currencyCode ||
    order.currency ||
    order.presentment_currency ||
    order.total_price_set?.shop_money?.currency_code ||
    "JPY"
  );
}

function serializeWithdrawalRequest(request) {
  return {
    ...request,
    createdAt: toIso(request.createdAt),
    updatedAt: toIso(request.updatedAt),
    receivedDate: toIso(request.receivedDate),
    deadlineAt: toIso(request.deadlineAt),
    confirmationSentAt: toIso(request.confirmationSentAt),
    decisionSentAt: toIso(request.decisionSentAt),
    returnReceivedAt: toIso(request.returnReceivedAt),
    returnProofTokenExpiresAt: toIso(request.returnProofTokenExpiresAt),
    returnProofSubmittedAt: toIso(request.returnProofSubmittedAt),
    returnInfoUpdatedAt: toIso(request.returnInfoUpdatedAt),
    refundDecisionUpdatedAt: toIso(request.refundDecisionUpdatedAt),
    completionRecordedAt: toIso(request.completionRecordedAt),
    completionNotifiedAt: toIso(request.completionNotifiedAt),
    completedAt: toIso(request.completedAt),
    rejectedAt: toIso(request.rejectedAt),
    statusLabel: getWithdrawalStatusLabel(request.status),
    statusTone: getWithdrawalStatusTone(request.status),
    eligibilityLabel: getWithdrawalEligibilityLabel(request.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    statusHistory: request.statusHistory.map((item) => ({
      ...item,
      createdAt: toIso(item.createdAt),
    })),
    emailLogs: request.emailLogs.map((item) => ({
      ...item,
      sentAt: toIso(item.sentAt),
      createdAt: toIso(item.createdAt),
    })),
  };
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (_error) {
    return null;
  }
}

const detailStyles = `
  .withdrawal-detail{
    display:grid;
    gap:20px;
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
  .withdrawal-detail__header{
    display:flex;
    justify-content:space-between;
    gap:18px;
    align-items:flex-start;
    flex-wrap:wrap;
  }
  .withdrawal-detail__back{
    color:#4b5563;
    display:inline-block;
    font-weight:800;
    margin-bottom:12px;
    text-decoration:none;
  }
  .withdrawal-detail h1,
  .withdrawal-detail h2{
    margin:0 0 12px;
  }
  .withdrawal-detail p{
    color:#4b5563;
    line-height:1.8;
    margin:0 0 12px;
  }
  .withdrawal-detail__badges,
  .withdrawal-detail__button-row{
    display:flex;
    flex-wrap:wrap;
    gap:10px;
  }
  .withdrawal-detail__guard{
    display:grid;
    gap:6px;
    min-width:160px;
    border:1px solid #e5e7eb;
    border-radius:12px;
    padding:12px;
    background:#f9fafb;
  }
  .withdrawal-detail__guard span{
    color:#4b5563;
  }
  .withdrawal-detail__badge{
    border-radius:999px;
    border:1px solid #d1d5db;
    display:inline-flex;
    font-size:13px;
    font-weight:800;
    padding:6px 12px;
    white-space:nowrap;
  }
  .withdrawal-detail__badge--success{background:#ecfdf5;border-color:#a7f3d0;color:#047857;}
  .withdrawal-detail__badge--warning{background:#fffbeb;border-color:#fde68a;color:#92400e;}
  .withdrawal-detail__badge--danger{background:#fef2f2;border-color:#fecaca;color:#b91c1c;}
  .withdrawal-detail__badge--info,
  .withdrawal-detail__badge--neutral{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}
  .withdrawal-detail__notice{
    border-radius:12px;
    font-weight:800;
    padding:14px 18px;
  }
  .withdrawal-detail__notice--ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;}
  .withdrawal-detail__notice--error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;}
  .withdrawal-detail__alert{
    background:#fffbeb;
    border-color:#fde68a;
    color:#92400e;
    display:grid;
    gap:10px;
  }
  .withdrawal-detail__alert h2{
    color:#78350f;
  }
  .withdrawal-detail__alert p{
    color:#92400e;
  }
  .withdrawal-detail__alert ul{
    line-height:1.7;
    margin:0;
    padding-left:22px;
  }
  .withdrawal-detail__next strong{
    display:block;
    font-size:20px;
    margin-bottom:8px;
  }
  .withdrawal-detail__next ol{
    margin:12px 0 0;
    padding-left:22px;
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawal-detail__quick-panel{
    display:grid;
    gap:16px;
  }
  .withdrawal-detail__quick-panel p{
    max-width:760px;
  }
  .withdrawal-detail__quick-grid{
    display:grid;
    gap:12px;
    grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
  }
  .withdrawal-detail__quick-action{
    align-content:start;
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:14px;
    display:grid;
    gap:10px;
    padding:14px;
  }
  .withdrawal-detail__quick-action strong{
    font-size:16px;
  }
  .withdrawal-detail__quick-action span{
    color:#4b5563;
    font-size:13px;
    line-height:1.6;
  }
  .withdrawal-detail__decision{
    display:grid;
    gap:16px;
  }
  .withdrawal-detail__decision-header{
    align-items:flex-start;
    display:flex;
    gap:16px;
    justify-content:space-between;
  }
  .withdrawal-detail__section-header{
    align-items:flex-start;
    display:flex;
    gap:16px;
    justify-content:space-between;
  }
  .withdrawal-detail__link-button{
    align-items:center;
    background:#111827;
    border-radius:10px;
    color:#fff;
    display:inline-flex;
    flex:0 0 auto;
    font-weight:900;
    justify-content:center;
    min-height:42px;
    padding:0 16px;
    text-decoration:none;
  }
  .withdrawal-detail__decision-list{
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:12px;
    color:#374151;
    line-height:1.7;
    margin:0;
    padding:14px 18px 14px 34px;
  }
  .withdrawal-detail__grid{
    display:grid;
    gap:20px;
    grid-template-columns:repeat(2, minmax(0, 1fr));
  }
  .withdrawal-detail__wide{
    grid-column:1 / -1;
  }
  .withdrawal-detail__subtext{
    color:#4b5563;
    line-height:1.7;
    margin:0 0 16px;
  }
  .withdrawal-detail__checklist{
    display:grid;
    gap:10px;
    grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));
  }
  .withdrawal-detail__steps{
    display:grid;
    gap:10px;
    grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));
  }
  .withdrawal-detail__check{
    align-items:flex-start;
    border:1px solid #e5e7eb;
    border-radius:12px;
    display:flex;
    gap:12px;
    justify-content:space-between;
    padding:14px;
  }
  .withdrawal-detail__step{
    align-items:flex-start;
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:12px;
    display:flex;
    gap:12px;
    justify-content:space-between;
    padding:14px;
  }
  .withdrawal-detail__check strong,
  .withdrawal-detail__check span,
  .withdrawal-detail__step strong,
  .withdrawal-detail__step span{
    display:block;
  }
  .withdrawal-detail__check span,
  .withdrawal-detail__step span{
    color:#6b7280;
    font-size:13px;
    line-height:1.6;
    margin-top:4px;
  }
  .withdrawal-detail__dl{
    display:grid;
    margin:0;
  }
  .withdrawal-detail__dl div{
    border-bottom:1px solid #e5e7eb;
    display:grid;
    gap:16px;
    grid-template-columns:180px minmax(0, 1fr);
    padding:12px 0;
  }
  .withdrawal-detail__dl dt{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawal-detail__dl dd{
    margin:0;
    overflow-wrap:anywhere;
  }
  .withdrawal-detail__form{
    display:flex;
    flex-direction:column;
    gap:14px;
  }
  .withdrawal-detail__form--spaced{
    margin-top:20px;
  }
  .withdrawal-detail__form label{
    display:flex;
    flex-direction:column;
    gap:6px;
  }
  .withdrawal-detail__form label span{
    color:#4b5563;
    font-size:13px;
    font-weight:800;
  }
  .withdrawal-detail__form input,
  .withdrawal-detail__form select,
  .withdrawal-detail__form textarea{
    border:1px solid #d1d5db;
    border-radius:10px;
    font:inherit;
    padding:10px 12px;
  }
  .withdrawal-detail__form textarea{
    min-height:84px;
  }
  .withdrawal-detail__checkbox{
    align-items:center;
    flex-direction:row !important;
  }
  .withdrawal-detail__checkbox input{
    width:auto;
  }
  .withdrawal-detail button{
    background:#111827;
    border:0;
    border-radius:10px;
    color:#fff;
    cursor:pointer;
    font:inherit;
    font-weight:800;
    padding:10px 16px;
  }
  .withdrawal-detail button:disabled{
    cursor:wait;
    opacity:.6;
  }
  .withdrawal-detail__button--success{
    background:#047857 !important;
  }
  .withdrawal-detail__button--warning{
    background:#92400e !important;
  }
  .withdrawal-detail__button--danger{
    background:#b91c1c !important;
  }
  .withdrawal-detail__button--neutral{
    background:#111827 !important;
  }
  .withdrawal-detail__amount-grid{
    display:grid;
    gap:12px;
    grid-template-columns:repeat(2, minmax(0, 1fr));
  }
  .withdrawal-detail__hint{
    background:#fffbeb;
    border:1px solid #fde68a;
    border-radius:12px;
    color:#92400e;
    line-height:1.7;
    margin-top:16px;
    padding:12px;
  }
  .withdrawal-detail__warning-list{
    background:#fffbeb;
    border:1px solid #fde68a;
    border-radius:12px;
    color:#92400e;
    line-height:1.7;
    margin-top:16px;
    padding:12px 14px;
  }
  .withdrawal-detail__warning-list ul{
    margin:8px 0 0;
    padding-left:20px;
  }
  .withdrawal-detail__ok-note{
    background:#ecfdf5;
    border:1px solid #a7f3d0;
    border-radius:12px;
    color:#047857;
    font-weight:800;
    margin-top:16px;
    padding:12px 14px;
  }
  .withdrawal-detail__table-wrap{
    margin-top:18px;
    overflow:auto;
  }
  .withdrawal-detail__table{
    border-collapse:collapse;
    min-width:640px;
    width:100%;
  }
  .withdrawal-detail__table th,
  .withdrawal-detail__table td{
    border-bottom:1px solid #e5e7eb;
    padding:12px 10px;
    text-align:left;
    vertical-align:top;
  }
  .withdrawal-detail__table th{
    color:#4b5563;
    font-size:13px;
    white-space:nowrap;
  }
  .withdrawal-detail__quick-actions,
  .withdrawal-detail__inline-form{
    border-top:1px solid #e5e7eb;
    margin-top:20px;
    padding-top:20px;
  }
  .withdrawal-detail__raw{
    margin-top:18px;
  }
  .withdrawal-detail__raw summary{
    color:#4b5563;
    cursor:pointer;
    font-weight:800;
  }
  .withdrawal-detail__pre{
    background:#0f172a;
    border-radius:12px;
    color:#e2e8f0;
    max-height:360px;
    overflow:auto;
    padding:16px;
  }
  .withdrawal-detail__timeline{
    display:flex;
    flex-direction:column;
    gap:12px;
  }
  .withdrawal-detail__timeline > div{
    border:1px solid #e5e7eb;
    border-radius:12px;
    padding:12px;
  }
  .withdrawal-detail__timeline span{
    color:#6b7280;
    display:block;
    font-size:13px;
    margin-top:4px;
  }
  .withdrawal-detail__empty{
    border:1px dashed #cbd5e1;
    border-radius:12px;
    color:#64748b;
    padding:18px;
  }
  .withdrawal-detail__error{
    color:#b91c1c;
  }
  @media (max-width:900px){
    .withdrawal-detail{
      padding:16px;
    }
    .withdrawal-detail__grid,
    .withdrawal-detail__amount-grid{
      grid-template-columns:1fr;
    }
    .withdrawal-detail__section-header{
      flex-direction:column;
    }
    .withdrawal-detail__dl div{
      grid-template-columns:1fr;
      gap:4px;
    }
  }
`;
