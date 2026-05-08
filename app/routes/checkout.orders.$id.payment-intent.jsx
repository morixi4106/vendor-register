import { json } from "@remix-run/node";

import { createCheckoutOrderPaymentIntent } from "../services/sellerPayments.server.js";

function methodNotAllowed() {
  return json(
    { ok: false, reason: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

function mapPaymentIntentFailure(reason) {
  switch (reason) {
    case "order_not_found":
      return { status: 404, message: "Order not found." };
    case "seller_not_active":
      return { status: 409, message: "Seller is not active." };
    case "stripe_account_missing":
      return { status: 409, message: "Seller Stripe account is not ready." };
    default:
      return { status: 500, message: "Payment intent creation failed." };
  }
}

export const loader = async () => methodNotAllowed();

export const action = async ({ request, params }) => {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  try {
    const result = await createCheckoutOrderPaymentIntent({
      orderId: params.id,
    });

    if (!result.ok) {
      const failure = mapPaymentIntentFailure(result.reason);
      return json(
        {
          ok: false,
          reason: result.reason,
          message: failure.message,
        },
        { status: failure.status },
      );
    }

    return json(result);
  } catch (error) {
    console.error("checkout payment intent error:", error);
    return json(
      {
        ok: false,
        reason: "internal_error",
        message: "Payment intent creation failed.",
      },
      { status: 500 },
    );
  }
};
