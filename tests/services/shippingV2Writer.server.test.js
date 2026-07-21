import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShippingRateSnapshot,
  buildShippingV2QuoteRequest,
} from "../../app/services/shippingV2Writer.server.js";

test("Shipping V2 writer preserves the strict international product profile", () => {
  const request = buildShippingV2QuoteRequest({
    shopDomain: "example.myshopify.com",
    shippingAddress: { countryCode: "FR", zip: "75001" },
    lines: [
      {
        productId: "product-1",
        variantId: "variant-1",
        quantity: 2,
        grams: 780,
        shippingLengthMm: 250,
        shippingWidthMm: 180,
        shippingHeightMm: 70,
        internationalShippingMethod: "AIR_PACKET",
        shippingWeightConfirmed: true,
        shippingWeightSource: "MANUAL_CONFIRMED",
        shopifyVariantCount: 1,
        shopifyWeightSyncStatus: "SYNCED",
      },
    ],
  });

  assert.deepEqual(request.orderLike.lines[0], {
    variantId: "variant-1",
    productId: "product-1",
    quantity: 2,
    grams: 780,
    shippingLengthMm: 250,
    shippingWidthMm: 180,
    shippingHeightMm: 70,
    internationalShippingMethod: "AIR_PACKET",
    shippingWeightSource: "MANUAL_CONFIRMED",
    shopifyWeightSyncStatus: "SYNCED",
    shippingWeightConfirmed: true,
    shopifyVariantCount: 1,
  });
});

test("Shipping V2 rate snapshot stores source, version, zone, band, and amount", () => {
  const snapshot = buildShippingRateSnapshot({
    ok: true,
    result: {
      rateSource: "japan_post_air_packet",
      currencyCode: "JPY",
      totalShippingFee: 2140,
    },
    debug: {
      rateVersion: "2026-06-01",
      countryCode: "FR",
      groups: [
        {
          mode: "air_packet",
          regionTier: "air_packet_zone_3",
          packageCount: 1,
          fee: 2140,
          lineQuotes: [
            {
              amountPerUnit: 2140,
              quantity: 1,
              zone: 3,
              packedWeightGrams: 780,
              weightBandGrams: 800,
              rateVersion: "2026-06-01",
              rateSource: "japan_post_air_packet",
            },
          ],
        },
      ],
    },
  });

  assert.equal(snapshot.version, "2026-06-01");
  assert.equal(snapshot.source, "japan_post_air_packet");
  assert.equal(snapshot.totalShippingFee, 2140);
  assert.equal(snapshot.groups[0].regionTier, "air_packet_zone_3");
  assert.equal(snapshot.groups[0].lineQuotes[0].weightBandGrams, 800);
});
