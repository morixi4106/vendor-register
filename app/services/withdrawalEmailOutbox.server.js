import { Resend } from "resend";

import prisma from "../db.server.js";
import { hashWithdrawalValue } from "./withdrawalCompliance.server.js";

const LOCK_MINUTES = 5;
const MAX_ATTEMPTS = 8;

export async function processWithdrawalEmailOutbox({
  prismaClient = prisma,
  limit = 10,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const results = [];

  for (let index = 0; index < boundedLimit; index += 1) {
    const item = await claimNextOutboxItem(prismaClient);
    if (!item) break;
    results.push(await deliverOutboxItem({ prismaClient, item }));
  }

  return {
    ok: results.every((result) => result.ok),
    processed: results.length,
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export async function claimNextOutboxItem(prismaClient) {
  const now = new Date();
  const candidate = await prismaClient.withdrawalEmailOutbox.findFirst({
    where: {
      OR: [
        {
          status: { in: ["PENDING", "FAILED"] },
          nextAttemptAt: { lte: now },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        {
          status: "PROCESSING",
          lockedUntil: { lt: now },
        },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
  });
  if (!candidate) return null;

  const claimed = await prismaClient.withdrawalEmailOutbox.updateMany({
    where: {
      id: candidate.id,
      OR: [
        {
          status: { in: ["PENDING", "FAILED"] },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        {
          status: "PROCESSING",
          lockedUntil: { lt: now },
        },
      ],
    },
    data: {
      status: "PROCESSING",
      lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000),
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  return prismaClient.withdrawalEmailOutbox.findUnique({ where: { id: candidate.id } });
}

async function deliverOutboxItem({ prismaClient, item }) {
  const from = item.sender || getWithdrawalFromEmail();
  const now = new Date();

  try {
    if (!process.env.RESEND_API_KEY || !from || !item.recipient) {
      throw new Error("email_not_configured");
    }
    const response = await new Resend(process.env.RESEND_API_KEY).emails.send(
      {
        from,
        to: item.recipient,
        subject: item.subjectSnapshot,
        text: item.textBodySnapshot,
        html: item.htmlBodySnapshot,
      },
      { idempotencyKey: item.idempotencyKey },
    );
    if (response?.error) {
      throw new Error(response.error.message || response.error.name || "resend_error");
    }

    const providerMessageId = response?.data?.id || response?.id || null;
    await prismaClient.$transaction(async (tx) => {
      await tx.withdrawalEmailOutbox.update({
        where: { id: item.id },
        data: {
          status: "SENT",
          sentAt: now,
          providerMessageId,
          lockedUntil: null,
          lastErrorCode: null,
        },
      });
      await tx.withdrawalEmailLog.create({
        data: {
          withdrawalRequestId: item.withdrawalRequestId,
          emailType: item.messageType,
          toEmail: item.recipient,
          fromEmail: from,
          subject: item.subjectSnapshot,
          bodyText: item.textBodySnapshot,
          bodyHtml: item.htmlBodySnapshot,
          providerMessageId,
          status: "sent",
          sentAt: now,
        },
      });
      if (item.messageType === "acknowledgement") {
        const current = await tx.withdrawalRequest.findUnique({
          where: { id: item.withdrawalRequestId },
          select: { status: true },
        });
        await tx.withdrawalRequest.update({
          where: { id: item.withdrawalRequestId },
          data: {
            status: current?.status === "REQUESTED" ? "ACKNOWLEDGED" : current?.status,
            confirmationSentAt: now,
            confirmationEmailMessageId: providerMessageId,
            durableMediumEmailJson: {
              emailType: item.messageType,
              toEmail: item.recipient,
              subject: item.subjectSnapshot,
              bodyText: item.textBodySnapshot,
              contentHash: item.renderedContentHash,
              sentAt: now.toISOString(),
              providerMessageId,
            },
          },
        });
        if (current?.status === "REQUESTED") {
          await tx.withdrawalRequestStatusHistory.create({
            data: {
              withdrawalRequestId: item.withdrawalRequestId,
              fromStatus: "REQUESTED",
              toStatus: "ACKNOWLEDGED",
              changedBy: "system",
              reason: "acknowledgement_email_sent",
            },
          });
        }
      }
      await createEventIfSupported(tx, {
        withdrawalRequestId: item.withdrawalRequestId,
        type: "EMAIL_SENT",
        actorType: "SYSTEM",
        payloadJson: { outboxId: item.id, messageType: item.messageType, providerMessageId },
        idempotencyKey: `email-sent:${item.id}`,
      });
    });
    return { ok: true, id: item.id, providerMessageId };
  } catch (error) {
    const message = String(error?.message || error || "email_delivery_failed").slice(0, 500);
    const deadLetter = Number(item.attemptCount || 0) >= MAX_ATTEMPTS;
    const retryDelayMinutes = Math.min(24 * 60, 2 ** Math.max(1, item.attemptCount || 1));
    await prismaClient.$transaction(async (tx) => {
      await tx.withdrawalEmailOutbox.update({
        where: { id: item.id },
        data: {
          status: deadLetter ? "DEAD_LETTER" : "FAILED",
          nextAttemptAt: new Date(now.getTime() + retryDelayMinutes * 60 * 1000),
          lockedUntil: null,
          lastErrorCode: message,
          deadLetteredAt: deadLetter ? now : null,
        },
      });
      await tx.withdrawalEmailLog.create({
        data: {
          withdrawalRequestId: item.withdrawalRequestId,
          emailType: item.messageType,
          toEmail: item.recipient,
          fromEmail: from,
          subject: item.subjectSnapshot,
          bodyText: item.textBodySnapshot,
          bodyHtml: item.htmlBodySnapshot,
          status: "failed",
          errorMessage: message,
        },
      });
    });
    return { ok: false, id: item.id, error: message, deadLetter };
  }
}

export function buildWithdrawalOutboxRecord({
  withdrawalRequest,
  withdrawalEventId,
  email,
} = {}) {
  const renderedContentHash = hashWithdrawalValue({
    recipient: withdrawalRequest.customerEmail,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  return {
    withdrawalRequestId: withdrawalRequest.id,
    withdrawalEventId,
    messageType: "acknowledgement",
    recipient: withdrawalRequest.customerEmail,
    sender: getWithdrawalFromEmail(),
    locale: email.locale,
    templateVersion: "withdrawal-ack-v3",
    subjectSnapshot: email.subject,
    textBodySnapshot: email.text,
    htmlBodySnapshot: email.html,
    renderedContentHash,
    idempotencyKey: `withdrawal-ack:${withdrawalRequest.id}`,
  };
}

async function createEventIfSupported(tx, data) {
  if (!tx.withdrawalEvent?.create) return null;
  return tx.withdrawalEvent.create({ data });
}

function getWithdrawalFromEmail() {
  return (
    process.env.WITHDRAWAL_FROM_EMAIL ||
    process.env.MAIL_FROM ||
    process.env.ADMIN_EMAIL ||
    null
  );
}
