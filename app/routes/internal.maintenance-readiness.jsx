import { inspectMaintenanceReadiness } from "../services/maintenanceReadiness.server.js";
import { inspectLaunchMonitorStatus } from "../services/launchMonitorStatus.server.js";
import {
  requireBearerToken,
  requirePostRequest,
} from "../utils/routeSecurity.server.js";

export const loader = () =>
  Response.json(
    { ok: false },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
  );
export async function action({ request }) {
  requirePostRequest(request);
  requireBearerToken(request, process.env.MAINTENANCE_GATE_TOKEN, {
    missingConfiguration: "maintenance_gate_not_configured",
  });
  const readiness = await inspectMaintenanceReadiness();
  const diagnostics = await inspectLaunchMonitorStatus();
  return Response.json(
    { ...readiness, diagnostics },
    {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
