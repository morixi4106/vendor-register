import { Resend } from "resend";

import prisma from "../db.server.js";
import {
  EMAIL_MESSAGE_CLASS,
  getEmailClassHoldStatus,
} from "./operationalReadiness.server.js";
import { hashWithdrawalValue } from "./withdrawalCompliance.server.js";

const LOCK_MINUTES = 5;
const MAX_ATTEMPTS = 8;
const TERMINAL_WITHDRAWAL_STATUSES = new Set([
  "REFUNDED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);
const BUYER_MESSAGE_TYPES = new Set([
  "acknowledgement",
  "return_instructions",
  "direct_return_instruction",
  "completion",
]);
const TERMINAL_INVALID_MESSAGE_TYPES = new Set([
  "return_instructions",
  "direct_return_instruction",
  "vendor_notification",
  "direct_return_store_notice",
  "status_update",
  "return_reminder",
]);
const AUTO_CANCELLABLE_HELD_MESSAGE_TYPES = new Set([
  "status_update",
  "return_reminder",
]);
const HELD_EMAIL_REVALIDATION_VERSION = "held-email-release-v2";

function getHeldEmailReleasePriority(item) {
  const messageType = String(item?.messageType || "").toLowerCase();
  if (messageType === "acknowledgement") return 0;
  if (messageType === "completion") return 1;
  if (
    messageType === "return_instructions" ||
    messageType === "direct_return_instruction"
  ) {
    return 2;
  }
  if (
    messageType === "vendor_notification" ||
    messageType === "direct_return_store_notice"
  ) {
    return 3;
  }
  return 4;
}

async function revalidateHeldEmail({
  prismaClient,
  item,
  getEmailClassHoldStatusImpl,
}) {
  const hold = await getEmailClassHoldStatusImpl(item.messageClass, {
    prismaClient,
  });
  if (hold?.active) {
    return { valid: false, retain: true, reason: "email_hold_still_active" };
  }

  const recipient = String(item.recipient || "").trim().toLowerCase();
  const requestStatus = String(
    item.withdrawalRequest?.status || "",
  ).toUpperCase();
  const messageType = String(item.messageType || "").toLowerCase();
  const currentRecipient = String(
    item.withdrawalRequest?.customerEmail || "",
  )
    .trim()
    .toLowerCase();
  if (
    !recipient ||
    !item.templateVersion ||
    !item.subjectSnapshot ||
    !item.textBodySnapshot ||
    !item.htmlBodySnapshot
  ) {
    return { valid: false, retain: false, reason: "email_snapshot_incomplete" };
  }
  if (
    BUYER_MESSAGE_TYPES.has(messageType) &&
    currentRecipient &&
    recipient !== currentRecipient
  ) {
    return { valid: false, retain: false, reason: "recipient_changed" };
  }
  if (
    TERMINAL_WITHDRAWAL_STATUSES.has(requestStatus) &&
    TERMINAL_INVALID_MESSAGE_TYPES.has(messageType)
  ) {
    return {
      valid: false,
      retain: false,
      reason: "withdrawal_already_terminal",
    };
  }
  if (
    messageType === "completion" &&
    !TERMINAL_WITHDRAWAL_STATUSES.has(requestStatus)
  ) {
    return {
      valid: false,
      retain: false,
      reason: "completion_state_not_reached",
    };
  }

  if (prismaClient?.withdrawalEmailLog?.findFirst) {
    const alreadySent = await prismaClient.withdrawalEmailLog.findFirst({
      where: {
        withdrawalRequestId: item.withdrawalRequestId,
        emailType: item.messageType,
        toEmail: item.recipient,
        subject: item.subjectSnapshot,
        status: "sent",
      },
      select: { id: true },
    });
    if (alreadySent) {
      return {
        valid: false,
        retain: false,
        reason: "equivalent_email_already_sent",
      };
    }
  }

  return { valid: true, retain: false, reason: null };
}

export async function processWithdrawalEmailOutbox({
  prismaClient = prisma,
  limit = 10,
  getEmailClassHoldStatusImpl = getEmailClassHoldStatus,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const recovered = await releaseRecoveredHeldWithdrawalEmails({
    prismaClient,
    limit: boundedLimit,
  });
  const results = [];

  for (let index = 0; index < boundedLimit; index += 1) {
    const item = await claimNextOutboxItem(prismaClient, {
      getEmailClassHoldStatusImpl,
    });
    if (!item) break;
    if (item.__held === true) {
      results.push({
        ok: true,
        held: true,
        id: item.id,
        messageClass: item.messageClass,
      });
    } else {
      results.push(await deliverOutboxItem({ prismaClient, item }));
    }
  }

  return {
    ok: results.every((result) => result.ok),
    processed: results.length,
    sent: results.filter((result) => result.ok && !result.held).length,
    held: results.filter((result) => result.held).length,
    failed: results.filter((result) => !result.ok).length,
    releasedFromRecoveredHold: recovered.released,
    results,
  };
}

async function releaseRecoveredHeldWithdrawalEmails({
  prismaClient,
  limit,
  now = new Date(),
}) {
  if (
    !prismaClient?.withdrawalEmailOutbox?.findFirst ||
    !prismaClient?.operationalControl?.findUnique
  ) {
    return { released: 0 };
  }
  const candidate = await prismaClient.withdrawalEmailOutbox.findFirst({
    where: {
      status: "HELD",
      heldByControlId: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: {
      heldByControlId: true,
      messageClass: true,
    },
  });
  if (!candidate?.heldByControlId) return { released: 0 };
  const control = await prismaClient.operationalControl.findUnique({
    where: { id: candidate.heldByControlId },
    select: {
      state: true,
      recoveredByUserId: true,
    },
  });
  if (control?.state !== "RECOVERED" || !control.recoveredByUserId) {
    return { released: 0 };
  }
  return releaseHeldWithdrawalEmails({
    prismaClient,
    messageClasses: [
      candidate.messageClass || EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL,
    ],
    approvedBy: control.recoveredByUserId,
    controlId: candidate.heldByControlId,
    limit,
    now,
  });
}

export async function claimNextOutboxItem(
  prismaClient,
  {
    getEmailClassHoldStatusImpl = getEmailClassHoldStatus,
    now = new Date(),
  } = {},
) {
  const run = async (tx) => {
    const candidate = await tx.withdrawalEmailOutbox.findFirst({
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

    const messageClass =
      candidate.messageClass || EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL;
    const hold = await getEmailClassHoldStatusImpl(messageClass, {
      prismaClient: tx,
    });
    const claimWhere = {
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
    };

    if (hold?.active) {
      const held = await tx.withdrawalEmailOutbox.updateMany({
        where: claimWhere,
        data: {
          status: "HELD",
          messageClass,
          heldByControlId: hold.control?.id || null,
          holdReason: hold.reason || `${messageClass.toLowerCase()}_hold_active`,
          heldAt: now,
          lockedUntil: null,
        },
      });
      if (held.count !== 1) return null;
      const item = await tx.withdrawalEmailOutbox.findUnique({
        where: { id: candidate.id },
      });
      return item ? { ...item, __held: true } : null;
    }

    const claimed = await tx.withdrawalEmailOutbox.updateMany({
      where: claimWhere,
      data: {
        status: "PROCESSING",
        messageClass,
        lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000),
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    return tx.withdrawalEmailOutbox.findUnique({
      where: { id: candidate.id },
    });
  };

  return typeof prismaClient.$transaction === "function"
    ? prismaClient.$transaction(run)
    : run(prismaClient);
}

export async function releaseHeldWithdrawalEmails({
  prismaClient = prisma,
  messageClasses = [EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL],
  approvedBy,
  controlId = null,
  limit = 100,
  now = new Date(),
  getEmailClassHoldStatusImpl = getEmailClassHoldStatus,
} = {}) {
  if (!prismaClient?.withdrawalEmailOutbox?.findMany) {
    return {
      ok: true,
      available: false,
      selected: 0,
      released: 0,
      failed: 0,
      hasMore: false,
      results: [],
    };
  }
  const normalizedClasses = Array.from(
    new Set(
      messageClasses
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  const normalizedApprover = String(approvedBy || "").trim();
  if (!normalizedApprover || normalizedClasses.length === 0) {
    return { ok: false, reason: "approver_and_message_class_required" };
  }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const candidates = await prismaClient.withdrawalEmailOutbox.findMany({
    where: {
      status: "HELD",
      messageClass: { in: normalizedClasses },
      ...(controlId ? { heldByControlId: controlId } : {}),
    },
    orderBy: [{ createdAt: "asc" }],
    take: Math.min(boundedLimit * 3, 300),
    include: {
      withdrawalRequest: {
        select: {
          id: true,
          customerEmail: true,
          status: true,
          progressStatus: true,
          outcomeStatus: true,
          completionStatus: true,
          marketplaceOrder: {
            select: {
              financialStatus: true,
              fulfillmentStatus: true,
            },
          },
        },
      },
    },
  });
  candidates.sort((left, right) => {
    const priority =
      getHeldEmailReleasePriority(left) - getHeldEmailReleasePriority(right);
    if (priority !== 0) return priority;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
  const selectedCandidates = candidates.slice(0, boundedLimit);
  const results = [];

  for (const [index, item] of selectedCandidates.entries()) {
    let validation;
    try {
      validation = await revalidateHeldEmail({
        prismaClient,
        item,
        getEmailClassHoldStatusImpl,
      });
    } catch {
      results.push({
        id: item.id,
        ok: false,
        released: false,
        reason: "held_email_revalidation_failed",
      });
      continue;
    }
    if (!validation.valid && validation.retain) {
      results.push({
        id: item.id,
        ok: false,
        released: false,
        reason: validation.reason,
      });
      continue;
    }
    if (!validation.valid) {
      const messageType = String(item.messageType || "").toLowerCase();
      if (!AUTO_CANCELLABLE_HELD_MESSAGE_TYPES.has(messageType)) {
        results.push({
          id: item.id,
          ok: false,
          released: false,
          reason: validation.reason,
        });
        continue;
      }
      const request = item.withdrawalRequest || null;
      const cancelled = await prismaClient.withdrawalEmailOutbox.updateMany({
        where: { id: item.id, status: "HELD" },
        data: {
          status: "CANCELLED",
          holdReason: validation.reason,
          lockedUntil: null,
          cancelledAt: now,
          cancelReasonCode: validation.reason,
          cancellationAuditJson: {
            evaluatedStateVersion: HELD_EMAIL_REVALIDATION_VERSION,
            evaluatedAt: now.toISOString(),
            relatedRequestStatus: request?.status || null,
            relatedRequestProgressStatus: request?.progressStatus || null,
            relatedRequestOutcomeStatus: request?.outcomeStatus || null,
            relatedRequestCompletionStatus: request?.completionStatus || null,
            relatedOrderStatus: {
              financialStatus:
                request?.marketplaceOrder?.financialStatus || null,
              fulfillmentStatus:
                request?.marketplaceOrder?.fulfillmentStatus || null,
            },
            templateVersion: item.templateVersion || null,
            operationalControlId:
              controlId || item.heldByControlId || null,
            approvedBy: normalizedApprover,
          },
          releaseApprovedById: normalizedApprover,
          lastErrorCode: validation.reason,
        },
      });
      results.push({
        id: item.id,
        ok: cancelled.count === 1,
        released: false,
        cancelled: cancelled.count === 1,
        reason: validation.reason,
      });
      continue;
    }

    const updated = await prismaClient.withdrawalEmailOutbox.updateMany({
      where: { id: item.id, status: "HELD" },
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(now.getTime() + index * 250),
        heldByControlId: null,
        holdReason: null,
        lockedUntil: null,
        releasedAt: now,
        releaseApprovedById: normalizedApprover,
      },
    });
    results.push({
      id: item.id,
      ok: updated.count === 1,
      released: updated.count === 1,
      reason: updated.count === 1 ? null : "held_email_changed_concurrently",
    });
  }

  return {
    ok: results.every((result) => result.ok),
    selected: selectedCandidates.length,
    released: results.filter((result) => result.released).length,
    cancelled: results.filter((result) => result.cancelled).length,
    failed: results.filter((result) => !result.ok).length,
    hasMore: candidates.length > selectedCandidates.length,
    results,
  };
}

export async function holdWithdrawalEmailSnapshot({
  prismaClient = prisma,
  withdrawalRequest,
  emailType,
  recipient,
  sender,
  subject,
  text,
  html,
  locale = null,
  templateVersion = null,
  holdStatus = null,
  now = new Date(),
} = {}) {
  if (
    !withdrawalRequest?.id ||
    !recipient ||
    !subject ||
    !text ||
    !html
  ) {
    return { ok: false, reason: "held_email_snapshot_incomplete" };
  }
  const messageClass = EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL;
  const renderedContentHash = hashWithdrawalValue({
    recipient,
    subject,
    text,
    html,
  });
  const idempotencyKey = `withdrawal-email:${withdrawalRequest.id}:${emailType}:${renderedContentHash}`;
  const eventKey = `email-held:${idempotencyKey}`;

  const run = async (tx) => {
    const event = await tx.withdrawalEvent.upsert({
      where: { idempotencyKey: eventKey },
      create: {
        withdrawalRequestId: withdrawalRequest.id,
        type: "EMAIL_HELD",
        actorType: "SYSTEM",
        payloadJson: {
          emailType,
          messageClass,
          holdReason: holdStatus?.reason || null,
        },
        payloadHash: renderedContentHash,
        idempotencyKey: eventKey,
      },
      update: {},
    });
    const outbox = await tx.withdrawalEmailOutbox.upsert({
      where: { idempotencyKey },
      create: {
        withdrawalRequestId: withdrawalRequest.id,
        withdrawalEventId: event.id,
        messageType: emailType,
        messageClass,
        recipient,
        sender,
        locale:
          locale ||
          withdrawalRequest.correspondenceLocale ||
          withdrawalRequest.locale ||
          "ja",
        templateVersion: templateVersion || `withdrawal-${emailType}-v1`,
        subjectSnapshot: subject,
        textBodySnapshot: text,
        htmlBodySnapshot: html,
        renderedContentHash,
        idempotencyKey,
        status: "HELD",
        heldByControlId: holdStatus?.control?.id || null,
        holdReason:
          holdStatus?.reason || "legal_transactional_email_hold_active",
        heldAt: now,
      },
      update: {},
    });
    return { event, outbox };
  };
  const stored =
    typeof prismaClient.$transaction === "function"
      ? await prismaClient.$transaction(run)
      : await run(prismaClient);

  return {
    ok: true,
    queued: true,
    held: true,
    outboxId: stored.outbox.id,
  };
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
    messageClass: EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL,
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
