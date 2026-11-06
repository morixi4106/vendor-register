import {
  inspectInternationalAuthorizationCapability,
  effectiveAuthorizationPurpose,
} from "./internationalAuthorizationPolicy.server.js";

export async function inspectInternationalAuthorizationState(
  { prismaClient, state, now = new Date() },
  { inspectCapability = inspectInternationalAuthorizationCapability } = {},
) {
  const unavailable = {
    ready: false,
    reason: "international_authorization_unverified",
  };
  if (!(await inspectCapability()).ready || !state.authorizationRequestId)
    return unavailable;
  const request =
    await prismaClient.internationalGateAuthorizationRequest.findFirst({
      where: { id: state.authorizationRequestId, shopDomain: state.shopDomain },
    });
  if (
    !request ||
    !request.consumedAt ||
    request.revokedAt ||
    request.effectiveExpiresAt <= now ||
    request.consumedGeneration > state.desiredGeneration ||
    request.scopeHash !== state.authorizedScopeHash ||
    request.nativeConfigHash !== state.nativeConfigHash ||
    request.releaseBinding !== state.releaseBinding ||
    request.effectiveExpiresAt.getTime() !==
      state.authorizationExpiresAt?.getTime() ||
    effectiveAuthorizationPurpose(request) !== state.authorizationPurpose
  )
    return unavailable;
  if (state.authorizationPurpose === "VERIFY") {
    const run =
      await prismaClient.internationalCheckoutVerificationRun.findFirst({
        where: {
          id: state.verificationRunId || "",
          shopDomain: state.shopDomain,
          authorizationRequestId: request.id,
        },
      });
    if (run?.status === "QUEUED" && run.expiresAt > now)
      return {
        ready: false,
        waiting: true,
        reason: "international_runner_not_started",
      };
    if (
      !run ||
      run.status !== "RUNNING" ||
      !run.leaseUntil ||
      run.leaseUntil <= now ||
      run.expiresAt <= now
    )
      return unavailable;
  }
  return { ready: true, purpose: state.authorizationPurpose };
}
