import { json } from "@remix-run/node";

import { readLaunchMonitorDeadmanState } from "../services/launchMonitor.server.js";
import {
  requireBearerToken,
  requirePostRequest,
} from "../utils/routeSecurity.server.js";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

export const loader = () =>
  json(
    { ok: false, error: "method_not_allowed" },
    { status: 405, headers: { ...RESPONSE_HEADERS, Allow: "POST" } },
  );

export async function action({ request }) {
  requirePostRequest(request);
  requireBearerToken(request, process.env.LAUNCH_MONITOR_DEADMAN_TOKEN, {
    missingConfiguration: "launch_monitor_deadman_token_not_configured",
  });

  try {
    const state = await readLaunchMonitorDeadmanState();
    return json(state, { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error("launch monitor deadman check failed", {
      code: error?.code || error?.name || "deadman_check_failed",
    });
    return json(
      { ok: false, error: "deadman_check_failed" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}
