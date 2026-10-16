import { createInternationalProofCommands } from "./internationalProofIssuance.server.js";
import { createInternationalAuthorizationCommands } from "./internationalAuthorizationRequests.server.js";
import { internationalAuthorizationTransaction } from "./internationalAuthorizationPolicy.server.js";
import { assertInternationalRunDelivery } from "./internationalProofDeliveryState.server.js";
import { revokeInternationalProofDelivery } from "./internationalProofDelivery.server.js";
import { saveInternationalSurfaceEvidence } from "./internationalSurfaceEvidence.server.js";
import {
  limitInternationalRequests,
  internationalJson,
} from "./internationalRunnerAuthentication.server.js";
import {
  proofHash,
  proofError,
  ID,
  HASH,
} from "../utils/internationalProofContract.js";
import { resolveInternationalShippingOperatorRole } from "../utils/marketplaceOperatorRoles.js";

const FIELDS = {
  recordInternationalSurfaceEvidence: [
    "evidenceReference",
    "evidenceHash",
    "notes",
    "expectedVersion",
    "status",
  ],
  prepareInternationalDeployment: [
    "deliveryId",
    "expectedDigest",
    "requestKey",
  ],
  revokeInternationalProofDelivery: ["deliveryId", "expectedDigest"],
  refreshInternationalProofObservation: ["runId", "resultDigest"],
  revokeInternationalProof: ["runId", "resultDigest", "expectedProof"],
  previewInternationalAuthorization: [
    "purpose",
    "resumePurpose",
    "verificationKind",
    "scope",
    "currencies",
    "expiresAt",
  ],
  confirmInternationalAuthorization: ["requestId", "nonce"],
};
export async function dispatchInternationalRunnerAdmin({
  request,
  formData,
  requireOperator,
  prismaClient,
  env = process.env,
}) {
  const intent = formData.get("intent");
  const fields = FIELDS[intent];
  if (!fields) return null;
  if ([...formData.keys()].some((key) => !["intent", ...fields].includes(key)))
    throw proofError("international_input_invalid", 400);
  const input = Object.fromEntries(
    fields.map((key) => [key, formData.get(key)]),
  );
  if (Object.values(input).some((value) => typeof value !== "string"))
    throw proofError("international_input_invalid", 400);
  const context = await requireOperator(request, {
    role: resolveInternationalShippingOperatorRole(intent),
  });
  const actor = {
    shopDomain: context.session.shop,
    actorKey: context.operator.actorKey,
  };
  if (
    [
      "prepareInternationalDeployment",
      "refreshInternationalProofObservation",
    ].includes(intent)
  )
    await limitInternationalRequests(prismaClient, actor, intent, 5);
  if (input.runId && !ID.test(input.runId))
    throw proofError("international_input_invalid", 422);
  if (input.deliveryId && !ID.test(input.deliveryId))
    throw proofError("international_input_invalid", 422);
  let result;
  if (intent === "recordInternationalSurfaceEvidence")
    result = await saveInternationalSurfaceEvidence(prismaClient, actor, input);
  else if (intent === "revokeInternationalProofDelivery")
    result = await revokeInternationalProofDelivery(prismaClient, actor, input);
  else if (intent === "refreshInternationalProofObservation")
    result = await internationalAuthorizationTransaction(
      prismaClient,
      async (tx, now) => {
        const row = await tx.internationalCheckoutVerificationRun.findFirst({
          where: { id: input.runId, shopDomain: actor.shopDomain },
        });
        if (
          !row ||
          row.kind !== "DEPLOYMENT" ||
          row.status !== "PASSED" ||
          row.revokedAt ||
          row.observationFailureCode === "international_deployment_changed" ||
          !HASH.test(input.resultDigest) ||
          proofHash(row.resultsJson) !== input.resultDigest
        )
          throw proofError("international_run_unavailable", 409);
        await assertInternationalRunDelivery(tx, row, now);
        if (!row.observationRefreshRequestedAt)
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: row.id },
            data: { observationRefreshRequestedAt: now },
          });
        return { ok: true, pending: true };
      },
    );
  else if (
    intent === "prepareInternationalDeployment" ||
    intent === "revokeInternationalProof"
  ) {
    const command = createInternationalProofCommands({
      requireOperator,
      prismaClient,
      env,
    });
    if (intent === "revokeInternationalProof")
      input.expectedProof = JSON.parse(input.expectedProof);
    result = await command[
      intent === "prepareInternationalDeployment" ? "prepare" : "revoke"
    ](request, input);
  } else {
    const command = createInternationalAuthorizationCommands({
      requireOperator,
      prismaClient,
    });
    if (intent === "previewInternationalAuthorization") {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt))
        throw proofError("international_expiry_timezone_required", 422);
      input.scope = JSON.parse(input.scope);
      input.currencies = JSON.parse(input.currencies);
      input.resumePurpose ||= null;
      input.verificationKind ||= null;
    }
    result = await command[
      intent === "previewInternationalAuthorization" ? "preview" : "confirm"
    ](request, input);
    if (intent === "previewInternationalAuthorization")
      result.preview = {
        purpose: input.purpose,
        resumePurpose: input.resumePurpose,
        scope: input.scope,
        currencies: input.currencies,
        expiresAt: result.effectiveExpiresAt,
      };
  }
  return internationalJson(result, result.pending ? 202 : 200);
}
