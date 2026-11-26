import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutBrowserPlanCapacity,
  CHECKOUT_BROWSER_MAX_SESSIONS,
} from "../../app/utils/internationalCheckoutCapacity.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";
import { checkoutBrowserCapacityCases } from "../helpers/internationalCheckoutBrowserFixture.js";

test("capacity counts reused old checkouts separately and accepts the exact 256-session boundary", () => {
  assert.deepEqual(
    checkoutBrowserPlanCapacity(checkoutBrowserCapacityCases(1)),
    {
      caseCount: 5,
      sessionCount: 4,
      retainedSessionCount: 1,
    },
  );
  assert.deepEqual(
    checkoutBrowserPlanCapacity(checkoutBrowserCapacityCases(127)),
    {
      caseCount: 383,
      sessionCount: CHECKOUT_BROWSER_MAX_SESSIONS,
      retainedSessionCount: 127,
    },
  );
  assert.throws(
    () => checkoutBrowserPlanCapacity(checkoutBrowserCapacityCases(128)),
    (e) => e.code === "international_checkout_session_limit",
  );
});

test("capacity refuses duplicates, orphaned old/new contexts, invalid rows and unsupported GB before execution", () => {
  for (const mutate of [
    (rows) => rows.push(rows[0]),
    (rows) =>
      rows.splice(
        rows.findIndex((row) => row.scenario === "allowed-before-payment"),
        1,
      ),
    (rows) =>
      rows.splice(
        rows.findIndex((row) => row.scenario === "old-checkout-blocked"),
        1,
      ),
    (rows) =>
      rows.splice(
        rows.findIndex((row) => row.scenario === "new-checkout-blocked"),
        1,
      ),
    (rows) => {
      rows[0].caseKey = "a".repeat(64);
    },
    (rows) => {
      rows.length = 2049;
    },
    (rows) => {
      for (const row of rows.filter((row) => row.target.country === "US")) {
        row.target.country = "GB";
        const { caseKey: _key, ...body } = row;
        row.caseKey = proofHash(body);
      }
    },
  ]) {
    const rows = checkoutBrowserCapacityCases(1);
    mutate(rows);
    assert.throws(() => checkoutBrowserPlanCapacity(rows));
  }
});
