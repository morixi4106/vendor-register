import { json, redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { createPayoutRun } from "../services/sellerPayments.server.js";

export const loader = async () => {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const result = await createPayoutRun({
    sellerId: String(formData.get("sellerId") || ""),
    amount: formData.get("amount"),
    currencyCode: String(formData.get("currencyCode") || "jpy"),
    createdBy: "admin",
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: "Failed to create payout run.",
      },
      { status: 400 },
    );
  }

  const acceptsJson = request.headers.get("Accept")?.includes("application/json");
  if (acceptsJson) {
    return json(result);
  }

  return redirect(`/app/payout-runs/${result.payoutRun.id}`);
};
