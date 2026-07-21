import assert from "node:assert/strict";
import test from "node:test";

import {
  quoteJapanPostAirPacket,
  resolveJapanPostAirPacketZone,
} from "../../app/services/japanPostAirPacket.server.js";

test("Japan Post Air Packet resolves representative destination zones", () => {
  assert.equal(resolveJapanPostAirPacketZone("KR"), 1);
  assert.equal(resolveJapanPostAirPacketZone("SG"), 2);
  assert.equal(resolveJapanPostAirPacketZone("FR"), 3);
  assert.equal(resolveJapanPostAirPacketZone("US"), 4);
  assert.equal(resolveJapanPostAirPacketZone("ZA"), 5);
  assert.equal(resolveJapanPostAirPacketZone("JP"), null);
});

test("Japan Post Air Packet rounds weight up to the next 100 gram band", () => {
  const quote = quoteJapanPostAirPacket({ countryCode: "FR", weightGrams: 101 });

  assert.equal(quote.ok, true);
  assert.equal(quote.zone, 3);
  assert.equal(quote.weightBandGrams, 200);
  assert.equal(quote.amount, 1060);
});

test("Japan Post Air Packet accepts exactly 2kg and rejects heavier parcels", () => {
  const maximum = quoteJapanPostAirPacket({ countryCode: "US", weightGrams: 2000 });
  const tooHeavy = quoteJapanPostAirPacket({ countryCode: "US", weightGrams: 2001 });

  assert.equal(maximum.ok, true);
  assert.equal(maximum.amount, 5190);
  assert.deepEqual(tooHeavy, {
    ok: false,
    reason: "air_packet_weight_exceeded",
  });
});

test("Japan Post Air Packet fails closed for missing data and unsupported destinations", () => {
  assert.deepEqual(
    quoteJapanPostAirPacket({ countryCode: "JP", weightGrams: 100 }),
    { ok: false, reason: "air_packet_country_unsupported" },
  );
  assert.deepEqual(
    quoteJapanPostAirPacket({ countryCode: "FR", weightGrams: null }),
    { ok: false, reason: "shipping_weight_missing" },
  );
});
