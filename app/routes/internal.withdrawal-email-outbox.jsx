import { json } from "@remix-run/node";
import crypto from "node:crypto";

import {
  recordOperationalHeartbeatSafely,
  WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY,
} from "../services/operationalHealth.server.js";
import { processWithdrawalEmailOutbox } from "../services/withdrawalEmailOutbox.server.js";

export async function action({ request }) {
  const configuredToken = String(
    process.env.WITHDRAWAL_OUTBOX_WORKER_TOKEN || "",
  ).trim();
  const providedToken = String(
    request.headers.get("authorization") || "",
  ).replace(/^Bearer\s+/i, "");
  if (!configuredToken || !tokensMatch(providedToken, configuredToken)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const formData = await request.formData().catch(() => new FormData());
  const url = new URL(request.url);
  const limit = formData.get("limit") || url.searchParams.get("limit") || 20;

  await recordOperationalHeartbeatSafely({
    key: WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY,
    status: "started",
    metadataJson: { limit: Number(limit) || 20 },
  });

  try {
    const result = await processWithdrawalEmailOutbox({ limit });
    await recordOperationalHeartbeatSafely({
      key: WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY,
      status: result.ok ? "succeeded" : "failed",
      errorCode: result.ok ? null : "withdrawal_email_delivery_failed",
      metadataJson: {
        processed: result.processed,
        sent: result.sent,
        failed: result.failed,
      },
    });
    return json(result, { status: result.ok ? 200 : 207 });
  } catch (error) {
    await recordOperationalHeartbeatSafely({
      key: WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY,
      status: "failed",
      errorCode: String(error?.message || error || "worker_failed"),
    });
    console.error("withdrawal email outbox worker failed:", error);
    return json(
      { ok: false, error: "withdrawal_email_outbox_worker_failed" },
      { status: 500 },
    );
  }
}

function tokensMatch(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function loader() {
  return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
