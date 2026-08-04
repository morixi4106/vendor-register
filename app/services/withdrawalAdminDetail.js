import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

export function directReturnErrorMessage(error) {
  const messages = {
    active_return_address_required: "この店舗の有効な返送先が未設定です。",
    withdrawal_approval_required:
      "申請を承認してから返送案内を送ってください。",
    line_mapping_required: "注文商品と店舗の対応を確認してください。",
    instruction_already_sent: "この店舗にはすでに返送案内を送信しています。",
    instruction_email_failed:
      "返送案内メールを送信できませんでした。メール設定を確認してください。",
    deduction_reason_required: "減額する場合は理由を入力してください。",
    invalid_shipping_refund_status: "初回送料の判断が正しくありません。",
    withdrawal_contract_not_found: "対象の契約が見つかりません。",
    withdrawal_partial_line_mapping_required:
      "撤回する商品を1点以上選び、数量を入力してください。",
    withdrawal_line_not_in_order:
      "この注文に含まれない商品が指定されました。画面を更新してやり直してください。",
    withdrawal_line_quantity_exceeded:
      "購入数を超える撤回数量は指定できません。",
    withdrawal_quantity_unavailable:
      "既返金分または他の申請で確保済みのため、その数量は選択できません。",
    withdrawal_line_mapping_locked:
      "対象商品はすでに確定済みのため変更できません。",
    withdrawal_partial_mapping_not_applicable:
      "注文全体の撤回では商品選択を変更できません。",
    withdrawal_policy_not_found:
      "この申請に適用する店舗別返送ポリシーが見つかりません。",
  };

  return messages[error] || `処理できませんでした: ${error || "unknown"}`;
}

export function getCompletionRecordBlockers(request, completionStatusValue) {
  const completionStatus = normalizeStatus(
    completionStatusValue || "UNDECIDED",
  );
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
    [
      "REFUNDED",
      "PARTIALLY_REFUNDED",
      "NO_REFUND_CLOSED",
      "MANUAL_CLOSED",
    ].includes(completionStatus) &&
    isReturnStillOpen(request)
  ) {
    blockers.push(
      "返送が未完了です。返送不要または返送確認済みにしてから完了記録を保存してください。",
    );
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    refundDecisionStatus === "NO_REFUND"
  ) {
    blockers.push(
      "返金なし判断の申請を返金済みとして完了できません。返金判断を見直してください。",
    );
  }

  return blockers;
}

export function getQuickTransitionConfig(key) {
  const definitions = {
    acknowledge: {
      label: "受付済みにする",
      description:
        "申請を受け付けた状態にします。受付メールは別途送信できます。",
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

export function serializeWithdrawalRequest(request) {
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

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isReturnStillOpen(request) {
  return ["REQUIRED", "WAITING", "IN_TRANSIT"].includes(
    normalizeStatus(request.returnRequirementStatus || "UNDECIDED"),
  );
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (_error) {
    return null;
  }
}
