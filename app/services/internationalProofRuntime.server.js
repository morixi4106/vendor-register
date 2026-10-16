import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import {
  internationalGraphQL,
  readInternationalMetafield,
} from "./internationalGateTransport.server.js";
import { internationalHash } from "./internationalGateProjection.server.js";
import { INTERNATIONAL_CURRENCY_POLICY, INTERNATIONAL_SHOP_PROJECTION_VERSION } from "../utils/internationalCurrencyPolicy.js";
import {
  proofError,
  proofHash,
  byteHash,
  FUNCTION_HANDLE,
  PROOF_SCHEMA_MIGRATION_VERSION,
} from "../utils/internationalProofContract.js";

export async function inspectInternationalProofRuntime({
  shopDomain,
  manifest,
  receipt,
  generation,
  closed = false,
  env = process.env,
  graphQL = internationalGraphQL,
}) {
  if (
    manifest.function.policy !== INTERNATIONAL_CURRENCY_POLICY ||
    manifest.function.projectionVersion !== INTERNATIONAL_SHOP_PROJECTION_VERSION ||
    env.SHOPIFY_API_KEY !== receipt.appId ||
    (env.RENDER_GIT_COMMIT || env.GIT_COMMIT) !== receipt.headSha ||
    env.SHOPIFY_APP_VERSION !== receipt.versionTag ||
    receipt.migrationVersion !== PROOF_SCHEMA_MIGRATION_VERSION
  )
    throw proofError("international_deployment_changed");
  const validation = await inspectMarketplaceCheckoutValidation(shopDomain, {
    graphQL,
  });
  const v = validation.validation;
  const f = v?.shopifyFunction;
  if (
    !validation.ok ||
    !validation.active ||
    validation.runtimeErrorDetected ||
    !v?.id ||
    !f?.id ||
    v.enabled !== true ||
    v.blockOnFailure !== true ||
    f.handle !== FUNCTION_HANDLE ||
    f.apiVersion !== manifest.function.apiVersion
  )
    throw proofError("international_deployment_unverified");
  const response = await graphQL({
    shopDomain,
    query: `query InternationalProofFunction($id: String!) { shopifyFunction(id: $id) { id appKey handle apiVersion inputQuery } }`,
    variables: { id: f.id },
  });
  const actual = response?.data?.shopifyFunction;
  const query = manifest.files.find(
    (row) => row.path === manifest.function.query,
  );
  // Strict bytes, not a permissive query/string rewrite. Differences remain unverified.
  if (
    !actual ||
    actual.id !== f.id ||
    actual.appKey !== receipt.appId ||
    actual.handle !== f.handle ||
    actual.apiVersion !== f.apiVersion ||
    typeof actual.inputQuery !== "string" ||
    Buffer.byteLength(actual.inputQuery) > 3000 ||
    byteHash(Buffer.from(actual.inputQuery)) !== query?.sha256
  )
    throw proofError("international_deployment_unverified");
  if (closed) {
    const shop = await readInternationalMetafield({
      shopDomain,
      targetType: "SHOP",
      graphQL,
    });
    if (!shop.value || Buffer.byteLength(shop.value) > 32000)
      throw proofError("international_stop_unverified");
    const { h, ...value } = JSON.parse(shop.value);
    if (
      h !== internationalHash(value) ||
      value.g !== generation ||
      value.s !== "PREPARING" ||
      value.p !== manifest.function.policy ||
      value.v !== manifest.function.projectionVersion ||
      !Array.isArray(value.u) || value.u.length !== 1 || value.u[0] !== "JPY" ||
      !Array.isArray(value.c) ||
      value.c.length
    )
      throw proofError("international_stop_unverified");
  }
  const dto = {
    validationId: v.id,
    functionId: f.id,
    handle: f.handle,
    apiVersion: f.apiVersion,
    queryHash: query.sha256,
    enabled: true,
    blockOnFailure: true,
  };
  return { dto, nativeConfigHash: proofHash(dto), observedAt: new Date() };
}
export function internationalReleaseBinding(manifest, receipt, dto) {
  return proofHash({
    v: "international-release-v1",
    shopDomain: receipt.shopDomain,
    appId: receipt.appId,
    web: receipt.web,
    cron: receipt.cron,
    migrationVersion: receipt.migrationVersion,
    versionId: receipt.versionId,
    versionTag: receipt.versionTag,
    native: dto,
    contentDigest: proofHash(manifest),
    deploymentDigest: manifest.deploymentDigest,
    policy: manifest.function.policy,
    projectionVersion: manifest.function.projectionVersion,
  });
}
