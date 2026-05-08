import { json } from "@remix-run/node";

import { handleStripeWebhook } from "../services/sellerPayments.server.js";

function methodNotAllowed() {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const loader = async () => methodNotAllowed();

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return json(
      { ok: false, message: "Missing Stripe signature." },
      { status: 400 },
    );
  }

  const rawBody = await request.text();

  try {
    const result = await handleStripeWebhook({
      rawBody,
      signature,
    });

    return json({
      ok: true,
      duplicate: Boolean(result?.duplicate),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("STRIPE_WEBHOOK_SECRET_MISSING") ||
      message.includes("No signatures found matching the expected signature") ||
      message.includes("Unable to extract timestamp and signatures from header") ||
      message.includes("JSON object requested")
    ) {
      return json(
        { ok: false, message: "Invalid Stripe webhook." },
        { status: 400 },
      );
    }

    console.error("stripe webhook route error:", error);

    return json(
      { ok: false, message: "Stripe webhook processing failed." },
      { status: 500 },
    );
  }
};
