const LIVE_ORDER_REFUND_E2E_CHECK_KEY = "LIVE_ORDER_REFUND_E2E_COMPLETED";

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

export function buildOperationalReadinessChecks({ inspection, control } = {}) {
  const checks = (inspection?.rows || [])
    .filter((row) => row.definition.supplemental !== true)
    .map((row) => {
      const evidence = row.effectiveAttestation || row.attestation;
      return {
        id: `operational_attestation_${row.definition.key.toLowerCase()}`,
        category: "operations",
        status: row.ready ? "pass" : "fail",
        title: row.definition.label,
        detail: row.ready
          ? `${row.evidenceLabel || "証跡"} ${evidence.evidenceReference} / 有効期限 ${evidence.expiresAt.toISOString()}`
          : row.reason === "expired"
            ? "確認証跡の有効期限が切れています。"
            : row.reason === "release_mismatch"
              ? "確認後にデプロイが更新されました。現在のリリースで再確認してください。"
              : row.reason === "release_unconfigured"
                ? "現在のリリースIDを特定できないため、実決済証跡を有効化できません。"
                : "有効な確認証跡が登録されていません。",
        action: row.ready
          ? ""
          : row.definition.key === LIVE_ORDER_REFUND_E2E_CHECK_KEY
            ? "本番注文・返金 E2E確認画面で、実注文と全額返金を自動照合してください。"
            : "本番確認画面で実際の確認を行い、証跡参照と確認者を記録してください。",
      };
    });

  const checkoutControlState = upper(control?.checkoutControlState || "IDLE");
  const checkoutControlActive =
    control?.checkoutHold === true || checkoutControlState !== "IDLE";
  checks.push({
    id: "platform_checkout_emergency_hold",
    category: "operations",
    status: checkoutControlActive ? "fail" : "pass",
    title: "販売緊急停止",
    detail: checkoutControlActive
      ? `販売統制 ${checkoutControlState} / ${control?.holdReason || "理由未記録"}`
      : "販売緊急停止は解除されています。",
    action: checkoutControlActive
      ? "原因を解消し、停止者とは別の管理者が証拠を確認して復旧してください。PARTIAL_FAILUREやRECOVERY_FAILEDでは購入拒否を維持します。"
      : "",
  });

  checks.push({
    id: "platform_automated_email_hold",
    category: "operations",
    status: control?.automatedEmailHold ? "fail" : "pass",
    title: "自動メール緊急停止",
    detail: control?.automatedEmailHold
      ? `自動メール停止中です: ${control.holdReason || "理由未記録"}`
      : "自動メール緊急停止は解除されています。",
    action: control?.automatedEmailHold
      ? "原因を解消し、停止者とは別の管理者が復旧証拠を確認して解除してください。"
      : "",
  });

  const classHoldChecks = [
    {
      id: "platform_order_email_hold",
      field: "orderEmailHold",
      title: "注文メール緊急停止",
    },
    {
      id: "platform_legal_email_hold",
      field: "legalEmailHold",
      title: "法務メール緊急保留",
    },
    {
      id: "platform_security_email_hold",
      field: "securityEmailHold",
      title: "セキュリティメール緊急停止",
    },
  ];
  for (const item of classHoldChecks) {
    const active = control?.[item.field] === true;
    checks.push({
      id: item.id,
      category: "operations",
      status: active ? "fail" : "pass",
      title: item.title,
      detail: active
        ? `${item.title}中です: ${control?.holdReason || "理由未記録"}`
        : `${item.title}は解除されています。`,
      action: active
        ? "原因を解消し、停止者とは別の管理者が復旧証拠を確認して解除してください。"
        : "",
    });
  }

  return checks;
}
