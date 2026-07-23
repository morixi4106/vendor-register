import { json } from "@remix-run/node";

import { enforceCatalogSyncSaleEligibilityFailSafe } from "../services/saleEligibilityWatchdog.server.js";
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

  try {
    const result = await enforceCatalogSyncSaleEligibilityFailSafe();
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
    console.error("sale eligibility watchdog failed", {
      code: error?.code || error?.name || "watchdog_failed",
    });
    return json(
      { ok: false, error: "sale_eligibility_watchdog_failed" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}
