import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareCheckoutAuthorizationPlan,
  assertCheckoutAuthorizationPlan,
  persistAuthorizedCheckoutCases,
} from "../../app/services/internationalCheckoutAuthorizationPlan.server.js";
import { checkoutInventoryFixture } from "../helpers/internationalCheckoutFixture.js";
import { collectInternationalCheckoutInventory } from "../../app/services/internationalCheckoutInventory.server.js";
import { internationalScopeHash } from "../../app/services/internationalGateProjection.server.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";

function fixture() {
  const inventory = checkoutInventoryFixture();
  return {
    shopDomain: "plan.myshopify.com",
    generation: 2,
    sourceHash: "a".repeat(64),
    input: {
      purpose: "VERIFY",
      verificationKind: "NON_FINANCIAL",
      scope: inventory.scope,
      scopeHash: internationalScopeHash(inventory.scope, ["JPY"]),
      currencies: ["JPY"],
    },
    context: {
      releaseBinding: "b".repeat(64),
      nativeConfigHash: "c".repeat(64),
      native: {
        available: true,
        validationReady: true,
        configHash: "c".repeat(64),
        verificationInventory: collectInternationalCheckoutInventory(inventory),
      },
      checkoutDescriptor: {
        runnerDigest: "d".repeat(64),
        environment: "ISOLATED_STORE",
      },
    },
  };
}
test("server authorization snapshot binds every checkout case and executor without another migration", async () => {
  const f = fixture(),
    prepared = prepareCheckoutAuthorizationPlan(f);
  assert.equal(prepared.summary.caseCount, 5);
  assertCheckoutAuthorizationPlan(
    prepareCheckoutAuthorizationPlan(f),
    prepared.summary,
  );
  let stored;
  await persistAuthorizedCheckoutCases(
    {
      internationalCheckoutVerificationCase: {
        createMany: async ({ data }) => {
          stored = data;
        },
      },
    },
    { id: "run", shopDomain: f.shopDomain },
    prepared,
  );
  assert.equal(stored.length, 5);
  assert.deepEqual(
    stored.map((r) => r.ordinal),
    [0, 1, 2, 3, 4],
  );
  assert.ok(
    stored.every(
      (r) =>
        r.runId === "run" &&
        r.shopDomain === f.shopDomain &&
        proofHash(r.expectedJson) === r.caseKey,
    ),
  );
});
for (const mutation of [
  (f) => {
    f.sourceHash = "e".repeat(64);
  },
  (f) => {
    f.generation++;
  },
  (f) => {
    f.context.checkoutDescriptor.runnerDigest = "e".repeat(64);
  },
  (f) => {
    f.context.checkoutDescriptor.environment = "LIVE_STORE";
  },
  (f) => {
    f.context.native.verificationInventory[0].routes[0].methodId = "different";
  },
])
  test(`preview rejects changed server plan: ${mutation.toString()}`, () => {
    const f = fixture(),
      pinned = prepareCheckoutAuthorizationPlan(f).summary;
    mutation(f);
    assert.throws(() =>
      assertCheckoutAuthorizationPlan(
        prepareCheckoutAuthorizationPlan(f),
        pinned,
      ),
    );
  });
test("financial, missing native, arbitrary descriptor fields and caller supplied fake scope do not authorize", () => {
  for (const mutation of [
    (f) => {
      f.input.verificationKind = "FINANCIAL";
    },
    (f) => {
      f.context.native = null;
    },
    (f) => {
      f.context.checkoutDescriptor.url = "https://example.test";
    },
    (f) => {
      f.context.nativeConfigHash = "e".repeat(64);
    },
    (f) => {
      f.input.scopeHash = "e".repeat(64);
    },
  ]) {
    const f = fixture();
    mutation(f);
    assert.throws(() => prepareCheckoutAuthorizationPlan(f));
  }
  assert.equal(
    prepareCheckoutAuthorizationPlan({ input: { purpose: "SALE" } }),
    null,
  );
});

test("authorization rejects browser-incompatible scope before returning an approvable preview", () => {
  const f = fixture();
  const template = f.context.native.verificationInventory[0].routes[0];
  const routes = (count) =>
    Array.from({ length: count }, (_, index) => ({
      ...template,
      methodId: `method-${index}`,
    }));
  f.context.native.verificationInventory[0].routes = routes(127);
  assert.equal(prepareCheckoutAuthorizationPlan(f).summary.caseCount, 383);
  f.context.native.verificationInventory[0].routes = routes(128);
  assert.throws(
    () => prepareCheckoutAuthorizationPlan(f),
    (e) => e.code === "international_checkout_session_limit",
  );
});
