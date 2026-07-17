import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectPublicEndpointRateLimit,
  pruneExpiredPublicEndpointRateLimits,
} from "../../app/services/publicEndpointRateLimit.server.js";

test("rate limit inspection does not create a record and blocks at the limit", async () => {
  let receivedWhere = null;
  const prismaClient = {
    publicEndpointRateLimit: {
      async findUnique({ where }) {
        receivedWhere = where;
        return { count: 100 };
      },
    },
  };

  const result = await inspectPublicEndpointRateLimit({
    endpoint: "contact-ai",
    key: "global:hour",
    limit: 100,
    windowMs: 60 * 60 * 1000,
    now: new Date("2026-07-17T00:30:00.000Z"),
    prismaClient,
  });

  assert.equal(result.ok, false);
  assert.equal(result.count, 100);
  assert.equal(
    receivedWhere.endpoint_keyHash_windowStart.endpoint,
    "contact-ai",
  );
});

test("expired public rate limit records can be pruned", async () => {
  let receivedWhere = null;
  const prismaClient = {
    publicEndpointRateLimit: {
      async deleteMany({ where }) {
        receivedWhere = where;
        return { count: 3 };
      },
    },
  };
  const now = new Date("2026-07-17T00:30:00.000Z");

  const result = await pruneExpiredPublicEndpointRateLimits({
    prismaClient,
    now,
  });

  assert.equal(result.count, 3);
  assert.deepEqual(receivedWhere, { expiresAt: { lt: now } });
});
