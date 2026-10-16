import assert from "node:assert/strict";
import test from "node:test";
import {
  internationalJpyMinorUnits,
  buildInternationalTransactionSnapshot,
  fetchInternationalTransactionSnapshot,
  INTERNATIONAL_TRANSACTION_ORDER_QUERY,
  inspectInternationalTransactionScope,
} from "../../app/services/internationalTransactionSnapshot.server.js";
import {
  internationalOrderFixture,
  moneyBag,
  connection,
} from "../helpers/internationalCheckoutFixture.js";

test("transaction scope matching rejects another country, variant, amount, route and time without financial certification", () => {
  const snapshot = buildInternationalTransactionSnapshot(
    internationalOrderFixture(),
  );
  const expected = {
    country: "US",
    appId: snapshot.commercial.appId,
    createdAfter: "2026-10-16T00:00:00Z",
    createdBefore: "2026-10-18T00:00:00Z",
    totalAmount: 65,
    lines: [
      {
        shopifyProductId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 1,
      },
    ],
    shippingLine: {
      codeHash: snapshot.commercial.shippingLine.codeHash,
      carrierHash: null,
      sourceHash: snapshot.commercial.shippingLine.sourceHash,
    },
  };
  assert.deepEqual(inspectInternationalTransactionScope(snapshot, expected), {
    matches: true,
  });
  for (const change of [
    { country: "CA" },
    {
      lines: [
        { ...expected.lines[0], shopifyProductId: "gid://shopify/Product/2" },
      ],
    },
    { totalAmount: 64 },
    { createdBefore: snapshot.createdAt },
    {
      lines: [
        { ...expected.lines[0], variantId: "gid://shopify/ProductVariant/2" },
      ],
    },
    { shippingLine: { ...expected.shippingLine, codeHash: "f".repeat(64) } },
    { shippingLine: {} },
    { passed: true },
  ])
    assert.equal(
      inspectInternationalTransactionScope(snapshot, { ...expected, ...change })
        .matches,
      false,
    );
});

test("JPY decimal parser is exact, bounded and never defaults or rounds", () => {
  for (const value of ["0", "0.00", "65", "65.000", "2147483647.00"])
    assert.equal(internationalJpyMinorUnits(value), Number(value));
  for (const value of [
    null,
    undefined,
    65,
    "",
    " ",
    "65.1",
    "65.0001",
    "1e2",
    "1,000",
    "+1",
    "-0",
    "01",
    "2147483648",
    "9007199254740992",
    "1.",
  ])
    assert.throws(() => internationalJpyMinorUnits(value));
});

test("international snapshot stores only strict dual JPY amounts and minimal country/source references", () => {
  const order = internationalOrderFixture();
  order.shippingAddress.name = "PRIVATE_NAME";
  order.shippingAddress.address1 = "PRIVATE_ADDRESS";
  order.email = "PRIVATE_EMAIL";
  order.checkout_token = "PRIVATE_TOKEN";
  const snapshot = buildInternationalTransactionSnapshot(order);
  assert.equal(snapshot.commercial.total.shopAmount, 65);
  assert.equal(snapshot.commercial.total.presentmentAmount, 65);
  assert.equal(snapshot.commercial.country, "US");
  assert.equal(snapshot.transactions[0].provider, "KOMOJU");
  assert.equal(snapshot.transactions[0].paymentMethod, "CARD");
  assert.equal(snapshot.commercial.shippingLine.codeHash.length, 64);
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(snapshot).includes('"complete":true'));
  for (const name of [
    "email",
    "address1",
    "zip",
    "phone",
    "checkoutToken",
    "checkout_token",
    "statusPageUrl",
  ])
    assert.ok(!INTERNATIONAL_TRANSACTION_ORDER_QUERY.includes(name));
});

for (const field of [
  "country",
  "gb",
  "test",
  "currency",
  "presentment",
  "amount",
  "pairMismatch",
  "missingCurrency",
  "missingPage",
  "truncatedLines",
  "transactionCount",
  "refundPage",
  "duplicateLine",
  "shipping",
  "source",
  "app",
  "edited",
  "missingBoolean",
  "variant",
  "fractional",
  "cancelled",
]) {
  test(`international snapshot fails closed for ${field}`, () => {
    const o = internationalOrderFixture();
    if (field === "country") o.shippingAddress.countryCodeV2 = "JP";
    if (field === "gb") o.shippingAddress.countryCodeV2 = "GB";
    if (field === "test") o.test = true;
    if (field === "currency") o.currencyCode = "USD";
    if (field === "presentment") o.presentmentCurrencyCode = "USD";
    if (field === "amount") delete o.totalPriceSet.shopMoney.amount;
    if (field === "pairMismatch")
      o.totalPriceSet.presentmentMoney.amount = "64";
    if (field === "missingCurrency")
      delete o.totalPriceSet.presentmentMoney.currencyCode;
    if (field === "missingPage") delete o.lineItems.pageInfo;
    if (field === "truncatedLines") o.lineItems.pageInfo.hasNextPage = true;
    if (field === "transactionCount") o.transactionsCount.count = 2;
    if (field === "refundPage")
      o.refunds = [
        {
          id: "gid://shopify/Refund/1",
          createdAt: o.createdAt,
          transactions: {
            ...connection(o.transactions),
            pageInfo: { hasNextPage: true },
          },
        },
      ];
    if (field === "duplicateLine") o.lineItems.nodes.push(o.lineItems.nodes[0]);
    if (field === "shipping")
      o.shippingLines.nodes.push(o.shippingLines.nodes[0]);
    if (field === "source") o.sourceName = "pos";
    if (field === "app") o.app = null;
    if (field === "edited") o.edited = true;
    if (field === "missingBoolean") delete o.test;
    if (field === "variant") o.lineItems.nodes[0].variant = null;
    if (field === "fractional") o.totalTaxSet = moneyBag("0.1");
    if (field === "cancelled") o.cancelledAt = o.createdAt;
    assert.throws(
      () => buildInternationalTransactionSnapshot(o),
      (e) => e.code === "international_transaction_unverified",
    );
  });
}

test("refund snapshot preserves exact parent and amounts without assuming success", () => {
  const o = internationalOrderFixture();
  const refund = {
    ...o.transactions[0],
    id: "gid://shopify/OrderTransaction/2",
    kind: "REFUND",
    status: "PENDING",
    parentTransaction: { id: o.transactions[0].id },
  };
  o.refunds = [
    {
      id: "gid://shopify/Refund/1",
      createdAt: o.createdAt,
      transactions: connection([refund]),
    },
  ];
  const snapshot = buildInternationalTransactionSnapshot(o);
  assert.equal(snapshot.refunds[0].transactions[0].status, "PENDING");
  assert.equal(
    snapshot.refunds[0].transactions[0].parentId,
    o.transactions[0].id,
  );
});

test("read-only snapshot fetch validates shop/order, API errors, partial response and safe failure", async () => {
  let calls = 0;
  const args = {
    shopDomain: "example.myshopify.com",
    orderId: "gid://shopify/Order/1",
  };
  const graphQL = async (request) => {
    calls++;
    assert.equal(request.apiVersion, "2026-04");
    assert.ok(request.query.startsWith("query "));
    assert.equal(request.timeoutMs, 10000);
    return { data: { order: internationalOrderFixture() } };
  };
  assert.equal(
    (await fetchInternationalTransactionSnapshot(args, { graphQL })).ok,
    true,
  );
  assert.equal(
    (
      await fetchInternationalTransactionSnapshot(
        { ...args, shopDomain: "https://example.com" },
        { graphQL },
      )
    ).ok,
    false,
  );
  assert.equal(calls, 1);
  for (const response of [
    {
      errors: [{ message: "PRIVATE" }],
      data: { order: internationalOrderFixture() },
    },
    { data: { order: null } },
  ]) {
    const result = await fetchInternationalTransactionSnapshot(args, {
      graphQL: async () => response,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "international_transaction_unverified",
    });
  }
});
