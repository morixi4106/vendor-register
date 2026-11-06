import { proofHash } from "../../app/utils/internationalProofContract.js";

export function checkoutBrowserFixture() {
  const target = {
    country: "US",
    shopifyProductId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    quantity: 1,
    currency: "JPY",
    profileId: "profile",
    zoneId: "zone",
    methodId: "method",
    providerId: "rate",
    service: "",
    routeKind: "FREE",
    routeHash: "a".repeat(64),
    paymentProvider: "KOMOJU",
    paymentMethod: "CARD",
  };
  const cases = [
    ["allowed-before-payment", "OPEN", "ALLOWED", target],
    ["old-checkout-blocked", "CLOSED", "REJECTED", target],
    ["new-checkout-blocked", "CLOSED", "REJECTED", target],
    [
      "country-rejected",
      "OPEN",
      "REJECTED",
      {
        shopifyProductId: target.shopifyProductId,
        variantId: target.variantId,
        country: "CA",
      },
    ],
    [
      "domestic-regression",
      "OPEN",
      "ALLOWED",
      {
        shopifyProductId: target.shopifyProductId,
        variantId: target.variantId,
        country: "JP",
      },
    ],
  ].map(([scenario, phase, expectedOutcome, target]) => {
    const value = {
      scenario,
      phase,
      expectedStage: "CHECKOUT_INTERACTION",
      expectedOutcome,
      target,
    };
    return { ...value, caseKey: proofHash(value) };
  });
  const row = cases[0];
  const facts = {
    v: "international-checkout-browser-facts-v1",
    country: "US",
    productId: row.target.shopifyProductId,
    variantId: row.target.variantId,
    quantity: 1,
    currency: "JPY",
    subtotal: "65.00",
    shipping: "0",
    tax: "5",
    total: "70",
    productTitle: "Fixture item",
    variantTitle: "Fixture variant",
    seller: "Fixture seller",
    deliveryLabel: "Fixture delivery",
    routeHash: row.target.routeHash,
    observedAt: new Date().toISOString(),
  };
  const view = {
    country: "US",
    visibleLines: [
      {
        productId: facts.productId,
        variantId: facts.variantId,
        productTitle: facts.productTitle,
        variantTitle: facts.variantTitle,
        seller: facts.seller,
        quantity: 1,
      },
    ],
    subtotal: 65,
    shipping: 0,
    tax: 5,
    total: 70,
    currency: "JPY",
    deliveryLabel: facts.deliveryLabel,
    alerts: [],
    paymentControlVisible: true,
    documentVisible: true,
  };
  const url = "https://browser.myshopify.com/checkouts/cn/abcdefghijklmnop";
  return { row, facts, view, url, plan: { cases } };
}

export function checkoutBrowserCapacityCases(routeCount) {
  const base = checkoutBrowserFixture().plan.cases;
  const cases = base.slice(3);
  for (let index = 0; index < routeCount; index++) {
    for (const row of base.slice(0, 3)) {
      const { caseKey: _key, ...body } = row;
      body.target = { ...body.target, methodId: `method-${index}` };
      cases.push({ ...body, caseKey: proofHash(body) });
    }
  }
  return cases.sort((a, b) => a.caseKey.localeCompare(b.caseKey));
}
