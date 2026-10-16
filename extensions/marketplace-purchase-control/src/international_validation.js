export const INTERNATIONAL_POLICY_VERSION = "international-sale-2026-10-v1";
const ERROR = "海外販売条件を確認できないため、この配送先への注文を受け付けられません。";
const NI_ERROR = "現在、北アイルランドへの配送は受け付けていません。";
const COUNTRY_CODES = new Set((
  "AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" "));

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parse(value, version, currentDate) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const row = JSON.parse(value);
    if (!row || Array.isArray(row) || row.v !== version || row.p !== INTERNATIONAL_POLICY_VERSION ||
        !Number.isSafeInteger(row.g) || row.g < 1 || !validDate(currentDate) ||
        !validDate(row.d) || !validDate(row.e) || row.d > currentDate || currentDate >= row.e ||
        !/^[a-f0-9]{64}$/.test(row.h || "") || !Array.isArray(row.c) || row.c.length > 128 ||
        row.c.some((country, index) => !COUNTRY_CODES.has(country) || country === "JP" ||
          (index > 0 && row.c[index - 1] >= country))) return null;
    return row;
  } catch {
    return null;
  }
}

function gbError(address) {
  const zip = String(address.zip || "").toUpperCase().replace(/\s/g, "");
  if (zip.startsWith("BT")) return NI_ERROR;
  return /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/.test(zip)
    ? null : ERROR;
}

export function getInternationalDestinationError(input, currentDate) {
  const step = input.buyerJourney?.step;
  if (!["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"].includes(step)) return ERROR;
  const lines = input.cart?.lines;
  const groups = input.cart?.deliveryGroups;
  if (!Array.isArray(lines) || lines.length > 200 || !Array.isArray(groups) || groups.length > 200) return ERROR;
  const byId = new Map();
  for (const line of lines) {
    if (typeof line.id !== "string" || !line.id || byId.has(line.id) ||
        typeof line.merchandise?.requiresShipping !== "boolean") return ERROR;
    byId.set(line.id, line);
  }
  const physical = lines.filter((line) => line.merchandise.requiresShipping);
  const containsNonPhysical = physical.length !== lines.length;
  const parsedProducts = new Map();
  const completion = step === "CHECKOUT_COMPLETION";
  if (!groups.length) return completion && physical.length ? ERROR : null;
  const covered = new Set();
  let traversed = 0;
  let bytes = 0;
  let gate;
  for (const group of groups) {
    const address = group?.deliveryAddress;
    const country = address?.countryCode;
    if (!country && !completion && groups.length === 1) return null;
    if (!COUNTRY_CODES.has(country) || !Array.isArray(group.cartLines) || !group.cartLines.length) return ERROR;
    if (country === "GB") {
      const error = gbError(address);
      if (error) return error;
    }
    const groupIds = new Set();
    for (const member of group.cartLines) {
      if (++traversed > 400 || groupIds.has(member?.id)) return ERROR;
      const line = byId.get(member?.id);
      if (!line || line.merchandise.requiresShipping !== true) return ERROR;
      groupIds.add(member.id);
      covered.add(member.id);
      if (country === "JP") continue;
      if (containsNonPhysical) return ERROR;
      gate ??= parse(input.shop?.internationalSaleGate?.value, 2, currentDate);
      if (!gate || gate.s !== "ACTIVE" || !gate.c.includes(country)) return ERROR;
      const serialized = line.merchandise.product?.internationalSaleEligibility?.value;
      bytes += typeof serialized === "string" ? serialized.length : 0;
      if (bytes > 96000) return ERROR;
      let projection = parsedProducts.get(serialized);
      if (projection === undefined) {
        projection = parse(serialized, 1, currentDate);
        parsedProducts.set(serialized, projection);
      }
      if (!projection || projection.g !== gate.g ||
          projection.i !== line.merchandise.product?.id ||
          !Number.isSafeInteger(projection.r) || projection.r < 1 ||
          !projection.c.includes(country)) return ERROR;
    }
  }
  return physical.some((line) => !covered.has(line.id)) ? ERROR : null;
}
