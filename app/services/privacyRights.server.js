import crypto from "node:crypto";
import prisma from "../db.server.js";
import { hashPrivateIdentifier } from "../utils/privacyHash.server.js";

export async function receivePrivacyRightsRequest(
  { shopDomain, topic, payload, webhookId },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  if (
    !["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"].includes(
      topic,
    )
  )
    throw new Error("invalid_privacy_topic");
  const orderIds = (
    payload?.orders_requested ||
    payload?.orders_to_redact ||
    []
  )
    .map(String)
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 1000);
  const email = String(payload?.customer?.email || "")
    .trim()
    .toLowerCase();
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ shopDomain, topic, payload }))
    .digest("hex");
  const requestKey = `${shopDomain}:${topic}:${webhookId || digest}`;
  const row = await prismaClient.privacyRightsRequest.upsert({
    where: { requestKey },
    update: {},
    create: {
      shopDomain,
      topic,
      requestKey,
      shopifyCustomerId: /^\d+$/.test(String(payload?.customer?.id || ""))
        ? String(payload.customer.id)
        : null,
      externalRequestId: /^\d+$/.test(String(payload?.data_request?.id || ""))
        ? String(payload.data_request.id)
        : null,
      customerEmailHash: email
        ? hashPrivateIdentifier(`contact-email:${email}`, { env })
        : null,
      orderIdsJson: orderIds,
      deadlineAt: new Date(now.getTime() + 30 * 86400_000),
    },
  });
  return { accepted: true, requestId: row.id };
}

export async function resolvePrivacyRightsRequest(
  { id, status, evidenceReference, evidenceHash, actor },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (
    !["COMPLETED", "LEGAL_HOLD"].includes(status) ||
    !String(evidenceReference || "").trim() ||
    !/^[a-f0-9]{64}$/i.test(String(evidenceHash || ""))
  )
    return { ok: false, reason: "privacy_evidence_required" };
  const result = await prismaClient.privacyRightsRequest.updateMany({
    where: { id, status: "RECEIVED" },
    data: {
      status,
      evidenceReference: String(evidenceReference).trim().slice(0, 1000),
      evidenceHash: String(evidenceHash).toLowerCase(),
      resolvedBy: actor,
      resolvedAt: now,
    },
  });
  return { ok: result.count === 1 };
}
