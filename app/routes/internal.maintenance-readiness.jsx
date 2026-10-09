import { inspectMaintenanceReadiness } from "../services/maintenanceReadiness.server.js";
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
  return Response.json(await inspectMaintenanceReadiness(), {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
