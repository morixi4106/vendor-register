import { Resend } from "resend";

import { readBoundedRequestBody } from "../utils/requestBody.server.js";
import { recordVerifiedMonitorDelivery } from "./monitorNotification.server.js";

const HEADERS = { "Cache-Control": "no-store" };
const EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
]);

export async function handleMonitorDeliveryWebhook(
  request,
  {
    env = process.env,
    verifyImpl = (input) =>
      new Resend(
        env.RESEND_API_KEY || "webhook-verification-only",
      ).webhooks.verify(input),
    recordImpl = recordVerifiedMonitorDelivery,
  } = {},
) {
  if (request.method !== "POST")
    return Response.json(
      { ok: false },
      { status: 405, headers: { ...HEADERS, Allow: "POST" } },
    );
  if (!env.RESEND_MONITOR_WEBHOOK_SECRET)
    return Response.json(
      { ok: false, error: "delivery_webhook_not_configured" },
      { status: 503, headers: HEADERS },
    );
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature)
    return Response.json(
      { ok: false, error: "invalid_delivery_signature" },
      { status: 401, headers: HEADERS },
    );
  const payload = (await readBoundedRequestBody(request, 64_000)).toString(
    "utf8",
  );
  let event;
  try {
    event = await verifyImpl({
      payload,
      headers: { id, timestamp, signature },
      webhookSecret: env.RESEND_MONITOR_WEBHOOK_SECRET,
    });
  } catch {
    return Response.json(
      { ok: false, error: "invalid_delivery_signature" },
      { status: 401, headers: HEADERS },
    );
  }
  if (!EVENTS.has(event?.type))
    return Response.json({ ok: true, ignored: true }, { headers: HEADERS });
  const messageId = event?.data?.email_id;
  if (!/^[A-Za-z0-9-]{1,128}$/.test(messageId || ""))
    return Response.json(
      { ok: false, error: "invalid_delivery_event" },
      { status: 400, headers: HEADERS },
    );
  try {
    const result = await recordImpl({
      messageId,
      providerEvent: event.type.slice("email.".length),
      webhookId: id,
      env,
    });
    return Response.json(
      { ok: !result.retry, ignored: result.ignored === true },
      { status: result.retry ? 503 : 200, headers: HEADERS },
    );
  } catch {
    return Response.json(
      { ok: false, error: "delivery_record_unavailable" },
      { status: 503, headers: HEADERS },
    );
  }
}
