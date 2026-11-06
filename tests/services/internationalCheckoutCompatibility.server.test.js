import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectInternationalCheckoutCompatibility,
  CHECKOUT_COMPATIBILITY_QUERY,
} from "../../app/services/internationalCheckoutCompatibility.server.js";
import { dispatchInternationalRunnerAdmin } from "../../app/services/internationalRunnerAdmin.server.js";
import { inspectInternationalAuthorizationCapability } from "../../app/services/internationalAuthorizationPolicy.server.js";

const shopDomain = "compatibility.myshopify.com";
const fixture = (plus = false, development = false) => ({
  data: {
    shop: {
      myshopifyDomain: shopDomain,
      plan: { shopifyPlus: plus, partnerDevelopment: development },
    },
  },
});
const inspect = (response) =>
  inspectInternationalCheckoutCompatibility({
    shopDomain,
    graphQL: async () => response,
  });

test("fixed read-only plan query binds the authenticated shop and never declares verification or sale readiness", async () => {
  for (const plus of [true, false])
    for (const development of [true, false]) {
      let calls = 0;
      const result = await inspectInternationalCheckoutCompatibility({
        shopDomain,
        graphQL: async (args) => {
          calls++;
          assert.equal(args.shopDomain, shopDomain);
          assert.equal(args.query, CHECKOUT_COMPATIBILITY_QUERY);
          assert.deepEqual(args.variables, {});
          assert.equal(args.timeoutMs, 5000);
          assert.ok(args.signal instanceof AbortSignal);
          assert.ok(!/mutation|customer|order|checkoutUrl/i.test(args.query));
          return fixture(plus, development);
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.plan, plus ? "PLUS" : "NON_PLUS");
      assert.equal(result.developmentStore, development);
      assert.equal(result.status, "OBSERVED");
      assert.equal(result.readOnly, true);
      assert.equal(result.verificationReady, false);
      assert.equal(result.saleReady, false);
      assert.equal(
        Date.parse(result.expiresAt) - Date.parse(result.observedAt),
        300000,
      );
      const ui = result.paths.find((row) => row.id === "CHECKOUT_UI_EXTENSION");
      assert.equal(ui.status, plus ? "UNVERIFIED" : "UNAVAILABLE");
      assert.ok(
        result.paths.every(
          (row) => !["READY", "QUALIFIED", "PASSED"].includes(row.status),
        ),
      );
    }
});

test("partial, wrong-tenant, oversized and malformed plan data are unavailable, never false non-Plus evidence", async () => {
  for (const mutate of [
    (row) => {
      row.errors = [{ message: "private canary" }];
    },
    (row) => {
      row.errors = "private canary";
    },
    (row) => {
      row.data.shop.myshopifyDomain = "other.myshopify.com";
    },
    (row) => {
      row.data.shop.plan.shopifyPlus = "true";
    },
    (row) => {
      delete row.data.shop.plan.partnerDevelopment;
    },
    (row) => {
      row.extra = "private canary".repeat(1000);
    },
    (row) => {
      row.data.shop = null;
    },
  ]) {
    const value = fixture(true);
    mutate(value);
    const result = await inspect(value);
    assert.equal(result.plan, "UNVERIFIED");
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.developmentStore, null);
    assert.equal(result.verificationReady, false);
    assert.ok(!JSON.stringify(result).includes("canary"));
  }
});

test("transport exceptions are sanitized and no customer data or raw provider content escapes", async () => {
  const result = await inspectInternationalCheckoutCompatibility({
    shopDomain,
    graphQL: async () => {
      throw new Error("private access token canary");
    },
  });
  assert.equal(result.status, "UNAVAILABLE");
  assert.ok(!JSON.stringify(result).includes("canary"));
  await assert.rejects(
    inspectInternationalCheckoutCompatibility({
      shopDomain: "https://attacker.test",
      graphQL: async () => {
        assert.fail("must not query");
      },
    }),
  );
  const successful = fixture(true);
  successful.data.shop.customerEmail = "private canary";
  const clean = await inspect(successful);
  assert.ok(!JSON.stringify(clean).includes("canary"));
});

test("caller cancellation prevents query start or rejects a late response without adopting its plan", async () => {
  const before = new AbortController();
  before.abort();
  assert.equal(
    (
      await inspectInternationalCheckoutCompatibility({
        shopDomain,
        signal: before.signal,
        graphQL: async () => {
          assert.fail("must not query");
        },
      })
    ).plan,
    "UNVERIFIED",
  );
  const during = new AbortController();
  let release, receivedSignal;
  const pending = inspectInternationalCheckoutCompatibility({
    shopDomain,
    signal: during.signal,
    graphQL: async (args) => {
      receivedSignal = args.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  during.abort();
  const result = await pending;
  assert.equal(result.plan, "UNVERIFIED");
  assert.equal(receivedSignal.aborted, true);
  release(fixture(true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.plan, "UNVERIFIED");
});

test(
  "five-second deadline bounds a reader that ignores cancellation",
  { timeout: 10000 },
  async () => {
    let signal;
    const result = await inspectInternationalCheckoutCompatibility({
      shopDomain,
      graphQL: async (args) => {
        signal = args.signal;
        return new Promise(() => {});
      },
    });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(signal.aborted, true);
  },
);

function commandFixture() {
  const events = [];
  const request = new Request(
    "https://app.example.test/app/international-shipping-commands",
    { method: "POST" },
  );
  const formData = new FormData();
  formData.set("intent", "inspectInternationalCheckoutCompatibility");
  const args = {
    request,
    formData,
    requireOperator: async (_request, options) => {
      events.push(["authorize", options.role]);
      assert.equal(options.role, "RELEASE_MANAGER");
      return {
        session: { shop: shopDomain },
        operator: { actorKey: "shopify_user:1" },
      };
    },
    prismaClient: new Proxy(
      {
        publicEndpointRateLimit: {
          deleteMany: async () => {
            events.push(["rate-cleanup"]);
          },
          upsert: async () => {
            events.push(["rate-limit"]);
            return { count: 1 };
          },
        },
      },
      {
        get(target, key) {
          assert.equal(
            key,
            "publicEndpointRateLimit",
            "business state must not be accessed",
          );
          return target[key];
        },
      },
    ),
    inspectCheckoutCompatibility: async ({ shopDomain: requested, signal }) => {
      events.push(["inspect", requested]);
      assert.equal(signal, request.signal);
      return inspect(fixture(true));
    },
  };
  return { args, events };
}

test("authenticated diagnostic works with source capability off, uses only the session shop and existing rate limiter", async () => {
  assert.equal(inspectInternationalAuthorizationCapability().ready, false);
  const f = commandFixture(),
    response = await dispatchInternationalRunnerAdmin(f.args);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.readOnly, true);
  assert.equal(result.compatibility.shopDomain, shopDomain);
  assert.equal(result.compatibility.verificationReady, false);
  assert.equal(f.events[0][0], "authorize");
  assert.equal(f.events.at(-1)[0], "inspect");
});

test("diagnostic rejects submitted shop/URL/plan/proof data before auth or reads and unauthorized callers never query", async () => {
  for (const field of [
    "shopDomain",
    "url",
    "plan",
    "report",
    "passed",
    "evidenceHash",
  ]) {
    const f = commandFixture();
    f.args.formData.set(field, "forged");
    await assert.rejects(
      dispatchInternationalRunnerAdmin(f.args),
      (e) => e.code === "international_input_invalid",
    );
    assert.deepEqual(f.events, []);
  }
  const f = commandFixture();
  f.args.requireOperator = async () => {
    throw new Response("Forbidden", { status: 403 });
  };
  await assert.rejects(
    dispatchInternationalRunnerAdmin(f.args),
    (e) => e.status === 403,
  );
  assert.deepEqual(f.events, []);
});

test("diagnostic rate limiting precedes any Shopify access", async () => {
  const f = commandFixture();
  f.args.prismaClient = {
    publicEndpointRateLimit: {
      deleteMany: async () => {},
      upsert: async () => ({ count: 6 }),
    },
  };
  await assert.rejects(
    dispatchInternationalRunnerAdmin(f.args),
    (e) => e.status === 429,
  );
  assert.ok(!f.events.some((event) => event[0] === "inspect"));
});
