import {
  evaluateKomojuLimitedLaunchControl,
  isCompleteKomojuLimitedLaunchMetadata,
  refreshKomojuLimitedLaunchControl,
} from "./komojuLimitedLaunchControl.server.js";

export const KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY =
  "KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH";

export const KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_DEFINITION = Object.freeze({
  key: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  label: "KOMOJU国内直販の限定公開",
  validityDays: 7,
  automated: true,
  supplemental: true,
});

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

function configuredShopDomain(env) {
  return clean(
    env?.SHOPIFY_PRIMARY_SHOP_DOMAIN ||
      env?.SHOPIFY_PRODUCT_SHOP_DOMAIN ||
      env?.SHOPIFY_SHOP_DOMAIN ||
      env?.SHOPIFY_STORE_DOMAIN,
  );
}

export function isCompleteKomojuZeroBalanceLimitedLaunchAttestation({
  metadata,
  evidenceReference,
  evidenceHash,
  confirmedBy,
}) {
  const hash = String(evidenceHash || "").trim().toLowerCase();
  return Boolean(
    isCompleteKomojuLimitedLaunchMetadata(metadata) &&
      confirmedBy === "system:komoju-zero-balance-limited-launch" &&
      evidenceReference === `komoju-limited-launch:${metadata?.probeId}` &&
      /^[a-f0-9]{64}$/.test(hash)
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
  let evaluation = null;
  if (limitedRow?.ready === true) {
    const shopDomain = configuredShopDomain(env);
    try {
      const control = shopDomain
        ? await prismaClient.komojuLimitedLaunchControl.findUnique({
            where: { shopDomain },
          })
        : null;
      evaluation = await evaluateKomojuLimitedLaunchControl(control, {
        prismaClient,
        env,
      });
      if (
        evaluation.blockingReason &&
        control &&
        typeof prismaClient.$transaction === "function"
      ) {
        await refreshKomojuLimitedLaunchControl(
          { shopDomain, applyEmergencyHold: true },
          { prismaClient },
        );
      }
    } catch {
      evaluation = {
        ready: false,
        reason: "limited_launch_evaluation_failed",
      };
    }
  }

  const effectiveLimitedReady =
    limitedRow?.ready === true && evaluation?.ready === true;
  const evaluatedRows = rows.map((row) =>
    row.definition.key === KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY &&
    row.ready === true &&
    !effectiveLimitedReady
      ? {
          ...row,
          ready: false,
          reason: evaluation?.reason || "limited_launch_control_missing",
          limitedLaunchEvaluation: evaluation,
        }
      : row,
  );

  return evaluatedRows.map((row) =>
    row.definition.key === strictCheckKey &&
    row.ready !== true &&
    effectiveLimitedReady
      ? {
          ...row,
          ready: true,
          reason: null,
          effectiveAttestation: limitedRow.attestation,
          evidenceLabel: "国内直販限定の期限付き検証証拠",
          substitutedBy: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
          limitedLaunchEvaluation: evaluation,
        }
      : row,
  );
}
