import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProductShippingProfileFormData,
  PRODUCT_SHIPPING_METHOD,
  validateStoredAirPacketProfile,
} from "../../app/utils/productShippingProfile.js";

function formData(values) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, String(value));
  }
  return data;
}

test("product shipping profile accepts a domestic packaged weight", () => {
  const result = parseProductShippingProfileFormData(
    formData({
      shippingWeightGrams: 350,
      shippingWeightConfirmed: 1,
      internationalShippingMethod: PRODUCT_SHIPPING_METHOD.DOMESTIC_ONLY,
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    data: {
      shippingWeightGrams: 350,
      shippingLengthMm: null,
      shippingWidthMm: null,
      shippingHeightMm: null,
      internationalShippingMethod: PRODUCT_SHIPPING_METHOD.DOMESTIC_ONLY,
      shippingWeightConfirmed: true,
    },
  });
});

test("product shipping profile stores Air Packet dimensions in millimeters", () => {
  const result = parseProductShippingProfileFormData(
    formData({
      shippingWeightGrams: 800,
      shippingWeightConfirmed: 1,
      internationalShippingMethod: PRODUCT_SHIPPING_METHOD.AIR_PACKET,
      shippingLengthCm: 25.5,
      shippingWidthCm: 18,
      shippingHeightCm: 7.5,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.shippingLengthMm, 255);
  assert.equal(result.data.shippingWidthMm, 180);
  assert.equal(result.data.shippingHeightMm, 75);
});

test("product shipping profile rejects Air Packet limit violations", () => {
  const overweight = parseProductShippingProfileFormData(
    formData({
      shippingWeightGrams: 2001,
      shippingWeightConfirmed: 1,
      internationalShippingMethod: PRODUCT_SHIPPING_METHOD.AIR_PACKET,
      shippingLengthCm: 20,
      shippingWidthCm: 20,
      shippingHeightCm: 20,
    }),
  );
  const oversized = validateStoredAirPacketProfile({
    internationalShippingMethod: PRODUCT_SHIPPING_METHOD.AIR_PACKET,
    shippingWeightGrams: 1000,
    shippingLengthMm: 601,
    shippingWidthMm: 100,
    shippingHeightMm: 100,
    shippingWeightConfirmedAt: new Date("2026-07-21T00:00:00.000Z"),
    shippingWeightSource: "MANUAL_CONFIRMED",
    shopifyVariantCount: 1,
    shopifyWeightSyncStatus: "SYNCED",
  });

  assert.equal(overweight.ok, false);
  assert.match(overweight.error, /2,000g/);
  assert.deepEqual(oversized, {
    ok: false,
    reason: "air_packet_longest_side_exceeded",
  });
});
