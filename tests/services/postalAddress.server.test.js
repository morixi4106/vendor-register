import assert from "node:assert/strict";
import test from "node:test";

import {
  formatJapanesePostalCode,
  lookupJapanesePostalAddress,
  normalizeJapanesePostalCode,
  normalizeZipCloudCandidates,
} from "../../app/services/postalAddress.server.js";

test("Japanese postal codes accept hyphens and normalize to seven digits", () => {
  assert.equal(normalizeJapanesePostalCode("100-0001"), "1000001");
  assert.equal(formatJapanesePostalCode("1000001"), "100-0001");
  assert.equal(normalizeJapanesePostalCode("100-001"), null);
});

test("ZipCloud candidates map prefecture, city, and town without duplicates", () => {
  const candidates = normalizeZipCloudCandidates([
    {
      zipcode: "1000001",
      address1: "東京都",
      address2: "千代田区",
      address3: "千代田",
    },
    {
      zipcode: "1000001",
      address1: "東京都",
      address2: "千代田区",
      address3: "千代田",
    },
  ]);

  assert.deepEqual(candidates, [
    {
      postalCode: "100-0001",
      region: "東京都",
      city: "千代田区",
      address1: "千代田",
    },
  ]);
});

test("postal address lookup returns normalized candidates", async () => {
  const result = await lookupJapanesePostalAddress("100-0001", {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          status: 200,
          results: [
            {
              zipcode: "1000001",
              address1: "東京都",
              address2: "千代田区",
              address3: "千代田",
            },
          ],
        };
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.candidates[0].city, "千代田区");
});
