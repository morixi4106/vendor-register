import { json } from "@remix-run/node";

import { createCheckoutOrder } from "../services/sellerPayments.server.js";

function methodNotAllowed() {
  return json(
    { ok: false, reason: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

function mapCheckoutCreateFailure(reason) {
  switch (reason) {
    case "invalid_payload":
      return { status: 400, message: "Invalid order payload." };
    case "seller_not_found":
      return { status: 404, message: "Seller not found." };
    case "seller_not_active":
      return { status: 409, message: "Seller is not active." };
    case "stripe_account_missing":
      return { status: 409, message: "Seller Stripe account is not ready." };
    case "invalid_items":
      return { status: 400, message: "Invalid order items." };
    default:
      return { status: 500, message: "Checkout order creation failed." };
  }
}

export const loader = async () => methodNotAllowed();

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        reason: "invalid_payload",
        message: "Request body must be valid JSON.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await createCheckoutOrder(body);

    if (!result.ok) {
      const failure = mapCheckoutCreateFailure(result.reason);
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
    console.error("checkout order create error:", error);
    return json(
      {
        ok: false,
        reason: "internal_error",
        message: "Checkout order creation failed.",
      },
      { status: 500 },
    );
  }
};
