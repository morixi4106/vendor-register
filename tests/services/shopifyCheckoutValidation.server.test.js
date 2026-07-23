import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureMarketplaceCheckoutValidation,
  inspectMarketplaceCheckoutValidation,
  stageMarketplaceCheckoutValidation,
} from "../../app/services/shopifyCheckoutValidation.server.js";

function validationNode(overrides = {}) {
  return {
    id: "gid://shopify/Validation/1",
    title: "Marketplace purchase control",
    enabled: true,
    blockOnFailure: true,
    shopifyFunction: {
      id: "gid://shopify/ShopifyFunction/1",
      handle: "marketplace-purchase-control",
      apiType: "cart_validations",
      apiVersion: "2026-04",
    },
    ...overrides,
  };
}

test("checkout validation inspection requires enabled fail-closed function", async () => {
  const result = await inspectMarketplaceCheckoutValidation(
    "example.myshopify.com",
    {
      graphQL: async () => ({
        data: {
          validations: {
            nodes: [validationNode()],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.reason, null);
});

test("checkout validation is created with blockOnFailure enabled", async () => {
  const calls = [];
  let created = false;
  const graphQL = async ({ query, variables }) => {
    calls.push({ query, variables });
    if (query.includes("validationCreate")) {
      created = true;
      return {
        data: {
          validationCreate: {
            validation: validationNode(),
            userErrors: [],
          },
        },
      };
    }
    return {
      data: {
        validations: {
          nodes: created ? [validationNode()] : [],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await ensureMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  const createCall = calls.find((call) =>
    call.query.includes("validationCreate"),
  );
  assert.equal(createCall.variables.validation.enable, true);
  assert.equal(createCall.variables.validation.blockOnFailure, true);
  assert.equal(
    createCall.variables.validation.functionHandle,
    "marketplace-purchase-control",
  );
});

test("disabled checkout validation is updated instead of duplicated", async () => {
  let enabled = false;
  let updateCount = 0;
  const graphQL = async ({ query, variables }) => {
    if (query.includes("validationUpdate")) {
      updateCount += 1;
      assert.equal(variables.id, "gid://shopify/Validation/1");
      enabled = true;
      return {
        data: {
          validationUpdate: {
            validation: validationNode(),
            userErrors: [],
          },
        },
      };
    }
    return {
      data: {
        validations: {
          nodes: [
            validationNode({
              enabled,
              blockOnFailure: enabled,
            }),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await ensureMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.active, true);
  assert.equal(updateCount, 1);
});

test("duplicate checkout validations fail closed without updating either one", async () => {
  let mutationCount = 0;
  const graphQL = async ({ query }) => {
    if (
      query.includes("validationCreate") ||
      query.includes("validationUpdate")
    ) {
      mutationCount += 1;
    }
    return {
      data: {
        validations: {
          nodes: [
            validationNode(),
            validationNode({ id: "gid://shopify/Validation/2" }),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await ensureMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(result.reason, "duplicate_marketplace_checkout_validations");
  assert.equal(result.validationCount, 2);
  assert.equal(mutationCount, 0);
});

test("validations owned by another Function are never changed", async () => {
  let created = false;
  let updatedOtherValidation = false;
  const graphQL = async ({ query, variables }) => {
    if (query.includes("validationUpdate")) {
      updatedOtherValidation = true;
    }
    if (query.includes("validationCreate")) {
      created = true;
      assert.equal(
        variables.validation.functionHandle,
        "marketplace-purchase-control",
      );
      return {
        data: {
          validationCreate: {
            validation: validationNode({
              id: "gid://shopify/Validation/ours",
            }),
            userErrors: [],
          },
        },
      };
    }
    return {
      data: {
        validations: {
          nodes: [
            validationNode({
              id: "gid://shopify/Validation/other",
              title: "Marketplace purchase control",
              shopifyFunction: {
                id: "gid://shopify/ShopifyFunction/other",
                handle: "another-app-validation",
                apiType: "cart_validations",
                apiVersion: "2026-04",
              },
            }),
            ...(created
              ? [
                  validationNode({
                    id: "gid://shopify/Validation/ours",
                  }),
                ]
              : []),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await ensureMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(updatedOtherValidation, false);
});

test("checkout validation can be staged disabled before projection backfill", async () => {
  const calls = [];
  let created = false;
  const graphQL = async ({ query, variables }) => {
    calls.push({ query, variables });
    if (query.includes("validationCreate")) {
      created = true;
      return {
        data: {
          validationCreate: {
            validation: validationNode({ enabled: false }),
            userErrors: [],
          },
        },
      };
    }
    return {
      data: {
        validations: {
          nodes: created ? [validationNode({ enabled: false })] : [],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await stageMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.active, false);
  assert.equal(result.prepared, true);
  assert.equal(result.reason, "validation_staged_disabled");
  const createCall = calls.find((call) =>
    call.query.includes("validationCreate"),
  );
  assert.equal(createCall.variables.validation.enable, false);
  assert.equal(createCall.variables.validation.blockOnFailure, true);
});

test("runtime error history is exposed to readiness monitoring", async () => {
  const result = await inspectMarketplaceCheckoutValidation(
    "example.myshopify.com",
    {
      graphQL: async () => ({
        data: {
          validations: {
            nodes: [
              validationNode({
                errorHistory: {
                  errorsFirstOccurredAt: "2026-07-24T00:00:00Z",
                  hasBeenSharedSinceLastError: false,
                },
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    },
  );

  assert.equal(result.active, true);
  assert.equal(result.runtimeErrorDetected, true);
});

test("runtime error history prevents checkout validation activation", async () => {
  let mutationCount = 0;
  const graphQL = async ({ query }) => {
    if (
      query.includes("validationCreate") ||
      query.includes("validationUpdate")
    ) {
      mutationCount += 1;
    }
    return {
      data: {
        validations: {
          nodes: [
            validationNode({
              enabled: false,
              errorHistory: {
                errorsFirstOccurredAt: "2026-07-24T00:00:00Z",
                hasBeenSharedSinceLastError: false,
              },
            }),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
  };

  const result = await ensureMarketplaceCheckoutValidation(
    "example.myshopify.com",
    { graphQL },
  );

  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(result.reason, "validation_runtime_error_detected");
  assert.equal(mutationCount, 0);
});
