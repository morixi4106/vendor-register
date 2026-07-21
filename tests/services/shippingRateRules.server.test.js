import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readShippingRateRuleConfig,
  resolveShippingRate,
} from '../../app/services/shippingRateRules.server.js';
import {
  quoteJapanPostAirPacket,
  resolveJapanPostAirPacketZone,
} from '../../app/services/japanPostAirPacket.server.js';

function createAirPacketLine(overrides = {}) {
  return {
    productId: 'product-extra',
    variantId: 'variant-extra',
    quantity: 1,
    requiresShipping: true,
    grams: 100,
    shippingLengthMm: 250,
    shippingWidthMm: 180,
    shippingHeightMm: 70,
    internationalShippingMethod: 'AIR_PACKET',
    shippingWeightConfirmed: true,
    shippingWeightSource: 'MANUAL_CONFIRMED',
    shopifyVariantCount: 1,
    shopifyWeightSyncStatus: 'SYNCED',
    ...overrides,
  };
}

function createInput(overrides = {}) {
  return {
    shippingAddress: {
      countryCode: 'JP',
      postalCode: '150-0001',
      province: 'JP-13',
      provinceCode: 'JP-13',
      provinceName: 'Tokyo',
      ...overrides.shippingAddress,
    },
    lines: [
      {
        productId: 'product-1',
        variantId: 'variant-1',
        quantity: 2,
        requiresShipping: true,
        grams: 500,
        shippingLengthMm: 250,
        shippingWidthMm: 180,
        shippingHeightMm: 70,
        internationalShippingMethod: 'AIR_PACKET',
        shippingWeightConfirmed: true,
        shippingWeightSource: 'MANUAL_CONFIRMED',
        shopifyVariantCount: 1,
        shopifyWeightSyncStatus: 'SYNCED',
        ...overrides.baseLine,
      },
      ...(overrides.lines || []),
    ],
    shippableLineCount: 1 + (overrides.lines || []).length,
    internationalServiceAvailabilityStatus:
      overrides.internationalServiceAvailabilityStatus || 'ACTIVE',
  };
}

test('shipping rate rules preserve domestic rates and use official Air Packet rates abroad', () => {
  const config = readShippingRateRuleConfig(null).config;

  assert.equal(resolveShippingRate(createInput(), config).totalShippingFee, 870);
  assert.equal(
    resolveShippingRate(
      createInput({
        shippingAddress: {
          countryCode: 'US',
          province: 'NY',
          provinceCode: null,
          provinceName: 'NY',
        },
      }),
      config,
    ).totalShippingFee,
    4080,
  );
});

test('shipping rate rules use Japan Post Air Packet zones for international destinations', () => {
  const config = readShippingRateRuleConfig(null).config;

  const cases = [
    ['SG', 'air_packet_zone_2', 2460],
    ['CA', 'air_packet_zone_3', 3200],
    ['FR', 'air_packet_zone_3', 3200],
    ['AU', 'air_packet_zone_3', 3200],
    ['ZA', 'air_packet_zone_5', 3920],
  ];

  for (const [countryCode, regionTier, totalShippingFee] of cases) {
    const resolution = resolveShippingRate(
      createInput({
        shippingAddress: {
          countryCode,
          province: null,
          provinceCode: null,
          provinceName: null,
        },
      }),
      config,
    );

    assert.equal(resolution.regionTier, regionTier);
    assert.equal(resolution.totalShippingFee, totalShippingFee);
  }
});

test('Japan Post Air Packet rates match every official 100g band in all five zones', () => {
  const expectedByZone = {
    1: [720, 820, 920, 1020, 1120, 1220, 1320, 1420, 1520, 1620, 1720, 1820, 1920, 2020, 2120, 2220, 2320, 2420, 2520, 2620],
    2: [750, 870, 990, 1110, 1230, 1350, 1470, 1590, 1710, 1830, 1950, 2070, 2190, 2310, 2430, 2550, 2670, 2790, 2910, 3030],
    3: [880, 1060, 1240, 1420, 1600, 1780, 1960, 2140, 2320, 2500, 2680, 2860, 3040, 3220, 3400, 3580, 3760, 3940, 4120, 4300],
    4: [1200, 1410, 1620, 1830, 2040, 2250, 2460, 2670, 2880, 3090, 3300, 3510, 3720, 3930, 4140, 4350, 4560, 4770, 4980, 5190],
    5: [920, 1180, 1440, 1700, 1960, 2220, 2480, 2740, 3000, 3260, 3520, 3780, 4040, 4300, 4560, 4820, 5080, 5340, 5600, 5860],
  };
  const representativeCountry = { 1: 'CN', 2: 'HK', 3: 'FR', 4: 'US', 5: 'BR' };

  for (const [zone, expectedRates] of Object.entries(expectedByZone)) {
    for (const [index, expectedAmount] of expectedRates.entries()) {
      const weightGrams = (index + 1) * 100;
      const quote = quoteJapanPostAirPacket({
        countryCode: representativeCountry[zone],
        weightGrams,
      });

      assert.equal(quote.ok, true);
      assert.equal(quote.zone, Number(zone));
      assert.equal(quote.weightBandGrams, weightGrams);
      assert.equal(quote.amount, expectedAmount);
    }
  }
});

test('Japan Post Air Packet country zones cover the high-risk country mappings', () => {
  const cases = {
    CN: 1, KR: 1, TW: 1,
    HK: 2, MO: 2,
    CA: 3, MX: 3, DE: 3, FR: 3, AU: 3,
    US: 4, GU: 4, PR: 4, VI: 4,
    BR: 5, AR: 5, ZA: 5, EG: 5,
  };

  for (const [countryCode, expectedZone] of Object.entries(cases)) {
    assert.equal(resolveJapanPostAirPacketZone(countryCode), expectedZone);
  }

  for (const euCountry of [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE',
    'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT',
    'RO', 'SK', 'SI', 'ES', 'SE',
  ]) {
    assert.equal(resolveJapanPostAirPacketZone(euCountry), 3);
  }
});

test('international Air Packet weight bands round upward and fail outside the limits', () => {
  const cases = [
    [1, 720],
    [100, 720],
    [101, 820],
    [1999, 2620],
    [2000, 2620],
  ];

  for (const [weightGrams, expectedAmount] of cases) {
    const quote = quoteJapanPostAirPacket({ countryCode: 'CN', weightGrams });
    assert.equal(quote.ok, true);
    assert.equal(quote.amount, expectedAmount);
  }

  assert.equal(
    quoteJapanPostAirPacket({ countryCode: 'CN', weightGrams: 2001 }).reason,
    'air_packet_weight_exceeded',
  );
  assert.equal(
    quoteJapanPostAirPacket({ countryCode: 'XX', weightGrams: 100 }).reason,
    'air_packet_country_unsupported',
  );
});

test('shipping rate rules fail closed when an international profile is missing', () => {
  const resolution = resolveShippingRate(
    createInput({
      shippingAddress: {
        countryCode: 'FR',
        province: null,
        provinceCode: null,
        provinceName: null,
      },
      lines: [
        {
          productId: 'product-unconfigured',
          variantId: 'variant-unconfigured',
          quantity: 1,
          requiresShipping: true,
          grams: 300,
          internationalShippingMethod: 'UNCONFIGURED',
        },
      ],
    }),
  );

  assert.equal(resolution.isDeliverable, false);
  assert.equal(resolution.totalShippingFee, null);
  assert.equal(resolution.rateSource, 'japan_post_air_packet');
  assert.equal(resolution.matchedRuleId, 'international_shipping_not_enabled');
});

test('international Air Packet fails closed for every unverified profile state', () => {
  const cases = [
    [{ shippingWeightConfirmed: false }, 'shipping_weight_unverified'],
    [{ shippingWeightSource: 'SHOPIFY_IMPORTED' }, 'shipping_weight_unverified'],
    [{ shopifyVariantCount: 2 }, 'multiple_variants_unsupported'],
    [{ shopifyWeightSyncStatus: 'PENDING' }, 'shopify_weight_sync_incomplete'],
    [{ shippingLengthMm: null }, 'shipping_dimensions_missing'],
    [{ shippingLengthMm: 601 }, 'air_packet_longest_side_exceeded'],
    [{ shippingLengthMm: 600, shippingWidthMm: 200, shippingHeightMm: 101 }, 'air_packet_dimensions_exceeded'],
    [{ shippingLengthMm: 147, shippingWidthMm: 105, shippingHeightMm: 20 }, 'air_packet_minimum_dimensions_not_met'],
    [{ shippingLengthMm: 148, shippingWidthMm: 104, shippingHeightMm: 20 }, 'air_packet_minimum_dimensions_not_met'],
    [{ shippingClass: 'cool' }, 'air_packet_shipping_class_unsupported'],
    [{ temperatureZone: 'chilled' }, 'air_packet_shipping_class_unsupported'],
  ];

  for (const [baseLine, expectedReason] of cases) {
    const resolution = resolveShippingRate(
      createInput({
        shippingAddress: { countryCode: 'FR' },
        baseLine,
      }),
    );
    assert.equal(resolution.isDeliverable, false);
    assert.equal(resolution.matchedRuleId, expectedReason);
  }
});

test('international Air Packet accepts exact size boundaries and rejects inactive service status', () => {
  const boundary = resolveShippingRate(
    createInput({
      shippingAddress: { countryCode: 'FR' },
      baseLine: {
        shippingLengthMm: 600,
        shippingWidthMm: 200,
        shippingHeightMm: 100,
      },
    }),
  );
  assert.equal(boundary.isDeliverable, true);

  for (const status of ['UNKNOWN', 'PARTIAL', 'SUSPENDED']) {
    const unavailable = resolveShippingRate(
      createInput({
        shippingAddress: { countryCode: 'FR' },
        internationalServiceAvailabilityStatus: status,
      }),
    );
    assert.equal(unavailable.isDeliverable, false);
    assert.equal(unavailable.matchedRuleId, 'international_service_unavailable');
  }
});

test('international quantity uses multiplication and does not allocate one array entry per item', () => {
  const resolution = resolveShippingRate(
    createInput({
      shippingAddress: { countryCode: 'FR' },
      baseLine: { quantity: 100, grams: 100 },
    }),
  );

  assert.equal(resolution.isDeliverable, true);
  assert.equal(resolution.totalShippingFee, 88000);
  assert.equal(resolution.groups[0].packageCount, 100);
  assert.equal(resolution.groups[0].lineQuotes.length, 1);
  assert.equal(resolution.groups[0].lineQuotes[0].quantity, 100);
});

test('international quantity stays constant-memory for very large quantities', () => {
  const resolution = resolveShippingRate(
    createInput({
      shippingAddress: { countryCode: 'FR' },
      baseLine: { quantity: 1_000_000, grams: 100 },
    }),
  );

  assert.equal(resolution.isDeliverable, true);
  assert.equal(resolution.totalShippingFee, 880_000_000);
  assert.equal(resolution.groups[0].packageCount, 1_000_000);
  assert.equal(resolution.groups[0].lineQuotes.length, 1);
  assert.equal(resolution.groups[0].lineQuotes[0].quantity, 1_000_000);
});

test('international Air Packet keeps store shipment groups separate', () => {
  const sameStore = resolveShippingRate(
    createInput({
      shippingAddress: { countryCode: 'FR' },
      baseLine: { shipFromId: 'store-a' },
      lines: [createAirPacketLine({ shipFromId: 'store-a' })],
    }),
  );
  const differentStores = resolveShippingRate(
    createInput({
      shippingAddress: { countryCode: 'FR' },
      baseLine: { shipFromId: 'store-a' },
      lines: [createAirPacketLine({ shipFromId: 'store-b' })],
    }),
  );

  assert.equal(sameStore.groups.length, 1);
  assert.equal(sameStore.groups[0].lineQuotes.length, 2);
  assert.equal(differentStores.groups.length, 2);
  assert.deepEqual(
    differentStores.groups.map((group) => group.shipFromId).sort(),
    ['store-a', 'store-b'],
  );
});

test('domestic overrides and free shipping never leak into international Air Packet quotes', () => {
  const config = {
    rateOverrides: [
      {
        id: 'domestic-anywhere-override',
        variantIds: ['variant-1'],
        amount: 1,
      },
    ],
    freeShippingRule: {
      enabled: true,
      threshold: 1,
      eligibleModes: ['parcel', 'air_packet'],
    },
  };
  const domestic = resolveShippingRate(createInput(), config);
  const international = resolveShippingRate(
    createInput({ shippingAddress: { countryCode: 'FR' } }),
    config,
  );

  assert.equal(domestic.totalShippingFee, 1);
  assert.equal(domestic.rateSource, 'rate_override');
  assert.equal(international.totalShippingFee, 3200);
  assert.equal(international.rateSource, 'japan_post_air_packet');
  assert.equal(international.isFreeShippingThresholdMet, false);
});

test('shipping rate rules match province, variant, and weight constraints', () => {
  const resolution = resolveShippingRate(createInput(), {
    currencyCode: 'JPY',
    defaultAmount: 3500,
    rateOverrides: [
      {
        id: 'tokyo-light-variant',
        countryCodes: ['JP'],
        provinceCodes: ['JP-13'],
        variantIds: ['variant-1'],
        maxTotalWeightGrams: 1200,
        amount: 990,
      },
    ],
  });

  assert.equal(resolution.totalShippingFee, 990);
  assert.equal(resolution.matchedRuleId, 'tokyo-light-variant');
  assert.equal(resolution.totalWeightGrams, 1000);
});

test('shipping rate rules can mark unmatched destinations undeliverable', () => {
  const resolution = resolveShippingRate(
    createInput(),
    {
      feeMatrix: {
        parcel: {
          honshu: null,
        },
      },
    },
  );

  assert.equal(resolution.isDeliverable, false);
  assert.equal(resolution.totalShippingFee, null);
  assert.equal(resolution.rateSource, 'group_unavailable');
});

test('shipping rate rules split direct, cool, and normal shipment groups', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-cool',
          variantId: 'variant-cool',
          quantity: 1,
          requiresShipping: true,
          temperatureZone: 'chilled',
          shippingPoint: 1,
        },
        {
          productId: 'product-direct',
          variantId: 'variant-direct',
          quantity: 1,
          requiresShipping: true,
          shippingClass: 'direct',
          directShipGroup: 'maker-a',
          shippingPoint: 1,
        },
      ],
    }),
  );

  assert.equal(resolution.isDeliverable, true);
  assert.deepEqual(
    resolution.groups.map((group) => group.mode).sort(),
    ['cool', 'direct', 'parcel'],
  );
  assert.equal(resolution.groups.length, 3);
});

test('shipping rate rules apply free shipping only to eligible normal groups', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-cool',
          variantId: 'variant-cool',
          quantity: 1,
          requiresShipping: true,
          temperatureZone: 'chilled',
          amountAfterItemDiscountBeforeOrderCoupon: 1000,
        },
      ],
    }),
    {
      freeShippingRule: {
        enabled: true,
        threshold: 1000,
        eligibleModes: ['parcel'],
      },
    },
  );

  const parcelGroup = resolution.groups.find((group) => group.mode === 'parcel');
  const coolGroup = resolution.groups.find((group) => group.mode === 'cool');

  assert.equal(resolution.isFreeShippingThresholdMet, true);
  assert.equal(parcelGroup.fee, 0);
  assert.equal(parcelGroup.isFreeShippingApplied, true);
  assert.equal(coolGroup.isFreeShippingApplied, false);
});

test('shipping rate rules do not apply free shipping by default', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-2',
          variantId: 'variant-2',
          quantity: 1,
          requiresShipping: true,
          amountAfterItemDiscountBeforeOrderCoupon: 12000,
        },
      ],
    }),
  );

  assert.equal(resolution.isFreeShippingThresholdMet, false);
  assert.equal(resolution.groups.every((group) => group.isFreeShippingApplied === false), true);
  assert.equal(resolution.totalShippingFee, 870);
});

test('shipping rate rules estimate package count by shipping points', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [],
    }),
    {
      pointThresholdByMode: {
        parcel: 3,
      },
    },
  );

  assert.equal(resolution.groups[0].mode, 'parcel');
  assert.equal(resolution.groups[0].packageCount, 1);

  const oversized = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-2',
          variantId: 'variant-2',
          quantity: 2,
          requiresShipping: true,
          shippingPoint: 2,
        },
      ],
    }),
    {
      pointThresholdByMode: {
        parcel: 3,
      },
    },
  );

  assert.equal(oversized.groups[0].packageCount, 2);
  assert.equal(oversized.groups[0].fee, 1570);
});

test('shipping rate rule config reports invalid JSON without throwing', () => {
  const result = readShippingRateRuleConfig('{nope');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shipping_rule_config_error');
  assert.match(result.error, /JSON/);
});
