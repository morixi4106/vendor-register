import {
  decorateCheckForDisplay,
  statusSortOrder,
} from "./productionReadinessViewModel.js";

export function buildProductionReadinessPageState(data, navigation) {
  const submittingIntent = navigation.formData?.get("intent");
  const displayChecks = data.checks.map((check) =>
    decorateCheckForDisplay(check, data),
  );
  const blockingChecks = displayChecks.filter(
    (check) => check.displayStatus === "fail",
  );
  const checkoutValidationPrepared = data.checkoutValidation?.prepared === true;
  const checkoutValidationActive = data.checkoutValidation?.active === true;

  return {
    isCarrierSubmitting:
      navigation.state === "submitting" &&
      submittingIntent === "register_carrier",
    isCheckoutGateSubmitting:
      navigation.state === "submitting" &&
      submittingIntent === "activate_checkout_gate",
    isCheckoutValidationSubmitting:
      navigation.state === "submitting" &&
      [
        "stage_checkout_validation",
        "activate_checkout_validation",
        "disable_checkout_validation_for_standard_direct",
      ].includes(submittingIntent),
    isLimitedLaunchBaselineSubmitting:
      navigation.state === "submitting" &&
      submittingIntent === "prepare_komoju_limited_launch_baseline",
    displaySummary: {
      blockingCount: blockingChecks.length,
      warningCount: displayChecks.filter(
        (check) => check.displayStatus === "warning",
      ).length,
      manualCount: displayChecks.filter(
        (check) => check.displayStatus === "manual",
      ).length,
      optionalCount: displayChecks.filter(
        (check) => check.displayStatus === "optional",
      ).length,
      decisionRequiredCount: Number(data.summary?.decisionRequiredCount || 0),
      releaseBlockingCount: Number(data.summary?.releaseBlockingCount || 0),
    },
    orderedChecks: [
      ...blockingChecks,
      ...displayChecks.filter((check) => check.displayStatus !== "fail"),
    ].sort(
      (a, b) =>
        statusSortOrder(a.displayStatus) - statusSortOrder(b.displayStatus),
    ),
    checkoutValidationPrepared,
    checkoutValidationActive,
    standardDirect: data.checkoutMode?.standardDirectReady === true,
    checkoutValidationUnavailable:
      data.checkoutValidation?.ok === false &&
      data.checkoutValidation?.reason !== "validation_not_created",
    checkoutReplayReady: Boolean(
      data.operationalReadiness?.rows?.some(
        (row) =>
          row.definition?.key === "CHECKOUT_VALIDATION_REPLAY_COMPLETED" &&
          row.ready === true,
      ),
    ),
  };
}
