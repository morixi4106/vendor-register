import { json, redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { createSellerStripeAccount } from "../services/sellerPayments.server.js";

export const loader = async () => {
  return json(
    {
      ok: false,
      message: "Method not allowed.",
    },
    {
      status: 405,
      headers: {
        Allow: "POST",
      },
    },
  );
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  try {
    const result = await createSellerStripeAccount({
      sellerId: params.sellerId,
    });

    if (!result.ok) {
      return json(
        {
          ok: false,
          reason: result.reason,
          message: "Failed to create connected account.",
        },
        { status: 400 },
      );
    }

    const acceptsJson = request.headers.get("Accept")?.includes("application/json");

    if (acceptsJson) {
      return json(result);
    }

    return redirect(`/app/sellers/${params.sellerId}`);
  } catch (error) {
    console.error("seller stripe account create error:", error);

    return json(
      {
        ok: false,
        reason: "internal_error",
        message: "Failed to create connected account.",
      },
      { status: 500 },
    );
  }
};
