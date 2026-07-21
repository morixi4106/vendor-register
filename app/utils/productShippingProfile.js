export const PRODUCT_SHIPPING_METHOD = Object.freeze({
  UNCONFIGURED: "UNCONFIGURED",
  DOMESTIC_ONLY: "DOMESTIC_ONLY",
  AIR_PACKET: "AIR_PACKET",
});

export const PRODUCT_SHIPPING_METHOD_OPTIONS = Object.freeze([
  { value: PRODUCT_SHIPPING_METHOD.DOMESTIC_ONLY, label: "国内配送のみ" },
  {
    value: PRODUCT_SHIPPING_METHOD.AIR_PACKET,
    label: "国内配送 + 国際エアパケット",
  },
]);

const VALID_METHODS = new Set(Object.values(PRODUCT_SHIPPING_METHOD));
const MAX_DOMESTIC_WEIGHT_GRAMS = 30000;
export const AIR_PACKET_MAX_WEIGHT_GRAMS = 2000;
export const AIR_PACKET_MAX_LONGEST_SIDE_MM = 600;
export const AIR_PACKET_MAX_DIMENSION_SUM_MM = 900;
export const AIR_PACKET_MIN_LONG_SIDE_MM = 148;
export const AIR_PACKET_MIN_SHORT_SIDE_MM = 105;

export const SHIPPING_WEIGHT_SOURCE = Object.freeze({
  UNSET: "UNSET",
  SHOPIFY_UNVERIFIED: "SHOPIFY_UNVERIFIED",
  MANUAL_CONFIRMED: "MANUAL_CONFIRMED",
});

export const SHOPIFY_WEIGHT_SYNC_STATUS = Object.freeze({
  NOT_LINKED: "NOT_LINKED",
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  SYNCED: "SYNCED",
  EXTERNAL_CHANGE: "EXTERNAL_CHANGE",
  ERROR: "ERROR",
});

function normalizeMethod(value, fallback = PRODUCT_SHIPPING_METHOD.UNCONFIGURED) {
  const normalized = String(value || "").trim().toUpperCase();
  return VALID_METHODS.has(normalized) ? normalized : fallback;
}

function parseRequiredInteger(value, label) {
  const raw = String(value ?? "").trim();
  const numeric = Number(raw);

  if (!raw || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${label}は1以上の整数で入力してください。`);
  }

  return numeric;
}

function parseCentimetersToMillimeters(value, label) {
  const raw = String(value ?? "").trim();
  const numeric = Number(raw);

  if (!raw || !Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label}は0より大きい数値で入力してください。`);
  }

  return Math.round(numeric * 10);
}

export function parseProductShippingProfileFormData(
  formData,
  { allowUnconfigured = false, variantCount = null } = {},
) {
  const fallbackMethod = PRODUCT_SHIPPING_METHOD.UNCONFIGURED;
  const internationalShippingMethod = normalizeMethod(
    formData.get("internationalShippingMethod"),
    fallbackMethod,
  );

  if (
    internationalShippingMethod === PRODUCT_SHIPPING_METHOD.UNCONFIGURED &&
    !allowUnconfigured
  ) {
    return { ok: false, error: "配送範囲を選択してください。" };
  }

  try {
    const shippingWeightConfirmed = ["1", "on", "true", "yes"].includes(
      String(formData.get("shippingWeightConfirmed") || "").trim().toLowerCase(),
    );
    const shippingWeightGrams = parseRequiredInteger(
      formData.get("shippingWeightGrams"),
      "梱包後重量",
    );

    if (shippingWeightGrams > MAX_DOMESTIC_WEIGHT_GRAMS) {
      throw new Error("梱包後重量は30,000g以下で入力してください。");
    }
    if (!shippingWeightConfirmed) {
      throw new Error("梱包材を含む重量であることを確認してください。");
    }

    let shippingLengthMm = null;
    let shippingWidthMm = null;
    let shippingHeightMm = null;

    if (internationalShippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET) {
      if (
        variantCount != null &&
        Number.isInteger(Number(variantCount)) &&
        Number(variantCount) !== 1
      ) {
        throw new Error(
          "複数バリエーション商品は、現在国際配送に対応していません。",
        );
      }
      shippingLengthMm = parseCentimetersToMillimeters(
        formData.get("shippingLengthCm"),
        "長さ",
      );
      shippingWidthMm = parseCentimetersToMillimeters(
        formData.get("shippingWidthCm"),
        "幅",
      );
      shippingHeightMm = parseCentimetersToMillimeters(
        formData.get("shippingHeightCm"),
        "厚さ",
      );

      if (shippingWeightGrams > AIR_PACKET_MAX_WEIGHT_GRAMS) {
        throw new Error("国際エアパケットは梱包後重量2,000g以下の商品だけ利用できます。");
      }

      const dimensions = [shippingLengthMm, shippingWidthMm, shippingHeightMm];
      if (Math.max(...dimensions) > AIR_PACKET_MAX_LONGEST_SIDE_MM) {
        throw new Error("国際エアパケットは最長辺60cm以下にしてください。");
      }
      if (
        dimensions.reduce((total, value) => total + value, 0) >
        AIR_PACKET_MAX_DIMENSION_SUM_MM
      ) {
        throw new Error("国際エアパケットは長さ・幅・厚さの合計を90cm以下にしてください。");
      }

      const sortedDimensions = [...dimensions].sort((left, right) => right - left);
      if (
        sortedDimensions[0] < AIR_PACKET_MIN_LONG_SIDE_MM ||
        sortedDimensions[1] < AIR_PACKET_MIN_SHORT_SIDE_MM
      ) {
        throw new Error(
          "国際エアパケットの最終梱包サイズは14.8cm × 10.5cm以上にしてください。",
        );
      }
    }

    return {
      ok: true,
      data: {
        shippingWeightGrams,
        shippingLengthMm,
        shippingWidthMm,
        shippingHeightMm,
        internationalShippingMethod,
        shippingWeightConfirmed,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "配送情報を確認してください。",
    };
  }
}

export function millimetersToCentimeters(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric / 10 : "";
}

export function getProductShippingMethodLabel(value) {
  const method = normalizeMethod(value);
  if (method === PRODUCT_SHIPPING_METHOD.AIR_PACKET) {
    return "国内配送 + 国際エアパケット";
  }
  if (method === PRODUCT_SHIPPING_METHOD.DOMESTIC_ONLY) {
    return "国内配送のみ";
  }
  return "未設定（国際配送不可）";
}

export function validateStoredAirPacketProfile(product) {
  if (
    normalizeMethod(product?.internationalShippingMethod) !==
    PRODUCT_SHIPPING_METHOD.AIR_PACKET
  ) {
    return { ok: false, reason: "international_shipping_not_enabled" };
  }

  const weight = Number(product?.shippingWeightGrams);
  const dimensions = [
    Number(product?.shippingLengthMm),
    Number(product?.shippingWidthMm),
    Number(product?.shippingHeightMm),
  ];

  if (!product?.shippingWeightConfirmedAt) {
    return { ok: false, reason: "shipping_weight_unverified" };
  }
  if (
    product?.shippingWeightSource !== SHIPPING_WEIGHT_SOURCE.MANUAL_CONFIRMED
  ) {
    return { ok: false, reason: "shipping_weight_unverified" };
  }
  if (Number(product?.shopifyVariantCount) !== 1) {
    return { ok: false, reason: "multiple_variants_unsupported" };
  }
  if (
    product?.shopifyWeightSyncStatus !== SHOPIFY_WEIGHT_SYNC_STATUS.SYNCED
  ) {
    return { ok: false, reason: "shopify_weight_sync_incomplete" };
  }

  if (!Number.isInteger(weight) || weight <= 0) {
    return { ok: false, reason: "shipping_weight_missing" };
  }
  if (weight > AIR_PACKET_MAX_WEIGHT_GRAMS) {
    return { ok: false, reason: "air_packet_weight_exceeded" };
  }
  if (dimensions.some((value) => !Number.isInteger(value) || value <= 0)) {
    return { ok: false, reason: "shipping_dimensions_missing" };
  }
  if (Math.max(...dimensions) > AIR_PACKET_MAX_LONGEST_SIDE_MM) {
    return { ok: false, reason: "air_packet_longest_side_exceeded" };
  }
  if (
    dimensions.reduce((total, value) => total + value, 0) >
    AIR_PACKET_MAX_DIMENSION_SUM_MM
  ) {
    return { ok: false, reason: "air_packet_dimensions_exceeded" };
  }
  const sortedDimensions = [...dimensions].sort((left, right) => right - left);
  if (
    sortedDimensions[0] < AIR_PACKET_MIN_LONG_SIDE_MM ||
    sortedDimensions[1] < AIR_PACKET_MIN_SHORT_SIDE_MM
  ) {
    return { ok: false, reason: "air_packet_minimum_dimensions_not_met" };
  }

  return { ok: true, reason: null };
}

export function buildConfirmedShippingProfileData(
  profileData,
  { isShopifyLinked = false, now = new Date() } = {},
) {
  const { shippingWeightConfirmed: _confirmed, ...storedProfile } = profileData;

  return {
    ...storedProfile,
    shippingWeightConfirmedAt: now,
    shippingWeightSource: SHIPPING_WEIGHT_SOURCE.MANUAL_CONFIRMED,
    shopifyWeightSyncStatus: isShopifyLinked
      ? SHOPIFY_WEIGHT_SYNC_STATUS.PENDING
      : SHOPIFY_WEIGHT_SYNC_STATUS.NOT_LINKED,
    shopifyWeightSyncError: null,
  };
}
