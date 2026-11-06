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
