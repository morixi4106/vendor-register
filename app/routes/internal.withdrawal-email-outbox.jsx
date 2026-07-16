import { json } from "@remix-run/node";
import crypto from "node:crypto";

import { processWithdrawalEmailOutbox } from "../services/withdrawalEmailOutbox.server.js";

export async function action({ request }) {
  const configuredToken = String(process.env.WITHDRAWAL_OUTBOX_WORKER_TOKEN || "").trim();
  const providedToken = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!configuredToken || !tokensMatch(providedToken, configuredToken)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const formData = await request.formData().catch(() => new FormData());
  const url = new URL(request.url);
  const result = await processWithdrawalEmailOutbox({
    limit: formData.get("limit") || url.searchParams.get("limit") || 20,
  });
  return json(result, { status: result.ok ? 200 : 207 });
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
