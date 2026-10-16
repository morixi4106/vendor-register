import { internationalGraphQL } from "./internationalGateTransport.server.js";
import {
  proofHash,
  proofError,
  shape,
} from "../utils/internationalProofContract.js";
import { JAPAN_POST_AIR_PACKET_COUNTRY_CODES } from "../utils/japanPostAirPacket.js";

const MAX_DB_AMOUNT = 2147483647;
const BAG = `shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }`;
const TX = `id kind status gateway test processedAt parentTransaction { id }
  paymentDetails { __typename ... on BasePaymentDetails { paymentMethodName } ... on CardPaymentDetails { wallet } }
  amountSet { ${BAG} }`;
export const INTERNATIONAL_TRANSACTION_ORDER_QUERY = `query InternationalTransactionOrder($id: ID!) {
  order(id: $id) { id createdAt updatedAt test cancelledAt edited taxesIncluded sourceName app { id }
    currencyCode presentmentCurrencyCode displayFinancialStatus
    shippingAddress { countryCodeV2 }
    subtotalPriceSet { ${BAG} } totalShippingPriceSet { ${BAG} } totalTaxSet { ${BAG} }
    totalPriceSet { ${BAG} } totalRefundedSet { ${BAG} }
    lineItems(first: 250) { nodes { id quantity product { id } variant { id }
      originalUnitPriceSet { ${BAG} } discountedTotalSet { ${BAG} }
    } pageInfo { hasNextPage } }
    shippingLines(first: 2) { nodes { id code carrierIdentifier source discountedPriceSet { ${BAG} } } pageInfo { hasNextPage } }
    transactionsCount { count } transactions(first: 100) { ${TX} }
    refunds { id createdAt transactions(first: 100) { nodes { ${TX} } pageInfo { hasNextPage } } }
  }
}`;

function invalid() {
  throw proofError("international_transaction_unverified");
}
function gid(value, kind) {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !new RegExp(`^gid://shopify/${kind}/[1-9]\\d*$`).test(value)
  )
    invalid();
  return value;
}
function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  const result = new Date(value).toISOString();
  if (result.slice(0, 19) !== value.slice(0, 19)) invalid();
  return result;
}
export function internationalJpyMinorUnits(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^(0|[1-9]\d*)(?:\.0+)?$/.test(value)
  )
    invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_DB_AMOUNT)
    invalid();
  return result;
}
function money(value) {
  if (
    value?.shopMoney?.currencyCode !== "JPY" ||
    value?.presentmentMoney?.currencyCode !== "JPY"
  )
    invalid();
  const shopAmount = internationalJpyMinorUnits(value.shopMoney.amount);
  const presentmentAmount = internationalJpyMinorUnits(
    value.presentmentMoney.amount,
  );
  if (shopAmount !== presentmentAmount) invalid();
  return {
    shopAmount,
    presentmentAmount,
    shopCurrency: "JPY",
    presentmentCurrency: "JPY",
  };
}
function nodes(connection, limit) {
  if (
    !Array.isArray(connection?.nodes) ||
    connection.nodes.length > limit ||
    connection.pageInfo?.hasNextPage !== false
  )
    invalid();
  return connection.nodes;
}
function unique(rows) {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) invalid();
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
function transaction(row) {
  if (
    !row ||
    typeof row.test !== "boolean" ||
    !["AUTHORIZATION", "CAPTURE", "SALE", "VOID", "REFUND"].includes(
      row.kind,
    ) ||
    ![
      "SUCCESS",
      "PENDING",
      "FAILURE",
      "ERROR",
      "AWAITING_RESPONSE",
      "UNKNOWN",
    ].includes(row.status)
  )
    invalid();
  const details = row.paymentDetails;
  return {
    id: gid(row.id, "OrderTransaction"),
    kind: row.kind,
    status: row.status,
    test: row.test,
    provider:
      typeof row.gateway === "string" &&
      /^komoju(?:[ _-](?:credit[ _-]?card|card))?$/i.test(row.gateway)
        ? "KOMOJU"
        : "UNKNOWN",
    paymentMethod:
      details?.__typename === "CardPaymentDetails" && !details.wallet
        ? "CARD"
        : "UNKNOWN",
    processedAt: row.processedAt === null ? null : instant(row.processedAt),
    parentId:
      row.parentTransaction === null
        ? null
        : gid(row.parentTransaction?.id, "OrderTransaction"),
    amount: money(row.amountSet),
  };
}

// A complete snapshot is still not proof of checkout provenance, payment, or refund success.
export function buildInternationalTransactionSnapshot(order) {
  if (
    !order ||
    order.currencyCode !== "JPY" ||
    order.presentmentCurrencyCode !== "JPY" ||
    typeof order.test !== "boolean" ||
    order.test ||
    order.cancelledAt !== null ||
    order.edited !== false ||
    typeof order.taxesIncluded !== "boolean" ||
    order.sourceName !== "web"
  )
    invalid();
  const country = order.shippingAddress?.countryCodeV2;
  if (
    !JAPAN_POST_AIR_PACKET_COUNTRY_CODES.includes(country) ||
    country === "JP" ||
    country === "GB"
  )
    invalid();
  const lines = unique(
    nodes(order.lineItems, 250).map((row) => {
      if (
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1 ||
        row.quantity > 200
      )
        invalid();
      return {
        id: gid(row.id, "LineItem"),
        shopifyProductId: gid(row.product?.id, "Product"),
        variantId: gid(row.variant?.id, "ProductVariant"),
        quantity: row.quantity,
        unitPrice: money(row.originalUnitPriceSet),
        total: money(row.discountedTotalSet),
      };
    }),
  );
  if (!lines.length) invalid();
  const shipping = nodes(order.shippingLines, 2);
  if (shipping.length !== 1) invalid();
  const rate = shipping[0];
  const safeReference = (value) => {
    if (value === null) return null;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 256 ||
      [...value].some((c) => c.charCodeAt(0) < 32)
    )
      invalid();
    return proofHash(value);
  };
  if (
    !Array.isArray(order.transactions) ||
    order.transactions.length > 100 ||
    !Number.isSafeInteger(order.transactionsCount?.count) ||
    order.transactionsCount.count !== order.transactions.length ||
    !Array.isArray(order.refunds) ||
    order.refunds.length >= 100
  )
    invalid();
  const transactions = unique(order.transactions.map(transaction));
  const refunds = unique(
    order.refunds.map((row) => ({
      id: gid(row.id, "Refund"),
      createdAt: instant(row.createdAt),
      transactions: unique(nodes(row.transactions, 100).map(transaction)),
    })),
  );
  const commercial = {
    country,
    appId: gid(order.app?.id, "App"),
    sourceName: "web",
    taxesIncluded: order.taxesIncluded,
    subtotal: money(order.subtotalPriceSet),
    shipping: money(order.totalShippingPriceSet),
    tax: money(order.totalTaxSet),
    total: money(order.totalPriceSet),
    lines,
    shippingLine: {
      id: gid(rate.id, "ShippingLine"),
      codeHash: safeReference(rate.code),
      carrierHash: safeReference(rate.carrierIdentifier),
      sourceHash: safeReference(rate.source),
      amount: money(rate.discountedPriceSet),
    },
  };
  return {
    version: "international-transaction-snapshot-v1",
    orderId: gid(order.id, "Order"),
    createdAt: instant(order.createdAt),
    updatedAt: instant(order.updatedAt),
    financialStatus: [
      "PENDING",
      "AUTHORIZED",
      "PAID",
      "PARTIALLY_PAID",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
      "VOIDED",
      "EXPIRED",
    ].includes(order.displayFinancialStatus)
      ? order.displayFinancialStatus
      : invalid(),
    commercial,
    commercialHash: proofHash(commercial),
    refunded: money(order.totalRefundedSet),
    transactions,
    refunds,
  };
}

export async function fetchInternationalTransactionSnapshot(
  { shopDomain, orderId },
  { graphQL = internationalGraphQL } = {},
) {
  try {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) invalid();
    gid(orderId, "Order");
    const response = await graphQL({
      shopDomain,
      apiVersion: "2026-04",
      query: INTERNATIONAL_TRANSACTION_ORDER_QUERY,
      variables: { id: orderId },
      timeoutMs: 10000,
    });
    if (!response?.data?.order || response.errors?.length) invalid();
    const snapshot = buildInternationalTransactionSnapshot(response.data.order);
    if (snapshot.orderId !== orderId) invalid();
    return { ok: true, snapshot };
  } catch {
    return { ok: false, reason: "international_transaction_unverified" };
  }
}

export function inspectInternationalTransactionScope(snapshot, expected) {
  try {
    shape(
      expected,
      [
        "country",
        "appId",
        "createdAfter",
        "createdBefore",
        "totalAmount",
        "lines",
        "shippingLine",
      ],
      32000,
    );
    gid(expected.appId, "App");
    const after = instant(expected.createdAfter),
      before = instant(expected.createdBefore);
    if (
      after >= before ||
      !Number.isSafeInteger(expected.totalAmount) ||
      expected.totalAmount < 0 ||
      expected.totalAmount > MAX_DB_AMOUNT ||
      !Array.isArray(expected.lines) ||
      !expected.lines.length ||
      expected.lines.length > 250
    )
      invalid();
    const normalized = (rows) =>
      rows
        .map((row) => {
          shape(row, ["shopifyProductId", "variantId", "quantity"]);
          gid(row.shopifyProductId, "Product");
          gid(row.variantId, "ProductVariant");
          if (
            !Number.isInteger(row.quantity) ||
            row.quantity < 1 ||
            row.quantity > 200
          )
            invalid();
          return row;
        })
        .sort((a, b) => a.variantId.localeCompare(b.variantId));
    const lines = normalized(expected.lines);
    if (new Set(lines.map((row) => row.variantId)).size !== lines.length)
      invalid();
    shape(expected.shippingLine, ["codeHash", "carrierHash", "sourceHash"]);
    for (const field of ["codeHash", "carrierHash", "sourceHash"])
      if (
        !(field === "carrierHash" && expected.shippingLine[field] === null) &&
        !/^[a-f0-9]{64}$/.test(expected.shippingLine[field])
      )
        invalid();
    if (
      snapshot?.version !== "international-transaction-snapshot-v1" ||
      snapshot.commercialHash !== proofHash(snapshot.commercial) ||
      snapshot.commercial.country !== expected.country ||
      snapshot.commercial.appId !== expected.appId ||
      snapshot.createdAt < after ||
      snapshot.createdAt >= before ||
      snapshot.commercial.total.shopCurrency !== "JPY" ||
      snapshot.commercial.total.presentmentCurrency !== "JPY" ||
      snapshot.commercial.total.shopAmount !== expected.totalAmount ||
      snapshot.commercial.total.presentmentAmount !== expected.totalAmount
    )
      invalid();
    const actual = normalized(
      snapshot.commercial.lines.map(
        ({ shopifyProductId, variantId, quantity }) => ({
          shopifyProductId,
          variantId,
          quantity,
        }),
      ),
    );
    if (
      proofHash(actual) !== proofHash(lines) ||
      ["codeHash", "carrierHash", "sourceHash"].some(
        (field) =>
          snapshot.commercial.shippingLine[field] !==
          expected.shippingLine[field],
      )
    )
      invalid();
    return { matches: true };
  } catch {
    return {
      matches: false,
      reason: "international_transaction_scope_mismatch",
    };
  }
}
