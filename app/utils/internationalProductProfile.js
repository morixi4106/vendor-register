import {
  PRODUCT_SHIPPING_METHOD,
  validateStoredAirPacketProfile,
} from "./productShippingProfile.js";

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizeHsCode(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

export function validateInternationalCustomsProfile(product) {
  const profile = product?.complianceProfile || product || {};
  const countryOfOriginCode = String(
    profile.countryOfOriginCode || "",
  ).trim().toUpperCase();
  const hsCode = normalizeHsCode(profile.hsCode);
  const customsDescriptionEn = normalizeText(profile.customsDescriptionEn);
  const regulatoryCategory = normalizeText(profile.regulatoryCategory);
  const reasons = [];

  if (!/^[A-Z]{2}$/.test(countryOfOriginCode)) {
    reasons.push("country_of_origin_invalid");
  }
  if (!/^\d{6,10}$/.test(hsCode)) {
    reasons.push("hs_code_invalid");
  }
  if (
    !customsDescriptionEn ||
    customsDescriptionEn.length < 3 ||
    customsDescriptionEn.length > 120 ||
    !/[A-Za-z]/.test(customsDescriptionEn)
  ) {
    reasons.push("customs_description_invalid");
  }
  if (!regulatoryCategory) {
    reasons.push("regulatory_category_missing");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    normalized: {
      countryOfOriginCode: countryOfOriginCode || null,
      hsCode: hsCode || null,
      customsDescriptionEn,
      regulatoryCategory,
    },
  };
}

export function validateInternationalProductProfile(product) {
  if (
    String(product?.internationalShippingMethod || "").toUpperCase() !==
    PRODUCT_SHIPPING_METHOD.AIR_PACKET
  ) {
    return {
      ok: false,
      reasons: ["international_shipping_not_enabled"],
      shipping: { ok: false, reason: "international_shipping_not_enabled" },
      customs: validateInternationalCustomsProfile(product),
    };
  }

  const shipping = validateStoredAirPacketProfile(product);
  const customs = validateInternationalCustomsProfile(product);
  const reasons = [
    ...(shipping.ok ? [] : [shipping.reason]),
    ...customs.reasons,
  ].filter(Boolean);

  return { ok: reasons.length === 0, reasons, shipping, customs };
}
