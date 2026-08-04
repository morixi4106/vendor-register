import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuickActions,
  buildShopifyReconciliation,
  formatMoney,
  formatMoneyInputValue,
} from "../../app/components/withdrawals/withdrawalDetailViewModel.js";

test("withdrawal money formatting respects currency minor units", () => {
  assert.equal(formatMoney(1650, "JPY"), "1,650 JPY");
  assert.equal(formatMoney(1650, "USD"), "16.50 USD");
  assert.equal(formatMoneyInputValue(1650, "JPY"), "1650");
  assert.equal(formatMoneyInputValue(1650, "USD"), "16.50");
});

test("requested withdrawals expose only the initial quick actions", () => {
  const actions = buildQuickActions({
    status: "REQUESTED",
    completionStatus: "UNDECIDED",
    returnRequirementStatus: "UNDECIDED",
  });

  assert.deepEqual(
    actions.map((action) => action.key),
    ["acknowledge", "start_review"],
  );
});

test("completed withdrawals do not expose workflow transition shortcuts", () => {
  assert.deepEqual(
    buildQuickActions({
      status: "REFUNDED",
      completionStatus: "REFUNDED",
      returnRequirementStatus: "RECEIVED",
    }),
    [],
  );
});

test("Shopify reconciliation reports a refund record without a Shopify refund id", () => {
  const reconciliation = buildShopifyReconciliation(
    {
      orderSnapshotJson: {
        currencyCode: "JPY",
        financialStatus: "REFUNDED",
      },
      completionStatus: "REFUNDED",
      refundDecisionStatus: "FULL_REFUND",
      completionRefundedAmount: 1650,
      refundTotalAmount: 1650,
      returnRequirementStatus: "NOT_REQUIRED",
      emailLogs: [],
    },
    "JPY",
  );

  assert.equal(
    reconciliation.issues.includes(
      "返金済みの完了記録ですが、Shopify返金IDが未記録です。",
    ),
    true,
  );
});
