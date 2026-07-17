import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWithdrawalLocale,
  getWithdrawalDictionary,
  parseWithdrawalAcceptLanguage,
  resolveWithdrawalLocale,
} from "../../app/utils/withdrawalLocale.js";
import {
  buildWithdrawalAcknowledgementSnapshot,
  buildWithdrawalCompletionSnapshot,
  buildWithdrawalStatusSnapshot,
} from "../../app/services/withdrawalEmailTemplates.js";

test("withdrawal locale resolution keeps an explicit or saved correspondence language", () => {
  assert.equal(
    resolveWithdrawalLocale({ urlLocale: "ja", acceptLanguage: "en-GB" }).locale,
    "ja-JP",
  );
  assert.equal(
    resolveWithdrawalLocale({ savedLocale: "en-GB", acceptLanguage: "ja" }).locale,
    "en-GB",
  );
  assert.equal(parseWithdrawalAcceptLanguage("fr;q=0.9, ja;q=0.8, en;q=0.7"), "ja-JP");
});

test("withdrawal locale links preserve the selected language", () => {
  assert.equal(
    appendWithdrawalLocale("/apps/vendors/withdrawal?embedded=1", "en-GB"),
    "/apps/vendors/withdrawal?embedded=1&lang=en-GB",
  );
});

test("buyer email snapshots use the saved correspondence language", () => {
  const request = {
    id: "request-1",
    correspondenceLocale: "en-GB",
    submittedAt: new Date("2026-07-17T12:00:00.000Z"),
    shopifyOrderName: "#1001",
    withdrawalScope: "FULL",
    consumerLawCountry: "DE",
    status: "RETURN_REQUESTED",
    completionStatus: "REFUNDED",
    completionRefundedAmount: 1000,
    completionRefundedShipping: 200,
    completionCurrencyCode: "EUR",
    customerName: "Test Buyer",
    customerEmail: "buyer@example.com",
    submissionLegalBundleVersion: "eu-withdrawal-2026-07",
    submittedPayloadJson: {
      customerName: "Test Buyer",
      customerEmail: "buyer@example.com",
      orderNumber: "#1001",
      withdrawalScope: "PARTIAL",
      selectedLineItems: [{ title: "Test coat", quantity: 2 }],
      receivedDate: "2026-07-16T00:00:00.000Z",
      itemCondition: "Opened for inspection",
      reason: "No longer needed",
      countryCode: "DE",
    },
  };
  const acknowledgement = buildWithdrawalAcknowledgementSnapshot(request);
  const status = buildWithdrawalStatusSnapshot(request);
  const completion = buildWithdrawalCompletionSnapshot(request);

  assert.match(acknowledgement.subject, /received/i);
  assert.match(acknowledgement.text, /Test Buyer/);
  assert.match(acknowledgement.text, /buyer@example\.com/);
  assert.match(acknowledgement.text, /Test coat x 2/);
  assert.match(acknowledgement.text, /eu-withdrawal-2026-07/);
  assert.match(acknowledgement.text, /Server receipt time \(UTC\)/);
  assert.match(status.text, /Return the goods/i);
  assert.match(completion.text, /standard outbound delivery/i);
  assert.doesNotMatch(completion.text, /返金/);
  assert.equal(getWithdrawalDictionary("en-GB").returnProof.submit, "Submit proof of return");
});
