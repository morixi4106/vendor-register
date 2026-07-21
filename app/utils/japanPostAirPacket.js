export const JAPAN_POST_AIR_PACKET_RATE_VERSION = "2026-06-01";
export const JAPAN_POST_AIR_PACKET_RATE_SOURCE = "japan_post_air_packet";
export const JAPAN_POST_AIR_PACKET_MAX_WEIGHT_GRAMS = 2000;

const RATES_BY_ZONE = Object.freeze({
  1: [720, 820, 920, 1020, 1120, 1220, 1320, 1420, 1520, 1620, 1720, 1820, 1920, 2020, 2120, 2220, 2320, 2420, 2520, 2620],
  2: [750, 870, 990, 1110, 1230, 1350, 1470, 1590, 1710, 1830, 1950, 2070, 2190, 2310, 2430, 2550, 2670, 2790, 2910, 3030],
  3: [880, 1060, 1240, 1420, 1600, 1780, 1960, 2140, 2320, 2500, 2680, 2860, 3040, 3220, 3400, 3580, 3760, 3940, 4120, 4300],
  4: [1200, 1410, 1620, 1830, 2040, 2250, 2460, 2670, 2880, 3090, 3300, 3510, 3720, 3930, 4140, 4350, 4560, 4770, 4980, 5190],
  5: [920, 1180, 1440, 1700, 1960, 2220, 2480, 2740, 3000, 3260, 3520, 3780, 4040, 4300, 4560, 4820, 5080, 5340, 5600, 5860],
});

const ZONE_1 = new Set(["CN", "KR", "TW"]);
const ZONE_2 = new Set([
  "AF", "BD", "BN", "BT", "HK", "ID", "IN", "KH", "KP", "LA",
  "LK", "MM", "MN", "MO", "MV", "MY", "NP", "PK", "PH",
  "SG", "TH", "TL", "VN",
]);
const ZONE_3 = new Set([
  "AD", "AE", "AL", "AM", "AT", "AU", "AZ", "BA", "BE", "BG", "BH", "BM", "BY", "CA",
  "CC", "CH", "CK", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FJ", "FM", "FO",
  "FR", "GB", "GE", "GG", "GI", "GR", "HR", "HU", "IE", "IL", "IM",
  "IQ", "IR", "IS", "IT", "JE", "JO", "KG", "KI", "KZ", "KW", "LB",
  "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MH", "MK", "MT", "MX", "NC",
  "NL", "NO", "NR", "NU", "NZ", "OM", "PF", "PG", "PM", "PN", "PL", "PT", "PW", "QA",
  "RO", "RS", "RU", "SA", "SB", "SE", "SI", "SK", "SM", "SY", "TJ", "TK", "TO", "TR",
  "TM", "TV", "UA", "UZ", "VA", "VU", "WS", "YE",
]);
const ZONE_4 = new Set(["AS", "GU", "MP", "PR", "UM", "US", "VI"]);
const ZONE_5 = new Set([
  "AO", "AR", "AW", "BB", "BF", "BI", "BJ", "BL", "BO",
  "BQ", "BR", "BS", "BW", "BZ", "CD", "CF", "CG", "CI", "CL",
  "CM", "CO", "CR", "CU", "CV", "CW", "DJ", "DM", "DO", "DZ", "EC",
  "EG", "EH", "ER", "ET", "FK", "GA", "GD", "GF", "GH", "GM", "GN",
  "GP", "GQ", "GS", "GT", "GW", "GY", "HN", "HT", "JM", "KE", "KM",
  "KN", "KY", "LC", "LR", "LS", "LY", "MA", "MF", "MG", "ML", "MQ",
  "MR", "MS", "MU", "MW", "MZ", "NA", "NE", "NG", "NI", "PA", "PE",
  "PY", "RE", "RW", "SC", "SD", "SH", "SL", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SZ", "TC", "TD", "TG", "TT", "TZ", "UG", "UY",
  "VC", "VE", "VG", "ZA", "ZM", "ZW",
]);

export const JAPAN_POST_AIR_PACKET_COUNTRY_CODES = Object.freeze(
  Array.from(
    new Set([...ZONE_1, ...ZONE_2, ...ZONE_3, ...ZONE_4, ...ZONE_5]),
  ).sort(),
);

export function resolveJapanPostAirPacketZone(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (ZONE_1.has(code)) return 1;
  if (ZONE_2.has(code)) return 2;
  if (ZONE_3.has(code)) return 3;
  if (ZONE_4.has(code)) return 4;
  if (ZONE_5.has(code)) return 5;
  return null;
}

export function quoteJapanPostAirPacket({ countryCode, weightGrams } = {}) {
  const weight = Number(weightGrams);
  const zone = resolveJapanPostAirPacketZone(countryCode);

  if (!zone) {
    return { ok: false, reason: "air_packet_country_unsupported" };
  }
  if (!Number.isFinite(weight) || weight <= 0) {
    return { ok: false, reason: "shipping_weight_missing" };
  }
  if (weight > JAPAN_POST_AIR_PACKET_MAX_WEIGHT_GRAMS) {
    return { ok: false, reason: "air_packet_weight_exceeded" };
  }

  const weightBandGrams = Math.ceil(weight / 100) * 100;
  const rateIndex = weightBandGrams / 100 - 1;
  const amount = RATES_BY_ZONE[zone]?.[rateIndex];

  if (!Number.isFinite(amount)) {
    return { ok: false, reason: "air_packet_rate_missing" };
  }

  return {
    ok: true,
    amount,
    currencyCode: "JPY",
    zone,
    weightBandGrams,
    rateVersion: JAPAN_POST_AIR_PACKET_RATE_VERSION,
    rateSource: JAPAN_POST_AIR_PACKET_RATE_SOURCE,
  };
}
