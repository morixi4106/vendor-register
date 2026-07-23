import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";

export const MARKETPLACE_PURCHASE_CONTROL_FUNCTION_HANDLE =
  "marketplace-purchase-control";
export const MARKETPLACE_PURCHASE_CONTROL_VALIDATION_TITLE =
  "Marketplace purchase control";

const VALIDATIONS_QUERY = `#graphql
  query MarketplacePurchaseControlValidations {
    validations(first: 100) {
      nodes {
        id
        title
        enabled
        blockOnFailure
        errorHistory {
          errorsFirstOccurredAt
          hasBeenSharedSinceLastError
        }
        shopifyFunction {
          id
          handle
          apiType
          apiVersion
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const VALIDATION_CREATE_MUTATION = `#graphql
  mutation MarketplacePurchaseControlValidationCreate(
    $validation: ValidationCreateInput!
  ) {
    validationCreate(validation: $validation) {
      validation {
        id
        title
        enabled
        blockOnFailure
        shopifyFunction {
          id
          handle
          apiType
          apiVersion
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const VALIDATION_UPDATE_MUTATION = `#graphql
  mutation MarketplacePurchaseControlValidationUpdate(
    $id: ID!
    $validation: ValidationUpdateInput!
  ) {
    validationUpdate(id: $id, validation: $validation) {
      validation {
        id
        title
        enabled
        blockOnFailure
        shopifyFunction {
          id
          handle
          apiType
          apiVersion
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function assertNoUserErrors(payload, operation) {
  const errors = Array.isArray(payload?.userErrors)
    ? payload.userErrors.filter((error) => error?.message)
    : [];
  if (errors.length === 0) return;
  const error = new Error(
    `${operation}: ${errors.map((entry) => entry.message).join("; ")}`,
  );
  error.reason = "shopify_validation_user_error";
  error.userErrors = errors;
  throw error;
}

function findMarketplaceValidations(nodes) {
  return nodes.filter(
    (validation) =>
      validation?.shopifyFunction?.handle ===
      MARKETPLACE_PURCHASE_CONTROL_FUNCTION_HANDLE,
  );
}

export async function inspectMarketplaceCheckoutValidation(
  rawShopDomain,
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  if (!shopDomain) {
    return {
      ok: false,
      active: false,
      reason: "shop_domain_missing",
      validation: null,
    };
  }

  const response = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VALIDATIONS_QUERY,
  });
  const connection = response?.data?.validations;
  if (!connection) {
    return {
      ok: false,
      active: false,
      reason: "validations_query_unavailable",
      validation: null,
    };
  }
  if (connection.pageInfo?.hasNextPage) {
    return {
      ok: false,
      active: false,
      reason: "validation_inventory_incomplete",
      validation: null,
    };
  }

  const matchingValidations = findMarketplaceValidations(
    connection.nodes || [],
  );
  if (matchingValidations.length > 1) {
    return {
      ok: false,
      exists: true,
      active: false,
      reason: "duplicate_marketplace_checkout_validations",
      validation: null,
      validationCount: matchingValidations.length,
      validationIds: matchingValidations.map((entry) => entry.id),
    };
  }
  const validation = matchingValidations[0] || null;
  return {
    ok: true,
    exists: Boolean(validation),
    active: Boolean(validation?.enabled && validation?.blockOnFailure),
    prepared: Boolean(validation && validation.blockOnFailure),
    validation,
    validationCount: matchingValidations.length,
    runtimeErrorDetected: Boolean(validation?.errorHistory),
    reason: !validation
      ? "validation_not_created"
      : !validation.enabled
        ? "validation_disabled"
        : !validation.blockOnFailure
          ? "validation_not_fail_closed"
          : null,
  };
}

export async function ensureMarketplaceCheckoutValidation(
  rawShopDomain,
  { graphQL = shopifyGraphQLWithOfflineSession, enabled = true } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const current = await inspectMarketplaceCheckoutValidation(shopDomain, {
    graphQL,
  });
  if (!current.ok && current.reason !== "validation_not_created") {
    return current;
  }
  const targetEnabled = enabled === true;
  if (targetEnabled && current.runtimeErrorDetected === true) {
    return {
      ...current,
      ok: false,
      active: false,
      prepared: false,
      reason: "validation_runtime_error_detected",
      changed: false,
    };
  }
  if (
    current.validation?.blockOnFailure === true &&
    current.validation?.enabled === targetEnabled
  ) {
    return { ...current, changed: false };
  }

  if (current.validation?.id) {
    const response = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VALIDATION_UPDATE_MUTATION,
      variables: {
        id: current.validation.id,
        validation: {
          title: MARKETPLACE_PURCHASE_CONTROL_VALIDATION_TITLE,
          enable: targetEnabled,
          blockOnFailure: true,
        },
      },
    });
    const payload = response?.data?.validationUpdate;
    assertNoUserErrors(
      payload,
      "validationUpdate marketplace purchase control",
    );
    if (!payload?.validation) {
      return {
        ok: false,
        active: false,
        reason: "validation_update_missing_result",
      };
    }
  } else {
    const response = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VALIDATION_CREATE_MUTATION,
      variables: {
        validation: {
          title: MARKETPLACE_PURCHASE_CONTROL_VALIDATION_TITLE,
          functionHandle: MARKETPLACE_PURCHASE_CONTROL_FUNCTION_HANDLE,
          enable: targetEnabled,
          blockOnFailure: true,
        },
      },
    });
    const payload = response?.data?.validationCreate;
    assertNoUserErrors(
      payload,
      "validationCreate marketplace purchase control",
    );
    if (!payload?.validation) {
      return {
        ok: false,
        active: false,
        reason: "validation_create_missing_result",
      };
    }
  }

  const verified = await inspectMarketplaceCheckoutValidation(shopDomain, {
    graphQL,
  });
  const targetReached =
    verified.ok === true &&
    verified.validationCount === 1 &&
    verified.validation?.enabled === targetEnabled &&
    verified.validation?.blockOnFailure === true;
  return {
    ...verified,
    ok: targetReached,
    prepared: targetReached,
    active: targetEnabled && targetReached,
    reason: targetReached
      ? targetEnabled
        ? null
        : "validation_staged_disabled"
      : verified.reason || "validation_target_state_not_reached",
    changed: true,
  };
}

export async function stageMarketplaceCheckoutValidation(
  rawShopDomain,
  options = {},
) {
  return ensureMarketplaceCheckoutValidation(rawShopDomain, {
    ...options,
    enabled: false,
  });
}

export function buildMarketplaceCheckoutValidationReadinessCheck(status) {
  const ready =
    status?.ok === true &&
    status?.active === true &&
    status?.validationCount === 1 &&
    status?.runtimeErrorDetected !== true;
  return {
    id: "marketplace_checkout_server_validation",
    category: "shopify",
    status: ready ? "pass" : "fail",
    title: "Shopifyサーバー側の購入制御",
    detail: ready
      ? "Cart and Checkout Validation Functionが有効で、実行失敗時も購入を拒否します。"
      : `Shopifyの購入制御が未完成です: ${
          status?.runtimeErrorDetected
            ? "validation_runtime_error_detected"
            : status?.reason || "status_unavailable"
        }`,
    action: ready
      ? ""
      : "アプリ設定のread_validations/write_validationsを承認後、購入制御を有効化してください。",
  };
}
