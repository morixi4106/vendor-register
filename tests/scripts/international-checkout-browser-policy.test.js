import assert from "node:assert/strict";
import test from "node:test";
import { checkoutBrowserFixture as browserPolicyFixture } from "../helpers/internationalCheckoutBrowserFixture.js";
import {
  checkoutSessionUrl,
  allowCheckoutBrowserRequest,
  checkoutSessionHasher,
  validateCheckoutBrowserFacts,
  classifyCheckoutBrowserView,
  CHECKOUT_REJECTION,
} from "../../scripts/international-checkout-browser-policy.mjs";
import { checkoutBrowserChildEnvironment } from "../../scripts/international-checkout-browser-process.mjs";
import { proofHash } from "../../app/utils/internationalProofContract.js";

test("session URLs are bound to one shop and a single checkout, never generic navigation or credentials", () => {
  const f = browserPolicyFixture();
  assert.equal(checkoutSessionUrl(f.url, "browser.myshopify.com").href, f.url);
  for (const value of [
    "http://browser.myshopify.com/checkouts/cn/abcdefghijklmnop",
    f.url + "/thank_you",
    f.url + "?redirect=https://example.test",
    f.url + "#fragment",
    "https://user:password@browser.myshopify.com/checkouts/cn/abcdefghijklmnop",
    f.url.replace("browser.", "other."),
    f.url + "?key=abcdefghijklmnop&key=qrstuvwxyzabcdef",
    "https://127.0.0.1/checkouts/cn/abcdefghijklmnop",
  ])
    assert.throws(() => checkoutSessionUrl(value, "browser.myshopify.com"));
});
test("only the exact main document and narrowly scoped static GET assets are permitted", () => {
  const f = browserPolicyFixture(),
    doc = {
      url: f.url,
      method: "GET",
      resourceType: "document",
      navigation: true,
      mainFrame: true,
    };
  assert.equal(allowCheckoutBrowserRequest(doc, f.url), true);
  const asset = {
    url: "https://cdn.shopify.com/cdn/shopifycloud/checkout-web/assets/checkout.js?v=123",
    method: "GET",
    resourceType: "script",
    navigation: false,
    mainFrame: false,
  };
  assert.equal(allowCheckoutBrowserRequest(asset, f.url), true);
  for (const request of [
    { ...doc, method: "POST" },
    { ...doc, mainFrame: false },
    { ...doc, url: f.url + "/complete" },
    { ...doc, url: "https://other.myshopify.com/" },
    { ...asset, resourceType: "fetch" },
    { ...asset, method: "POST" },
    { ...asset, url: "https://example.test/checkout.js" },
    { ...asset, url: asset.url + "&token=canary" },
    { ...asset, url: "file:///C:/Windows/win.ini" },
    { ...asset, url: "https://cdn.shopify.com:444/cdn/shop/test.js" },
  ])
    assert.equal(allowCheckoutBrowserRequest(request, f.url), false);
});
test("an observed view is compared to independent facts, not to the case's expected outcome", () => {
  const f = browserPolicyFixture();
  assert.deepEqual(classifyCheckoutBrowserView(f.view, f.facts, f.row), {
    stage: "CHECKOUT_INTERACTION",
    outcome: "ALLOWED",
  });
  f.view.alerts = [CHECKOUT_REJECTION];
  assert.equal(
    classifyCheckoutBrowserView(f.view, f.facts, f.row).outcome,
    "REJECTED",
  );
});
for (const change of [
  (f) => {
    f.view.currency = "USD";
  },
  (f) => {
    f.view.total = 71;
  },
  (f) => {
    f.view.tax = null;
  },
  (f) => {
    f.view.country = "CA";
  },
  (f) => {
    f.view.visibleLines[0].variantId = "gid://shopify/ProductVariant/99";
  },
  (f) => {
    f.view.visibleLines[0].seller = "different";
  },
  (f) => {
    f.view.visibleLines.push(f.view.visibleLines[0]);
  },
  (f) => {
    f.view.paymentControlVisible = false;
  },
  (f) => {
    f.view.deliveryLabel = "different";
  },
  (f) => {
    f.view.alerts = ["An unrelated shipping failure"];
  },
  (f) => {
    f.view.documentVisible = false;
  },
  (f) => {
    f.facts.observedAt = new Date(Date.now() - 30000).toISOString();
  },
])
  test(`incomplete or substituted views cannot pass: ${change.toString()}`, () => {
    const f = browserPolicyFixture();
    change(f);
    assert.equal(
      classifyCheckoutBrowserView(f.view, f.facts, f.row).outcome,
      "NOT_OBSERVED",
    );
  });
test("facts reject PII/free fields, non-JPY, missing values, arithmetic and route/variant substitutions", () => {
  for (const change of [
    (f) => {
      f.facts.customerEmail = "canary";
    },
    (f) => {
      f.facts.currency = "USD";
    },
    (f) => {
      f.facts.tax = null;
    },
    (f) => {
      f.facts.tax = "0.1";
    },
    (f) => {
      f.facts.total = "69";
    },
    (f) => {
      f.facts.variantId = "gid://shopify/ProductVariant/2";
    },
    (f) => {
      f.facts.routeHash = "f".repeat(64);
    },
    (f) => {
      f.facts.country = "GB";
      f.row.target.country = "GB";
      const body = { ...f.row };
      delete body.caseKey;
      f.row.caseKey = proofHash(body);
    },
  ]) {
    const f = browserPolicyFixture();
    change(f);
    assert.throws(() => validateCheckoutBrowserFacts(f.facts, f.row));
  }
});
test("session digests are keyed, run-specific and stable only for the same retained checkout", () => {
  const f = browserPolicyFixture(),
    hash = checkoutSessionHasher(Buffer.alloc(32, 1));
  assert.equal(hash("run", f.url), hash("run", f.url));
  assert.equal(hash("run", f.url), hash("run", `${f.url}?locale=en`));
  assert.notEqual(hash("run", f.url), hash("other", f.url));
  assert.notEqual(
    hash("run", f.url),
    checkoutSessionHasher(Buffer.alloc(32, 2))("run", f.url),
  );
});
test("browser child environment strips application, signing, payment and Node preload credentials", () => {
  const env = checkoutBrowserChildEnvironment("isolated-home", {
    PATH: "system-path",
    NODE_OPTIONS: "--import=untrusted",
    SHOPIFY_API_SECRET: "canary",
    RESEND_API_KEY: "canary",
    DATABASE_URL: "canary",
    INTERNATIONAL_CHECKOUT_RUNNER_TOKEN: "canary",
    INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY: "canary",
    PLAYWRIGHT_BROWSERS_PATH: "fixed-cache",
  });
  assert.equal(env.PATH, "system-path");
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "fixed-cache");
  assert.ok(!JSON.stringify(env).includes("canary"));
  assert.equal(env.NODE_OPTIONS, undefined);
});
