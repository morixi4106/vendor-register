import { getOfflineSessionForShopDomain } from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import {
  INTERNATIONAL_PRODUCT_GATE_KEY,
  INTERNATIONAL_SHOP_GATE_KEY,
  internationalHash,
  serializeInternationalProjection,
} from "./internationalGateProjection.server.js";

export function internationalGateError(code, retryAfterMs = null) {
  const error = new Error(code);
  error.code = code;
  error.retryAfterMs = retryAfterMs;
  return error;
}

export async function internationalGraphQL({
  shopDomain,
  query,
  variables = {},
  timeoutMs = 10000,
  signal,
}) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    throw internationalGateError("international_shop_invalid");
  const session = await getOfflineSessionForShopDomain(shopDomain);
  signal?.throwIfAborted();
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.min(10000, timeoutMs))),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!response.ok) {
    const retry = Number(response.headers.get("Retry-After"));
    throw internationalGateError(
      response.status === 429
        ? "international_throttled"
        : response.status >= 500
          ? "international_transport_failed"
          : "international_access_denied",
      Number.isFinite(retry) && retry > 0
        ? Math.min(retry * 1000, 86400000)
        : null,
    );
  }
  const result = await response.json();
  if (result.errors?.length || !result.data)
    throw internationalGateError(
      result.errors?.some((e) => e.extensions?.code === "THROTTLED")
        ? "international_throttled"
        : "international_query_unverified",
    );
  return result;
}

export async function readInternationalMetafield({
  shopDomain,
  targetType,
  targetId,
  graphQL = internationalGraphQL,
}) {
  const shop = targetType === "SHOP";
  const key = shop
    ? INTERNATIONAL_SHOP_GATE_KEY
    : INTERNATIONAL_PRODUCT_GATE_KEY;
  const query = shop
    ? `query InternationalGateShop { shop { id ianaTimezone gate: metafield(namespace: "$app", key: "${key}") { value compareDigest } } }`
    : `query InternationalGateProduct($id: ID!) { node(id: $id) { ... on Product { id gate: metafield(namespace: "$app", key: "${key}") { value compareDigest } } } }`;
  const response = await graphQL({
    shopDomain,
    query,
    variables: shop ? {} : { id: targetId },
  });
  const owner = shop ? response?.data?.shop : response?.data?.node;
  if (!owner?.id || (!shop && owner.id !== targetId))
    throw internationalGateError("international_target_missing");
  if (
    owner.gate &&
    (typeof owner.gate.value !== "string" || !owner.gate.compareDigest)
  )
    throw internationalGateError("international_readback_invalid");
  return {
    ownerId: owner.id,
    timezone: owner.ianaTimezone,
    value: owner.gate?.value || null,
    digest: owner.gate?.compareDigest ?? null,
  };
}

export async function writeInternationalMetafield({
  shopDomain,
  targetType,
  targetId,
  projection,
  assertCurrent,
  graphQL = internationalGraphQL,
}) {
  const current = await readInternationalMetafield({
    shopDomain,
    targetType,
    targetId,
    graphQL,
  });
  // The generation and lease fence is checked AFTER reading the Shopify digest.
  await assertCurrent(current);
  const value = serializeInternationalProjection(projection);
  if (current.value !== value) {
    const response = await graphQL({
      shopDomain,
      query: `mutation InternationalGateSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { code } } }`,
      variables: {
        metafields: [
          {
            ownerId: current.ownerId,
            namespace: "$app",
            key:
              targetType === "SHOP"
                ? INTERNATIONAL_SHOP_GATE_KEY
                : INTERNATIONAL_PRODUCT_GATE_KEY,
            type: "json",
            value,
            compareDigest: current.digest,
          },
        ],
      },
    });
    if (
      !Array.isArray(response?.data?.metafieldsSet?.userErrors) ||
      response.data.metafieldsSet.userErrors.length
    ) {
      throw internationalGateError("international_cas_conflict");
    }
  }
  const observed = await readInternationalMetafield({
    shopDomain,
    targetType,
    targetId,
    graphQL,
  });
  await assertCurrent(observed);
  if (observed.value !== value)
    throw internationalGateError("international_readback_mismatch");
  const { h, ...base } = JSON.parse(observed.value);
  if (h !== internationalHash(base))
    throw internationalGateError("international_hash_mismatch");
  return observed;
}

export async function verifyInternationalProductReadbacks({
  shopDomain,
  targets,
  graphQL = internationalGraphQL,
}) {
  if (targets.length > 200)
    throw internationalGateError("international_inventory_incomplete");
  for (let index = 0; index < targets.length; index += 25) {
    const batch = targets.slice(index, index + 25);
    const response = await graphQL({
      shopDomain,
      query: `query InternationalGateReadbacks($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
        id gate: metafield(namespace: "$app", key: "international_sale_eligibility") { value }
      } } }`,
      variables: { ids: batch.map((t) => t.targetId) },
    });
    const nodes = response?.data?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== batch.length)
      throw internationalGateError("international_readback_mismatch");
    for (const target of batch) {
      const node = nodes.find((n) => n?.id === target.targetId);
      if (
        node?.gate?.value !==
        serializeInternationalProjection(target.payloadJson)
      )
        throw internationalGateError("international_readback_mismatch");
      const { h, ...base } = JSON.parse(node.gate.value);
      if (h !== target.expectedHash || h !== internationalHash(base))
        throw internationalGateError("international_hash_mismatch");
    }
  }
}
