import assert from "node:assert/strict";
import test from "node:test";

import { createMarketplaceOperatorAuthorizer } from "../../app/utils/marketplaceOperatorAuthorization.js";
import { MARKETPLACE_OPERATOR_ROLES } from "../../app/utils/marketplaceOperatorRoles.js";

const PRIVACY_HASH_SECRET = "operator-test-secret-0123456789abcdef";

function createPrismaClient(storedSession = null) {
  return {
    session: {
      findUnique: async () => storedSession,
    },
  };
}

function createAuthorizer({
  context,
  storedSession = null,
  env = {},
} = {}) {
  return createMarketplaceOperatorAuthorizer({
    authenticateAdminImpl: async () => context,
    defaultPrismaClient: createPrismaClient(storedSession),
    defaultEnv: {
      PRIVACY_HASH_SECRET,
      ...env,
    },
  });
}

function buildRequest() {
  return new Request("https://example.com/app/production-readiness", {
    headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
  });
}

test("embedded auth accepts an explicitly allowlisted Shopify user ID", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: { id: "offline_primary", shop: "primary.myshopify.com" },
      sessionToken: { sub: "98531410083" },
    },
    env: { MARKETPLACE_ADMIN_USER_IDS: "98531410083" },
  });

  const result = await requireOperator(buildRequest(), {
    role: MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  });

  assert.equal(result.operator.actorKey, "shopify_user:98531410083");
  assert.equal(result.operator.userId, "98531410083");
  assert.equal(
    result.operator.role,
    MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  );
  assert.equal(result.operator.email, null);
  assert.match(result.operator.ipHash, /^[a-f0-9]{64}$/);
});

test("embedded auth denies a Shopify user ID outside the allowlist", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: { id: "offline_primary", shop: "primary.myshopify.com" },
      sessionToken: { sub: "11111111111" },
    },
    env: { MARKETPLACE_ADMIN_USER_IDS: "98531410083" },
  });

  await assert.rejects(
    () => requireOperator(buildRequest()),
    (error) =>
      error instanceof Response &&
      error.status === 403 &&
      error.headers.get("Cache-Control") === "no-store",
  );
});

test("role-specific Shopify user IDs grant only the requested role", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: { id: "offline_primary" },
      sessionToken: { sub: "22222222222" },
    },
    env: {
      RELEASE_MANAGER_USER_IDS: "22222222222",
    },
  });

  const releaseManager = await requireOperator(buildRequest(), {
    role: MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
  });
  assert.equal(
    releaseManager.operator.role,
    MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
  );

  await assert.rejects(
    () =>
      requireOperator(buildRequest(), {
        role: MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
      }),
    (error) => error instanceof Response && error.status === 403,
  );
});

test("existing email allowlists remain supported", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: {
        id: "online_primary",
        onlineAccessInfo: {
          associated_user: {
            id: 33333333333,
            email: "OWNER@EXAMPLE.COM",
            account_owner: false,
          },
        },
      },
      sessionToken: { sub: "33333333333" },
    },
    env: { MARKETPLACE_ADMIN_EMAILS: "owner@example.com" },
  });

  const result = await requireOperator(buildRequest());

  assert.equal(result.operator.email, "owner@example.com");
  assert.equal(result.operator.userId, "33333333333");
});

test("account owners remain authorized when embedded identity is consistent", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: {
        id: "online_primary",
        onlineAccessInfo: {
          associated_user: {
            id: 44444444444,
            email: "owner@example.com",
            account_owner: true,
          },
        },
      },
      sessionToken: { sub: "44444444444" },
    },
  });

  const result = await requireOperator(buildRequest());

  assert.equal(result.operator.accountOwner, true);
  assert.equal(result.operator.actorKey, "shopify_user:44444444444");
});

test("a token and persisted user mismatch fails closed", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: {
        id: "online_primary",
        onlineAccessInfo: {
          associated_user: {
            id: 55555555555,
            email: "owner@example.com",
            account_owner: true,
          },
        },
      },
      sessionToken: { sub: "66666666666" },
    },
    env: {
      MARKETPLACE_ADMIN_USER_IDS: "66666666666",
      MARKETPLACE_ADMIN_EMAILS: "owner@example.com",
    },
  });

  await assert.rejects(
    () => requireOperator(buildRequest()),
    (error) => error instanceof Response && error.status === 403,
  );
});

test("missing embedded and persisted identities fail closed", async () => {
  const requireOperator = createAuthorizer({
    context: {
      session: { id: "offline_primary" },
      sessionToken: {},
    },
  });

  await assert.rejects(
    () => requireOperator(buildRequest()),
    (error) => error instanceof Response && error.status === 403,
  );
});
