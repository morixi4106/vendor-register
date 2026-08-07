export const CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS = Object.freeze([
  {
    id: "directProductAllowed",
    label: "INACTIVE baselineで通常の運営直販商品を購入できた",
    expectedResult: "checkout_allowed",
  },
  {
    id: "blockedProductRejected",
    label: "ACTIVE中に許可対象外の商品が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "globalStopRejected",
    label: "BLOCKED中に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "shopPayObserved",
    label: "Shop Payでも期待どおりになった",
    expectedResult: "checkout_allowed",
  },
  {
    id: "controlMetafieldMissingRejected",
    label: "control metafield欠落時に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "controlMetafieldMalformedRejected",
    label: "control metafieldが不正JSONの場合に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "controlVersionUnknownRejected",
    label: "未知のcontrol versionで購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "preparingControlRejected",
    label: "PREPARING中に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "activeAllowedProductAllowed",
    label: "ACTIVE中に許可商品を上限内で購入できた",
    expectedResult: "checkout_allowed",
  },
  {
    id: "activeSingleOrderLimitRejected",
    label: "ACTIVE中に単一注文上限超過が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "activeGrossLimitRejected",
    label: "ACTIVE中に残り売上上限超過が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "activeLiabilityLimitRejected",
    label: "ACTIVE中に残り未返金債務上限超過が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "activeOrderCountLimitRejected",
    label: "ACTIVE中に残り注文件数0で購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "expiryBoundaryRejected",
    label: "期限当日に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "expiredControlRejected",
    label: "期限経過後に購入が拒否された",
    expectedResult: "checkout_rejected",
  },
  {
    id: "staleRevisionRejected",
    label: "古いcontrol revisionで購入が拒否された",
    expectedResult: "checkout_rejected",
  },
]);

export const CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIO_COUNT =
  CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS.length;
