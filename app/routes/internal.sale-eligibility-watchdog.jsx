import { json } from "@remix-run/node";

import { enforceCatalogSyncSaleEligibilityFailSafe } from "../services/saleEligibilityWatchdog.server.js";
import { recordSaleEligibilityWatchdogHeartbeat } from "../services/releaseMonitoringReadiness.server.js";
import {
  requireBearerToken,
  requirePostRequest,
} from "../utils/routeSecurity.server.js";

const RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
});

export const loader = () =>
  json(
    { ok: false, error: "method_not_allowed" },
    {
      status: 405,
      headers: { ...RESPONSE_HEADERS, Allow: "POST" },
    },
  );

export async function action({ request }) {
  requirePostRequest(request);
  requireBearerToken(request, process.env.SALE_ELIGIBILITY_WATCHDOG_TOKEN, {
    missingConfiguration: "sale_eligibility_watchdog_token_not_configured",
  });
  const mode =
    request.headers.get("x-watchdog-mode") === "validate"
      ? "validation"
      : "live";
  const source =
    request.headers.get("x-watchdog-source") === "github_actions"
      ? "github_actions"
      : "local_agent";
  const credentialValidation =
    request.headers.get("x-watchdog-credentials-verified") === "true";
  const runId = request.headers.get("x-watchdog-run-id");
  const schedulerEnabled =
    request.headers.get("x-watchdog-scheduler-enabled") === "true";

  try {
    if (mode === "validation") {
      await recordSaleEligibilityWatchdogHeartbeat({
        status: "validated",
        mode,
        action: "validated",
        protected: false,
        source,
        credentialValidation,
        schedulerEnabled,
        runId,
      });
      return json(
        {
          ok: true,
          protected: false,
          action: "validated",
          status: "validated",
          code: null,
        },
        { status: 200, headers: RESPONSE_HEADERS },
      );
    }

    const result = await enforceCatalogSyncSaleEligibilityFailSafe();
    await recordSaleEligibilityWatchdogHeartbeat({
      status: result.status || result.freshness?.status || "critical",
      mode,
      action: result.action,
      protected: result.protected,
      source,
      credentialValidation,
      schedulerEnabled,
      runId,
      errorCode: result.ok ? null : result.reason || "watchdog_failed",
    });
    return json(
      {
        ok: result.ok,
        protected: result.protected,
        action: result.action,
        status: result.status || result.freshness?.status || "critical",
        code: result.reason || result.freshness?.reason || null,
      },
      {
        status: result.ok ? 200 : 500,
        headers: RESPONSE_HEADERS,
      },
    );
  } catch (error) {
    await recordSaleEligibilityWatchdogHeartbeat({
      status: "failed",
      mode,
      action: "failed",
      protected: false,
      source,
      credentialValidation,
      schedulerEnabled,
      runId,
      errorCode: error?.code || error?.name || "watchdog_failed",
    }).catch(() => {});
    console.error("sale eligibility watchdog failed", {
      code: error?.code || error?.name || "watchdog_failed",
    });
    return json(
      { ok: false, error: "sale_eligibility_watchdog_failed" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}
