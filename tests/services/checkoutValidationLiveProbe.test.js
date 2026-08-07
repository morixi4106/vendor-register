import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS,
  CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIO_COUNT,
} from "../../app/services/checkoutValidationLiveProbe.js";

test("checkout live probe keeps 16 unique release-bound scenarios", () => {
  const ids = CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS.map(({ id }) => id);

  assert.equal(CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIO_COUNT, 16);
  assert.equal(new Set(ids).size, ids.length);
});

test("Function revision evidence covers invalid r=0, not server-side stale writes", () => {
  const invalidRevision = CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS.find(
    ({ id }) => id === "invalidRevisionRejected",
  );

  assert.deepEqual(invalidRevision, {
    id: "invalidRevisionRejected",
    label: "不正なcontrol revision（r=0）で購入が拒否された",
    expectedResult: "checkout_rejected",
  });
  assert.equal(
    CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS.some(
      ({ id }) => id === "staleRevisionRejected",
    ),
    false,
  );
});
