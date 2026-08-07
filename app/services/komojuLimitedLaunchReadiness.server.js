import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";

export const KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY =
  "KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH";

export const KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_DEFINITION = Object.freeze({
  key: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  label: "新規KOMOJUの国内直販限定公開",
  validityDays: 7,
  automated: true,
  supplemental: true,
});

const CONTINUING_PROBE_STATUSES = new Set([
  "AWAITING_PAYOUT_EVIDENCE",
  "AWAITING_REFUND_RESERVE_CONFIRMATION",
  "AWAITING_REFUND",
  "PASSED",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeSha256(value) {
  const normalized = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export function isCompleteKomojuZeroBalanceLimitedLaunchAttestation({
  metadata,
  evidenceReference,
  evidenceHash,
  confirmedBy,
}) {
  const probeId = clean(metadata?.probeId);
  const saleVerifiedAt = new Date(metadata?.saleVerifiedAt);
  const completionDeadline = new Date(metadata?.completionDeadline);
  const actualPaidAmount = Number(metadata?.actualPaidAmount);
  const maximumPlannedChargeAmount = Number(
    metadata?.maximumPlannedChargeAmount,
  );
  const companyRefundReserveAmount = Number(
    metadata?.companyRefundReserveAmount,
  );
  return Boolean(
    metadata?.verificationSource === "komoju_zero_balance_limited_launch" &&
    confirmedBy === "system:komoju-zero-balance-limited-launch" &&
    probeId &&
    evidenceReference === `komoju-limited-launch:${probeId}` &&
    evidenceHash &&
    clean(metadata?.releaseId) &&
    normalizeSha256(metadata?.releaseFingerprint) &&
    Number.isFinite(saleVerifiedAt.getTime()) &&
    Number.isFinite(completionDeadline.getTime()) &&
    completionDeadline.getTime() > saleVerifiedAt.getTime() &&
    Number.isInteger(actualPaidAmount) &&
    actualPaidAmount > 0 &&
    Number.isInteger(maximumPlannedChargeAmount) &&
    maximumPlannedChargeAmount >= actualPaidAmount &&
    Number.isInteger(companyRefundReserveAmount) &&
    companyRefundReserveAmount >= maximumPlannedChargeAmount &&
    Number(metadata?.confirmedKomojuUnsettledBalanceAmount) === 0 &&
    metadata?.zeroUnsettledBalanceConfirmed === true &&
    metadata?.companyRefundReserveConfirmed === true &&
    metadata?.directRefundFallbackConfirmed === true &&
    metadata?.domesticPlatformDirectOnlyConfirmed === true &&
    metadata?.thirdPartyCommerceDisabled === true &&
    Number(metadata?.euEnabledSellerCount) === 0 &&
    Number(metadata?.euEnabledProductCount) === 0 &&
    Number(metadata?.internationalEnabledProductCount) === 0
  );
}

export async function applyKomojuLimitedLaunchReadiness({
  rows,
  prismaClient,
  env,
  strictCheckKey,
}) {
  const limitedRow = rows.find(
    (row) =>
      row.definition.key === KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  );
  let scope = null;
  let continuity = null;
  if (limitedRow?.ready === true) {
    try {
      const metadata = asObject(limitedRow.attestation?.metadataJson);
      const probeId = clean(metadata.probeId);
      [scope, continuity] = await Promise.all([
        inspectKomojuLimitedLaunchScope({ prismaClient, env }),
        probeId && prismaClient?.productionTransactionProbe?.findUnique
          ? prismaClient.productionTransactionProbe.findUnique({
              where: { id: probeId },
            })
          : null,
      ]);
      const probeReadiness = asObject(
        asObject(continuity?.orderEvidenceJson).externalReadiness,
      );
      const paidEvidence = asObject(continuity?.paidEvidenceJson);
      continuity = {
        ready: Boolean(
          continuity &&
            CONTINUING_PROBE_STATUSES.has(continuity.status) &&
            continuity.releaseId === clean(metadata.releaseId) &&
            continuity.releaseFingerprint ===
              clean(metadata.releaseFingerprint) &&
            probeReadiness.strategy === "ZERO_BALANCE_LIMITED_LAUNCH" &&
            paidEvidence.passed === true &&
            continuity.paidVerifiedAt,
        ),
        status: continuity?.status || null,
      };
    } catch {
      scope = { ready: false, reason: "scope_check_failed" };
      continuity = { ready: false, reason: "continuity_check_failed" };
    }
  }
  const scopedRows = rows.map((row) =>
    row.definition.key === KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY &&
    row.ready === true &&
    (scope?.ready !== true || continuity?.ready !== true)
      ? {
          ...row,
          ready: false,
          reason:
            scope?.ready !== true
              ? scope?.reason || "scope_changed"
              : continuity?.reason || "probe_not_continuing",
          currentScope: scope,
          probeContinuity: continuity,
        }
      : row,
  );
  const activeLimitedRow = scopedRows.find(
    (row) =>
      row.definition.key === KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  );
  return scopedRows.map((row) =>
    row.definition.key === strictCheckKey &&
    row.ready !== true &&
    activeLimitedRow?.ready === true
      ? {
          ...row,
          ready: true,
          reason: null,
          effectiveAttestation: activeLimitedRow.attestation,
          evidenceLabel: "国内直販限定の期限付き証跡",
          substitutedBy: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
        }
      : row,
  );
}
