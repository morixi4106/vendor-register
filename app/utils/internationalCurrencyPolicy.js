export const INTERNATIONAL_CURRENCY_POLICY = "international-sale-2026-10-v2";
export const INTERNATIONAL_SHOP_PROJECTION_VERSION = 3;
export const INTERNATIONAL_CURRENCIES = Object.freeze(["JPY"]);

export function requireInternationalCurrencies(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "JPY")
    throw Object.assign(new Error("international_currency_unsupported"), {
      code: "international_currency_unsupported",
      status: 422,
    });
  return ["JPY"];
}

export function isInternationalPolicyPair(policy, version) {
  return (
    (policy === "international-sale-2026-10-v1" && version === 2) ||
    (policy === INTERNATIONAL_CURRENCY_POLICY &&
      version === INTERNATIONAL_SHOP_PROJECTION_VERSION)
  );
}
