import assert from "node:assert/strict";
import test from "node:test";

import {
  isSingleOperatorPayoutReadinessAllowed,
  SINGLE_OPERATOR_PAYOUT_SCOPE,
} from "../../app/utils/singleOperatorReadiness.js";

test("single-operator payout readiness requires an explicit opt-in", () => {
  assert.equal(isSingleOperatorPayoutReadinessAllowed({}), false);
  assert.equal(
    isSingleOperatorPayoutReadinessAllowed({
      SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED: "true",
    }),
    true,
  );
  assert.equal(SINGLE_OPERATOR_PAYOUT_SCOPE, "DOMESTIC_PLATFORM_DIRECT_ONLY");
});

test("every third-party commerce path invalidates single-operator payout readiness", () => {
  const flags = [
    "PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED",
    "MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED",
    "MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED",
    "MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED",
    "MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED",
    "MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED",
    "MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED",
    "DOMESTIC_SELLER_SETTLEMENT_ENABLED",
    "CROSS_BORDER_SELLER_SETTLEMENT_ENABLED",
  ];

  for (const flag of flags) {
    assert.equal(
      isSingleOperatorPayoutReadinessAllowed({
        SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED: "true",
        [flag]: "true",
      }),
      false,
      flag,
    );
  }
});
