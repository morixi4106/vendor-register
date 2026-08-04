import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateCheckForDisplay,
  statusSortOrder,
} from "../../app/components/readiness/productionReadinessViewModel.js";

test("production readiness orders blocking checks before advisory checks", () => {
  const statuses = ["pass", "manual", "fail", "warning", "optional"];

  assert.deepEqual(
    statuses.sort((a, b) => statusSortOrder(a) - statusSortOrder(b)),
    ["fail", "warning", "manual", "optional", "pass"],
  );
});

test("unused Stripe warnings are presented as optional", () => {
  const result = decorateCheckForDisplay(
    {
      id: "stripe_secret_key_live",
      title: "Stripe secret key",
      category: "stripe",
      status: "warning",
      detail: "missing",
      action: "configure",
    },
    { operation: { stripeConnectProductionEnabled: false } },
  );

  assert.equal(result.displayStatus, "optional");
  assert.match(result.displayDetail, /現在の本番導線では使いません/);
});

test("scope-excluded checks retain their release decision reason", () => {
  const result = decorateCheckForDisplay(
    {
      id: "example",
      title: "Example",
      category: "app",
      status: "warning",
      detail: "raw detail",
      action: "raw action",
      releaseDisposition: "scope_excluded",
      releaseDispositionReason: "国内直販の公開範囲外",
      releaseBlocking: false,
    },
    { operation: {} },
  );

  assert.equal(result.displayStatus, "optional");
  assert.equal(result.displayDetail, "国内直販の公開範囲外");
  assert.equal(result.displayAction, "");
});
