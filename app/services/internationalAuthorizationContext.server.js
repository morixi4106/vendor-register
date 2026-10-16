import {
  buildInternationalGateSnapshot,
  internationalHash,
} from "./internationalGateProjection.server.js";
import { inspectInternationalNativeConfiguration } from "./internationalNativeConfiguration.server.js";
import {
  internationalGraphQL,
  readInternationalMetafield,
} from "./internationalGateTransport.server.js";

// Dedicated deployment/release issuers and live-run adapters arrive in 4B-2/4C.
export async function inspectInternationalAuthorizationProof() {
  return { ready: false, reason: "international_system_proof_unavailable" };
}

export async function inspectInternationalAuthorizationContext(
  { prismaClient, shopDomain, input, now },
  {
    graphQL = internationalGraphQL,
    inspectProof = inspectInternationalAuthorizationProof,
  } = {},
) {
  const countries = [...new Set(input.scope.flatMap((row) => row.countries))];
  const routes = await prismaClient.operationalReadinessAttestation.findMany({
    where: {
      scopeType: "MARKET_COUNTRY",
      scopeId: { in: countries },
      checkKey: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
    },
  });
  const native = await inspectInternationalNativeConfiguration({
    shopDomain,
    scope: input.scope,
    graphQL,
    expectedRoutes: Object.fromEntries(
      routes.map((row) => [row.scopeId, row.metadataJson?.deliveryProfileId]),
    ),
  });
  const proof = await inspectProof({
    shopDomain,
    input,
    prismaClient,
    native,
    now,
  });
  if (!native.available || !native.validationReady || !proof.ready)
    return { ready: false, reason: "international_authorization_unverified" };
  const shop = await readInternationalMetafield({
    shopDomain,
    targetType: "SHOP",
    graphQL,
  });
  return {
    ...proof,
    nativeConfigHash: native.configHash,
    shopTimezone: shop.timezone,
    observedAt: now,
  };
}

export async function collectInternationalAuthorizationSource({
  prismaClient,
  shopDomain,
  input,
  context,
  expiresAt,
  now,
}) {
  const snapshot = await buildInternationalGateSnapshot({
    prismaClient,
    now,
    persist: false,
    state: {
      shopDomain,
      mode: "ENFORCE",
      desiredGeneration: 0,
      authorizedScopeJson: input.scope,
      authorizationExpiresAt: expiresAt,
      shopTimezone: context.shopTimezone,
    },
  });
  const complete = input.scope.every((row) => {
    const target = snapshot.targets.find(
      (candidate) => candidate.targetId === row.shopifyProductId,
    );
    return (
      target &&
      internationalHash(target.projection.c) ===
        internationalHash(row.countries)
    );
  });
  return { ready: complete, sourceHash: snapshot.sourceHash };
}
