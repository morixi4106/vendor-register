import { internationalEvidenceVersion } from "../utils/internationalEvidenceVersion.js";
import { inspectInternationalAuthorizationCapability } from "./internationalAuthorizationPolicy.server.js";
import { proofHash, ID } from "../utils/internationalProofContract.js";
import { MARKETPLACE_OPERATOR_ROLES as ROLES } from "../utils/marketplaceOperatorRoles.js";

export async function loadInternationalRunnerAdmin(db, context, request) {
  const shopDomain = context.session.shop;
  const query = new URL(request.url).searchParams;
  const rawCursor = query.get("runCursor");
  const cursor =
    ID.test(rawCursor || "") &&
    (await db.internationalCheckoutVerificationRun.findFirst({
      where: { id: rawCursor, shopDomain },
      select: { id: true },
    }));
  const runs = await db.internationalCheckoutVerificationRun.findMany({
    where: { shopDomain },
    select: {
      id: true,
      kind: true,
      status: true,
      closureStatus: true,
      expiresAt: true,
      observedAt: true,
      observationExpiresAt: true,
      observationRefreshRequestedAt: true,
      observationFailureCode: true,
      revokedAt: true,
      createdAt: true,
      resultsJson: true,
      releaseBinding: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21,
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
  });
  const deliveries = await db.internationalProofDelivery.findMany({
    where: { shopDomain },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: {
      id: true,
      receiptDigest: true,
      headSha: true,
      versionTag: true,
      allowedUseUntil: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  const surface = await db.operationalReadinessAttestation.findUnique({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
        scopeType: "SHOP",
        scopeId: shopDomain,
      },
    },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      revision: true,
      updatedAt: true,
    },
  });
  const proofs = await db.operationalReadinessAttestation.findMany({
    where: {
      scopeType: "SHOP",
      scopeId: shopDomain,
      checkKey: {
        in: [
          "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
          "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED",
        ],
      },
    },
    select: {
      id: true,
      revision: true,
      evidenceHash: true,
      metadataJson: true,
    },
  });
  const auths = await db.internationalGateAuthorizationRequest.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      purpose: true,
      resumePurpose: true,
      verificationKind: true,
      previewExpiresAt: true,
      consumedAt: true,
      revokedAt: true,
    },
  });
  const roles = context.operator.authorizedRoles || [];
  const can = (role) => roles.includes(role);
  const capability = inspectInternationalAuthorizationCapability();
  const products = capability.ready
    ? await db.product.findMany({
        where: {
          shopDomain,
          approvalStatus: "approved",
          shopifyProductId: { not: null },
        },
        select: { id: true, name: true, shopifyProductId: true },
        take: 200,
        orderBy: { id: "asc" },
      })
    : [];
  return {
    saleReady: false,
    capability,
    products,
    permissions: {
      review: can(ROLES.COMPLIANCE_REVIEWER),
      release: can(ROLES.RELEASE_MANAGER),
      stop: can(ROLES.INCIDENT_COMMANDER),
      resume: can(ROLES.RELEASE_MANAGER) && can(ROLES.RECOVERY_APPROVER),
    },
    surface: {
      status: surface?.status || "PENDING",
      expiresAt: surface?.expiresAt || null,
      expectedVersion: internationalEvidenceVersion(surface),
    },
    deliveries,
    authorizations: auths,
    runs: runs.slice(0, 20).map(({ resultsJson, ...row }) => {
      const proof = proofs.find((p) => p.metadataJson?.runId === row.id);
      return {
        ...row,
        resultDigest: resultsJson ? proofHash(resultsJson) : null,
        expectedProof: proof
          ? {
              id: proof.id,
              revision: proof.revision,
              evidenceHash: proof.evidenceHash,
            }
          : null,
      };
    }),
    nextRunCursor: runs.length > 20 ? runs[19].id : null,
  };
}
