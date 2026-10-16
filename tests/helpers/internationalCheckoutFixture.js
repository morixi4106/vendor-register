export const connection = (nodes = []) => ({
  nodes,
  pageInfo: { hasNextPage: false },
});
export const moneyBag = (amount = "65.00") => ({
  shopMoney: { amount, currencyCode: "JPY" },
  presentmentMoney: { amount, currencyCode: "JPY" },
});
export function checkoutInventoryFixture() {
  const scope = [
    {
      productId: "p1",
      shopifyProductId: "gid://shopify/Product/1",
      countries: ["US"],
    },
  ];
  const markets = [
    {
      id: "market",
      status: "ACTIVE",
      currencySettings: {
        baseCurrency: { currencyCode: "JPY" },
        localCurrencies: false,
      },
      conditions: {
        regionsCondition: { regions: connection([{ code: "US" }]) },
      },
    },
  ];
  const method = {
    id: "method",
    active: true,
    methodConditions: [],
    rateProvider: {
      __typename: "DeliveryRateDefinition",
      id: "rate",
      price: { amount: "0.00", currencyCode: "JPY" },
    },
  };
  const zone = {
    zone: {
      id: "zone",
      countries: [
        { code: { countryCode: "US", restOfWorld: false }, provinces: [] },
      ],
    },
    methodDefinitions: connection([method]),
  };
  const profile = {
    id: "profile",
    default: true,
    profileItems: connection(),
    profileLocationGroups: [{ locationGroupZones: connection([zone]) }],
  };
  const variantFacts = [
    {
      id: scope[0].shopifyProductId,
      variants: connection([
        {
          id: "gid://shopify/ProductVariant/1",
          inventoryItem: { requiresShipping: true },
        },
      ]),
    },
  ];
  return { scope, markets, profiles: [profile], variantFacts, method, zone };
}
export function internationalOrderFixture() {
  const transaction = {
    id: "gid://shopify/OrderTransaction/1",
    kind: "SALE",
    status: "SUCCESS",
    gateway: "KOMOJU",
    manualPaymentGateway: false,
    test: false,
    processedAt: "2026-10-17T00:00:00Z",
    parentTransaction: null,
    paymentDetails: { __typename: "CardPaymentDetails", wallet: null },
    amountSet: moneyBag(),
  };
  return {
    id: "gid://shopify/Order/1",
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:01Z",
    test: false,
    cancelledAt: null,
    edited: false,
    taxesIncluded: true,
    sourceName: "web",
    app: { id: "gid://shopify/App/1" },
    currencyCode: "JPY",
    presentmentCurrencyCode: "JPY",
    displayFinancialStatus: "PAID",
    shippingAddress: { countryCodeV2: "US" },
    subtotalPriceSet: moneyBag(),
    totalShippingPriceSet: moneyBag("0.0"),
    totalTaxSet: moneyBag("0.00"),
    totalPriceSet: moneyBag(),
    totalRefundedSet: moneyBag("0.0"),
    lineItems: connection([
      {
        id: "gid://shopify/LineItem/1",
        quantity: 1,
        product: { id: "gid://shopify/Product/1" },
        variant: { id: "gid://shopify/ProductVariant/1" },
        originalUnitPriceSet: moneyBag(),
        discountedTotalSet: moneyBag(),
      },
    ]),
    shippingLines: connection([
      {
        id: "gid://shopify/ShippingLine/1",
        code: "free",
        carrierIdentifier: null,
        source: "shopify",
        discountedPriceSet: moneyBag("0.00"),
      },
    ]),
    transactionsCount: { count: 1 },
    transactions: [transaction],
    refunds: [],
  };
}
