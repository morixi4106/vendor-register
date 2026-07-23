const SHOPIFY_API_VERSION = "2026-04";
const QUARANTINE_TAG = "vendor-register-quarantine";
const QUARANTINE_HOLD_HANDLE = "vendor-register-sale-eligibility";

const ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrderFulfillmentOrdersForQuarantine($id: ID!, $after: String) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50, after: $after) {
        nodes {
          id
          status
          fulfillmentHolds {
            id
            handle
            heldByRequestingApp
            reason
            reasonNotes
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const FULFILLMENT_ORDER_HOLD_MUTATION = `#graphql
  mutation HoldFulfillmentOrderForQuarantine(
    $id: ID!
    $fulfillmentHold: FulfillmentOrderHoldInput!
  ) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentHold {
        id
        handle
        heldByRequestingApp
        reason
        reasonNotes
      }
      fulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation TagQuarantinedOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function normalizeText(value) {
  return String(value || "").trim();
}

function sanitizeUserErrors(value) {
  return (Array.isArray(value) ? value : []).slice(0, 10).map((entry) => ({
    field: Array.isArray(entry?.field)
      ? entry.field.map(String).slice(0, 8)
      : [],
    message: normalizeText(entry?.message).slice(0, 500),
  }));
}

function existingQuarantineHold(fulfillmentOrder) {
  return (
    Array.isArray(fulfillmentOrder?.fulfillmentHolds)
      ? fulfillmentOrder.fulfillmentHolds
      : []
  ).find(
    (hold) =>
      hold?.heldByRequestingApp === true &&
      normalizeText(hold?.handle) === QUARANTINE_HOLD_HANDLE,
  );
}

function isTerminalFulfillmentOrder(fulfillmentOrder) {
  return ["CANCELLED", "CLOSED"].includes(
    normalizeText(fulfillmentOrder?.status).toUpperCase(),
  );
}

async function persistQuarantineHoldResult(
  { shopDomain, shopifyOrderId, operationalCaseId, result, now = new Date() },
  { prismaClient } = {},
) {
  if (
    !prismaClient?.shopifyOrderQuarantineHold?.upsert ||
    !result?.fulfillmentOrderId
  ) {
    return;
  }
  const status = result.ok
    ? "APPLIED"
    : result.terminal
      ? "TERMINAL_UNPROTECTED"
      : "FAILED";
  await prismaClient.shopifyOrderQuarantineHold.upsert({
    where: {
      shopDomain_fulfillmentOrderId_holdHandle: {
        shopDomain,
        fulfillmentOrderId: result.fulfillmentOrderId,
        holdHandle: QUARANTINE_HOLD_HANDLE,
      },
    },
    create: {
      shopDomain,
      shopifyOrderId,
      fulfillmentOrderId: result.fulfillmentOrderId,
      fulfillmentHoldId: result.holdId || null,
      holdHandle: QUARANTINE_HOLD_HANDLE,
      status,
      fulfillmentOrderStatus: result.fulfillmentOrderStatus || null,
      operationalCaseId,
      appliedAt: result.ok ? now : null,
      lastVerifiedAt: now,
      lastErrorCode: result.errorCode || null,
      metadataJson: {
        alreadyApplied: result.alreadyApplied === true,
        terminal: result.terminal === true,
        userErrors: result.userErrors || [],
      },
    },
    update: {
      fulfillmentHoldId: result.holdId || null,
      status,
      fulfillmentOrderStatus: result.fulfillmentOrderStatus || null,
      operationalCaseId,
      appliedAt: result.ok ? now : undefined,
      lastVerifiedAt: now,
      lastErrorCode: result.errorCode || null,
      metadataJson: {
        alreadyApplied: result.alreadyApplied === true,
        terminal: result.terminal === true,
        userErrors: result.userErrors || [],
      },
    },
  });
}

async function addOrderQuarantineTag({ graphQL, shopDomain, shopifyOrderId }) {
  try {
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: TAGS_ADD_MUTATION,
      variables: {
        id: shopifyOrderId,
        tags: [QUARANTINE_TAG],
      },
    });
    const payload = data?.tagsAdd;
    const userErrors = sanitizeUserErrors(payload?.userErrors);
    return {
      ok: Boolean(payload?.node?.id) && userErrors.length === 0,
      orderId: payload?.node?.id || null,
      tag: QUARANTINE_TAG,
      userErrors,
    };
  } catch (error) {
    return {
      ok: false,
      tag: QUARANTINE_TAG,
      errorCode: "order_quarantine_tag_failed",
      error: normalizeText(error?.message || error).slice(0, 500),
    };
  }
}

async function holdFulfillmentOrder({
  graphQL,
  shopDomain,
  fulfillmentOrder,
  operationalCaseId,
}) {
  const existing = existingQuarantineHold(fulfillmentOrder);
  if (existing) {
    return {
      ok: true,
      alreadyApplied: true,
      fulfillmentOrderId: fulfillmentOrder.id,
      fulfillmentOrderStatus: fulfillmentOrder.status || null,
      holdId: existing.id || null,
      handle: existing.handle || QUARANTINE_HOLD_HANDLE,
      reason: existing.reason || "OTHER",
    };
  }

  if (isTerminalFulfillmentOrder(fulfillmentOrder)) {
    return {
      ok: false,
      terminal: true,
      alreadyApplied: false,
      fulfillmentOrderId: fulfillmentOrder.id,
      fulfillmentOrderStatus: fulfillmentOrder.status || null,
      holdId: null,
      handle: QUARANTINE_HOLD_HANDLE,
      errorCode: "fulfillment_order_already_terminal",
      userErrors: [],
    };
  }

  try {
    const reasonNotes = operationalCaseId
      ? `Sale eligibility quarantine. Operational case: ${operationalCaseId}`
      : "Sale eligibility quarantine. Review before shipment.";
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: FULFILLMENT_ORDER_HOLD_MUTATION,
      variables: {
        id: fulfillmentOrder.id,
        fulfillmentHold: {
          handle: QUARANTINE_HOLD_HANDLE,
          notifyMerchant: true,
          reason: "OTHER",
          reasonNotes,
        },
      },
    });
    const payload = data?.fulfillmentOrderHold;
    const userErrors = sanitizeUserErrors(payload?.userErrors);
    const hold = payload?.fulfillmentHold;
    return {
      ok: Boolean(hold?.id) && userErrors.length === 0,
      alreadyApplied: false,
      fulfillmentOrderId: payload?.fulfillmentOrder?.id || fulfillmentOrder.id,
      fulfillmentOrderStatus:
        payload?.fulfillmentOrder?.status || fulfillmentOrder.status || null,
      holdId: hold?.id || null,
      handle: hold?.handle || QUARANTINE_HOLD_HANDLE,
      reason: hold?.reason || "OTHER",
      userErrors,
    };
  } catch (error) {
    return {
      ok: false,
      fulfillmentOrderId: fulfillmentOrder.id,
      handle: QUARANTINE_HOLD_HANDLE,
      errorCode: "fulfillment_order_hold_failed",
      error: normalizeText(error?.message || error).slice(0, 500),
    };
  }
}

export async function applyShopifyOrderQuarantine(
  {
    shopDomain,
    shopifyOrderId,
    operationalCaseId = null,
    requiresShipping = true,
  },
  { graphQL, prismaClient = null } = {},
) {
  const normalizedShop = normalizeText(shopDomain).toLowerCase();
  const normalizedOrderId = normalizeText(shopifyOrderId);
  if (!normalizedShop || !normalizedOrderId || typeof graphQL !== "function") {
    return {
      ok: false,
      status: "PARTIAL_FAILURE",
      reason: "shopify_quarantine_dependencies_missing",
      tag: null,
      fulfillmentOrders: [],
    };
  }

  let order;
  const fulfillmentOrders = [];
  let after = null;
  let paginationIncomplete = false;
  try {
    for (let page = 0; page < 10; page += 1) {
      const { data } = await graphQL({
        shopDomain: normalizedShop,
        apiVersion: SHOPIFY_API_VERSION,
        query: ORDER_FULFILLMENT_ORDERS_QUERY,
        variables: { id: normalizedOrderId, after },
      });
      order = data?.order || null;
      if (!order?.id) break;
      const connection = order.fulfillmentOrders;
      fulfillmentOrders.push(
        ...(Array.isArray(connection?.nodes)
          ? connection.nodes.filter((entry) => entry?.id)
          : []),
      );
      if (!connection?.pageInfo?.hasNextPage) break;
      after = normalizeText(connection?.pageInfo?.endCursor);
      if (!after) {
        paginationIncomplete = true;
        break;
      }
      if (page === 9) paginationIncomplete = true;
    }
  } catch (error) {
    return {
      ok: false,
      status: "PARTIAL_FAILURE",
      reason: "shopify_order_quarantine_lookup_failed",
      error: normalizeText(error?.message || error).slice(0, 500),
      tag: null,
      fulfillmentOrders: [],
    };
  }

  if (!order?.id) {
    return {
      ok: false,
      status: "PARTIAL_FAILURE",
      reason: "shopify_order_not_found_for_quarantine",
      tag: null,
      fulfillmentOrders: [],
    };
  }

  const tag = await addOrderQuarantineTag({
    graphQL,
    shopDomain: normalizedShop,
    shopifyOrderId: normalizedOrderId,
  });
  const holdResults = [];
  for (const fulfillmentOrder of fulfillmentOrders) {
    const result = await holdFulfillmentOrder({
      graphQL,
      shopDomain: normalizedShop,
      fulfillmentOrder,
      operationalCaseId,
    });
    holdResults.push(result);
    await persistQuarantineHoldResult(
      {
        shopDomain: normalizedShop,
        shopifyOrderId: normalizedOrderId,
        operationalCaseId,
        result,
      },
      { prismaClient },
    );
  }

  const fulfillmentProtected =
    requiresShipping === false ||
    (holdResults.length > 0 &&
      holdResults.every((entry) => entry.ok) &&
      !paginationIncomplete);
  const ok = tag.ok === true && fulfillmentProtected;

  return {
    ok,
    status: ok ? "COMPLETE" : "PARTIAL_FAILURE",
    reason: ok ? null : "shopify_order_quarantine_incomplete",
    orderId: order.id,
    tag,
    requiresShipping: requiresShipping !== false,
    fulfillmentOrders: holdResults,
    paginationIncomplete,
    terminalFulfillmentOrderCount: holdResults.filter(
      (entry) => entry.terminal === true,
    ).length,
    appliedAt: new Date().toISOString(),
  };
}

export const SHOPIFY_ORDER_QUARANTINE = Object.freeze({
  tag: QUARANTINE_TAG,
  holdHandle: QUARANTINE_HOLD_HANDLE,
});
