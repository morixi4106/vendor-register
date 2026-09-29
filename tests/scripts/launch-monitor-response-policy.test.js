import assert from "node:assert/strict";
import test from "node:test";

import { isExpectedPasswordCriticalPayload } from "../../scripts/launch-monitor-response-policy.mjs";

const passwordCritical = {
  id: "official_storefront",
  status: "critical",
  code: "password_page",
  count: 1,
};

function payload(checks, overrides = {}) {
  return {
    status: "critical",
    notificationKind: "alert",
    checks,
    ...overrides,
  };
}

test("accepts the password critical with allowlisted owner-risk warnings", () => {
  assert.equal(
    isExpectedPasswordCriticalPayload(
      payload([
        passwordCritical,
        {
          id: "operational_attestation_legal_disclosures_reviewed",
          status: "warning",
          code: "operational_attestation_legal_disclosures_reviewed",
          count: 1,
        },
        {
          id: "operational_attestation_platform_direct_payment_flow_verified",
          status: "warning",
          code: "operational_attestation_platform_direct_payment_flow_verified",
          count: 1,
        },
      ]),
    ),
    true,
  );
});

test("rejects any additional critical", () => {
  assert.equal(
    isExpectedPasswordCriticalPayload(
      payload([
        passwordCritical,
        {
          id: "render_http_5xx",
          status: "critical",
          code: "render_http_5xx",
          count: 1,
        },
      ]),
    ),
    false,
  );
});

test("rejects warnings outside the bounded owner-risk allowlist", () => {
  assert.equal(
    isExpectedPasswordCriticalPayload(
      payload([
        passwordCritical,
        {
          id: "shopify_product_catalog_sync_freshness",
          status: "warning",
          code: "catalog_sync_stale",
          count: 1,
        },
      ]),
    ),
    false,
  );
});

test("requires the first alert and the password-page code", () => {
  assert.equal(
    isExpectedPasswordCriticalPayload(
      payload([passwordCritical], { notificationKind: null }),
    ),
    false,
  );
  assert.equal(
    isExpectedPasswordCriticalPayload(
      payload([{ ...passwordCritical, code: "storefront_marker_missing" }]),
    ),
    false,
  );
});
