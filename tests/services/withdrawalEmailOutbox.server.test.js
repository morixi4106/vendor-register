import assert from "node:assert/strict";
import test from "node:test";

import { claimNextOutboxItem } from "../../app/services/withdrawalEmailOutbox.server.js";

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
