// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
const POLICY_VERSION = "sale-eligibility-2026-07-v1";
const ALLOWED_STATUSES = new Set(["ELIGIBLE", "LEGACY_REVIEW_REQUIRED"]);
const MAX_SUPPORTED_CART_LINES = 200;

function parseProjection(value) {
  if (!value) return null;
  try {
    const projection = JSON.parse(value);
    return projection && typeof projection === "object" ? projection : null;
  } catch {
    return null;
  }
}

function parseLimitedLaunchControl(value) {
  if (!value) return { present: false, valid: false, control: null };
  const control = parseProjection(value);
  const valid = Boolean(
    control &&
      Number(control.v) === 2 &&
      ["ACTIVE", "BLOCKED", "INACTIVE", "PREPARING"].includes(
        String(control.s),
      ) &&
      Number.isInteger(control.r) &&
      control.r >= 1 &&
      /^[a-f0-9]{64}$/.test(String(control.h || "")) &&
      Array.isArray(control.p) &&
      Number.isInteger(control.o) &&
      Number.isInteger(control.g) &&
      Number.isInteger(control.l) &&
      Number.isInteger(control.m) &&
      typeof control.e === "string" &&
      typeof control.x === "string" &&
      typeof control.q === "string" &&
      typeof control.c === "string",
  );
  return { present: true, valid, control: valid ? control : null };
}

function parseInternationalSaleGate(value) {
  if (!value) return { present: false, valid: false, gate: null };
  const gate = parseProjection(value);
  const countries = Array.isArray(gate?.c) ? gate.c.map(String) : [];
  const valid = Boolean(
    gate &&
      Number(gate.v) === 1 &&
      Number.isInteger(gate.r) &&
      gate.r >= 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(gate.d || "")) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(gate.e || "")) &&
      /^[a-f0-9]{64}$/.test(String(gate.h || "")) &&
      countries.every((country) => /^[A-Z]{2}$/.test(country)),
  );
  return {
    present: true,
    valid,
    gate: valid ? { ...gate, c: countries } : null,
  };
}

function isNorthernIrelandAddress(address) {
  const countryCode = String(address?.countryCode || "").toUpperCase();
  if (countryCode !== "GB") return false;
  const provinceCode = String(address?.provinceCode || "")
    .toUpperCase()
    .replace(/^GB-/, "");
  const postalCode = String(address?.zip || "")
    .toUpperCase()
    .replace(/\s+/g, "");
  return (
    provinceCode === "NIR" ||
    provinceCode === "NI" ||
    postalCode.startsWith("BT")
  );
}

function getInternationalDestinationError(input, currentDate) {
  const deliveryGroups = Array.isArray(input.cart?.deliveryGroups)
    ? input.cart.deliveryGroups
    : [];
  const addresses = deliveryGroups
    .map((group) => group?.deliveryAddress)
    .filter((address) => address?.countryCode);
  const internationalAddresses = addresses.filter(
    (address) => String(address.countryCode).toUpperCase() !== "JP",
  );
  if (internationalAddresses.length === 0) return null;
  if (internationalAddresses.some(isNorthernIrelandAddress)) {
    return "現在、北アイルランドへの配送は受け付けていません。";
  }

  const parsed = parseInternationalSaleGate(
    input.shop?.internationalSaleGate?.value,
  );
  if (!parsed.present || !parsed.valid) {
    return "海外販売条件を確認できないため、この配送先への注文を受け付けられません。";
  }
  const gate = parsed.gate;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(currentDate) ||
    gate.d > currentDate ||
    currentDate >= gate.e
  ) {
    return "海外販売条件の有効期限を確認できないため、この配送先への注文を受け付けられません。";
  }
  const allowedCountries = new Set(gate.c);
  if (
    internationalAddresses.some(
      (address) =>
        !allowedCountries.has(String(address.countryCode).toUpperCase()),
    )
  ) {
    return "現在、この国・地域への販売は受け付けていません。";
  }
  return null;
}

function getCartAmount(input) {
  const amount = Number(input.cart?.cost?.totalAmount?.amount);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

function getLimitedLaunchError(input, currentDate) {
  const parsed = parseLimitedLaunchControl(
    input.shop?.komojuLimitedLaunchControl?.value,
  );
  if (!parsed.present) {
    return "現在、購入条件を確認できないため注文を受け付けられません。時間をおいて再度お試しください。";
  }
  if (!parsed.valid) {
    return "限定公開の購入条件を確認できません。時間をおいて再度お試しください。";
  }
  const control = parsed.control;
  if (control.s === "INACTIVE") return null;
  if (
    control.s === "BLOCKED" ||
    control.s === "PREPARING" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(currentDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(control.e) ||
    currentDate >= control.e
  ) {
    return "限定公開期間が終了したため、現在注文を受け付けていません。";
  }
  const allowedProducts = new Set(control.p.map(String));
  const cartLines = Array.isArray(input.cart?.lines) ? input.cart.lines : [];
  const productIds = cartLines
    .map((line) => String(line.merchandise?.product?.id || ""))
    .filter(Boolean);
  if (
    control.p.length !== 1 ||
    typeof control.q !== "string" ||
    !control.q ||
    cartLines.length !== 1 ||
    Number(cartLines[0]?.quantity) !== 1 ||
    String(cartLines[0]?.merchandise?.id || "") !== control.q ||
    productIds.length === 0 ||
    productIds.some((productId) => !allowedProducts.has(productId))
  ) {
    return "限定公開の対象外商品が含まれています。";
  }
  const currencyCode = String(
    input.cart?.cost?.totalAmount?.currencyCode || "",
  ).toUpperCase();
  const cartAmount = getCartAmount(input);
  if (
    currencyCode !== String(control.c).toUpperCase() ||
    cartAmount === null ||
    control.o < 1 ||
    cartAmount > control.m ||
    cartAmount > control.g ||
    cartAmount > control.l
  ) {
    return "限定公開の注文上限に達したため、現在注文を受け付けていません。";
  }
  return null;
}

function isValidDirectProjection({ policy, projectionValue, currentDate }) {
  if (policy !== "PLATFORM_DIRECT") return false;
  const projection = parseProjection(projectionValue);
  if (!projection) return false;
  const compact = Number(projection.v) === 2;
  const routingClass = compact ? projection.c : projection.routingClass;
  const allowed = compact ? projection.a : projection.allowed;
  const status = compact ? projection.s : projection.status;
  const policyVersion = compact ? projection.p : projection.policyVersion;
  const inputHash = compact ? projection.h : projection.inputHash;
  const revision = compact
    ? projection.r
    : projection.projectionRevision;
  const evaluatedDate = String(
    compact ? projection.d : projection.evaluatedOn || "",
  );
  // Shopify supplies the shop date, not an arbitrary current UTC timestamp.
  // This exclusive date is a final hard backstop. The external watchdog
  // enforces the shorter minute-level catalog freshness limit.
  const hardValidUntilExclusive = String(
    compact ? projection.e : projection.expiresOnExclusive || "",
  );

  if (routingClass !== "PLATFORM_DIRECT") return false;
  if (allowed !== true) return false;
  if (!ALLOWED_STATUSES.has(String(status || "").toUpperCase())) {
    return false;
  }
  if (policyVersion !== POLICY_VERSION) return false;
  if (!/^[a-f0-9]{64}$/.test(String(inputHash || ""))) {
    return false;
  }
  if (!Number.isInteger(revision) || revision < 1) {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evaluatedDate)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hardValidUntilExclusive)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return false;
  return (
    currentDate < hardValidUntilExclusive && evaluatedDate <= currentDate
  );
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const operationalState = String(
    input.shop?.operationalPurchaseControl?.value || "",
  )
    .trim()
    .toUpperCase();
  const watchdogStopActive =
    String(input.shop?.watchdogPurchaseStop?.value || "")
      .trim()
      .toUpperCase() === "BLOCKED";
  const purchaseStopActive =
    operationalState !== "ALLOWED" || watchdogStopActive;
  const currentDate = String(input.shop?.localTime?.date || "");
  const limitedLaunchError = getLimitedLaunchError(input, currentDate);
  const internationalDestinationError = getInternationalDestinationError(
    input,
    currentDate,
  );
  const cartLines = Array.isArray(input.cart?.lines) ? input.cart.lines : [];
  const unsupportedCartSize = cartLines.length > MAX_SUPPORTED_CART_LINES;
  const invalidProductPresent = cartLines.some((line) => {
    const policy = String(
      line.merchandise?.product?.marketplaceCheckoutPolicy?.value || "",
    )
      .trim()
      .toUpperCase();
    return !isValidDirectProjection({
      policy,
      projectionValue:
        line.merchandise?.product?.saleEligibilityProjection?.value || "",
      currentDate,
    });
  });
  const errors = purchaseStopActive
    ? [
        {
          message:
            "現在注文受付を一時停止しています。時間をおいて再度お試しください。",
          target: "$.cart",
        },
      ]
    : limitedLaunchError
      ? [
          {
            message: limitedLaunchError,
            target: "$.cart",
          },
        ]
      : internationalDestinationError
        ? [
            {
              message: internationalDestinationError,
              target: "$.cart",
            },
          ]
      : unsupportedCartSize
      ? [
          {
            message:
              "一度に購入できる商品行数を超えています。カートを分けてお試しください。",
            target: "$.cart",
          },
        ]
      : invalidProductPresent
      ? [
          {
            message:
              "現在購入できない商品が含まれています。対象商品をカートから削除してください。",
            target: "$.cart",
          },
        ]
      : [];

  const operations = [
    {
      validationAdd: {
        errors,
      },
    },
  ];

  return { operations };
}
