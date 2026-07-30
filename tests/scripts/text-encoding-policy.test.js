import assert from "node:assert/strict";
import test from "node:test";

import { containsLikelyMojibake } from "../../scripts/text-encoding-policy.mjs";

test("text encoding policy detects UTF-8 mojibake seen in Japanese UI copy", () => {
  const brokenText = String.fromCodePoint(0x7e3a, 0x8599, 0xff65, 0x903e);
  assert.equal(containsLikelyMojibake(brokenText), true);
  assert.equal(containsLikelyMojibake("本番注文・返金 E2E確認"), false);
  assert.equal(containsLikelyMojibake("MarketplaceOrderを照合します。"), false);
});
