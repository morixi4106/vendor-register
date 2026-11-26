import {
  proofHash,
  proofError,
  ID,
  HASH,
} from "../utils/internationalProofContract.js";

export async function readInternationalDelivery(
  tx,
  shopDomain,
  id,
  now,
  expectedDigest,
) {
  const row =
    ID.test(id || "") &&
    (await tx.internationalProofDelivery.findFirst({
      where: { id, shopDomain },
    }));
  if (
    !row ||
    row.revokedAt ||
    row.allowedUseUntil <= now ||
    !HASH.test(row.receiptDigest) ||
    proofHash(row.receiptJson) !== row.receiptDigest ||
    (expectedDigest && expectedDigest !== row.receiptDigest)
  )
    throw proofError("international_delivery_unavailable", 409);
  return row;
}
export async function assertInternationalRunDelivery(tx, run, now) {
  const row = await readInternationalDelivery(
    tx,
    run.shopDomain,
    run.proofDeliveryId,
    now,
  );
  if (proofHash(run.resultsJson?.receipt) !== row.receiptDigest)
    throw proofError("international_delivery_changed", 409);
  return row;
}
