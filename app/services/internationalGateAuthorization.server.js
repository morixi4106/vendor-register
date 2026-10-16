import {
  internationalHash,
  internationalLocalDate,
  normalizeInternationalScope,
} from "./internationalGateProjection.server.js";
import {
  internationalGateTransaction,
  invalidateInternationalGates,
  staleInternationalEvidence,
} from "./internationalGateQueue.server.js";
import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import { inspectInternationalNativeConfiguration } from "./internationalNativeConfiguration.server.js";
import {
  internationalGraphQL,
  readInternationalMetafield,
} from "./internationalGateTransport.server.js";

export const INTERNATIONAL_RELEASE_EVIDENCE_KEY =
  "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED";

export async function inspectInternationalStopProtection({
  shopDomain,
  prismaClient,
  env,
  graphQL,
  now,
}) {
  const validation = await inspectMarketplaceCheckoutValidation(shopDomain, {
    graphQL,
  });
  const release = await inspectInternationalGateRelease({
    shopDomain,
    prismaClient,
    env,
    now,
    native: {
      available: validation.ok,
      validationReady: validation.active && !validation.runtimeErrorDetected,
      validationId: validation.validation?.id,
      functionId: validation.validation?.shopifyFunction?.id,
      functionApiVersion: validation.validation?.shopifyFunction?.apiVersion,
    },
  });
  return { ready: release.ready };
}

export async function inspectInternationalGateRelease({
  prismaClient,
  shopDomain,
  native,
  env = process.env,
  now = new Date(),
}) {
  const proof = await prismaClient.operationalReadinessAttestation.findUnique({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: INTERNATIONAL_RELEASE_EVIDENCE_KEY,
        scopeType: "SHOP",
        scopeId: shopDomain,
      },
    },
  });
  const metadata = proof?.metadataJson || {};
  const binding = {
    commit: env.RENDER_GIT_COMMIT || env.GIT_COMMIT,
    appVersion: env.SHOPIFY_APP_VERSION,
    functionHash: env.INTERNATIONAL_CHECKOUT_FUNCTION_SHA256,
    validationId: native.validationId,
    functionId: native.functionId,
    internationalPolicy: "international-sale-2026-10-v1",
  };
  const valid =
    native.available &&
    native.validationReady &&
    native.functionApiVersion === "2026-04" &&
    env.PLATFORM_DIRECT_CHECKOUT_MODE === "MARKETPLACE_VALIDATED" &&
    Object.values(binding).every(
      (v) => typeof v === "string" && v.length > 0,
    ) &&
    /^[a-f0-9]{64}$/.test(binding.functionHash) &&
    proof?.status === "CONFIRMED" &&
    proof.confirmedBy &&
    !String(proof.confirmedBy).endsWith(".myshopify.com") &&
    proof.evidenceReference &&
    /^[a-f0-9]{64}$/.test(proof.evidenceHash || "") &&
    proof.confirmedAt &&
    new Date(proof.confirmedAt) <= now &&
    proof.expiresAt &&
    new Date(proof.expiresAt) > now &&
    Object.entries(binding).every(([key, value]) => metadata[key] === value) &&
    metadata.productCountryBlockingVerified === true &&
    metadata.nonFunctionPathsDisabled === true &&
    metadata.revocationReadbackVerified === true;
  return {
    ready: Boolean(valid),
    binding: valid ? internationalHash(binding) : null,
    expiresAt: proof?.expiresAt || null,
  };
}

// Called only by a RELEASE_MANAGER command, never by evidence saves or a worker.
export async function authorizeInternationalGateScope(
  {
    prismaClient,
    shopDomain,
    scope,
    expectedGeneration,
    expectedScopeHash,
    actorKey,
    env = process.env,
    now = new Date(),
  },
  {
    graphQL = internationalGraphQL,
    inspectNative = inspectInternationalNativeConfiguration,
    inspectRelease = inspectInternationalGateRelease,
  } = {},
) {
  const normalized = normalizeInternationalScope(scope);
  const hash = internationalHash(normalized);
  const rows = await prismaClient.operationalReadinessAttestation.findMany({
    where: {
      scopeType: "MARKET_COUNTRY",
      checkKey: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
    },
  });
  const native = await inspectNative({
    shopDomain,
    scope: normalized,
    graphQL,
    expectedRoutes: Object.fromEntries(
      rows.map((r) => [r.scopeId, r.metadataJson?.deliveryProfileId]),
    ),
  });
  const release = await inspectRelease({
    prismaClient,
    shopDomain,
    native,
    env,
    now,
  });
  const shop = await readInternationalMetafield({
    shopDomain,
    targetType: "SHOP",
    graphQL,
  });
  const timezone = shop.timezone;
  internationalLocalDate(now, timezone);
  if (
    !actorKey ||
    !native?.available ||
    !native.validationReady ||
    !release?.ready ||
    hash !== expectedScopeHash ||
    !timezone ||
    !release.expiresAt ||
    new Date(release.expiresAt) <= now
  )
    return { ok: false, reason: "international_authorization_unverified" };
  return internationalGateTransaction(prismaClient, async (tx) => {
    const state = await tx.internationalGateSyncState.upsert({
      where: { shopDomain },
      create: { shopDomain },
      update: {},
    });
    if (state.desiredGeneration !== expectedGeneration)
      throw staleInternationalEvidence();
    await tx.internationalGateSyncState.update({
      where: { shopDomain },
      data: {
        mode: "ENFORCE",
        authorizedScopeJson: normalized,
        authorizedScopeHash: hash,
        nativeConfigHash: native.configHash,
        releaseBinding: release.binding,
        shopTimezone: timezone,
        authorizationExpiresAt: release.expiresAt,
      },
    });
    await invalidateInternationalGates(tx, { shopDomain, now });
    return { ok: true, pending: true };
  });
}
