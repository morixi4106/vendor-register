import {
  internationalAuthorizationTransaction,
  INTERNATIONAL_SYSTEM_EVIDENCE_KEYS,
} from "./internationalAuthorizationPolicy.server.js";
import {
  proofHash,
  proofError,
  verifyProofSignature,
  PROOF_VERSION,
  ID,
  SHA,
  HASH,
  proofDate,
  shape,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";

export async function receiveInternationalProofDelivery(
  db,
  principal,
  receipt,
  { trust = INTERNATIONAL_PROOF_TRUST } = {},
) {
  if (Buffer.byteLength(JSON.stringify(receipt)) > 24000)
    throw proofError("international_receipt_limit", 413);
  const receiptDigest = proofHash(receipt);
  return internationalAuthorizationTransaction(db, async (tx, now) => {
    const p = verifyProofSignature(receipt, "publisher", now, trust);
    shape(
      p,
      [
        "v",
        "id",
        "approvalId",
        "purpose",
        "shopDomain",
        "appId",
        "headSha",
        "runId",
        "runAttempt",
        "artifactId",
        "contentDigest",
        "archiveDigest",
        "deploymentDigest",
        "versionId",
        "versionTag",
        "startedAt",
        "completedAt",
        "executeBefore",
        "allowedUseUntil",
        "web",
        "cron",
        "migrationVersion",
      ],
      24000,
    );
    for (const service of [p.web, p.cron]) {
      shape(service, ["serviceId", "deployId", "commit", "status"]);
      if (
        !ID.test(service.serviceId || "") ||
        !ID.test(service.deployId || "") ||
        service.commit !== p.headSha ||
        service.status !== "live"
      )
        throw proofError("international_receipt_untrusted", 422);
    }
    if (
      p.v !== PROOF_VERSION ||
      p.purpose !== "RELEASE" ||
      p.shopDomain !== principal.shopDomain ||
      p.appId !== principal.appId ||
      ![p.id, p.versionTag].every((v) => ID.test(v || "")) ||
      !SHA.test(p.headSha || "") ||
      ![p.archiveDigest, p.contentDigest, p.deploymentDigest].every((v) =>
        HASH.test(v || ""),
      ) ||
      !Number.isSafeInteger(p.artifactId) ||
      p.artifactId < 1 ||
      p.artifactId > 2147483647
    )
      throw proofError("international_receipt_untrusted", 422);
    const key = { shopDomain: principal.shopDomain, receiptId: p.id };
    const existing = await tx.internationalProofDelivery.findUnique({
      where: { shopDomain_receiptId: key },
    });
    if (existing) {
      if (existing.receiptDigest !== receiptDigest)
        throw proofError("international_delivery_changed", 409);
      return {
        ok: true,
        deliveryId: existing.id,
        replayed: true,
        revoked: Boolean(existing.revokedAt),
        saleReady: false,
      };
    }
    if (proofDate(p.allowedUseUntil) <= now || proofDate(p.completedAt) > now)
      throw proofError("international_receipt_expired", 422);
    const count = await tx.internationalProofDelivery.count({
      where: {
        ...{ shopDomain: principal.shopDomain },
        revokedAt: null,
        allowedUseUntil: { gt: now },
        verificationRuns: { none: {} },
      },
    });
    if (count >= 100) throw proofError("international_delivery_limit", 409);
    const row = await tx.internationalProofDelivery.create({
      data: {
        ...key,
        appId: p.appId,
        receiptJson: receipt,
        receiptDigest,
        artifactId: p.artifactId,
        headSha: p.headSha,
        versionTag: p.versionTag,
        allowedUseUntil: proofDate(p.allowedUseUntil),
        receivedBy: principal.principalId,
      },
    });
    return { ok: true, deliveryId: row.id, saleReady: false };
  });
}

export async function revokeInternationalProofDelivery(db, actor, input) {
  return internationalAuthorizationTransaction(db, async (tx, now) => {
    const row = await tx.internationalProofDelivery.findFirst({
      where: { id: input.deliveryId, shopDomain: actor.shopDomain },
    });
    if (!row || row.receiptDigest !== input.expectedDigest)
      throw proofError("international_delivery_changed", 409);
    if (row.revokedAt) return { ok: true, replayed: true };
    await tx.internationalProofDelivery.update({
      where: { id: row.id },
      data: { revokedAt: now, revokedBy: actor.actorKey },
    });
    const live = await tx.internationalCheckoutVerificationRun.findFirst({
      where: {
        shopDomain: actor.shopDomain,
        proofDeliveryId: row.id,
        status: { in: ["QUEUED", "RUNNING", "CLOSING"] },
      },
    });
    const proofs = await tx.operationalReadinessAttestation.findMany({
      where: {
        scopeType: "SHOP",
        scopeId: actor.shopDomain,
        checkKey: { in: INTERNATIONAL_SYSTEM_EVIDENCE_KEYS },
      },
    });
    let affected = Boolean(live);
    for (const proof of proofs) {
      const ids = [
        proof.metadataJson?.runId,
        ...(proof.metadataJson?.runReferences || []),
      ].filter(Boolean);
      const dependency =
        ids.length &&
        (await tx.internationalCheckoutVerificationRun.findFirst({
          where: {
            shopDomain: actor.shopDomain,
            proofDeliveryId: row.id,
            id: { in: ids },
          },
        }));
      if (dependency) {
        await tx.operationalReadinessAttestation.update({
          where: { id: proof.id },
          data: { status: "REVOKED", revision: { increment: 1 } },
        });
        affected = true;
      }
    }
    await tx.internationalCheckoutVerificationRun.updateMany({
      where: {
        shopDomain: actor.shopDomain,
        proofDeliveryId: row.id,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
        revokedBy: actor.actorKey,
        revocationReason: "international_delivery_revoked",
      },
    });
    if (affected)
      await stopInternationalGateInTransaction(tx, {
        ...actor,
        now,
        reason: "international_delivery_revoked",
      });
    return { ok: true, pending: affected };
  });
}
