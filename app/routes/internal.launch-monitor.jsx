import { json } from "@remix-run/node";

import {
  acquireLaunchMonitorRunLock,
  releaseLaunchMonitorRunLock,
  runLaunchMonitor,
  sanitizeLaunchMonitorResult,
} from "../services/launchMonitor.server.js";
import {
  requireBearerToken,
  requirePostRequest,
} from "../utils/routeSecurity.server.js";

const MAX_BODY_BYTES = 50_000;

export const loader = () =>
  json(
    { ok: false, error: "method_not_allowed" },
    {
      status: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" },
    },
  );

export async function action({ request }) {
  const startedAt = Date.now();
  requirePostRequest(request);
  requireBearerToken(request, process.env.LAUNCH_MONITOR_TOKEN, {
    missingConfiguration: "launch_monitor_token_not_configured",
  });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, { status: 413 });
  }
  let renderSnapshot = {};
  try {
    renderSnapshot = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json(
      { ok: false, error: "invalid_json" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const lockAcquired = await acquireLaunchMonitorRunLock();
  if (!lockAcquired) {
    return json(
      { ok: false, error: "monitor_run_in_progress" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await runLaunchMonitor({ renderSnapshot });
    return json(
      sanitizeLaunchMonitorResult(result, {
        durationMs: Date.now() - startedAt,
      }),
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  } catch (error) {
    console.error("launch monitor run failed", {
      code: error?.code || error?.name || "monitor_run_failed",
    });
    return json(
      { ok: false, error: "launch_monitor_run_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await releaseLaunchMonitorRunLock().catch(() => {});
  }
}
