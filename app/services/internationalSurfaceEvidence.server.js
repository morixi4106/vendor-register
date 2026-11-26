import { internationalAuthorizationTransaction } from "./internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";
import { internationalEvidenceVersion } from "../utils/internationalEvidenceVersion.js";
import { OPERATIONAL_READINESS_DEFINITIONS } from "./operationalReadiness.server.js";
import {
  proofError,
  HASH,
  shape,
} from "../utils/internationalProofContract.js";

export async function saveInternationalSurfaceEvidence(db, actor, input) {
  shape(input, [
    "evidenceReference",
    "evidenceHash",
    "notes",
    "expectedVersion",
    "status",
  ]);
  if (
    !["CONFIRMED", "FAILED"].includes(input.status) ||
    !HASH.test(input.evidenceHash || "") ||
    typeof input.evidenceReference !== "string" ||
    !input.evidenceReference.trim() ||
    input.evidenceReference.length > 500 ||
    typeof input.notes !== "string" ||
    !input.notes.trim() ||
    input.notes.length > 2000 ||
    typeof input.expectedVersion !== "string"
  )
    throw proofError("international_surface_input_invalid", 422);
  return internationalAuthorizationTransaction(db, async (tx, now) => {
    const key = {
      checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
      scopeType: "SHOP",
      scopeId: actor.shopDomain,
    };
    const row = await tx.operationalReadinessAttestation.findUnique({
      where: { checkKey_scopeType_scopeId: key },
    });
    if (internationalEvidenceVersion(row) !== input.expectedVersion)
      throw proofError("international_surface_changed", 409);
    const validity = OPERATIONAL_READINESS_DEFINITIONS.find(
      (d) => d.key === key.checkKey,
    ).validityDays;
    const data = {
      status: input.status,
      evidenceReference: input.evidenceReference.trim(),
      evidenceHash: input.evidenceHash,
      notes: input.notes.trim(),
      confirmedBy: actor.actorKey,
      confirmedAt: input.status === "CONFIRMED" ? now : null,
      expiresAt:
        input.status === "CONFIRMED"
          ? new Date(+now + validity * 86400000)
          : null,
    };
    await tx.operationalReadinessAttestation.upsert({
      where: { checkKey_scopeType_scopeId: key },
      create: { ...key, ...data },
      update: { ...data, revision: { increment: 1 } },
    });
    const state = await tx.internationalGateSyncState.findUnique({
      where: { shopDomain: actor.shopDomain },
    });
    if (state && state.mode !== "DISABLED")
      await stopInternationalGateInTransaction(tx, {
        ...actor,
        now,
        reason: "international_surface_evidence_changed",
      });
    return { ok: true, pending: Boolean(state && state.mode !== "DISABLED") };
  });
}
