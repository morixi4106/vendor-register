import crypto from "node:crypto";
import { Resend } from "resend";

import prisma from "../db.server.js";

export const MONITOR_NOTIFICATION_KEY = "launch_monitor_notification_receipt";
export const MONITOR_ACK_KEY = "launch_monitor_incident_acknowledgement";
export const MONITOR_MAIL_KEY = "launch_monitor_latest_mail";
const WEEK = 7 * 86400_000;
const COOLDOWN = 30 * 60_000;
const FAILED_EVENTS = new Set(["bounced", "complained", "failed", "canceled"]);

function routing(env) {
  const key = String(env.PRIVACY_HASH_SECRET || "");
  const from = String(
    env.LAUNCH_MONITOR_FROM_EMAIL ||
      env.MAIL_FROM ||
      env.WITHDRAWAL_FROM_EMAIL ||
      "",
  ).trim();
  const to = String(
    env.LAUNCH_MONITOR_ALERT_EMAIL || env.ADMIN_EMAIL || "",
  ).trim();
  if (key.length < 32 || !env.RESEND_API_KEY || !from || !to)
    throw new Error("notification_receipt_not_configured");
  const fingerprint = crypto
    .createHmac("sha256", key)
    .update(JSON.stringify([from, to]))
    .digest("hex");
  return { key, from, to, fingerprint };
}

function digest(key, nonce, code) {
  return crypto
    .createHmac("sha256", key)
    .update(`monitor-receipt:${nonce}:${code}`)
    .digest("hex");
}

async function ensureReceipt(client) {
  return client.operationalHeartbeat.upsert({
    where: { key: MONITOR_NOTIFICATION_KEY },
    create: { key: MONITOR_NOTIFICATION_KEY, metadataJson: { revision: 0 } },
    update: {},
  });
}

async function replaceReceipt(client, row, metadata) {
  const result = await client.operationalHeartbeat.updateMany({
    where: { key: row.key, metadataJson: { equals: row.metadataJson } },
    data: {
      metadataJson: {
        ...metadata,
        revision: Number(row.metadataJson.revision || 0) + 1,
      },
    },
  });
  if (result.count !== 1) throw new Error("notification_receipt_changed");
}

export async function sendMonitorReceiptTest({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  sendImpl = (message) => new Resend(env.RESEND_API_KEY).emails.send(message),
} = {}) {
  const config = routing(env);
  const row = await ensureReceipt(prismaClient);
  const previous = row.metadataJson;
  if (previous.sentAt && now - new Date(previous.sentAt) < COOLDOWN)
    throw new Error("notification_test_rate_limited");
  const nonce = crypto.randomUUID();
  const code = crypto.randomInt(100000, 1000000).toString();
  const pending = {
    status: "SENDING",
    routingFingerprint: config.fingerprint,
    nonce,
    codeHash: digest(config.key, nonce, code),
    attempts: 0,
    sentAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WEEK).toISOString(),
  };
  await replaceReceipt(prismaClient, row, pending);
  const reserved = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: MONITOR_NOTIFICATION_KEY },
  });
  let messageId;
  try {
    const result = await sendImpl({
      from: config.from,
      to: config.to,
      subject: "Oja: notification receipt check",
      text: `Receipt confirmation code: ${code}\nEnter this code in the app's monitor page.\nThis message does not change sales, orders, or payments.`,
    });
    if (result?.error || !/^[A-Za-z0-9-]{1,128}$/.test(result?.data?.id || ""))
      throw new Error("notification_test_send_failed");
    messageId = result.data.id;
  } catch {
    await replaceReceipt(prismaClient, reserved, {
      ...pending,
      status: "SEND_FAILED",
    });
    throw new Error("notification_test_send_failed");
  }
  await replaceReceipt(prismaClient, reserved, {
    ...pending,
    status: "PENDING",
    messageId,
  });
  return { ok: true };
}

export async function refreshMonitorReceipt({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  getEmailImpl = (id) => new Resend(env.RESEND_API_KEY).emails.get(id),
} = {}) {
  const config = routing(env);
  const receipt = await ensureReceipt(prismaClient);
  const latest = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: MONITOR_MAIL_KEY },
  });
  const row =
    latest?.metadataJson?.messageId &&
    latest.metadataJson.routingFingerprint === config.fingerprint &&
    new Date(latest.metadataJson.sentAt) > new Date(receipt.metadataJson.sentAt)
      ? latest
      : receipt;
  const metadata = row.metadataJson;
  if (!metadata.messageId || metadata.routingFingerprint !== config.fingerprint)
    return { ok: false, reason: "notification_test_required" };
  let providerEvent = "unknown";
  try {
    const result = await getEmailImpl(metadata.messageId);
    if (
      !result?.error &&
      result?.data?.id === metadata.messageId &&
      ["sent", "delivered", "opened", "clicked", ...FAILED_EVENTS].includes(
        result.data.last_event,
      )
    )
      providerEvent = result.data.last_event;
  } catch {
    /* A provider outage cannot prove successful delivery. */
  }
  const deliveryFailed =
    metadata.deliveryFailed === true || FAILED_EVENTS.has(providerEvent);
  await replaceReceipt(prismaClient, row, {
    ...metadata,
    providerEvent,
    deliveryFailed,
    providerCheckedAt: now.toISOString(),
    lastDeliveredAt: ["delivered", "opened", "clicked"].includes(providerEvent)
      ? metadata.sentAt
      : metadata.lastDeliveredAt || null,
  });
  return { ok: providerEvent !== "unknown" && !deliveryFailed, providerEvent };
}

export async function confirmMonitorReceipt({
  code,
  actor,
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
} = {}) {
  const config = routing(env);
  if (!actor) throw new Error("notification_actor_required");
  const row = await ensureReceipt(prismaClient);
  const m = row.metadataJson;
  const expiresAt = new Date(m.expiresAt).getTime();
  if (
    m.status !== "PENDING" ||
    m.routingFingerprint !== config.fingerprint ||
    !Number.isFinite(expiresAt) ||
    now.getTime() >= expiresAt ||
    m.attempts >= 5 ||
    m.deliveryFailed
  )
    throw new Error("notification_confirmation_unavailable");
  const candidate = digest(config.key, m.nonce, String(code || "").trim());
  if (
    !/^[0-9a-f]{64}$/.test(m.codeHash || "") ||
    !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(m.codeHash))
  ) {
    await replaceReceipt(prismaClient, row, {
      ...m,
      attempts: Number(m.attempts || 0) + 1,
    });
    throw new Error("notification_confirmation_invalid");
  }
  const verified = {
    ...m,
    status: "VERIFIED",
    humanVerifiedAt: now.toISOString(),
    verifiedBy: actor,
  };
  delete verified.codeHash;
  await replaceReceipt(prismaClient, row, verified);
  return { ok: true };
}

export async function getMonitorReceiptStatus({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
} = {}) {
  const row = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: MONITOR_NOTIFICATION_KEY },
  });
  const m = row?.metadataJson || {};
  const latest = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: MONITOR_MAIL_KEY },
  });
  const transport =
    latest?.metadataJson?.routingFingerprint === m.routingFingerprint &&
    new Date(latest.metadataJson.sentAt) > new Date(m.sentAt)
      ? latest.metadataJson
      : m;
  const age =
    now - new Date(transport.lastDeliveredAt || transport.sentAt || 0);
  const delivered =
    ["delivered", "opened", "clicked"].includes(transport.providerEvent) ||
    (transport.providerEvent === "pending" &&
      now - new Date(transport.sentAt) < COOLDOWN &&
      transport.lastDeliveredAt);
  const failed = m.deliveryFailed || transport.deliveryFailed;
  let matches = false;
  try {
    matches = m.routingFingerprint === routing(env).fingerprint;
  } catch {
    /* Missing configuration is not a receipt. */
  }
  return {
    ready: Boolean(
      matches &&
      m.status === "VERIFIED" &&
      m.humanVerifiedAt &&
      m.verifiedBy &&
      !failed &&
      delivered &&
      age >= 0 &&
      age < 8 * 86400_000,
    ),
    status: !matches
      ? "UNCONFIGURED"
      : failed
        ? "DELIVERY_FAILED"
        : m.status || "UNVERIFIED",
    sentAt: m.sentAt || null,
    humanVerifiedAt: m.humanVerifiedAt || null,
    providerEvent: transport.providerEvent || "unchecked",
    providerCheckedAt: transport.providerCheckedAt || null,
  };
}

export async function recordMonitorMailAccepted({
  messageId,
  env = process.env,
  now = new Date(),
  prismaClient = prisma,
} = {}) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(messageId || ""))
    throw new Error("notification_message_id_missing");
  const config = routing(env);
  const row = await prismaClient.operationalHeartbeat.upsert({
    where: { key: MONITOR_MAIL_KEY },
    create: { key: MONITOR_MAIL_KEY, metadataJson: { revision: 0 } },
    update: {},
  });
  await replaceReceipt(prismaClient, row, {
    messageId,
    routingFingerprint: config.fingerprint,
    sentAt: now.toISOString(),
    providerEvent: "pending",
    deliveryFailed:
      row.metadataJson.routingFingerprint === config.fingerprint &&
      row.metadataJson.deliveryFailed === true,
    lastDeliveredAt:
      row.metadataJson.routingFingerprint === config.fingerprint
        ? row.metadataJson.lastDeliveredAt || null
        : null,
  });
}

export async function acknowledgeMonitorIncident({
  incidentKey,
  actor,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  if (!actor || !/^[0-9a-f]{24}$/.test(String(incidentKey || "")))
    throw new Error("notification_incident_invalid");
  const current = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: "production_integrity_monitor" },
  });
  if (
    current?.metadataJson?.incidentKey !== incidentKey ||
    current.metadataJson.currentStatus === "healthy"
  )
    throw new Error("notification_incident_changed");
  const row = await prismaClient.operationalHeartbeat.upsert({
    where: { key: MONITOR_ACK_KEY },
    create: { key: MONITOR_ACK_KEY, metadataJson: { revision: 0 } },
    update: {},
  });
  const incidentStartedAt = current.metadataJson.firstDetectedAt;
  if (!Number.isFinite(new Date(incidentStartedAt).getTime()))
    throw new Error("notification_incident_changed");
  if (
    row.metadataJson.incidentKey === incidentKey &&
    row.metadataJson.incidentStartedAt === incidentStartedAt &&
    row.metadataJson.acknowledgedAt
  )
    return { ok: true, responseDueAt: row.metadataJson.responseDueAt };
  const responseDueAt = new Date(now.getTime() + WEEK).toISOString();
  await replaceReceipt(prismaClient, row, {
    incidentKey,
    incidentStartedAt,
    acknowledgedAt: now.toISOString(),
    responseDueAt,
    actor,
  });
  return { ok: true, responseDueAt };
}

export async function getMonitorAcknowledgement({
  incidentKey,
  incidentStartedAt,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const row = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: MONITOR_ACK_KEY },
  });
  const m = row?.metadataJson || {};
  if (!incidentStartedAt) {
    const current = await prismaClient.operationalHeartbeat.findUnique({
      where: { key: "production_integrity_monitor" },
    });
    incidentStartedAt = current?.metadataJson?.firstDetectedAt;
  }
  if (
    !incidentKey ||
    m.incidentKey !== incidentKey ||
    !incidentStartedAt ||
    m.incidentStartedAt !== incidentStartedAt
  )
    return { acknowledged: false, overdue: false };
  return {
    acknowledged: true,
    acknowledgedAt: m.acknowledgedAt,
    responseDueAt: m.responseDueAt,
    overdue: now >= new Date(m.responseDueAt),
  };
}
