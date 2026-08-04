import { json, redirect } from "@remix-run/node";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import WithdrawalDetailPage from "../components/withdrawals/WithdrawalDetailPage.jsx";
import {
  directReturnErrorMessage,
  getCompletionRecordBlockers,
  getQuickTransitionConfig,
  serializeWithdrawalRequest,
} from "../services/withdrawalAdminDetail.js";
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

  if (
    intent === "execute_shopify_cancel" ||
    intent === "execute_shopify_refund"
  ) {
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

export default WithdrawalDetailPage;
