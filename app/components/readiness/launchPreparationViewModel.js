const EVIDENCE_GUIDANCE = {
  LEGAL_DISCLOSURES_REVIEWED: "公開ページと実際の販売条件を照合した記録",
  CHECKOUT_FINAL_SCREEN_REVIEWED:
    "価格・送料・販売者を確認できる購入直前画面の記録",
  UNSUPPORTED_SALES_SURFACES_DISABLED: "未対応の販売経路を無効化した設定の記録",
  EMERGENCY_STOP_DRILL_COMPLETED: "販売停止と安全な復旧を試験した記録",
  REFUND_LIQUIDITY_CONFIRMED: "現在の返金可能額と代替返金手段の証拠",
  ADMIN_MFA_ACCESS_REVIEWED: "管理者・権限・MFAの棚卸し記録",
  PRIVACY_INCIDENT_RUNBOOK_CONFIRMED:
    "事故時の連絡先・担当・対応手順の確認記録",
  EMAIL_DELIVERY_CONFIRMED: "購入者・管理者向け業務メールの実受信記録",
  PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED:
    "現在のリリースのKOMOJU売上・注文・台帳の照合結果",
};

const EVIDENCE_REASONS = {
  missing: "証跡未登録",
  expired: "有効期限切れ",
  release_mismatch: "現在のリリースと不一致",
  release_unconfigured: "現在のリリースを特定できません",
  model_unavailable: "証跡を取得できません",
  payout_evidence_invalid: "入金証拠の照合が未完了",
};

export function operationalEvidenceAnchor(key) {
  return key === "CHECKOUT_VALIDATION_REPLAY_COMPLETED"
    ? "checkout-validation-replay-evidence"
    : `operational-evidence-${String(key).toLowerCase()}`;
}

export function formatReadinessTime(value) {
  if (!value) return "未取得";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        dateStyle: "short",
        timeStyle: "short",
      }).format(date)
    : "未取得";
}

function evidenceView(row, check, available) {
  const excluded =
    check?.releaseDisposition === "scope_excluded" &&
    check.releaseBlocking === false;
  const confirmed = available && row.ready === true;
  const accepted =
    !confirmed &&
    !excluded &&
    check?.releaseDisposition === "owner_risk_accepted";
  const evidence = row.effectiveAttestation || row.attestation;
  const failed = row.attestation?.status === "FAILED";
  return {
    key: row.definition.key,
    title: row.definition.label,
    confirmed,
    excluded,
    accepted,
    status: excluded
      ? "optional"
      : confirmed
        ? "pass"
        : accepted
          ? "warning"
          : "fail",
    label: excluded
      ? "対象外"
      : confirmed
        ? "確認済み"
        : accepted
          ? "未確認・国内限定例外"
          : failed
            ? "確認失敗"
            : "未確認",
    reason: excluded
      ? check.releaseDispositionReason || "現在の販売範囲では対象外"
      : !available
        ? "証跡を取得できません"
        : confirmed
          ? row.substitutedBy
            ? "国内直販限定の代替証跡"
            : "有効な証跡あり"
          : EVIDENCE_REASONS[row.reason] ||
            (failed ? "失敗した確認の再実施が必要" : "確認が完了していません"),
    expiresAt: evidence?.expiresAt
      ? formatReadinessTime(evidence.expiresAt)
      : null,
    guidance:
      EVIDENCE_GUIDANCE[row.definition.key] ||
      "対象項目の確認者・保存先・確認日を含む証跡",
    to:
      row.definition.key === "SHOPIFY_PAYMENTS_PAYOUT_CONFIRMED"
        ? "/app/shopify-payout-evidence"
        : row.definition.automated
          ? "/app/production-transaction-probe"
          : `#${operationalEvidenceAnchor(row.definition.key)}`,
  };
}

function internationalView(data, checks) {
  const shipping = data.shopify?.productShipping;
  const internationalChecks = checks.filter((check) =>
    /^(international_|air_packet_|eu_product_international_)/.test(check.id),
  );
  if (
    shipping?.available !== true ||
    !Number.isInteger(shipping.internationalProductCount)
  ) {
    return {
      label: "未確認",
      detail: "海外対象商品・国の情報を取得できていません。",
      status: "manual",
    };
  }
  if (shipping.internationalProductCount === 0) {
    return {
      label: "対象未設定",
      detail: "海外対象商品は0件です。海外販売の準備完了ではありません。",
      status: "manual",
    };
  }
  if (
    !Number.isInteger(shipping.requiredCountryCount) ||
    shipping.requiredCountryCount < 1
  ) {
    return {
      label: "販売国未確認",
      detail: "海外対象商品の販売国と配送経路の確認が必要です。",
      status: "manual",
    };
  }
  if (internationalChecks.length === 0) {
    return {
      label: "未確認",
      detail: "海外対象はありますが、国際設定の検査結果を取得できていません。",
      status: "manual",
    };
  }
  const failed = internationalChecks.filter((check) => check.status !== "pass");
  return failed.length > 0
    ? {
        label: "要対応",
        detail: `国際設定の未完了 ${failed.length}件。国別・商品別の証拠を確認してください。`,
        status: "fail",
      }
    : {
        label: "実機確認待ち",
        detail:
          "設定検査とは別に、Shopifyへの反映・購入遮断・実取引の確認が必要です。",
        status: "manual",
      };
}

export function buildLaunchPreparation(data, displayChecks = []) {
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const checkById = new Map(checks.map((check) => [check.id, check]));
  const source = data.operationalReadiness;
  const sourceRows = Array.isArray(source?.rows) ? source.rows : [];
  const evidenceAvailable = source?.available === true && sourceRows.length > 0;
  const evidenceRows = sourceRows
    .filter(
      (row) => row?.definition?.key && row.definition.supplemental !== true,
    )
    .map((row) =>
      evidenceView(
        row,
        checkById.get(
          `operational_attestation_${row.definition.key.toLowerCase()}`,
        ),
        evidenceAvailable,
      ),
    );
  const required = evidenceRows.filter((row) => !row.excluded);
  const pending = required.filter((row) => !row.confirmed);
  const acceptedCount = pending.filter((row) => row.accepted).length;
  const validationCheck = checkById.get(
    "marketplace_checkout_server_validation",
  );
  const standardDirect = data.checkoutMode?.standardDirectReady === true;
  const international = internationalView(data, checks);
  const mode = data.monitorNotificationMode;
  const notificationLabel =
    mode === "prelaunch"
      ? "公開前停止"
      : mode === "live"
        ? "本番通知有効"
        : mode === "paused"
          ? "停止"
          : "未取得";
  const candidates = [];
  for (const check of displayChecks) {
    if (
      check.id.startsWith("operational_attestation_") ||
      check.displayStatus === "optional" ||
      check.status === "pass"
    )
      continue;
    if (check.releaseBlocking !== true && check.displayStatus !== "fail")
      continue;
    candidates.push({
      id: check.id,
      priority: 0,
      title: check.displayTitle,
      detail: check.displayAction || "設定と確認結果の照合が必要です。",
      to:
        check.actionLink?.to ||
        (check.id === "marketplace_checkout_server_validation"
          ? "#checkout-validation-control"
          : "#readiness-check-results"),
    });
  }
  if (!evidenceAvailable) {
    candidates.push({
      id: "evidence_unavailable",
      priority: 0,
      title: "実地確認の取得状況を確認",
      detail: "有効な証跡一覧を取得できていません。",
      to: "#operational-evidence",
    });
  }
  for (const row of pending) {
    candidates.push({
      id: `evidence_${row.key}`,
      priority: row.accepted ? 2 : 1,
      title: row.title,
      detail: `${row.reason} / ${row.guidance}`,
      to: row.to,
    });
  }
  candidates.push({
    id: "international_review",
    priority: 3,
    title: "海外販売の対象と証拠を確認",
    detail: international.detail,
    to: "/app/international-shipping",
  });
  const hasConditionalEvidence = !evidenceAvailable || pending.length > 0;
  const verdict =
    checks.length === 0 || typeof data.canGoLive !== "boolean"
      ? { label: "現設定の判定：未取得", status: "manual" }
      : !data.canGoLive
        ? { label: "現設定：公開前の対応が必要", status: "fail" }
        : hasConditionalEvidence
          ? { label: "現設定の判定：条件付き", status: "warning" }
          : { label: "現設定の公開条件を充足", status: "pass" };
  return {
    verdict,
    observedAt: formatReadinessTime(data.generatedAt),
    releaseId: data.productionRelease?.expected?.releaseId || "未特定",
    modeLabel: standardDirect
      ? "国内運営直販・標準Checkout"
      : data.checkoutMode
        ? "検証付き購入経路"
        : "購入経路未取得",
    checkout: {
      label:
        validationCheck?.status === "pass"
          ? "経路設定確認済み"
          : "経路設定未確認",
      status: validationCheck?.status === "pass" ? "pass" : "manual",
    },
    evidence: {
      available: evidenceAvailable,
      requiredCount: required.length,
      confirmedCount: required.length - pending.length,
      pendingCount: pending.length,
      acceptedCount,
    },
    evidenceByKey: Object.fromEntries(
      evidenceRows.map((row) => [row.key, row]),
    ),
    international,
    notificationLabel,
    nextActions: candidates.sort((a, b) => a.priority - b.priority).slice(0, 3),
  };
}
