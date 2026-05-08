import { json } from "@remix-run/node";

import { requireVendorContext } from "../services/vendorManagement.server.js";
import { createSellerAccountSession } from "../services/sellerPayments.server.js";

export const loader = async () => {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
};

export const action = async ({ request }) => {
  try {
    const { vendor } = await requireVendorContext(request);
    const result = await createSellerAccountSession({ vendorId: vendor.id });

    if (!result.ok) {
      return json(
        {
          ok: false,
          reason: result.reason,
          message: "Unable to create Stripe account session.",
        },
        { status: 400 },
      );
    }

    return json({
      ok: true,
      clientSecret: result.clientSecret,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error("seller account session error:", error);

    return json(
      {
        ok: false,
        reason: "internal_error",
        message: "Unable to create Stripe account session.",
      },
      { status: 500 },
    );
  }
};
