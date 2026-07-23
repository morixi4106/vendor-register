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
  const purchaseStopActive = operationalState !== "ALLOWED";
  const currentDate = String(input.shop?.localTime?.date || "");
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
