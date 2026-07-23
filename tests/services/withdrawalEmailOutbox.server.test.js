import assert from "node:assert/strict";
import test from "node:test";

import {
  claimNextOutboxItem,
  processWithdrawalEmailOutbox,
  releaseHeldWithdrawalEmails,
} from "../../app/services/withdrawalEmailOutbox.server.js";

test("expired PROCESSING withdrawal email is reclaimed", async () => {
  const item = {
    id: "outbox-1",
    status: "PROCESSING",
    attemptCount: 1,
    lockedUntil: new Date(Date.now() - 60_000),
    nextAttemptAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 120_000),
  };
  let findWhere = null;
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findFirst({ where }) {
        findWhere = where;
        return item;
      },
      async updateMany({ data }) {
        item.status = data.status;
        item.lockedUntil = data.lockedUntil;
        item.attemptCount += 1;
        return { count: 1 };
      },
      async findUnique() {
        return item;
      },
    },
  };

  const claimed = await claimNextOutboxItem(prismaClient);

  assert.equal(claimed.id, "outbox-1");
  assert.equal(claimed.status, "PROCESSING");
  assert.equal(claimed.attemptCount, 2);
  assert.ok(claimed.lockedUntil > new Date());
  assert.ok(
    findWhere.OR.some(
      (condition) => condition.status === "PROCESSING" && condition.lockedUntil?.lt,
    ),
  );
});

test("automation hold does not pause legal withdrawal email", async () => {
  const item = {
    id: "outbox-legal",
    messageClass: "LEGAL_TRANSACTIONAL",
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: new Date(Date.now() - 1_000),
    lockedUntil: null,
    createdAt: new Date(Date.now() - 2_000),
  };
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findFirst() {
        return item;
      },
      async updateMany({ data }) {
        const { attemptCount, ...values } = data;
        Object.assign(item, values);
        if (attemptCount?.increment) item.attemptCount += 1;
        return { count: 1 };
      },
      async findUnique() {
        return item;
      },
    },
  };

  const claimed = await claimNextOutboxItem(prismaClient, {
    getEmailClassHoldStatusImpl: async (messageClass) => ({
      active: messageClass === "AUTOMATION",
    }),
  });

  assert.equal(claimed.status, "PROCESSING");
  assert.equal(claimed.__held, undefined);
});

test("legal email hold moves matching outbox item to HELD", async () => {
  const item = {
    id: "outbox-held",
    messageClass: "LEGAL_TRANSACTIONAL",
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: new Date(Date.now() - 1_000),
    lockedUntil: null,
    createdAt: new Date(Date.now() - 2_000),
  };
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findFirst() {
        return item.status === "PENDING" ? item : null;
      },
      async updateMany({ data }) {
        Object.assign(item, data);
        return { count: 1 };
      },
      async findUnique() {
        return item;
      },
    },
  };

  const result = await processWithdrawalEmailOutbox({
    prismaClient,
    limit: 1,
    getEmailClassHoldStatusImpl: async () => ({
      active: true,
      reason: "legal_template_incident",
      control: { id: "control-1" },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.processed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.held, 1);
  assert.equal(item.status, "HELD");
  assert.equal(item.heldByControlId, "control-1");
});

test("held withdrawal emails are released in bounded batches after revalidation", async () => {
  const items = [
    {
      id: "held-1",
      status: "HELD",
      messageClass: "LEGAL_TRANSACTIONAL",
      messageType: "acknowledgement",
      recipient: "buyer@example.com",
      templateVersion: "withdrawal-ack-v3",
      subjectSnapshot: "subject",
      textBodySnapshot: "text",
      htmlBodySnapshot: "<p>text</p>",
      createdAt: new Date("2026-07-22T00:00:00Z"),
      withdrawalRequest: {
        id: "withdrawal-1",
        customerEmail: "buyer@example.com",
        status: "ACKNOWLEDGED",
      },
    },
  ];
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findMany({ take }) {
        assert.equal(take, 3);
        return items;
      },
      async updateMany({ data }) {
        Object.assign(items[0], data);
        return { count: 1 };
      },
    },
  };

  const result = await releaseHeldWithdrawalEmails({
    prismaClient,
    messageClasses: ["LEGAL_TRANSACTIONAL"],
    approvedBy: "operator-2",
    limit: 1,
    now: new Date("2026-07-23T00:00:00Z"),
    getEmailClassHoldStatusImpl: async () => ({ active: false }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.released, 1);
  assert.equal(result.hasMore, false);
  assert.equal(items[0].status, "PENDING");
  assert.equal(items[0].releaseApprovedById, "operator-2");
});

test("held return instructions stay held after the withdrawal becomes terminal", async () => {
  const item = {
    id: "held-terminal",
    withdrawalRequestId: "withdrawal-terminal",
    messageType: "return_instructions",
    messageClass: "LEGAL_TRANSACTIONAL",
    status: "HELD",
    recipient: "buyer@example.com",
    templateVersion: "return-v1",
    subjectSnapshot: "return",
    textBodySnapshot: "return",
    htmlBodySnapshot: "<p>return</p>",
    createdAt: new Date("2026-07-22T00:00:00Z"),
    withdrawalRequest: {
      id: "withdrawal-terminal",
      customerEmail: "buyer@example.com",
      status: "REFUNDED",
    },
  };
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findMany() {
        return [item];
      },
      async updateMany({ data }) {
        Object.assign(item, data);
        return { count: 1 };
      },
    },
  };

  const result = await releaseHeldWithdrawalEmails({
    prismaClient,
    approvedBy: "operator-2",
    getEmailClassHoldStatusImpl: async () => ({ active: false }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.released, 0);
  assert.equal(item.status, "HELD");
  assert.equal(result.results[0].reason, "withdrawal_already_terminal");
});

test("only allowlisted low-risk held messages are auto-cancelled with audit data", async () => {
  const now = new Date("2026-07-24T03:00:00.000Z");
  const item = {
    id: "held-reminder",
    withdrawalRequestId: "withdrawal-terminal",
    messageType: "return_reminder",
    messageClass: "LEGAL_TRANSACTIONAL",
    recipient: "buyer@example.com",
    templateVersion: "return-reminder-v1",
    subjectSnapshot: "Return reminder",
    textBodySnapshot: "Return reminder",
    htmlBodySnapshot: "<p>Return reminder</p>",
    status: "HELD",
    heldByControlId: "control-1",
    createdAt: new Date("2026-07-24T01:00:00.000Z"),
    withdrawalRequest: {
      id: "withdrawal-terminal",
      customerEmail: "buyer@example.com",
      status: "REFUNDED",
      progressStatus: "COMPLETED",
      outcomeStatus: "FULL_REFUND",
      completionStatus: "REFUNDED",
      marketplaceOrder: {
        financialStatus: "refunded",
        fulfillmentStatus: "fulfilled",
      },
    },
  };
  let cancellationData = null;
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findMany() {
        return [item];
      },
      async updateMany({ data }) {
        cancellationData = data;
        item.status = data.status;
        return { count: 1 };
      },
    },
  };

  const result = await releaseHeldWithdrawalEmails({
    prismaClient,
    approvedBy: "operator@example.com",
    now,
    getEmailClassHoldStatusImpl: async () => ({ active: false }),
  });

  assert.equal(result.ok, true);
  assert.equal(item.status, "CANCELLED");
  assert.equal(cancellationData.cancelReasonCode, "withdrawal_already_terminal");
  assert.equal(cancellationData.cancelledAt.toISOString(), now.toISOString());
  assert.equal(
    cancellationData.cancellationAuditJson.relatedRequestStatus,
    "REFUNDED",
  );
  assert.equal(
    cancellationData.cancellationAuditJson.relatedOrderStatus.financialStatus,
    "refunded",
  );
  assert.equal(
    cancellationData.cancellationAuditJson.operationalControlId,
    "control-1",
  );
});

test("held email revalidation errors keep the message held", async () => {
  const item = {
    id: "held-error",
    withdrawalRequestId: "withdrawal-1",
    messageType: "status_update",
    messageClass: "LEGAL_TRANSACTIONAL",
    status: "HELD",
    createdAt: new Date(),
    withdrawalRequest: {
      id: "withdrawal-1",
      customerEmail: "buyer@example.com",
      status: "REQUESTED",
    },
  };
  let updates = 0;
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findMany() {
        return [item];
      },
      async updateMany() {
        updates += 1;
        return { count: 1 };
      },
    },
  };

  const result = await releaseHeldWithdrawalEmails({
    prismaClient,
    approvedBy: "operator@example.com",
    getEmailClassHoldStatusImpl: async () => {
      throw new Error("database unavailable");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(updates, 0);
  assert.equal(item.status, "HELD");
  assert.equal(result.results[0].reason, "held_email_revalidation_failed");
});

test("held email remains held when its class hold is still active", async () => {
  const item = {
    id: "held-active",
    withdrawalRequestId: "withdrawal-active",
    messageType: "acknowledgement",
    messageClass: "LEGAL_TRANSACTIONAL",
    status: "HELD",
    recipient: "buyer@example.com",
    templateVersion: "ack-v1",
    subjectSnapshot: "received",
    textBodySnapshot: "received",
    htmlBodySnapshot: "<p>received</p>",
    createdAt: new Date("2026-07-22T00:00:00Z"),
    withdrawalRequest: {
      id: "withdrawal-active",
      customerEmail: "buyer@example.com",
      status: "REQUESTED",
    },
  };
  let updateCount = 0;
  const prismaClient = {
    withdrawalEmailOutbox: {
      async findMany() {
        return [item];
      },
      async updateMany() {
        updateCount += 1;
        return { count: 1 };
      },
    },
  };

  const result = await releaseHeldWithdrawalEmails({
    prismaClient,
    approvedBy: "operator-2",
    getEmailClassHoldStatusImpl: async () => ({ active: true }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.released, 0);
  assert.equal(updateCount, 0);
  assert.equal(item.status, "HELD");
  assert.equal(result.results[0].reason, "email_hold_still_active");
});
