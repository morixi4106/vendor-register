export function internationalRunnerPageFixture(
  role = "admin",
  phase = "PASSED",
) {
  const can = (name) => role === "admin" || role === name;
  const now = new Date().toISOString();
  return {
    rows: [],
    evidenceRows: [],
    gateState: {
      mode: "STOPPED",
      phase: "BLOCKED",
      desiredGeneration: 3,
      appliedGeneration: 3,
      verifiedProductCount: 0,
      expectedProductCount: 0,
    },
    runner: {
      permissions: {
        release: can("release"),
        review: can("review"),
        stop: can("incident"),
        resume: role === "admin",
      },
      saleReady: false,
      capability: {
        ready: false,
        reason: "international_verification_not_implemented",
      },
      surface: {
        status: "CONFIRMED",
        expiresAt: now,
        expectedVersion: "0:fixture",
      },
      deliveries:
        phase === "EMPTY"
          ? []
          : [
              {
                id: "delivery-fixture",
                versionTag:
                  "international-candidate-version-long-name-for-layout-verification",
                headSha: "a".repeat(40),
                receiptDigest: "b".repeat(64),
                allowedUseUntil: now,
                revokedAt: phase === "REVOKED" ? now : null,
              },
            ],
      runs:
        phase === "EMPTY"
          ? []
          : [
              {
                id: "run-fixture",
                kind: "DEPLOYMENT",
                status: phase === "REVOKED" ? "PASSED" : phase,
                closureStatus:
                  phase === "PASSED" || phase === "REVOKED"
                    ? "CONFIRMED"
                    : "UNVERIFIED",
                createdAt: now,
                observedAt: now,
                observationExpiresAt: now,
                observationRefreshRequestedAt: phase === "RUNNING" ? now : null,
                resultDigest: "c".repeat(64),
                expectedProof: null,
                revokedAt: phase === "REVOKED" ? now : null,
              },
            ],
      authorizations: [],
      nextRunCursor: null,
    },
  };
}

export function internationalCompatibilityPageFixture(mode = "NON_PLUS") {
  const observedAt = new Date(Date.now() - (mode === "EXPIRED" ? 600000 : 0));
  const plan = ["PLUS", "NON_PLUS"].includes(mode) ? mode : "UNVERIFIED";
  return {
    version: "international-checkout-compatibility-v1",
    apiVersion: "2026-04",
    shopDomain: "fixture.myshopify.com",
    status: plan === "UNVERIFIED" ? "UNAVAILABLE" : "OBSERVED",
    plan,
    developmentStore: plan === "UNVERIFIED" ? null : false,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(+observedAt + 300000).toISOString(),
    paths: [
      {
        id: "STOREFRONT_CART",
        status: "INSUFFICIENT",
        reason: "ESTIMATES_AND_ROUTE_BINDING_UNVERIFIED",
      },
      {
        id: "CHECKOUT_UI_EXTENSION",
        status:
          plan === "PLUS"
            ? "UNVERIFIED"
            : plan === "NON_PLUS"
              ? "UNAVAILABLE"
              : "UNKNOWN",
        reason:
          plan === "PLUS"
            ? "PLAN_ONLY_OBSERVED"
            : plan === "NON_PLUS"
              ? "PLUS_REQUIRED"
              : "PLAN_UNVERIFIED",
      },
      {
        id: "WEB_PIXEL",
        status: "INSUFFICIENT",
        reason: "ANALYTICS_NOT_INDEPENDENT_CHECKOUT_PROOF",
      },
    ],
    readOnly: true,
    verificationReady: false,
    saleReady: false,
  };
}
